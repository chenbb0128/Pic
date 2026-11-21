use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use futures_util::{stream, StreamExt};
use serde::Serialize;
use tauri::{Emitter, State};
use tokio::sync::{Notify, Semaphore};

use crate::qiniu_settings::{self, Settings};
use crate::qiniu_store::{retry_at, Mutation, SnapshotJob, UploadJob};
use crate::qiniu_transport::{self, Client, Device, Error, RemoteAsset, UploadRequest};
use crate::{store::Store, AppState};

const LIMIT: usize = 2;

pub(crate) struct Sync {
    pub settings: Settings,
    client: Option<Client>,
    push: Notify,
    pull: Notify,
    transfer_slots: Semaphore,
    last_push_error: Mutex<Option<String>>,
    last_pull_error: Mutex<Option<String>>,
    validated: Mutex<HashMap<PathBuf, FileStamp>>,
}

#[derive(PartialEq)]
struct FileStamp {
    bytes: u64,
    modified: SystemTime,
    sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    enabled: bool,
    legacy_enabled: bool,
    active: bool,
    role: Option<String>,
    workspace_id: Option<String>,
    device_id: Option<String>,
    last_error: Option<String>,
    pending: u64,
    failed: u64,
    downloading: u64,
}

impl Sync {
    pub(crate) fn new(settings: Settings, secret: &[u8]) -> Self {
        let (client, error) = if settings.enabled {
            match qiniu_settings::client(&settings, secret) {
                Ok(client) => (Some(client), None),
                Err(error) => (None, Some(error)),
            }
        } else {
            (None, None)
        };
        Self {
            settings,
            client,
            push: Notify::new(),
            pull: Notify::new(),
            transfer_slots: Semaphore::new(LIMIT),
            last_push_error: Mutex::new(error),
            last_pull_error: Mutex::new(None),
            validated: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn legacy(&self) -> bool {
        !self.settings.enabled && !self.settings.has_token
    }

    pub(crate) fn wake(&self) {
        self.push.notify_one();
        self.pull.notify_one();
    }

    pub(crate) fn status(&self, store: &Store) -> Result<Status, String> {
        let (pending, failed, downloading, last_error) = store.qiniu_counts().map_err(str_error)?;
        Ok(Status {
            enabled: self.settings.enabled,
            legacy_enabled: self.legacy(),
            active: self.client.is_some(),
            role: self.settings.role.clone(),
            workspace_id: self.settings.workspace_id.clone(),
            device_id: self.settings.device_id.clone(),
            last_error: self
                .last_push_error
                .lock()
                .unwrap()
                .clone()
                .or_else(|| self.last_pull_error.lock().unwrap().clone())
                .or(last_error),
            pending,
            failed,
            downloading,
        })
    }

    pub(crate) fn start(self: &Arc<Self>, app: tauri::AppHandle, store: Arc<Store>, root: PathBuf) {
        let Some(client) = self.client.clone() else {
            return;
        };
        let sync = self.clone();
        let pull_store = store.clone();
        let pull_root = root.clone();
        let pull_client = client.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let result = sync
                    .pull_cycle(
                        &pull_client,
                        &pull_store,
                        &pull_root,
                        |number, images, productions| {
                            let _ = app.emit("paidan:cloud-imported", serde_json::json!({
                        "orderNumber": number, "newImages": images, "newProductions": productions,
                    }));
                        },
                    )
                    .await;
                record_cycle_error(&sync.last_pull_error, &pull_root, "拉取", result);
                tokio::select! {
                    _ = sync.pull.notified() => {},
                    _ = tokio::time::sleep(Duration::from_secs(sync.settings.poll_seconds.clamp(10, 60))) => {},
                }
            }
        });
        let sync = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let result = sync.push_cycle(&client, &store, &root).await;
                record_cycle_error(&sync.last_push_error, &root, "推送", result);
                tokio::select! {
                    _ = sync.push.notified() => {},
                    _ = tokio::time::sleep(Duration::from_secs(5)) => {},
                }
            }
        });
    }

    fn verify_device(&self, device: &Device) -> Result<(), String> {
        if self.settings.workspace_id.as_deref() != Some(device.workspace_id.as_str())
            || self.settings.device_id.as_deref() != Some(device.device_id.as_str())
            || self.settings.role.as_deref() != Some(device.role.as_str())
        {
            return Err("设备或权限已变化，请在设置中重新验证并重启程序".into());
        }
        Ok(())
    }

    async fn push_cycle(&self, client: &Client, store: &Store, root: &Path) -> Result<(), String> {
        let uploads = store.qiniu_due_uploads().map_err(str_error)?;
        let mutations = store.qiniu_due_mutations().map_err(str_error)?;
        if uploads.is_empty() && mutations.is_empty() {
            return Ok(());
        }
        let device = client.device().await.map_err(str_error)?;
        self.verify_device(&device)?;
        // Publish versioned edits before starting new uploads from this machine.
        for task in mutations {
            let result = match task.operation {
                Mutation::Templates {
                    image_id,
                    templates,
                } => {
                    client
                        .patch_templates(
                            &task.order_number,
                            &image_id,
                            task.version,
                            &task.id,
                            &templates,
                        )
                        .await
                }
                Mutation::DeleteImage { image_id } => {
                    client
                        .delete_image(&task.order_number, &image_id, task.version, &task.id)
                        .await
                }
                Mutation::DeleteOrder => {
                    client
                        .delete_order(&task.order_number, task.version, &task.id)
                        .await
                }
            };
            match result {
                Ok(committed) => {
                    store
                        .qiniu_mutation_done(&task.id, committed)
                        .map_err(str_error)?;
                    self.pull.notify_one();
                }
                Err(error) => {
                    let conflict = error.is_conflict();
                    let message = if conflict {
                        "此订单已在另一端更新，本次修改保留在本机。同步最新版本后可重新提交"
                            .to_string()
                    } else {
                        error.to_string()
                    };
                    log(root, "订单更新失败", &task.order_number, &task.id, &message);
                    store
                        .qiniu_mutation_failed(
                            &task.id,
                            &message,
                            retry_at(task.attempts, error.retryable()),
                            conflict || !error.retryable(),
                        )
                        .map_err(str_error)?;
                    if conflict {
                        self.pull.notify_one();
                    }
                }
            }
        }
        let max = device.max_file_bytes;
        stream::iter(uploads)
            .for_each_concurrent(LIMIT, |job| async move {
                let id = job.id.clone();
                let number = job.order_number.clone();
                let attempts = job.attempts;
                match store.qiniu_begin_upload(&id) {
                    Ok(true) => {}
                    Ok(false) => return,
                    Err(error) => {
                        log(root, "读取上传任务失败", &number, &id, &str_error(error));
                        return;
                    }
                }
                let start = std::time::Instant::now();
                log(root, "开始上传", &number, &id, "");
                match self.upload_one(client, store, root, job, max).await {
                    Ok(()) => {
                        log(
                            root,
                            "上传完成",
                            &number,
                            &id,
                            &format!("{} ms", start.elapsed().as_millis()),
                        );
                        self.pull.notify_one();
                        self.push.notify_one();
                    }
                    Err((message, retryable)) => {
                        log(root, "上传失败", &number, &id, &message);
                        if let Err(error) =
                            store.qiniu_upload_failed(&id, &message, retry_at(attempts, retryable))
                        {
                            log(
                                root,
                                "保存上传失败状态失败",
                                &number,
                                &id,
                                &str_error(error),
                            );
                        }
                    }
                }
            })
            .await;
        Ok(())
    }

    async fn upload_one(
        &self,
        client: &Client,
        store: &Store,
        root: &Path,
        job: UploadJob,
        max: u64,
    ) -> Result<(), (String, bool)> {
        let _slot = self
            .transfer_slots
            .acquire()
            .await
            .expect("transfer semaphore is open");
        let size = std::fs::metadata(&job.path).map_err(local_error)?.len();
        if size == 0 {
            return Err(("本地文件为空".into(), false));
        }
        if size > max {
            return Err((
                format!(
                    "文件超过七牛同步上限（{} MiB），文件已保存在本机",
                    max / (1024 * 1024)
                ),
                false,
            ));
        }
        let hash = qiniu_transport::hash_file(&job.path)
            .await
            .map_err(network_error)?;
        let request: UploadRequest = if let Some(frozen) = &job.request {
            let request: UploadRequest = serde_json::from_str(frozen).map_err(local_error)?;
            if request.sha256 != hash.sha256 || request.byte_length != hash.byte_length {
                return Err(("原文件已改变，请重新排单或导出".into(), false));
            }
            request
        } else {
            let (_, mime) =
                file_format(&job.path).ok_or_else(|| ("不支持的文件格式".into(), false))?;
            let (width, height) = if job.kind == "production" {
                let path = job.path.clone();
                tokio::task::spawn_blocking(move || image::image_dimensions(path))
                    .await
                    .map_err(local_error)?
                    .map_err(local_error)?
            } else {
                (job.width, job.height)
            };
            let file_name = if job.file_name.is_empty() {
                let archived = job
                    .path
                    .file_name()
                    .and_then(|part| part.to_str())
                    .unwrap_or("成品.png");
                archived
                    .strip_prefix(&format!("{}_", job.id))
                    .unwrap_or(archived)
                    .to_owned()
            } else {
                job.file_name
            };
            let request = UploadRequest {
                request_id: job.id.clone(),
                asset_id: job.id.clone(),
                kind: job.kind,
                order_number: job.order_number,
                file_name,
                mime: mime.to_owned(),
                byte_length: hash.byte_length,
                width,
                height,
                sha256: hash.sha256,
                etag: hash.etag,
                templates: store.qiniu_upload_templates(&job.id).map_err(local_error)?,
                source_image_id: job.source_image_id,
                metadata: job.metadata,
            };
            store
                .qiniu_save_upload_request(&job.id, &request)
                .map_err(local_error)?;
            request
        };
        let checkpoint_dir = root.join("qiniu-upload");
        std::fs::create_dir_all(&checkpoint_dir).map_err(local_error)?;
        let checkpoint = checkpoint_dir.join(format!("{}.json", job.id));
        client
            .upload(&request, &job.path, &checkpoint)
            .await
            .map_err(network_error)?;
        store.qiniu_upload_done(&request).map_err(local_error)?;
        Ok(())
    }

    async fn pull_cycle(
        &self,
        client: &Client,
        store: &Store,
        root: &Path,
        received: impl Fn(&str, usize, usize) + std::marker::Sync,
    ) -> Result<(), String> {
        let device = client.device().await.map_err(str_error)?;
        self.verify_device(&device)?;
        let mut cursor: Option<String> = None;
        loop {
            let page = client.orders(cursor.as_deref()).await.map_err(str_error)?;
            for item in page.orders {
                if store
                    .qiniu_needs_snapshot(&item.order_number, item.version)
                    .map_err(str_error)?
                {
                    match client.order(&item.order_number).await {
                        Ok(snapshot) => store.qiniu_stage_snapshot(&snapshot).map_err(str_error)?,
                        Err(error) => log(
                            root,
                            "读取订单失败",
                            &item.order_number,
                            "",
                            &str_error(error),
                        ),
                    }
                }
            }
            if let Some(next) = page.next {
                if cursor.as_ref().is_some_and(|previous| previous >= &next) {
                    return Err("服务端返回了无效的订单分页位置".into());
                }
                cursor = Some(next);
            } else {
                break;
            }
        }
        let jobs = store.qiniu_due_snapshots().map_err(str_error)?;
        let count = jobs.len();
        let received = &received;
        stream::iter(jobs)
            .for_each_concurrent(LIMIT, |job| async move {
                let number = job.order.order_number.clone();
                let attempts = job.attempts;
                match self.apply_one(client, store, root, job).await {
                    Ok((images, productions)) => {
                        if images + productions > 0 {
                            received(&number, images, productions);
                        }
                    }
                    Err((message, retryable)) => {
                        log(root, "下载或导入失败", &number, "", &message);
                        if let Err(error) = store.qiniu_snapshot_failed(
                            &number,
                            &message,
                            retry_at(attempts, retryable),
                        ) {
                            log(root, "保存下载失败状态失败", &number, "", &str_error(error));
                        }
                    }
                }
            })
            .await;
        if count == LIMIT {
            self.pull.notify_one();
        }
        Ok(())
    }

    async fn apply_one(
        &self,
        client: &Client,
        store: &Store,
        root: &Path,
        job: SnapshotJob,
    ) -> Result<(usize, usize), (String, bool)> {
        let mut files = Vec::new();
        if !job.order.deleted {
            for asset in job.order.assets.iter().filter(|asset| !asset.deleted) {
                let _slot = self
                    .transfer_slots
                    .acquire()
                    .await
                    .expect("transfer semaphore is open");
                let (file, thumbnail) = self
                    .materialize(client, store, root, &job.order.order_number, asset)
                    .await?;
                files.push((asset.id.clone(), file, thumbnail));
            }
        }
        store
            .qiniu_apply_snapshot(&job.order, &files)
            .map_err(local_error)
    }

    async fn valid_file(&self, path: &Path, asset: &RemoteAsset) -> bool {
        let Ok(meta) = std::fs::metadata(path) else {
            return false;
        };
        if !meta.is_file() || meta.len() != asset.byte_length {
            return false;
        }
        let stamp = meta.modified().ok().map(|modified| FileStamp {
            bytes: meta.len(),
            modified,
            sha256: asset.sha256.clone(),
        });
        if let Some(stamp) = &stamp {
            if self.validated.lock().unwrap().get(path) == Some(stamp) {
                return true;
            }
        }
        let valid = qiniu_transport::hash_file(path)
            .await
            .is_ok_and(|hash| hash.byte_length == asset.byte_length && hash.sha256 == asset.sha256);
        if valid {
            if let Some(stamp) = stamp {
                self.validated
                    .lock()
                    .unwrap()
                    .insert(path.to_owned(), stamp);
            }
        }
        valid
    }

    async fn materialize(
        &self,
        client: &Client,
        store: &Store,
        root: &Path,
        number: &str,
        asset: &RemoteAsset,
    ) -> Result<(PathBuf, Option<PathBuf>), (String, bool)> {
        let extension = match asset.mime.as_str() {
            "image/jpeg" => "jpg",
            "image/png" => "png",
            "image/webp" => "webp",
            "image/gif" => "gif",
            _ => return Err(("服务器返回了不支持的文件格式".into(), false)),
        };
        if asset.id.len() != 32 || !asset.id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(("服务器返回了无效的资源 ID".into(), false));
        }
        let folder = match asset.kind.as_str() {
            "original" => "images",
            "production" => "productions",
            _ => return Err(("服务器返回了无效的资源类型".into(), false)),
        };
        let media_root = root.join(folder);
        let default_path = media_root
            .join("qiniu")
            .join(format!("{}.{extension}", asset.id));
        let existing = store
            .qiniu_asset_path(&asset.id, &asset.kind)
            .map_err(local_error)?
            .map(PathBuf::from);
        let path = match existing {
            Some(path) if path.starts_with(&media_root) && self.valid_file(&path, asset).await => {
                path
            }
            _ => {
                if !self.valid_file(&default_path, asset).await {
                    log(root, "开始下载", number, &asset.id, "");
                    client
                        .download(asset, &default_path)
                        .await
                        .map_err(network_error)?;
                    log(root, "下载完成", number, &asset.id, "");
                }
                default_path
            }
        };
        let thumbnail = if asset.kind == "original" {
            let copy = path.clone();
            tokio::task::spawn_blocking(move || thumbnail(&copy))
                .await
                .map_err(local_error)?
        } else {
            None
        };
        Ok((path, thumbnail))
    }
}

