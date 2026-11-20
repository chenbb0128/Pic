// 一次性：创建专用数据库 paidan（幂等），并清空旧 postgres 库中的同步表。
use vagaga_lib::pg::{PgClient, PgConfig};

#[tokio::main]
async fn main() {
    // 连接默认 postgres 库执行 CREATE DATABASE（不能在事务内）
    let admin = PgConfig {
        enabled: true,
        host: "192.168.31.200".into(),
        port: 15432,
        user: "postgres".into(),
        password: "admin!@#123".into(),
        dbname: "postgres".into(),
        poll_seconds: 30,
    };
    let client = PgClient::new(&admin);
    let exists: i64 = {
        let c = client.connect().await.expect("connect postgres db");
        let row = c
            .query_one(
                "SELECT COUNT(*) FROM pg_database WHERE datname = 'paidan'",
                &[],
            )
            .await
            .expect("query pg_database");
        row.get(0)
    };
    if exists == 0 {
        client
            .raw_execute("CREATE DATABASE paidan", &[])
            .await
            .expect("create database");
        println!("[ok] 数据库 paidan 已创建");
    } else {
        println!("[ok] 数据库 paidan 已存在");
    }

    // 清理旧 postgres 库里的同步表（不再使用）
    client
        .raw_execute("DROP TABLE IF EXISTS order_images CASCADE", &[])
        .await
        .expect("drop old order_images");
    client
        .raw_execute("DROP TABLE IF EXISTS productions CASCADE", &[])
        .await
        .expect("drop old productions");
    client
        .raw_execute("DROP TABLE IF EXISTS orders CASCADE", &[])
        .await
        .expect("drop old orders");
    println!("[ok] 旧 postgres 库中的同步表已清除");
}
