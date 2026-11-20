//! MySQL 多机协同（单 DB 方案）：订单、素材字节、模板份数、成品全入库。
//!
//! 角色与语义：客服机（千帆捕获）推送订单/素材；制作机轮询拉取；
//! 制作机导出成品回写；客服机轮询看到成品。
//! 水位：`orders.updated_at`（写入后 GREATEST 单调推进），
//! 本地 `orders.cloud_hash` 存最近一次同步的 MySQL `updated_at` 文本。
//!
//! 连接层使用成熟驱动 `mysql_async`（池化、断线重连、caching_sha2/TLS 全支持，
//! 替代此前的自研协议实现——认证细节由驱动兜底）。每次业务操作从池取连接。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use mysql_async::prelude::*;
use mysql_async::{Conn, OptsBuilder, Pool};

use crate::store::{CloudImageMeta, Store, TemplateQty};

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
        !self.host.is_empty() && !self.user.is_empty() && !self.dbname.is_empty()
    }
}

pub fn config_path(data_root: &Path) -> PathBuf {
    data_root.join("mysql.json")
}

pub fn load_config(data_root: &Path) -> MysqlConfig {
    match std::fs::read_to_string(config_path(data_root)) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => MysqlConfig::default(),
    }
}

pub fn save_config(data_root: &Path, config: &MysqlConfig) -> Result<(), String> {
    let text = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    std::fs::write(config_path(data_root), text).map_err(|error| error.to_string())
}

/* ---------- SCHEMA ---------- */

const SCHEMA_STATEMENTS: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS orders (\
         order_number VARCHAR(64) PRIMARY KEY, \
         created_at DATETIME NOT NULL, \
         updated_at DATETIME NOT NULL, \
         cloud_hash VARCHAR(64) NULL, \
         metadata TEXT NULL, \
         INDEX idx_orders_updated (updated_at)\
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
    "CREATE TABLE IF NOT EXISTS order_images (\
         id VARCHAR(64) PRIMARY KEY, \
         order_number VARCHAR(64) NOT NULL, \
         file_name VARCHAR(255) NOT NULL, \
         original_name VARCHAR(255) NOT NULL, \
         byte_length BIGINT NOT NULL, \
         width BIGINT NOT NULL, \
         height BIGINT NOT NULL, \
         source VARCHAR(32) NOT NULL, \
         data LONGBLOB NOT NULL, \
         thumb MEDIUMBLOB NULL, \
         templates JSON NOT NULL, \
         created_at DATETIME NOT NULL, \
         INDEX idx_order_images_order (order_number)\
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
    "CREATE TABLE IF NOT EXISTS productions (\
         id VARCHAR(64) PRIMARY KEY, \
         order_number VARCHAR(64) NOT NULL, \
         image_id VARCHAR(64) NULL, \
         file_name VARCHAR(255) NOT NULL, \
         data LONGBLOB NOT NULL, \
         created_at DATETIME NOT NULL, \
         INDEX idx_productions_order (order_number)\
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
];

/* ---------- 客户端（连接池 + 兼容结果集） ---------- */

/// MySQL 文本结果集（列名 + 行字节），与业务层兼容。
pub struct ResultSet {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<Vec<u8>>>>,
}

impl ResultSet {
    fn column_index(&self, name: &str) -> Result<usize, String> {
        self.columns
            .iter()
            .position(|c| c.eq_ignore_ascii_case(name))
            .ok_or_else(|| format!("结果集缺少列 {name}"))
    }
    fn str_at(&self, row: usize, name: &str) -> Result<String, String> {
        let idx = self.column_index(name)?;
        Ok(self.rows[row][idx]
            .as_ref()
            .map(|b| String::from_utf8_lossy(b).to_string())
            .unwrap_or_default())
    }
    fn opt_bytes(&self, row: usize, name: &str) -> Result<Option<Vec<u8>>, String> {
        let idx = self.column_index(name)?;
        Ok(self.rows[row][idx].clone())
    }
    fn opt_str(&self, row: usize, name: &str) -> Result<Option<String>, String> {
        Ok(self.opt_bytes(row, name)?.map(|b| String::from_utf8_lossy(&b).to_string()))
    }
}

