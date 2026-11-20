//! MySQL 多机协同真库验证（用户提供的局域网 MySQL）。
//! 覆盖：建库建表 → 推单（订单/素材/模板）→ 另一端拉取入库 → 成品回写 → 回拉成品 → 清理。
//! 测试数据订单号 P123TEST，结束后清理。

use vagaga_lib::mysql::{MyClient, MysqlConfig};
use vagaga_lib::store::Store;

const HOST: &str = "192.168.31.200";
const PORT: u16 = 3306;
const USER: &str = "root";
const PASSWORD: &str = "admin123";
const DBNAME: &str = "vagaga_test";
const TEST_ORDER: &str = "P123TEST";

/// 现场生成 4x4 PNG（保证字节合法，供 ingest 解码校验）。
fn tiny_png() -> Vec<u8> {
    let img = image::RgbaImage::from_pixel(4, 4, image::Rgba([255, 120, 160, 255]));
    let mut buf = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut buf, image::ImageFormat::Png)
        .expect("png encode");
    buf.into_inner()
}

fn test_config() -> MysqlConfig {
    MysqlConfig {
        enabled: true,
        host: HOST.into(),
        port: PORT,
        user: USER.into(),
        password: PASSWORD.into(),
        dbname: DBNAME.into(),
        poll_seconds: 30,
    }
}

