//! 共享订单、制作状态和素材引用。图片字节由共享存储管理。

use std::path::{Path, PathBuf};

use mysql_async::prelude::*;
use mysql_async::{Conn, OptsBuilder, Pool};

/* ---------- 配置（数据根/mysql.json） ---------- */

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MysqlConfig {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub dbname: String,
    /// 轮询间隔秒（最小 10）
    pub poll_seconds: u64,
}

impl Default for MysqlConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            host: String::new(),
            port: 3306,
            user: String::new(),
            password: String::new(),
            dbname: "vagaga".into(),
            poll_seconds: 30,
        }
    }
}

impl MysqlConfig {
    pub fn valid(&self) -> bool {
        self.port > 0 && !self.host.trim().is_empty() && !self.user.trim().is_empty() && !self.dbname.trim().is_empty()
    }
}

pub fn config_path(data_root: &Path) -> PathBuf {
    data_root.join("mysql.json")
}

pub fn load_config(data_root: &Path) -> MysqlConfig {
    match std::fs::read_to_string(config_path(data_root)) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/mysql-defaults.json")))
                .unwrap_or_default()
        }
        Err(_) => MysqlConfig::default(),
    }
}

pub fn save_config(data_root: &Path, config: &MysqlConfig) -> Result<(), String> {
    let text = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    std::fs::write(config_path(data_root), text).map_err(|error| error.to_string())
}