fn value_to_bytes(value: &mysql_async::Value) -> Option<Vec<u8>> {
    match value {
        mysql_async::Value::Bytes(b) => Some(b.clone()),
        mysql_async::Value::NULL => None,
        other => Some(other.as_sql(true).to_string().into_bytes()),
    }
}

pub struct MyClient {
    pool: Pool,
    dbname: String,
}

impl MyClient {
    pub fn new(config: &MysqlConfig) -> Self {
        let opts = OptsBuilder::default()
            .ip_or_hostname(config.host.as_str())
            .tcp_port(config.port)
            .user(Some(config.user.as_str()))
            .pass(Some(config.password.as_str()))
            .db_name(Some(config.dbname.as_str()));
        let pool = Pool::new(opts);
        Self { pool, dbname: config.dbname.clone() }
    }


    /// 从池取连接（池自动断线重连），10s 连接超时。
    async fn conn(&self) -> Result<Conn, String> {
        tokio::time::timeout(std::time::Duration::from_secs(10), self.pool.get_conn())
            .await
            .map_err(|_| "连接 MySQL 超时（10s）".to_string())?
            .map_err(|error| format!("连接 MySQL 失败：{error}"))
    }

    pub async fn test(&self) -> Result<String, String> {
        let mut conn = self.conn().await?;
        self.ensure_schema(&mut conn).await?;
        conn.query_drop("SELECT 1")
            .await
            .map_err(|error| format!("SELECT 1 失败：{error}"))?;
        Ok("连接正常，schema 已就绪。".into())
    }

    async fn ensure_schema(&self, conn: &mut Conn) -> Result<(), String> {
        conn.query_drop(&format!(
            "CREATE DATABASE IF NOT EXISTS {} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci",
            self.dbname
        ))
        .await
        .map_err(|error| format!("建库失败：{error}"))?;
        conn.query_drop(&format!("USE {}", self.dbname))
            .await
            .map_err(|error| format!("USE 失败：{error}"))?;
        for statement in SCHEMA_STATEMENTS {
            conn.query_drop(*statement)
                .await
                .map_err(|error| format!("建表失败：{error}"))?;
        }
        // 旧库兼容：metadata 列补齐（重复执行报错忽略）
        let _ = conn
            .query_drop("ALTER TABLE orders ADD COLUMN metadata TEXT NULL")
            .await;
        Ok(())
    }

    /// 执行查询并返回兼容结果集（自动 USE 库）。
    pub async fn query(&self, sql: &str) -> Result<ResultSet, String> {
        let mut conn = self.conn().await?;
        conn.query_drop(&format!("USE {}", self.dbname))
            .await
            .map_err(|error| error.to_string())?;
        let mut result = conn.query_iter(sql).await.map_err(|error| error.to_string())?;
        let columns_arc: std::sync::Arc<[mysql_async::Column]> =
            result.columns().clone().unwrap_or_default();
        let columns_meta: Vec<String> = columns_arc
            .iter()
            .map(|c| c.name_str().to_string())
            .collect();
        let mysql_rows: Vec<mysql_async::Row> = result
            .collect()
            .await
            .map_err(|error| error.to_string())?;
        let rows = mysql_rows
            .into_iter()
            .map(|row| {
                (0..columns_meta.len())
                    .map(|idx| row.as_ref(idx).and_then(value_to_bytes))
                    .collect::<Vec<_>>()
            })
            .collect();
        Ok(ResultSet { columns: columns_meta, rows })
    }

    async fn exec(&self, sql: &str) -> Result<(), String> {
        let mut conn = self.conn().await?;
        conn.query_drop(sql).await.map_err(|error| error.to_string())
    }

    /// 执行多语句（按分号拆分；schema SQL 不含字符串内分号）。
    pub async fn batch_execute(&self, sql: &str) -> Result<(), String> {
        let mut conn = self.conn().await?;
        for statement in sql.split(';') {
            let trimmed = statement.trim();
            if trimmed.is_empty() {
                continue;
            }
            conn.query_drop(trimmed)
                .await
                .map_err(|error| format!("执行失败：{error}"))?;
        }
        Ok(())
    }
}

/* ---------- SQL 工具 ---------- */

/// 字符串字面量转义（文本协议）。
fn sql_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 8);
    out.push('\'');
    for c in value.chars() {
        match c {
            '\'' => out.push_str("\\'"),
            '\\' => out.push_str("\\\\"),
            '\0' => out.push_str("\\0"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            _ => out.push(c),
        }
    }
    out.push('\'');
    out
}

