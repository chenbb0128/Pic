//! 用内嵌 fake CDP 服务端验证注入器协议闭环：
//! /json/list 发现 → WS 注入 → bindingCalled 回流 → 捕获入库。

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use vagaga_lib::store::Store;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

struct FakeCdp {
    port: u16,
}

impl FakeCdp {
    async fn start(capture_payload: String) -> Self {
        let ws_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind ws");
        let http_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind http");
        let http_port = http_listener.local_addr().expect("local addr").port();
        let ws_port = ws_listener.local_addr().expect("local addr").port();

        // HTTP /json/list：返回指向 WS 端口的目标清单
        let http_task = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = http_listener.accept().await else {
                    return;
                };
                let mut buffer = Vec::new();
                // 读到请求头结束（\r\n\r\n）
                let mut byte = [0u8; 1];
                loop {
                    let n = socket.read(&mut byte).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buffer.push(byte[0]);
                    if buffer.ends_with(b"\r\n\r\n") {
                        break;
                    }
                }
                let body = json_list_body(ws_port);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });

        // WebSocket 端：只有隔离的工作台主页面能够回流捕获。
        let ws_task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = ws_listener.accept().await else {
                    return;
                };
                let payload = capture_payload.clone();
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else {
                        return;
                    };
                    while let Some(Ok(Message::Text(text))) = ws.next().await {
                        let Ok(message) = serde_json::from_str::<serde_json::Value>(&text) else {
                            continue;
                        };
                        let id = message.get("id").and_then(|v| v.as_u64());
                        let method = message["method"].as_str().unwrap_or_default();
                        if let Some(id) = id {
                            let result = match method {
                                "Page.getFrameTree" => serde_json::json!({"frameTree":{"frame":{
                                    "id":"main","url":"https://walle.xiaohongshu.com/cstools/seller/dashboard"
                                }}}),
                                "Page.createIsolatedWorld" => {
                                    serde_json::json!({"executionContextId":37})
                                }
                                "Runtime.addBinding" => {
                                    assert_eq!(
                                        message["params"]["executionContextName"],
                                        "pic-paidan-capture"
                                    );
                                    serde_json::json!({})
                                }
                                _ => serde_json::json!({}),
                            };
                            let _ = ws
                                .send(Message::Text(
                                    serde_json::json!({ "id": id, "result": result }).to_string(),
                                ))
                                .await;
                        }
                        if method == "Runtime.evaluate" {
                            assert_eq!(message["params"]["contextId"], 37);
                            let unrelated = capture_payload_for_test("UNTRUSTED");
                            let _ = ws.send(Message::Text(serde_json::json!({
                                "method": "Runtime.bindingCalled",
                                "params": {"name":"qianfanBridge","executionContextId":3,"payload":unrelated},
                            }).to_string())).await;
                            let _ = ws
                                .send(Message::Text(
                                    serde_json::json!({
                                        "method": "Runtime.bindingCalled",
                                        "params": { "name": "qianfanBridge", "executionContextId":37, "payload": payload }
                                    })
                                    .to_string(),
                                ))
                                .await;
                        }
                    }
                });
            }
        });

        tokio::spawn(async move {
            let _ = http_task.await;
            let _ = ws_task.await;
        });

        Self { port: http_port }
    }
}

fn json_list_body(ws_port: u16) -> String {
    serde_json::json!([
        {
            "id": "t1",
            "type": "page",
            "title": "颜-工作台",
            "url": "https://walle.xiaohongshu.com/cstools/seller/dashboard",
            "webSocketDebuggerUrl": format!("ws://127.0.0.1:{ws_port}/devtools/t1"),
        }
    ])
    .to_string()
}

static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

const PNG_BYTES: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
];

fn capture_payload_for_test(order_no: &str) -> String {
    use base64::Engine as _;
    serde_json::json!({
        "type": "paidan.capture",
        "mime": "image/png",
        "b64": base64::engine::general_purpose::STANDARD.encode(PNG_BYTES),
        "scaled": false,
        "ts": 1,
        "context": { "orderNo": order_no },
        "templates": [{ "id": "模板爱心.png", "qty": 2 }],
    })
    .to_string()
}

#[tokio::test]
async fn 捕获经fake_cdp回流后入库() {
    let mut payload: serde_json::Value =
        serde_json::from_str(&capture_payload_for_test("610")).unwrap();
    // A single CDP frame above the upstream library's 16 MiB default must still arrive.
    payload["padding"] = "x".repeat(17 * 1024 * 1024).into();
    let server = FakeCdp::start(payload.to_string()).await;
    let data_root = std::env::temp_dir().join(format!(
        "paidan-cdp-test-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    ));
    let store = Arc::new(Store::open(&data_root).expect("open store"));

    let (events_tx, mut events_rx) = mpsc::channel::<vagaga_lib::cdp::PaidanEvent>(16);
    let (_stop, shutdown) = tokio::sync::watch::channel(false);
    let injector = vagaga_lib::cdp::Injector {
        store: store.clone(),
        core_script: "window.__test = true;".to_string(),
        port: server.port,
        events_tx,
        shutdown,
        scan_interval: Duration::from_millis(100),
    };
    tokio::spawn(injector.run());

    // 等待入库事件
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let ingested = loop {
        assert!(tokio::time::Instant::now() < deadline, "等待入库事件超时");
        let event = tokio::time::timeout(Duration::from_secs(2), events_rx.recv())
            .await
            .expect("事件等待超时")
            .expect("channel 关闭");
        if let vagaga_lib::cdp::PaidanEvent::Ingested {
            order_number,
            image_id,
            scaled,
        } = event
        {
            assert_eq!(order_number, "610");
            assert!(!scaled);
            break image_id;
        }
    };

    let orders = store.list_orders().expect("list");
    assert_eq!(orders.len(), 1);
    assert_eq!(orders[0].order_number, "610");
    assert_eq!(orders[0].image_count, 1);
    assert_eq!(orders[0].task_count, 2);
    let detail = store.get_order(&orders[0].id).expect("get").expect("存在");
    let image = &detail.images[0];
    assert_eq!(image.id, ingested);
    assert_eq!(image.source, "千帆");
    assert_eq!(image.templates.len(), 1);
    assert_eq!(image.templates[0].quantity, 2);
    // 暂存文件入库成功后已清理
    assert!(
        store
            .incoming_directory()
            .read_dir()
            .map(|mut d| d.next().is_none())
            .unwrap_or(true),
        "incoming 目录应为空"
    );
}

#[tokio::test]
async fn 无订单号跳过入库() {
    let server = FakeCdp::start(capture_payload_for_test("")).await;
    let data_root = std::env::temp_dir().join(format!(
        "paidan-cdp-test-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    ));
    let store = Arc::new(Store::open(&data_root).expect("open store"));

    let (events_tx, _events_rx) = mpsc::channel::<vagaga_lib::cdp::PaidanEvent>(16);
    let (_stop, shutdown) = tokio::sync::watch::channel(false);
    let injector = vagaga_lib::cdp::Injector {
        store: store.clone(),
        core_script: "window.__test = true;".to_string(),
        port: server.port,
        events_tx,
        shutdown,
        scan_interval: Duration::from_millis(100),
    };
    tokio::spawn(injector.run());

    // 给注入器足够时间处理（应静默跳过，无事件、无订单）
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(store.list_orders().expect("list").is_empty());
}

use std::time::Duration;