fn thumbnail(path: &Path) -> Option<PathBuf> {
    let thumb = path.with_extension("thumb.jpg");
    if thumb.is_file() {
        return Some(thumb);
    }
    let image = image::open(path).ok()?;
    image
        .thumbnail(320, 320)
        .to_rgb8()
        .save_with_format(&thumb, image::ImageFormat::Jpeg)
        .ok()?;
    Some(thumb)
}

fn file_format(path: &Path) -> Option<(&'static str, &'static str)> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Some(("jpg", "image/jpeg")),
        "png" => Some(("png", "image/png")),
        "webp" => Some(("webp", "image/webp")),
        "gif" => Some(("gif", "image/gif")),
        _ => None,
    }
}

fn str_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn local_error(error: impl std::fmt::Display) -> (String, bool) {
    (format!("本地文件或数据库操作失败：{error}"), true)
}

fn network_error(error: Error) -> (String, bool) {
    (error.to_string(), error.retryable())
}

fn record_cycle_error(
    slot: &Mutex<Option<String>>,
    root: &Path,
    stage: &str,
    result: Result<(), String>,
) {
    let next = result.err();
    let mut previous = slot.lock().unwrap();
    if next != *previous {
        if let Some(error) = &next {
            log(root, stage, "", "", error);
        }
        *previous = next;
    }
}