fn mysql_time(rfc3339: &str) -> String {
    let normalized = rfc3339.replace("T", " ");
    normalized.chars().take(19).collect()
}

/* ---------- 业务层 ---------- */

pub struct MysqlNotice {
    pub order_number: String,
    pub new_images: usize,
    pub new_productions: usize,
}

impl MyClient {
    /// 推送订单：图片字节 + 模板全量 upsert，订单水位 GREATEST 单调推进。
    pub async fn push_order(&self, store: &Store, order_number: &str) -> Result<(), String> {
        let mut conn = self.conn().await?;
        self.ensure_schema(&mut conn).await?;
        let images = store
            .cloud_order_images(order_number)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "订单不存在".to_string())?;
        let updated_at = mysql_time(
            &store
                .order_updated_at_by_number(order_number)
                .map_err(|error| error.to_string())?
                .unwrap_or_else(|| chrono::Local::now().to_rfc3339()),
        );
        let metadata = store
            .order_metadata_by_number(order_number)
            .map_err(|error| error.to_string())?;

        conn.exec_drop(
            "INSERT INTO orders(order_number, created_at, updated_at, metadata) \
             VALUES(?, NOW(), ?, ?) \
             ON DUPLICATE KEY UPDATE \
               updated_at = GREATEST(updated_at, VALUES(updated_at)), \
               metadata = COALESCE(VALUES(metadata), orders.metadata)",
            (order_number, updated_at.as_str(), metadata.as_deref()),
        )
        .await
        .map_err(|error| format!("订单写入失败：{error}"))?;
        Ok(())
    }
}

