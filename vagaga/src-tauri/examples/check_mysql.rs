// 查看 MySQL paidan 库的同步状态：订单/素材/成品行数与明细。
use vagaga_lib::mysql::{MyClient, MysqlConfig};

#[tokio::main]
async fn main() {
    let config = MysqlConfig {
        enabled: true,
        host: "192.168.31.200".into(),
        port: 3306,
        user: "root".into(),
        password: "admin123".into(),
        dbname: "vagaga".into(),
        poll_seconds: 30,
    };
    let client = MyClient::new(&config);
    let mut conn = client.connect().await.expect("connect");
    conn.exec("USE vagaga").await.expect("use paidan");
    let rows = conn
        .query(
            "SELECT o.order_number, DATE_FORMAT(o.updated_at, '%Y-%m-%d %H:%i:%s') AS u, COUNT(i.id) AS imgs \
             FROM orders o LEFT JOIN order_images i ON i.order_number = o.order_number \
             GROUP BY o.order_number, o.updated_at ORDER BY o.updated_at DESC",
        )
        .await
        .expect("query orders");
    println!("== orders ==");
    for i in 0..rows.rows.len() {
        println!(
            "{} | imgs={} | {}",
            rows.str_at(i, "order_number").unwrap(),
            rows.str_at(i, "imgs").unwrap(),
            rows.str_at(i, "u").unwrap()
        );
    }
    let rows = conn
        .query("SELECT order_number, COUNT(*) AS n FROM productions GROUP BY order_number")
        .await
        .expect("query productions");
    println!("== productions ==");
    for i in 0..rows.rows.len() {
        println!("{} | {}", rows.str_at(i, "order_number").unwrap(), rows.str_at(i, "n").unwrap());
    }
}
