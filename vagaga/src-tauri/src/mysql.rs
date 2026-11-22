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

pub struct OrderIndex(Conn);

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
        conn.query_drop(
            "CREATE TABLE IF NOT EXISTS orders (
                storage_id VARBINARY(1024) NOT NULL,
                order_number VARBINARY(256) NOT NULL,
                operation_id CHAR(32) CHARACTER SET ascii NOT NULL,
                payload JSON NOT NULL,
                completed BOOLEAN NOT NULL,
                PRIMARY KEY (storage_id, order_number)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        )
        .await
        .map_err(mysql_error)?;
        Ok(OrderIndex(conn))
    }
}

impl OrderIndex {
    pub async fn write(
        &mut self,
        storage: &str,
        expected_operation: Option<&str>,
        order: &SharedOrder,
    ) -> Result<bool, String> {
        if let Some(expected) = expected_operation {
            self.0
                .exec_drop(
                    "UPDATE orders SET operation_id=?,payload=?,completed=?
                 WHERE storage_id=? AND order_number=? AND operation_id=? AND NOT completed",
                    (
                        &order.operation_id,
                        &order.payload,
                        order.completed,
                        storage,
                        &order.number,
                        expected,
                    ),
                )
                .await
                .map_err(mysql_error)?;
            if self.0.affected_rows() != 0 {
                return Ok(true);
            }
        } else if !order.completed {
            let result = self.0.exec_drop(
                "INSERT INTO orders(storage_id,order_number,operation_id,payload,completed)
                 VALUES(?,?,?,?,FALSE)",
                (storage, &order.number, &order.operation_id, &order.payload),
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

    pub async fn get(
        &mut self,
        storage: &str,
        number: &str,
    ) -> Result<Option<SharedOrder>, String> {
        let row: Option<(String, String, String, bool)> = self
            .0
            .exec_first(
                "SELECT order_number, operation_id, payload, completed FROM orders
             WHERE storage_id=? AND order_number=?",
                (storage, number),
            )
            .await
            .map_err(mysql_error)?;
        Ok(row.map(shared_order))
    }

    pub async fn read(&mut self, storage: &str) -> Result<Vec<SharedOrder>, String> {
        self.0
            .exec_map(
                "SELECT order_number, operation_id, payload, completed FROM orders
             WHERE storage_id=?",
                (storage,),
                shared_order,
            )
            .await
            .map_err(mysql_error)
    }
}

fn shared_order(
    (number, operation_id, payload, completed): (String, String, String, bool),
) -> SharedOrder {
    SharedOrder {
        number,
        operation_id,
        payload,
        completed,
    }
}

fn mysql_error(error: mysql_async::Error) -> String {
    format!("MySQL 同步失败：{error}")
}