impl MyClient {
    /// 启动回填：本地全部订单推到 MySQL（已有订单幂等覆盖）。
    pub async fn backfill_push(&self, store: &Store) -> Result<usize, String> {
        let orders = store
            .list_orders()
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|o| o.order_number)
            .collect::<Vec<_>>();
        let mut pushed = 0usize;
        for order_number in orders {
            self.push_order(store, &order_number).await?;
            pushed += 1;
        }
        Ok(pushed)
    }

    /// 成品回写（制作机导出后调用）。
    pub async fn put_production(
        &self,
        id: &str,
        order_number: &str,
        image_id: Option<&str>,
        file_name: &str,
        data: &[u8],
    ) -> Result<(), String> {
        let mut conn = self.conn().await?;
        self.ensure_schema(&mut conn).await?;
        conn.exec_drop(
            "INSERT INTO productions(id, order_number, image_id, file_name, data, created_at) \
             VALUES(?, ?, ?, ?, ?, NOW()) \
             ON DUPLICATE KEY UPDATE data=VALUES(data)",
            (id, order_number, image_id, file_name, data),
        )
        .await
        .map_err(|error| format!("成品写入失败：{error}"))?;
        Ok(())
    }

    /// 全量拉取：订单水位比对 + 素材落盘导入 + 成品回本地。
    pub async fn pull_all(
        &self,
        store: &Store,
        data_root: &Path,
    ) -> Result<Vec<MysqlNotice>, String> {
        let mut conn = self.conn().await?;
        self.ensure_schema(&mut conn).await?;

        let result = self
            .query(
                "SELECT order_number, DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS w, metadata \
                 FROM orders ORDER BY order_number",
            )
            .await
            .map_err(|error| error.to_string())?;
        let local_hashes: HashMap<String, Option<String>> = store
            .cloud_hashes()
            .map_err(|error| error.to_string())?
            .into_iter()
            .collect();

        let mut notices: HashMap<String, MysqlNotice> = HashMap::new();
        for row_index in 0..result.rows.len() {
            let order_number = result.str_at(row_index, "order_number")?;
            let watermark = result.str_at(row_index, "w")?;
            let cloud_metadata = result.opt_str(row_index, "metadata")?;
            if local_hashes
                .get(&order_number)
                .and_then(|h| h.as_deref())
                == Some(watermark.as_str())
            {
                continue;
            }
            let image_result = self
                .query(
                    &format!(
                        "SELECT id, file_name, original_name, byte_length, width, height, source, data, templates \
                         FROM order_images WHERE order_number = {} ORDER BY created_at ASC",
                        sql_string(&order_number)
                    ),
                )
                .await
                .map_err(|error| error.to_string())?;
            let directory = store.cloud_import_directory(&order_number);
            let _ = std::fs::create_dir_all(&directory);
            let mut staged: Vec<(CloudImageMeta, PathBuf)> = Vec::new();
            for img_index in 0..image_result.rows.len() {
                let id = image_result.str_at(img_index, "id")?;
                let file_name = image_result.str_at(img_index, "file_name")?;
                let original_name = image_result.str_at(img_index, "original_name")?;
                let byte_length: i64 = image_result
                    .opt_bytes(img_index, "byte_length")?
                    .and_then(|b| String::from_utf8_lossy(&b).parse().ok())
                    .unwrap_or(0);
                let width: i64 = image_result
                    .opt_bytes(img_index, "width")?
                    .and_then(|b| String::from_utf8_lossy(&b).parse().ok())
                    .unwrap_or(0);
                let height: i64 = image_result
                    .opt_bytes(img_index, "height")?
                    .and_then(|b| String::from_utf8_lossy(&b).parse().ok())
                    .unwrap_or(0);
                let source = image_result.str_at(img_index, "source")?;
                let data = image_result
                    .opt_bytes(img_index, "data")?
                    .ok_or_else(|| format!("素材 BLOB 为空 {order_number}/{file_name}"))?;
                let templates_json = image_result.str_at(img_index, "templates")?;
                let path = directory.join(&file_name);
                if !path.exists() {
                    std::fs::write(&path, &data)
                        .map_err(|error| format!("写入素材失败 {order_number}/{file_name}：{error}"))?;
                }
                let templates: Vec<TemplateQty> = serde_json::from_str::<
                    Vec<serde_json::Value>,
                >(&templates_json)
                .unwrap_or_default()
                .into_iter()
                .filter_map(|v| {
                    Some(TemplateQty {
                        template_id: v.get("templateId")?.as_str()?.to_string(),
                        quantity: v.get("quantity")?.as_i64()?,
                    })
                })
                .collect();
                staged.push((
                    CloudImageMeta {
                        id,
                        file_name,
                        original_name,
                        byte_length,
                        width,
                        height,
                        source,
                        templates,
                    },
                    path,
                ));
            }
            let new_images = store
                .import_cloud_order(&order_number, &staged, &watermark, &watermark)
                .map_err(|error| error.to_string())?;
            if let Some(meta) = &cloud_metadata {
                let _ = store.set_order_metadata(&order_number, meta);
            }
            notices
                .entry(order_number.clone())
                .and_modify(|n| n.new_images += new_images)
                .or_insert(MysqlNotice {
                    order_number: order_number.clone(),
                    new_images,
                    new_productions: 0,
                });
        }

        // 成品：按 id 幂等回本地
        let prod_result = self
            .query(
                "SELECT id, order_number, image_id, file_name, data FROM productions ORDER BY created_at ASC",
            )
            .await?;
        for prod_index in 0..prod_result.rows.len() {
            let id = prod_result.str_at(prod_index, "id")?;
            let order_number = prod_result.str_at(prod_index, "order_number")?;
            let image_id = prod_result.opt_str(prod_index, "image_id")?;
            let file_name = prod_result.str_at(prod_index, "file_name")?;
            let data = prod_result
                .opt_bytes(prod_index, "data")?
                .ok_or_else(|| format!("成品 BLOB 为空 {order_number}/{id}"))?;
            if store.production_exists(&id).map_err(|error| error.to_string())? {
                continue;
            }
            let directory = data_root
                .join("productions")
                .join(order_number.replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_"));
            let _ = std::fs::create_dir_all(&directory);
            let path = directory.join(format!("{id}_{file_name}"));
            std::fs::write(&path, &data)
                .map_err(|error| format!("写入成品失败 {order_number}/{id}：{error}"))?;
            store
                .add_production(&id, &order_number, image_id.as_deref(), &path)
                .map_err(|error| error.to_string())?;
            notices
                .entry(order_number.clone())
                .and_modify(|n| n.new_productions += 1)
                .or_insert(MysqlNotice {
                    order_number,
                    new_images: 0,
                    new_productions: 1,
                });
        }

        Ok(notices.into_values().collect())
    }
}