#[tokio::test]
async fn full_sync_loop() {
    let config = test_config();

    // 清理上次运行的残留（幂等）
    {
        let mut conn = MyClient::new(&config).connect().await.expect("connect for cleanup");
        conn.exec(&format!("CREATE DATABASE IF NOT EXISTS {DBNAME}"))
            .await
            .expect("create db");
        conn.exec(&format!("USE {DBNAME}")).await.expect("use db");
        conn.exec("CREATE TABLE IF NOT EXISTS orders (order_number VARCHAR(64) PRIMARY KEY, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, cloud_hash VARCHAR(64) NULL) ENGINE=InnoDB")
            .await
            .expect("create orders");
        conn.exec("CREATE TABLE IF NOT EXISTS order_images (id VARCHAR(64) PRIMARY KEY, order_number VARCHAR(64) NOT NULL, file_name VARCHAR(255) NOT NULL, original_name VARCHAR(255) NOT NULL, byte_length BIGINT NOT NULL, width BIGINT NOT NULL, height BIGINT NOT NULL, source VARCHAR(32) NOT NULL, data LONGBLOB NOT NULL, thumb MEDIUMBLOB NULL, templates JSON NOT NULL, created_at DATETIME NOT NULL) ENGINE=InnoDB")
            .await
            .expect("create images");
        conn.exec("CREATE TABLE IF NOT EXISTS productions (id VARCHAR(64) PRIMARY KEY, order_number VARCHAR(64) NOT NULL, image_id VARCHAR(64) NULL, file_name VARCHAR(255) NOT NULL, data LONGBLOB NOT NULL, created_at DATETIME NOT NULL) ENGINE=InnoDB")
            .await
            .expect("create productions");
        conn.exec(&format!("DELETE FROM order_images WHERE order_number = '{TEST_ORDER}'"))
            .await
            .expect("cleanup images");
        conn.exec(&format!("DELETE FROM productions WHERE order_number = '{TEST_ORDER}'"))
            .await
            .expect("cleanup productions");
        conn.exec(&format!("DELETE FROM orders WHERE order_number = '{TEST_ORDER}'"))
            .await
            .expect("cleanup orders");
    }

    // ---------- 客服机：入库 + 推送 ----------
    let collector_root = std::env::temp_dir().join("mysql_live_collector");
    let _ = std::fs::remove_dir_all(&collector_root);
    let collector = Store::open(&collector_root).expect("collector store open");
    let png = tiny_png();
    let ingested = collector
        .ingest_image(
            TEST_ORDER,
            &png,
            "image/png",
            &[("模板爱心.png".to_string(), 2)],
            "test",
        )
        .expect("ingest");

    let mysql = MyClient::new(&config);
    let report = mysql.test().await.expect("mysql test");
    println!("[test] {report}");

    mysql.push_order(&collector, TEST_ORDER).await.expect("push order");

    // MySQL 侧验证：素材 + 模板份数
    let mut conn = mysql.connect().await.expect("connect");
    conn.exec(&format!("USE {DBNAME}")).await.expect("use db");
    let result = conn
        .query(&format!(
            "SELECT COUNT(*) AS n, MIN(templates) AS t FROM order_images WHERE order_number = '{TEST_ORDER}'"
        ))
        .await
        .expect("query images");
    let count: i64 = result
        .opt_bytes(0, "n")
        .expect("count col")
        .and_then(|b| String::from_utf8_lossy(&b).parse().ok())
        .expect("count parse");
    assert_eq!(count, 1, "MySQL 应有 1 张素材");
    let templates_json = result.str_at(0, "t").expect("templates");
    assert!(
        templates_json.contains("模板爱心.png") && templates_json.contains('2'),
        "模板 JSON 应含模板 id 与份数 2：{templates_json}"
    );

    // ---------- 制作机：拉取入库 ----------
    let maker_root = std::env::temp_dir().join("mysql_live_maker");
    let _ = std::fs::remove_dir_all(&maker_root);
    let maker = Store::open(&maker_root).expect("maker store open");

    let notices = mysql.pull_all(&maker, &maker_root).await.expect("maker pull");
    let notice = notices.iter().find(|n| n.order_number == TEST_ORDER).expect("应有订单通知");
    assert_eq!(notice.new_images, 1, "制作机应导入 1 张新素材");

    let detail = maker
        .get_order_by_number(TEST_ORDER)
        .expect("get order")
        .expect("订单应存在");
    assert_eq!(detail.images.len(), 1);
    assert_eq!(detail.images[0].id, ingested.image_id, "图片 ID 应双机一致");
    assert_eq!(detail.images[0].templates.len(), 1);
    assert_eq!(detail.images[0].templates[0].quantity, 2);
    assert!(
        std::path::Path::new(&detail.images[0].file_path).exists(),
        "素材应已落盘：{}",
        detail.images[0].file_path
    );
    // 水位应已记录（重复拉取无通知）
    let notices_again = mysql.pull_all(&maker, &maker_root).await.expect("maker pull again");
    assert!(
        !notices_again.iter().any(|n| n.order_number == TEST_ORDER),
        "水位去重后不应再有通知"
    );

    // ---------- 制作机：导出成品 → 客服机回拉 ----------
    let production_id = "prod_test_0001";
    mysql
        .put_production(production_id, TEST_ORDER, None, "成品.png", &png)
        .await
        .expect("put production");

    let notices = mysql.pull_all(&collector, &collector_root).await.expect("collector pull");
    let notice = notices.iter().find(|n| n.order_number == TEST_ORDER).expect("应有成品通知");
    assert_eq!(notice.new_productions, 1, "客服机应收 1 个成品");
    assert!(
        collector.production_exists(production_id).expect("production exists"),
        "成品记录应已入本地库"
    );
    let productions = collector.list_productions(TEST_ORDER).expect("list productions");
    assert_eq!(productions.len(), 1);
    assert!(std::path::Path::new(&productions[0].file_path).exists(), "成品文件应落盘");

    // ---------- 清理 ----------
    conn.exec(&format!("DELETE FROM order_images WHERE order_number = '{TEST_ORDER}'"))
        .await
        .expect("cleanup images");
    conn.exec(&format!("DELETE FROM productions WHERE order_number = '{TEST_ORDER}'"))
        .await
        .expect("cleanup productions");
    conn.exec(&format!("DELETE FROM orders WHERE order_number = '{TEST_ORDER}'"))
        .await
        .expect("cleanup orders");
    let result = conn
        .query(&format!("SELECT COUNT(*) AS n FROM orders WHERE order_number = '{TEST_ORDER}'"))
        .await
        .expect("count");
    let remaining: i64 = result
        .opt_bytes(0, "n")
        .expect("n col")
        .and_then(|b| String::from_utf8_lossy(&b).parse().ok())
        .expect("n parse");
    assert_eq!(remaining, 0, "测试数据应已清理");
    println!("[test] 全链路验证通过：建库建表 → 推单 → 拉单 → 成品回流 → 清理");
}
