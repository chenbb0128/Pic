//! Run with a dedicated test database configured via VAGAGA_TEST_MYSQL_CONFIG.
use vagaga_lib::mysql::{MyClient, MysqlConfig, SharedOrder};

#[tokio::test]
#[ignore = "requires a dedicated MySQL test database"]
async fn synchronizes_fields_and_completion_without_rolling_back_versions() {
    let config_path = std::env::var_os("VAGAGA_TEST_MYSQL_CONFIG").expect("set VAGAGA_TEST_MYSQL_CONFIG");
    let config: MysqlConfig = serde_json::from_slice(&std::fs::read(config_path).unwrap()).unwrap();
    let client = MyClient::new(&config);
    let mut index = client.order_index().await.unwrap();
    let target = vagaga_lib::store::random_hex_pub(32);
    let order = SharedOrder {
        number: "TEST-MYSQL-SYNC".into(), revision: 1,
        operation_id: vagaga_lib::store::random_hex_pub(16),
        metadata: Some(serde_json::json!({ "layoutNumber": "ch-017", "amount": "15.00" })),
        completed: false,
    };
    assert!(index.write(&target, &order).await.unwrap());
    assert!(!index.write(&target, &order).await.unwrap());
    let mut completed = order.clone();
    completed.revision = 2;
    completed.operation_id = vagaga_lib::store::random_hex_pub(16);
    completed.completed = true;
    assert!(index.write(&target, &completed).await.unwrap());
    assert!(!index.write(&target, &order).await.unwrap());
    assert_eq!(index.read(&target).await.unwrap().remove(&order.number), Some(completed));
    assert!(index.read("other-storage").await.unwrap().is_empty());
}
