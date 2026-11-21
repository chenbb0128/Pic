//! 共享订单的字段与制作状态。原图和成品由共享存储管理。

use std::collections::HashMap;
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
    pub revision: u64,
    pub operation_id: String,
    pub metadata: Option<serde_json::Value>,
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
        Self { pool: Pool::new(options) }
    }

    async fn conn(&self) -> Result<Conn, String> {
        tokio::time::timeout(std::time::Duration::from_secs(10), self.pool.get_conn())
            .await
            .map_err(|_| "连接 MySQL 超时。".to_string())?
            .map_err(|error| format!("连接 MySQL 失败：{error}"))
    }

    pub async fn test(&self) -> Result<String, String> {
        self.conn().await?.query_drop("SELECT 1").await.map_err(mysql_error)?;
        Ok("连接成功。".into())
    }

    pub async fn order_index(&self) -> Result<OrderIndex, String> {
        let mut conn = self.conn().await?;
        conn.query_drop(
            "CREATE TABLE IF NOT EXISTS vagaga_shared_orders (
                storage_id BINARY(32) NOT NULL,
                order_number VARCHAR(256) COLLATE utf8mb4_bin NOT NULL,
                revision BIGINT UNSIGNED NOT NULL,
                operation_id CHAR(32) CHARACTER SET ascii NOT NULL,
                metadata JSON,
                completed BOOLEAN NOT NULL,
                PRIMARY KEY (storage_id, order_number)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        ).await.map_err(mysql_error)?;
        Ok(OrderIndex(conn))
    }
}

impl OrderIndex {
    pub async fn write(&mut self, storage: &str, order: &SharedOrder) -> Result<bool, String> {
        let metadata = order.metadata.as_ref().map(serde_json::Value::to_string);
        // MySQL evaluates these assignments left to right. Keep the revision
        // assignment after metadata so those fields compare against the previous revision.
        // The completion guard also makes a terminal state sticky.
        self.0.exec_drop(
            "INSERT INTO vagaga_shared_orders
             (storage_id, order_number, revision, operation_id, metadata, completed)
             VALUES (UNHEX(SHA2(?, 256)), ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                operation_id = IF(VALUES(revision)>revision AND NOT completed, VALUES(operation_id), operation_id),
                metadata = IF(VALUES(revision)>revision AND NOT completed, VALUES(metadata), metadata),
                revision = IF(NOT completed, GREATEST(VALUES(revision),revision), revision),
                completed = completed OR (VALUES(revision)=revision AND VALUES(operation_id)=operation_id AND VALUES(completed))",
            (storage, &order.number, order.revision, &order.operation_id, metadata, order.completed),
        ).await.map_err(mysql_error)?;
        Ok(self.0.affected_rows() != 0)
    }

    pub async fn read(&mut self, storage: &str) -> Result<HashMap<String, SharedOrder>, String> {
        let rows: Vec<(String, u64, String, Option<String>, bool)> = self.0.exec(
            "SELECT order_number, revision, operation_id, metadata, completed
             FROM vagaga_shared_orders WHERE storage_id=UNHEX(SHA2(?, 256))",
            (storage,),
        ).await.map_err(mysql_error)?;
        rows.into_iter().map(|(number, revision, operation_id, metadata, completed)| {
            let metadata = metadata.map(|value| serde_json::from_str(&value)).transpose()
                .map_err(|error| format!("MySQL 订单字段无效：{error}"))?;
            Ok((number.clone(), SharedOrder { number, revision, operation_id, metadata, completed }))
        }).collect()
    }
}

fn mysql_error(error: mysql_async::Error) -> String {
    format!("MySQL 同步失败：{error}")
}
