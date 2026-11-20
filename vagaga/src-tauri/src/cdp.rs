//! 千帆客服工作台 CDP 注入器（Rust 版）。
//!
//! 周期扫描 `http://127.0.0.1:<port>/json/list`，对每个客服工作台页面建立
//! WebSocket 连接并注入 `assets/paidan_core.js`；页面内「进入排单」捕获的
//! 图片经 `qianfanBridge` binding 回流后写收件暂存并落库。
//!
//! 语义与 Flutter 注入器（desktop/paidan_cdp_injector.dart）一致：
//! 多 target 自动接入、失败 30s 退避、断线清理重连、无订单号跳过。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch, Mutex};
use tokio_tungstenite::tungstenite::{protocol::WebSocketConfig, Message};

use crate::store::{valid_layout_number, Store};

const BINDING_NAME: &str = "qianfanBridge";
const CAPTURE_WORLD: &str = "pic-paidan-capture";
const MAX_IMAGE_BYTES: usize = 512 * 1024 * 1024;
// CDP wraps the base64 payload in two JSON messages. Leave room for both envelopes.
const MAX_CAPTURE_MESSAGE: usize = MAX_IMAGE_BYTES.div_ceil(3) * 4 + 1024 * 1024;
const ATTACH_RETRY_BACKOFF: Duration = Duration::from_secs(30);
type Attached = HashMap<String, tokio::task::JoinHandle<()>>;

#[derive(Default)]
struct Frames {
    main: Option<String>,
    allowed: bool,
    worlds: HashMap<i64, String>,
}

impl Frames {
    fn observe(&mut self, message: &Value) {
        let params = &message["params"];
        match message["method"].as_str() {
            Some("Page.frameNavigated") if params["frame"]["parentId"].is_null() => {
                self.set_main(&params["frame"]);
            }
            Some("Runtime.executionContextCreated") => {
                let context = &params["context"];
                if context["name"] == CAPTURE_WORLD {
                    if let (Some(id), Some(frame)) = (
                        context["id"].as_i64(),
                        context["auxData"]["frameId"].as_str(),
                    ) {
                        self.worlds.insert(id, frame.to_owned());
                    }
                }
            }
            Some("Runtime.executionContextDestroyed") => {
                if let Some(id) = params["executionContextId"].as_i64() {
                    self.worlds.remove(&id);
                }
            }
            Some("Runtime.executionContextsCleared") => self.worlds.clear(),
            _ => {}
        }
    }

    fn set_main(&mut self, frame: &Value) {
        self.main = frame["id"].as_str().map(str::to_owned);
        self.allowed = frame["url"].as_str().is_some_and(is_workbench_url);
    }

    fn accepts(&self, params: &Value) -> bool {
        self.allowed
            && params["name"] == BINDING_NAME
            && self.main.as_ref().is_some_and(|main| {
                params["executionContextId"]
                    .as_i64()
                    .and_then(|id| self.worlds.get(&id))
                    == Some(main)
            })
    }
}

/// 注入器对外事件（前端提示 + 日志）。
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PaidanEvent {
    Ingested {
        order_number: String,
        image_id: String,
        scaled: bool,
    },
    Failed {
        order_number: String,
        detail: String,
    },
}

#[cfg(test)]
mod event_tests {
    use super::*;

    #[test]
    fn ingested_event_matches_frontend_field_names() {
        let event = PaidanEvent::Ingested {
            order_number: "ORDER-one".into(),
            image_id: "photo-one".into(),
            scaled: false,
        };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({
                "kind": "ingested", "orderNumber": "ORDER-one", "imageId": "photo-one", "scaled": false
            })
        );
    }

    #[test]
    fn failed_event_matches_frontend_field_names() {
        let event = PaidanEvent::Failed {
            order_number: "ORDER-one".into(),
            detail: "write failed".into(),
        };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({
                "kind": "failed", "orderNumber": "ORDER-one", "detail": "write failed"
            })
        );
    }

    #[test]
    fn capture_metadata_preserves_layout_number_as_a_string() {
        let captured_at = 1_800_000_000_123_i64;
        let payload = json!({
            "ts": captured_at,
            "context": { "layoutNumber": "ch-000Ab", "status": "待发货" }
        });
        assert_eq!(
            capture_metadata(&payload),
            Some(json!({
                "layoutNumber": "ch-000Ab",
                "layoutNumberCapturedAt": "2027-01-15T08:00:00.123Z",
                "status": "待发货"
            }).to_string())
        );
        assert_eq!(
            capture_metadata(&json!({"context": {"layoutNumber": "ch-"}})),
            None
        );
    }
}