pub struct MyClient {
    pool: Pool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SharedOrder {
    pub number: String,
    pub operation_id: String,
    pub payload: String,
    pub completed: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SharedOrderRow {
    pub order: SharedOrder,
    pub change_seq: u64,
    pub claimed_by: Option<String>,
    pub claimed_name: Option<String>,
    pub claimed_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ClaimResult {
    Claimed,
    HeldByOther {
        device_id: String,
        device_name: String,
        claimed_at: i64,
    },
    Completed,
    NotFound,
}

pub struct OrderIndex(Conn);

pub(crate) struct TemplateIndex(Conn);

async fn ensure_column(conn: &mut Conn, table: &str, definition: &str) -> Result<(), String> {
    match conn
        .query_drop(format!("ALTER TABLE {table} ADD COLUMN {definition}"))
        .await
    {
        Ok(()) => Ok(()),
        // 1060 = Duplicate column name in MySQL
        Err(mysql_async::Error::Server(error)) if error.code == 1060 => Ok(()),
        Err(error) => Err(mysql_error(error)),
    }
}

async fn ensure_index(conn: &mut Conn, sql: &str) -> Result<(), String> {
    match conn.query_drop(sql).await {
        Ok(()) => Ok(()),
        // 1061 = Duplicate key name in MySQL
        Err(mysql_async::Error::Server(error)) if error.code == 1061 => Ok(()),
        Err(error) => Err(mysql_error(error)),
    }
}

async fn init_sequences(conn: &mut Conn) -> Result<(), String> {
    conn.query_drop(
        "CREATE TABLE IF NOT EXISTS sync_sequences (
            name VARCHAR(64) CHARACTER SET ascii NOT NULL PRIMARY KEY,
            seq BIGINT UNSIGNED NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
    )
    .await
    .map_err(mysql_error)
}

async fn next_sequence(conn: &mut Conn, name: &str) -> Result<u64, String> {
    conn.exec_drop(
        "INSERT INTO sync_sequences(name, seq) VALUES (?, 1)
         ON DUPLICATE KEY UPDATE seq = LAST_INSERT_ID(seq + 1)",
        (name,),
    )
    .await
    .map_err(mysql_error)?;
    let seq: Option<u64> = conn
        .query_first("SELECT LAST_INSERT_ID()")
        .await
        .map_err(mysql_error)?;
    Ok(seq.unwrap_or(1))
}

pub(crate) async fn connect_template_index(root: &Path) -> Result<TemplateIndex, String> {
    let config = load_config(root);
    if !config.valid() {
        return Err("请先在设置 → 共享数据库中保存完整的 MySQL 配置。".into());
    }
    let client = MyClient::new(&config);
    let mut conn = client.conn().await?;
    conn.query_drop(
        "CREATE TABLE IF NOT EXISTS templates (
            storage_id VARBINARY(1024) NOT NULL,
            id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            code VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            name VARCHAR(80) NOT NULL,
            width DOUBLE NOT NULL, height DOUBLE NOT NULL, dpi INT UNSIGNED NOT NULL,
            layout JSON NOT NULL, enabled BOOLEAN NOT NULL, updated_at BIGINT NOT NULL,
            background_key VARCHAR(128) CHARACTER SET ascii NOT NULL,
            preview_key VARCHAR(128) CHARACTER SET ascii NOT NULL,
            PRIMARY KEY (storage_id,id), UNIQUE KEY template_code (storage_id,code)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
    ).await.map_err(mysql_error)?;
    Ok(TemplateIndex(conn))
}

type TemplateRow = (String, String, String, f64, f64, u32, String, bool, i64, String, String);
const TEMPLATE_COLUMNS: &str = "id,code,name,width,height,dpi,layout,enabled,updated_at,background_key,preview_key";

impl TemplateIndex {
    pub(crate) async fn get(&mut self, storage: &str, id: &str) -> Result<Option<crate::templates::SavedTemplate>, String> {
        let row: Option<TemplateRow> = self.0.exec_first(
            format!("SELECT {TEMPLATE_COLUMNS} FROM templates WHERE storage_id=? AND id=?"),
            (storage, id),
        ).await.map_err(mysql_error)?;
        row.map(shared_template).transpose()
    }

    pub(crate) async fn find_by_code(&mut self, storage: &str, code: &str) -> Result<Option<crate::templates::SavedTemplate>, String> {
        let row: Option<TemplateRow> = self.0.exec_first(
            format!("SELECT {TEMPLATE_COLUMNS} FROM templates WHERE storage_id=? AND code=?"),
            (storage, code),
        ).await.map_err(mysql_error)?;
        row.map(shared_template).transpose()
    }

    pub(crate) async fn list(&mut self, storage: &str) -> Result<Vec<crate::templates::SavedTemplate>, String> {
        let rows: Vec<TemplateRow> = self.0.exec(
            format!("SELECT {TEMPLATE_COLUMNS} FROM templates WHERE storage_id=? ORDER BY code"),
            (storage,),
        ).await.map_err(mysql_error)?;
        rows.into_iter().map(shared_template).collect()
    }

    pub(crate) async fn write(
        &mut self, storage: &str, template: &crate::templates::SavedTemplate, exists: bool,
    ) -> Result<(), String> {
        if exists {
            self.0.exec_drop(
                "UPDATE templates
                 SET name=?,width=?,height=?,dpi=?,layout=?,enabled=?,updated_at=?,background_key=?,preview_key=?
                 WHERE storage_id=? AND id=? AND updated_at<=?",
                (
                    &template.name,
                    template.width,
                    template.height,
                    template.dpi,
                    &template.layout,
                    template.enabled,
                    template.updated_at,
                    template.background_key(),
                    template.preview_key(),
                    storage,
                    &template.id,
                    template.updated_at,
                ),
            ).await.map_err(mysql_error)?;
            if self.0.affected_rows() == 0
                && self.get(storage, &template.id).await?.is_none_or(|current| current.updated_at > template.updated_at)
            {
                return Err(format!("共享模板 {} 已变化，请先同步模板。", template.code));
            }
            return Ok(());
        }
        match self.0.exec_drop(
            "INSERT INTO templates(storage_id,id,code,name,width,height,dpi,layout,enabled,updated_at,background_key,preview_key)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (storage, &template.id, &template.code, &template.name, template.width, template.height, template.dpi,
                &template.layout, template.enabled, template.updated_at, template.background_key(), template.preview_key()),
        ).await {
            Ok(()) => Ok(()),
            Err(mysql_async::Error::Server(error)) if error.code == 1062 => {
                Err(format!("共享目录已有规格 {}，请同步后重试。", template.code))
            }
            Err(error) => Err(mysql_error(error)),
        }
    }
}

fn parse_template_rev<'a>(key: &'a str, suffix: &str) -> Option<&'a str> {
    let rest = key.strip_prefix("templates/")?;
    let rev = rest.strip_suffix(suffix)?;
    crate::templates::is_saved_id(rev).then_some(rev)
}

