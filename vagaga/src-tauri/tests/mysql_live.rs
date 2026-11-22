//! Run with a dedicated test database configured via VAGAGA_TEST_MYSQL_CONFIG.
use vagaga_lib::mysql::{MyClient, MysqlConfig, SharedOrder};

#[tokio::test]
#[ignore = "requires a dedicated MySQL test database"]
async fn synchronizes_order_fields_and_image_references_with_conflict_protection() {
    let config_path =
        std::env::var_os("VAGAGA_TEST_MYSQL_CONFIG").expect("set VAGAGA_TEST_MYSQL_CONFIG");
    let config: MysqlConfig = serde_json::from_slice(&std::fs::read(config_path).unwrap()).unwrap();
    let client = MyClient::new(&config);
    let mut index = client.order_index().await.unwrap();
    let target = vagaga_lib::store::random_hex_pub(32);
    let order = SharedOrder {
        number: "TEST-MYSQL-SYNC".into(),
        operation_id: vagaga_lib::store::random_hex_pub(16),
        payload: serde_json::json!({
            "metadata": { "layoutNumber": "ch-017", "amount": "15.00" },
            "assets": [{ "objectName": "12345678901234567890123456789012.png" }]
        })
        .to_string(),
        completed: false,
    };
    assert!(index.write(&target, None, &order).await.unwrap());
    assert!(index.write(&target, None, &order).await.unwrap());
    let mut completed = order.clone();
    completed.operation_id = vagaga_lib::store::random_hex_pub(16);
    completed.completed = true;
    assert!(!index
        .write(&target, Some("stale"), &completed)
        .await
        .unwrap());
    assert!(index
        .write(&target, Some(&order.operation_id), &completed)
        .await
        .unwrap());
    assert!(!index
        .write(&target, Some(&completed.operation_id), &order)
        .await
        .unwrap());
    let saved = index.get(&target, &order.number).await.unwrap().unwrap();
    assert_eq!(saved.operation_id, completed.operation_id);
    assert!(saved.completed);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&saved.payload).unwrap(),
        serde_json::from_str::<serde_json::Value>(&order.payload).unwrap()
    );
    assert_eq!(index.read(&target).await.unwrap().len(), 1);
    assert!(index.read("other-storage").await.unwrap().is_empty());
}

#[tokio::test]
#[ignore = "requires a dedicated MySQL test database"]
async fn only_one_concurrent_writer_can_replace_the_same_order() {
    let path = std::env::var_os("VAGAGA_TEST_MYSQL_CONFIG").expect("set VAGAGA_TEST_MYSQL_CONFIG");
    let config = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let client = MyClient::new(&config);
    let mut first = client.order_index().await.unwrap();
    let mut second = client.order_index().await.unwrap();
    let storage = vagaga_lib::store::random_hex_pub(32);
    let original = SharedOrder {
        number: "TEST-CONCURRENT".into(),
        operation_id: vagaga_lib::store::random_hex_pub(16),
        payload: "{}".into(),
        completed: false,
    };
    assert!(first.write(&storage, None, &original).await.unwrap());
    let mut left = original.clone();
    left.operation_id = vagaga_lib::store::random_hex_pub(16);
    let mut right = original.clone();
    right.operation_id = vagaga_lib::store::random_hex_pub(16);
    right.completed = true;
    let expected = Some(original.operation_id.as_str());
    let (one, two) = tokio::join!(
        first.write(&storage, expected, &left),
        second.write(&storage, expected, &right),
    );
    let one = one.unwrap();
    assert_ne!(one, two.unwrap());
    let winner = if one { left } else { right };
    assert!(second.write(&storage, expected, &winner).await.unwrap());
    assert_eq!(
        first.get(&storage, &winner.number).await.unwrap(),
        Some(winner)
    );
}