pub struct Injector {
    pub store: Arc<Store>,
    pub core_script: String,
    pub port: u16,
    pub events_tx: mpsc::Sender<PaidanEvent>,
    pub shutdown: watch::Receiver<bool>,
    pub scan_interval: Duration,
}

impl Injector {
    pub async fn run(self) {
        let attached = Mutex::new(Attached::new());
        let failed_at: Arc<Mutex<HashMap<String, i64>>> = Arc::new(Mutex::new(HashMap::new()));
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .expect("构建 CDP HTTP 客户端失败");
        let mut interval = tokio::time::interval(self.scan_interval);
        let mut shutdown = self.shutdown;
        // 日志降噪：只在状态变化（断开/恢复）时打印，持续失败每 60 次（约 3 分钟）提醒一次
        let mut last_scan_ok = true;
        let mut fail_count: u64 = 0;
        loop {
            tokio::select! {
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() { break; }
                }
                _ = interval.tick() => {
                    if let Err(error) = scan_once(
                        &self.store,
                        &self.core_script,
                        self.port,
                        &client,
                        &attached,
                        &failed_at,
                        &self.events_tx,
                    )
                    .await
                    {
                        fail_count += 1;
                        if last_scan_ok {
                            eprintln!("[paidan-cdp] 扫描失败（将持续重试）: {error}");
                        } else if fail_count % 60 == 0 {
                            eprintln!(
                                "[paidan-cdp] 扫描失败已持续 {} 次（千帆未运行或未带调试端口 {}）",
                                fail_count, self.port
                            );
                        }
                        last_scan_ok = false;
                    } else {
                        if !last_scan_ok {
                            eprintln!("[paidan-cdp] 已恢复：千帆工作台可访问");
                        }
                        last_scan_ok = true;
                        fail_count = 0;
                    }
                }
            }
            if *shutdown.borrow() {
                break;
            }
        }
        for connection in attached.into_inner().into_values() {
            connection.abort();
        }
    }
}

fn is_workbench_url(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("walle.xiaohongshu.com")
            && url.port().is_none()
            && url.path().starts_with("/cstools/")
            && !url.path().starts_with("/cstools/login")
    })
}

fn local_debugger(address: &str) -> bool {
    reqwest::Url::parse(address).is_ok_and(|url| {
        url.scheme() == "ws"
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
            && url.username().is_empty()
            && url.password().is_none()
    })
}

fn is_workbench_target(target: &Value) -> bool {
    let url = target["url"].as_str().unwrap_or_default();
    target["type"] == "page"
        && is_workbench_url(url)
        && target["webSocketDebuggerUrl"]
            .as_str()
            .is_some_and(local_debugger)
}

async fn list_targets(client: &reqwest::Client, port: u16) -> Result<Vec<Value>, String> {
    let response = client
        .get(format!("http://127.0.0.1:{port}/json/list"))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status().as_u16() != 200 {
        return Err(format!("json/list 返回 {}", response.status()));
    }
    let body: Vec<Value> = response.json().await.map_err(|error| error.to_string())?;
    Ok(body.into_iter().filter(is_workbench_target).collect())
}