fn shared_template(
    (id, code, name, width, height, dpi, layout, enabled, updated_at, background, preview): TemplateRow,
) -> Result<crate::templates::SavedTemplate, String> {
    let Some(bg_rev) = parse_template_rev(&background, "/background.png") else {
        return Err(format!("共享模板 {} 的图片路径无效。", code));
    };
    let Some(pv_rev) = parse_template_rev(&preview, "/preview.webp") else {
        return Err(format!("共享模板 {} 的图片路径无效。", code));
    };
    if bg_rev != pv_rev {
        return Err(format!("共享模板 {} 的图片版本不一致。", code));
    }
    Ok(crate::templates::SavedTemplate {
        id,
        code,
        name,
        width,
        height,
        dpi,
        layout,
        enabled,
        updated_at,
        image_rev: bg_rev.to_owned(),
    })
}

impl MyClient {
    pub fn new(config: &MysqlConfig) -> Self {
        let options = OptsBuilder::default()
            .ip_or_hostname(config.host.trim())
            .tcp_port(config.port)
            .user(Some(config.user.as_str()))
            .pass(Some(config.password.as_str()))
            .db_name(Some(config.dbname.as_str()));
        Self {
            pool: Pool::new(options),
        }
    }

    async fn conn(&self) -> Result<Conn, String> {
        tokio::time::timeout(std::time::Duration::from_secs(10), self.pool.get_conn())
            .await
            .map_err(|_| "连接 MySQL 超时。".to_string())?
            .map_err(|error| format!("连接 MySQL 失败：{error}"))
    }

    pub async fn test(&self) -> Result<String, String> {
        self.conn()
            .await?
            .query_drop("SELECT 1")
            .await
            .map_err(mysql_error)?;
        Ok("连接成功。".into())
    }

    pub async fn order_index(&self) -> Result<OrderIndex, String> {
        let mut conn = self.conn().await?;
        init_sequences(&mut conn).await?;
        conn.query_drop(
            "CREATE TABLE IF NOT EXISTS orders (
                storage_id VARBINARY(1024) NOT NULL,
                order_number VARBINARY(256) NOT NULL,
                operation_id CHAR(32) CHARACTER SET ascii NOT NULL,
                payload JSON NOT NULL,
                completed BOOLEAN NOT NULL,
                change_seq BIGINT UNSIGNED NOT NULL DEFAULT 0,
                claimed_by VARCHAR(128) NULL,
                claimed_name VARCHAR(128) NULL,
                claimed_at BIGINT NULL,
                PRIMARY KEY (storage_id, order_number)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        )
        .await
        .map_err(mysql_error)?;
        ensure_column(&mut conn, "orders", "change_seq BIGINT UNSIGNED NOT NULL DEFAULT 0").await?;
        ensure_column(&mut conn, "orders", "claimed_by VARCHAR(128) NULL").await?;
        ensure_column(&mut conn, "orders", "claimed_name VARCHAR(128) NULL").await?;
        ensure_column(&mut conn, "orders", "claimed_at BIGINT NULL").await?;
        ensure_index(&mut conn, "CREATE INDEX idx_orders_change_seq ON orders (change_seq)").await?;

        // Backfill legacy rows with change_seq = 0 so incremental cursors never miss pre-existing orders.
        let legacy: Vec<(Vec<u8>, Vec<u8>)> = conn
            .query("SELECT storage_id, order_number FROM orders WHERE change_seq = 0 LIMIT 500")
            .await
            .map_err(mysql_error)?;
        for (storage_id, order_number) in legacy {
            let seq = next_sequence(&mut conn, "orders").await?;
            conn.exec_drop(
                "UPDATE orders SET change_seq = ? WHERE storage_id = ? AND order_number = ? AND change_seq = 0",
                (seq, storage_id, order_number),
            )
            .await
            .map_err(mysql_error)?;
        }
        Ok(OrderIndex(conn))
    }
}

type OrderRowTuple = (String, String, String, bool, u64, Option<String>, Option<String>, Option<i64>);
const ORDER_SELECT_COLUMNS: &str = "order_number, operation_id, payload, completed, change_seq, claimed_by, claimed_name, claimed_at";

