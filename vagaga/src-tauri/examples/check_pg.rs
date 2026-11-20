// 查看 PG 同步状态：订单/素材/成品行数与明细。
use vagaga_lib::pg::{PgClient, PgConfig};

#[tokio::main]
async fn main() {
    let config = PgConfig {
        enabled: true,
        host: "192.168.31.200".into(),
        port: 15432,
        user: "postgres".into(),
        password: "admin!@#123".into(),
        dbname: "paidan".into(),
        poll_seconds: 30,
    };
    let client = PgClient::new(&config);
    let c = client.connect().await.expect("connect");
    let rows = c
        .query(
            "SELECT o.order_number, o.updated_at::text, COUNT(i.id) AS imgs
             FROM orders o LEFT JOIN order_images i ON i.order_number = o.order_number
             GROUP BY o.order_number, o.updated_at ORDER BY o.updated_at DESC",
            &[],
        )
        .await
        .expect("query");
    println!("== orders ==");
    for r in &rows {
        println!("{} | imgs={} | {}", r.get::<_, String>(0), r.get::<_, i64>(2), r.get::<_, String>(1));
    }
    let rows = c
        .query(
            "SELECT order_number, COUNT(*) FROM productions GROUP BY order_number",
            &[],
        )
        .await
        .expect("query productions");
    println!("== productions ==");
    for r in &rows {
        println!("{} | {}", r.get::<_, String>(0), r.get::<_, i64>(1));
    }
}