fn log(root: &Path, stage: &str, number: &str, id: &str, detail: &str) {
    if let Ok(mut out) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("qiniu-sync.log"))
    {
        // Network errors are sanitized by the transport. Never add request bodies or URLs here.
        let _ = writeln!(
            out,
            "{} {} order={} asset={} {}",
            chrono::Local::now().to_rfc3339(),
            stage,
            number,
            id,
            detail.replace(['\r', '\n'], " ")
        );
    }
}

#[tauri::command]
pub(crate) fn get_qiniu_status(state: State<'_, AppState>) -> Result<Status, String> {
    let (settings, credential) = qiniu_settings::load(&state.store)?;
    Sync::new(settings, &credential).status(&state.store)
}

#[tauri::command]
pub(crate) async fn qiniu_sync_now(state: State<'_, AppState>) -> Result<usize, String> {
    let _guard = state.workflow_operations.lock().await;
    let (mut settings, credential) = qiniu_settings::load(&state.store)?;
    settings.enabled = true;
    let sync = Sync::new(settings, &credential);
    let client = sync.client.as_ref().ok_or("请先配置七牛设备凭证。")?;
    let temporary = tempfile::tempdir().map_err(str_error)?;
    let incoming = Store::open(temporary.path()).map_err(str_error)?;
    sync.pull_cycle(client, &incoming, temporary.path(), |_, _, _| {}).await?;
    Ok(crate::workflow::import_legacy(&state, &incoming, temporary.path())?.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::qiniu_store::CaptureQuality;
    use crate::qiniu_transport::tests::{local_server, receive, reply};
    use serde_json::{json, Value};

    #[tokio::test]
    async fn customer_and_production_stores_exchange_identical_original_and_result() {
        let (listener, base) = local_server();
        let a_dir = tempfile::tempdir().unwrap();
        let b_dir = tempfile::tempdir().unwrap();
        let test_image = a_dir.path().join("fixture.png");
        image::RgbaImage::from_pixel(2, 2, image::Rgba([40, 80, 120, 200]))
            .save(&test_image)
            .unwrap();
        let original = std::fs::read(&test_image).unwrap();
        let template = ("模板爱心.png".to_owned(), 2);
        let a = Store::open(a_dir.path()).unwrap();
        a.ingest_image("history", &original, "image/png", &[], "legacy")
            .unwrap();
        let ingested = a
            .ingest_with_sync(
                "ORDER-1",
                &original,
                "image/png",
                &[template],
                "千帆",
                Some(CaptureQuality::Original),
                Some(r#"{"status":"待发货"}"#),
            )
            .unwrap();
        let b = Store::open(b_dir.path()).unwrap();
        let endpoint = base.clone();
        let sender_bytes = original.clone();
        let asset_id = ingested.image_id.clone();
        let production_id = "c9".repeat(16);
        let result_id = production_id.clone();
        let server = std::thread::spawn(move || {
            use std::net::TcpStream;
            fn send(socket: TcpStream, value: Value) {
                reply(
                    socket,
                    200,
                    &[("Content-Type", "application/json")],
                    value.to_string().as_bytes(),
                );
            }
            let device = |token: &str, role: &str| {
                let (socket, request) = receive(&listener, "GET /api/v1/paidan/device");
                assert_eq!(request.headers["authorization"], format!("Bearer {token}"));
                send(
                    socket,
                    json!({"deviceId": token, "workspaceId": "test", "role": role, "maxFileBytes": 104857600}),
                );
            };
            let upload = |id: &str, kind: &str, version: usize, token: &str| -> Value {
                let (socket, request) = receive(&listener, "POST /api/v1/paidan/upload-sessions");
                assert_eq!(request.headers["authorization"], format!("Bearer {token}"));
                let mut asset: Value = serde_json::from_slice(&request.body).unwrap();
                assert_eq!(asset["orderNumber"], "ORDER-1");
                assert_eq!(asset["assetId"], id);
                assert_eq!(asset["kind"], kind);
                if kind == "original" {
                    assert_eq!(
                        asset["templates"],
                        json!([{"templateId":"模板爱心.png","quantity":2}])
                    );
                } else {
                    assert_eq!(asset["sourceImageId"], asset_id);
                }
                send(
                    socket,
                    json!({"id": id, "key": id, "uploadUrl": format!("{endpoint}/form"), "token":"short", "completed":false}),
                );
                let complete = format!("POST /api/v1/paidan/upload-sessions/{id}/complete");
                let (socket, _) = receive(&listener, &complete);
                reply(
                    socket,
                    409,
                    &[("Content-Type", "application/json")],
                    br#"{"code":"upload_missing"}"#,
                );
                let (socket, request) = receive(&listener, "POST /form");
                assert!(!request.headers.contains_key("authorization"));
                assert!(request
                    .body
                    .windows(sender_bytes.len())
                    .any(|part| part == sender_bytes));
                send(socket, json!({}));
                let (socket, _) = receive(&listener, &complete);
                send(socket, json!({"version":version}));
                asset["id"] = json!(id);
                asset["createdAt"] = json!("2026-11-19T12:00:00Z");
                asset["deleted"] = json!(false);
                asset
            };
            let pull = |version: usize, assets: Vec<Value>, download: &str| {
                let (socket, _) = receive(&listener, "GET /api/v1/paidan/orders?after=&limit=100");
                send(
                    socket,
                    json!({"orders":[{"orderNumber":"ORDER-1","version":version,"deleted":false}]}),
                );
                let (socket, _) = receive(&listener, "GET /api/v1/paidan/orders/ORDER-1");
                send(
                    socket,
                    json!({"orderNumber":"ORDER-1","version":version,"deleted":false,"assets":assets}),
                );
                let (socket, _) = receive(
                    &listener,
                    &format!("POST /api/v1/paidan/assets/{download}/download-url"),
                );
                send(socket, json!({"url":format!("{endpoint}/object")}));
                let (socket, request) = receive(&listener, "GET /object");
                assert!(!request.headers.contains_key("authorization"));
                reply(socket, 200, &[("Content-Type", "image/png")], &sender_bytes);
            };
            device("customer-token", "customer");
            let original = upload(&asset_id, "original", 1, "customer-token");
            device("production-token", "production");
            pull(1, vec![original.clone()], &asset_id);
            device("production-token", "production");
            let production = upload(&result_id, "production", 2, "production-token");
            device("customer-token", "customer");
            pull(2, vec![original, production], &result_id);
        });
        let roster = |role: &str, token: &str| Settings {
            enabled: true,
            api_url: base.clone(),
            poll_seconds: 15,
            has_token: true,
            workspace_id: Some("test".into()),
            device_id: Some(token.into()),
            role: Some(role.into()),
        };
        let customer = Sync::new(roster("customer", "customer-token"), &[]);
        let maker = Sync::new(roster("production", "production-token"), &[]);
        let customer_client = Client::new(&base, "customer-token").unwrap();
        let production_client = Client::new(&base, "production-token").unwrap();
        customer
            .push_cycle(&customer_client, &a, a_dir.path())
            .await
            .unwrap();
        assert_eq!(a.qiniu_counts().unwrap().0, 0);
        maker
            .pull_cycle(
                &production_client,
                &b,
                b_dir.path(),
                |order, images, productions| {
                    assert_eq!((order, images, productions), ("ORDER-1", 1, 0));
                },
            )
            .await
            .unwrap();
        let orders = b.list_orders().unwrap();
        assert_eq!(orders.len(), 1);
        let details = b.get_order(&orders[0].id).unwrap().unwrap();
        let image = &details.images[0];
        assert_eq!(std::fs::read(&image.file_path).unwrap(), original);
        assert!(Path::new(image.thumb_path.as_ref().unwrap()).is_file());
        assert_eq!(image.templates[0].quantity, 2);
        let production = b_dir
            .path()
            .join("productions")
            .join(format!("{production_id}_result.png"));
        std::fs::create_dir_all(production.parent().unwrap()).unwrap();
        std::fs::write(&production, &original).unwrap();
        b.add_qiniu_production(
            &production_id,
            "ORDER-1",
            Some(&image.id),
            &production,
            true,
        )
        .unwrap();
        maker
            .push_cycle(&production_client, &b, b_dir.path())
            .await
            .unwrap();
        customer
            .pull_cycle(
                &customer_client,
                &a,
                a_dir.path(),
                |order, images, productions| {
                    assert_eq!((order, images, productions), ("ORDER-1", 0, 1));
                },
            )
            .await
            .unwrap();
        let returned = a.list_productions("ORDER-1").unwrap().pop().unwrap();
        assert_eq!(returned.id, production_id);
        assert_eq!(std::fs::read(returned.file_path).unwrap(), original);
        server.join().unwrap();
    }
}