impl OrderIndex {
    async fn next_seq(&mut self) -> Result<u64, String> {
        next_sequence(&mut self.0, "orders").await
    }

    pub async fn write(
        &mut self,
        storage: &str,
        expected_operation: Option<&str>,
        order: &SharedOrder,
    ) -> Result<bool, String> {
        let seq = self.next_seq().await?;
        if let Some(expected) = expected_operation {
            if order.completed {
                self.0
                    .exec_drop(
                        "UPDATE orders SET operation_id=?,payload=?,completed=TRUE,change_seq=?,
                         claimed_by=NULL,claimed_name=NULL,claimed_at=NULL
                         WHERE storage_id=? AND order_number=? AND operation_id=? AND NOT completed",
                        (
                            &order.operation_id,
                            &order.payload,
                            seq,
                            storage,
                            &order.number,
                            expected,
                        ),
                    )
                    .await
                    .map_err(mysql_error)?;
            } else {
                self.0
                    .exec_drop(
                        "UPDATE orders SET operation_id=?,payload=?,completed=FALSE,change_seq=?
                         WHERE storage_id=? AND order_number=? AND operation_id=? AND NOT completed",
                        (
                            &order.operation_id,
                            &order.payload,
                            seq,
                            storage,
                            &order.number,
                            expected,
                        ),
                    )
                    .await
                    .map_err(mysql_error)?;
            }
            if self.0.affected_rows() != 0 {
                return Ok(true);
            }
        } else if !order.completed {
            let result = self.0.exec_drop(
                "INSERT INTO orders(storage_id,order_number,operation_id,payload,completed,change_seq)
                 VALUES(?,?,?,?,FALSE,?)",
                (storage, &order.number, &order.operation_id, &order.payload, seq),
            ).await;
            match result {
                Ok(()) => return Ok(true),
                Err(mysql_async::Error::Server(error)) if error.code == 1062 => {}
                Err(error) => return Err(mysql_error(error)),
            }
        }
        // Read the operation ID to recognize an earlier successful attempt even
        // if the response was lost. SQL enforces the expected row on every write.
        Ok(self
            .get(storage, &order.number)
            .await?
            .is_some_and(|current| current.operation_id == order.operation_id))
    }

    pub async fn reopen(
        &mut self,
        storage: &str,
        expected_operation: &str,
        order: &SharedOrder,
    ) -> Result<bool, String> {
        let seq = self.next_seq().await?;
        self.0
            .exec_drop(
                "UPDATE orders SET operation_id=?,payload=?,completed=FALSE,change_seq=?,
                 claimed_by=NULL,claimed_name=NULL,claimed_at=NULL
                 WHERE storage_id=? AND order_number=? AND operation_id=?",
                (
                    &order.operation_id,
                    &order.payload,
                    seq,
                    storage,
                    &order.number,
                    expected_operation,
                ),
            )
            .await
            .map_err(mysql_error)?;
        if self.0.affected_rows() != 0 {
            return Ok(true);
        }
        Ok(self
            .get(storage, &order.number)
            .await?
            .is_some_and(|current| current.operation_id == order.operation_id && !current.completed))
    }

    pub async fn claim(
        &mut self,
        storage: &str,
        number: &str,
        device_id: &str,
        device_name: &str,
        now_ms: i64,
        lease_ms: i64,
        force: bool,
    ) -> Result<ClaimResult, String> {
        let seq = self.next_seq().await?;
        let expired_before = now_ms.saturating_sub(lease_ms);
        if force {
            self.0
                .exec_drop(
                    "UPDATE orders SET claimed_by=?,claimed_name=?,claimed_at=?,change_seq=?
                     WHERE storage_id=? AND order_number=? AND NOT completed",
                    (device_id, device_name, now_ms, seq, storage, number),
                )
                .await
                .map_err(mysql_error)?;
        } else {
            self.0
                .exec_drop(
                    "UPDATE orders SET claimed_by=?,claimed_name=?,claimed_at=?,change_seq=?
                     WHERE storage_id=? AND order_number=? AND NOT completed
                     AND (claimed_by IS NULL OR claimed_by=? OR claimed_at IS NULL OR claimed_at<?)",
                    (
                        device_id,
                        device_name,
                        now_ms,
                        seq,
                        storage,
                        number,
                        device_id,
                        expired_before,
                    ),
                )
                .await
                .map_err(mysql_error)?;
        }
        if self.0.affected_rows() != 0 {
            return Ok(ClaimResult::Claimed);
        }
        let Some(current) = self.get_row(storage, number).await? else {
            return Ok(ClaimResult::NotFound);
        };
        if current.order.completed {
            return Ok(ClaimResult::Completed);
        }
        if current.claimed_by.as_deref() == Some(device_id) {
            return Ok(ClaimResult::Claimed);
        }
        Ok(ClaimResult::HeldByOther {
            device_id: current.claimed_by.unwrap_or_default(),
            device_name: current.claimed_name.unwrap_or_else(|| "其他设备".into()),
            claimed_at: current.claimed_at.unwrap_or(now_ms),
        })
    }