async fn scan_once(
    store: &Arc<Store>,
    core_script: &str,
    port: u16,
    client: &reqwest::Client,
    attached: &Mutex<Attached>,
    failed_at: &Mutex<HashMap<String, i64>>,
    events_tx: &mpsc::Sender<PaidanEvent>,
) -> Result<(), String> {
    let targets = list_targets(client, port).await?;
    let alive: std::collections::HashSet<String> = targets
        .iter()
        .filter_map(|target| target["id"].as_str().map(str::to_string))
        .collect();
    attached.lock().await.retain(|id, connection| {
        let keep = alive.contains(id) && !connection.is_finished();
        if !keep {
            connection.abort();
        }
        keep
    });

    for target in &targets {
        let Some(id) = target["id"].as_str().map(str::to_string) else {
            continue;
        };
        if attached.lock().await.contains_key(&id) {
            continue;
        }
        {
            let failed_guard = failed_at.lock().await;
            if let Some(at) = failed_guard.get(&id) {
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                if now_ms - at < ATTACH_RETRY_BACKOFF.as_millis() as i64 {
                    continue;
                }
            }
        }
        let title = target["title"].as_str().unwrap_or("未命名");
        let address = target["webSocketDebuggerUrl"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        match attach_target(store.clone(), events_tx.clone(), &address, core_script).await {
            Ok(connection) => {
                attached.lock().await.insert(id.clone(), connection);
                failed_at.lock().await.remove(&id);
                eprintln!("[paidan-cdp] 已接入: {title}");
            }
            Err(error) => {
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                failed_at.lock().await.insert(id.clone(), now_ms);
                eprintln!("[paidan-cdp] attach {title} 失败: {error}");
            }
        }
    }

    failed_at.lock().await.retain(|id, _| alive.contains(id));
    Ok(())
}

/// 读循环先于请求启动：响应按 id 配对，binding 回流交 handle_capture。
async fn attach_target(
    store: Arc<Store>,
    events_tx: mpsc::Sender<PaidanEvent>,
    address: &str,
    core_script: &str,
) -> Result<tokio::task::JoinHandle<()>, String> {
    let config = WebSocketConfig {
        max_message_size: Some(MAX_CAPTURE_MESSAGE),
        max_frame_size: Some(MAX_CAPTURE_MESSAGE),
        ..WebSocketConfig::default()
    };
    let (socket, _) = tokio::time::timeout(
        Duration::from_secs(6),
        tokio_tungstenite::connect_async_with_config(address, Some(config), false),
    )
    .await
    .map_err(|_| "连接工作台超时".to_string())?
    .map_err(|error| error.to_string())?;
    let (mut sink, mut stream) = socket.split();
    let pending: Arc<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    let reader_store = store.clone();
    let reader_events = events_tx.clone();
    let reader_pending = pending.clone();
    let frames = Arc::new(Mutex::new(Frames::default()));
    let reader_frames = frames.clone();
    let connection = tokio::spawn(async move {
        while let Some(message) = stream.next().await {
            let text = match message {
                Ok(Message::Text(text)) => text,
                Ok(Message::Close(_)) | Err(_) => break,
                _ => continue,
            };
            let Ok(message) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if let Some(id) = message["id"].as_u64() {
                if let Some(tx) = reader_pending.lock().await.remove(&id) {
                    let _ = tx.send(message);
                }
                continue;
            }
            if message["method"] == "Runtime.bindingCalled" {
                let accepted = reader_frames.lock().await.accepts(&message["params"]);
                if !accepted {
                    continue;
                }
                if let Some(payload) = message["params"]["payload"].as_str() {
                    handle_capture(&reader_store, &reader_events, payload).await;
                }
            } else {
                reader_frames.lock().await.observe(&message);
            }
        }
        reader_pending.lock().await.clear();
    });

    let setup = async {
        let mut id = 0;
        handshake_request(&mut sink, &mut id, &pending, "Runtime.enable", json!({})).await?;
        handshake_request(&mut sink, &mut id, &pending, "Page.enable", json!({})).await?;
        let tree =
            handshake_request(&mut sink, &mut id, &pending, "Page.getFrameTree", json!({})).await?;
        let frame = &tree["frameTree"]["frame"];
        let frame_id = frame["id"].as_str().ok_or("未找到工作台主页面")?;
        frames.lock().await.set_main(frame);
        handshake_request(
            &mut sink,
            &mut id,
            &pending,
            "Runtime.addBinding",
            json!({ "name": BINDING_NAME, "executionContextName": CAPTURE_WORLD }),
        )
        .await?;
        handshake_request(
            &mut sink,
            &mut id,
            &pending,
            "Page.addScriptToEvaluateOnNewDocument",
            json!({ "source": core_script, "worldName": CAPTURE_WORLD }),
        )
        .await?;
        let context = handshake_request(
            &mut sink,
            &mut id,
            &pending,
            "Page.createIsolatedWorld",
            json!({ "frameId": frame_id, "worldName": CAPTURE_WORLD }),
        )
        .await?;
        let context_id = context["executionContextId"]
            .as_i64()
            .ok_or("未找到排单脚本上下文")?;
        frames
            .lock()
            .await
            .worlds
            .insert(context_id, frame_id.to_owned());
        handshake_request(
            &mut sink,
            &mut id,
            &pending,
            "Runtime.evaluate",
            json!({ "expression": core_script, "contextId": context_id }),
        )
        .await?;
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = setup {
        connection.abort();
        return Err(error);
    }
    Ok(connection)
}

/// 握手期请求：发送后等待按 id 配对的响应（binding 回流由读循环分发）。
async fn handshake_request(
    sink: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Message,
    >,
    next_id: &mut u64,
    pending: &Arc<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Value>>>>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    *next_id += 1;
    let id = *next_id;
    let (tx, rx) = tokio::sync::oneshot::channel();
    pending.lock().await.insert(id, tx);
    sink.send(Message::Text(
        json!({ "id": id, "method": method, "params": params }).to_string(),
    ))
    .await
    .map_err(|error| error.to_string())?;
    let result = tokio::time::timeout(Duration::from_secs(6), rx)
        .await
        .map_err(|_| format!("{method} 等待响应超时"))?
        .map_err(|error| error.to_string())?;
    if !result["error"].is_null() {
        return Err(format!("{method} 调用失败: {}", result["error"]));
    }
    Ok(result["result"].clone())
}

fn capture_metadata(payload: &Value) -> Option<String> {
    let context = &payload["context"];
    let mut fields = serde_json::Map::new();
    for key in ["status", "amount", "specText"] {
        if let Some(value) = context[key].as_str().filter(|value| !value.is_empty()) {
            fields.insert(key.into(), Value::String(value.into()));
        }
    }
    if let Some(number) = context["layoutNumber"]
        .as_str()
        .filter(|number| valid_layout_number(number))
    {
        let captured_at = payload["ts"]
            .as_i64()
            .and_then(DateTime::from_timestamp_millis)
            .unwrap_or_else(Utc::now);
        fields.insert("layoutNumber".into(), Value::String(number.into()));
        fields.insert(
            "layoutNumberCapturedAt".into(),
            Value::String(captured_at.to_rfc3339_opts(SecondsFormat::Millis, true)),
        );
    }
    (!fields.is_empty()).then(|| Value::Object(fields).to_string())
}

async fn handle_capture(store: &Arc<Store>, events_tx: &mpsc::Sender<PaidanEvent>, payload: &str) {
    let parsed: Value = match serde_json::from_str(payload) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("[paidan-cdp] payload 解析失败: {error}");
            return;
        }
    };
    if parsed["type"] != "paidan.capture" {
        return;
    }
    let order_number = parsed["context"]["orderNo"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_string();
    if order_number.is_empty() {
        eprintln!("[paidan-cdp] 未识别到订单号，跳过入库");
        return;
    }
    let metadata = capture_metadata(&parsed);
    let Some(encoded) = parsed["b64"].as_str() else {
        eprintln!("[paidan-cdp] payload 缺少图片数据");
        return;
    };
    use base64::Engine as _;
    let bytes = match base64::engine::general_purpose::STANDARD.decode(encoded) {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!("[paidan-cdp] 图片 base64 解码失败: {error}");
            return;
        }
    };
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        eprintln!("[paidan-cdp] 图片字节越界: {}", bytes.len());
        return;
    }
    let mime = parsed["mime"].as_str().unwrap_or("image/png");
    let scaled = parsed["scaled"].as_bool().unwrap_or(false);
    let quality = store.qiniu_enabled().then(|| {
        use crate::qiniu_store::CaptureQuality;
        match (scaled, parsed["sourceQuality"].as_str()) {
            (true, _) | (_, Some("scaled")) => CaptureQuality::Scaled,
            (false, Some("original")) => CaptureQuality::Original,
            _ => CaptureQuality::Unknown,
        }
    });
    let templates: Vec<(String, i64)> = parsed["templates"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item["id"].as_str()?.to_string();
                    let qty = item["qty"].as_i64().unwrap_or(1);
                    if qty < 1 {
                        None
                    } else {
                        Some((id, qty))
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    // 先写 incoming 暂存，入库成功后删除；失败保留现场供人工处理。
    let staged_path = store.incoming_directory().join(format!(
        "paidan-{}-{}.bin",
        chrono::Utc::now().timestamp_millis(),
        rand::Rng::gen::<u32>(&mut rand::thread_rng())
    ));
    let staged =
        match std::fs::create_dir_all(staged_path.parent().expect("incoming file has a parent"))
            .and_then(|()| std::fs::write(&staged_path, &bytes))
        {
            Ok(_) => true,
            Err(error) => {
                eprintln!("[paidan-cdp] 暂存写入失败: {error}");
                false
            }
        };

    match store.ingest_with_sync(
        &order_number,
        &bytes,
        mime,
        &templates,
        "千帆",
        quality,
        metadata.as_deref(),
    ) {
        Ok(ingested) => {
            if staged {
                let _ = std::fs::remove_file(&staged_path);
            }
            let _ = events_tx
                .send(PaidanEvent::Ingested {
                    order_number: ingested.order_number,
                    image_id: ingested.image_id,
                    scaled,
                })
                .await;
        }
        Err(error) => {
            // Box<dyn Error> 非 Send，先转字符串再跨 await 发送。
            let detail = format!("{error}（暂存保留在 incoming/）");
            let _ = events_tx
                .send(PaidanEvent::Failed {
                    order_number,
                    detail,
                })
                .await;
        }
    }
}