    pub async fn release_claim(
        &mut self,
        storage: &str,
        number: &str,
        device_id: &str,
        force: bool,
    ) -> Result<bool, String> {
        let seq = self.next_seq().await?;
        if force {
            self.0
                .exec_drop(
                    "UPDATE orders SET claimed_by=NULL,claimed_name=NULL,claimed_at=NULL,change_seq=?
                     WHERE storage_id=? AND order_number=? AND claimed_by IS NOT NULL",
                    (seq, storage, number),
                )
                .await
                .map_err(mysql_error)?;
        } else {
            self.0
                .exec_drop(
                    "UPDATE orders SET claimed_by=NULL,claimed_name=NULL,claimed_at=NULL,change_seq=?
                     WHERE storage_id=? AND order_number=? AND claimed_by=?",
                    (seq, storage, number, device_id),
                )
                .await
                .map_err(mysql_error)?;
        }
        Ok(self.0.affected_rows() != 0)
    }

    pub async fn get_row(
        &mut self,
        storage: &str,
        number: &str,
    ) -> Result<Option<SharedOrderRow>, String> {
        let row: Option<OrderRowTuple> = self
            .0
            .exec_first(
                format!(
                    "SELECT {ORDER_SELECT_COLUMNS} FROM orders
                     WHERE storage_id=? AND order_number=?"
                ),
                (storage, number),
            )
            .await
            .map_err(mysql_error)?;
        Ok(row.map(shared_order_row))
    }

    pub async fn get(
        &mut self,
        storage: &str,
        number: &str,
    ) -> Result<Option<SharedOrder>, String> {
        Ok(self.get_row(storage, number).await?.map(|row| row.order))
    }

    pub async fn read(&mut self, storage: &str) -> Result<Vec<SharedOrder>, String> {
        let rows: Vec<SharedOrderRow> = self
            .0
            .exec_map(
                format!(
                    "SELECT {ORDER_SELECT_COLUMNS} FROM orders
                     WHERE storage_id=? ORDER BY change_seq ASC"
                ),
                (storage,),
                shared_order_row,
            )
            .await
            .map_err(mysql_error)?;
        Ok(rows.into_iter().map(|row| row.order).collect())
    }

    pub async fn read_since(
        &mut self,
        storage: &str,
        after_seq: u64,
        limit: u32,
    ) -> Result<Vec<SharedOrderRow>, String> {
        self.0
            .exec_map(
                format!(
                    "SELECT {ORDER_SELECT_COLUMNS} FROM orders
                     WHERE storage_id=? AND change_seq>?
                     ORDER BY change_seq ASC LIMIT ?"
                ),
                (storage, after_seq, limit.max(1)),
                shared_order_row,
            )
            .await
            .map_err(mysql_error)
    }
}

fn shared_order_row(
    (number, operation_id, payload, completed, change_seq, claimed_by, claimed_name, claimed_at): OrderRowTuple,
) -> SharedOrderRow {
    SharedOrderRow {
        order: SharedOrder {
            number,
            operation_id,
            payload,
            completed,
        },
        change_seq,
        claimed_by,
        claimed_name,
        claimed_at,
    }
}

fn mysql_error(error: mysql_async::Error) -> String {
    format!("MySQL 同步失败：{error}")
}
