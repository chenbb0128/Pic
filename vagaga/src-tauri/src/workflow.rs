use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::mysql::{ClaimResult, MyClient, OrderIndex, SharedOrder, SharedOrderRow};
use crate::store::{random_hex_pub, Store};
use crate::workflow_db::{self as db, ImportAction, ImportedAsset, OrderState, Task};
use crate::workflow_storage::Backend;
use crate::AppState;

pub(crate) const MAX_ASSET_BYTES: u64 = 104_857_600;

#[derive(Clone, Copy, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum SharedState {
    Pending,
    Completed,
}

impl SharedState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Completed => "completed",
        }
    }
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Template {
    template_id: String,
    quantity: i64,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum AssetKind {
    Original,
    Production,
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Asset {
    id: String,
    kind: AssetKind,
    name: String,
    object_name: String,
    bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    image_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    quality: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    remark: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    templates: Vec<Template>,
}

impl Asset {
    fn production(&self) -> bool {
        matches!(self.kind, AssetKind::Production)
    }

    fn folder(&self) -> &'static str {
        if self.production() {
            "production"
        } else {
            "original"
        }
    }
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrderData {
    order_number: String,
    operation_id: String,
    state: SharedState,
    metadata: Option<serde_json::Map<String, serde_json::Value>>,
    assets: Vec<Asset>,
    updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    completed_at: Option<String>,
}

impl OrderData {
    fn template_ids(&self) -> impl Iterator<Item = &str> {
        self.assets.iter().flat_map(|asset| asset.templates.iter().map(|template| template.template_id.as_str()))
    }

    fn record(&self, payload: String) -> SharedOrder {
        SharedOrder {
            number: self.order_number.clone(),
            operation_id: self.operation_id.clone(),
            payload,
            completed: self.state == SharedState::Completed,
        }
    }

    fn from_record(record: SharedOrder) -> Result<Self, String> {
        let order = Self::parse(record.payload.as_bytes())?;
        if order.order_number != record.number
            || order.operation_id != record.operation_id
            || (order.state == SharedState::Completed) != record.completed
        {
            return Err("共享数据库中的订单记录不一致。".into());
        }
        Ok(order)
    }

    fn parse(bytes: &[u8]) -> Result<Self, String> {
        let order: Self = serde_json::from_slice(bytes).map_err(display)?;
        if order.order_number.trim().is_empty()
            || order.order_number.len() > 256
            || !hex_id(&order.operation_id, 32)
        {
            return Err("共享数据库中的订单信息无效。".into());
        }
        let order_directory = order_key_segment(&order.order_number);
        let mut ids = std::collections::HashSet::new();
        if order.assets.iter().any(|asset| {
            let filename = match asset.object_name.split_once('/') {
                Some((directory, filename)) if directory == order_directory => filename,
                Some(_) => return true,
                None => asset.object_name.as_str(),
            };
            !filename.split_once('.').is_some_and(|(id, ext)| {
                hex_id(id, 32) && crate::workflow_qiniu::image_mime(ext).is_some()
            }) || asset.bytes == 0
                || asset.bytes > MAX_ASSET_BYTES
                || !hex_id(&asset.id, 32)
                || !ids.insert(asset.id.as_str())
        }) {
            return Err("共享订单包含无效或重复的素材记录。".into());
        }
        Ok(order)
    }
}

fn order_key_segment(number: &str) -> String {
    // Standard order numbers stay readable. Escape every other form as one
    // reversible segment so it cannot add folders or collide with a literal ID.
    if !number.is_empty()
        && !matches!(number, "." | "..")
        && number
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        number.to_owned()
    } else {
        format!("~{}", URL_SAFE_NO_PAD.encode(number))
    }
}

fn hex_id(value: &str, size: usize) -> bool {
    value.len() == size
        && value
            .bytes()
            .all(|k| k.is_ascii_digit() || (b'a'..=b'f').contains(&k))
}

fn display(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn outbox_file(root: &Path, operation: &str, asset_id: &str) -> PathBuf {
    root.join("workflow-outbox").join(operation).join(asset_id)
}

fn file_name(path: &Path, fallback: &str) -> String {
    path.file_name()
        .and_then(|part| part.to_str())
        .unwrap_or(fallback)
        .to_owned()
}

#[derive(Deserialize, Serialize)]
struct SourceFile {
    path: PathBuf,
    bytes: u64,
    modified: SystemTime,
}

type SourceFiles = BTreeMap<String, SourceFile>;

impl SourceFile {
    fn open(&self, root: &Path) -> Result<File, String> {
        if self
            .path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err("本机归档记录包含无效路径。".into());
        }
        let file = File::open(archive_path(root, &root.join(&self.path))?).map_err(display)?;
        self.check(&file)?;
        Ok(file)
    }

    fn check(&self, file: &File) -> Result<(), String> {
        let metadata = file.metadata().map_err(display)?;
        if metadata.len() != self.bytes || metadata.modified().map_err(display)? != self.modified {
            return Err("本机归档文件已变化。".into());
        }
        Ok(())
    }

    fn read(&self, root: &Path, size: u64) -> Result<Vec<u8>, String> {
        if self.bytes != size {
            return Err("本机归档记录与待上传图片不一致。".into());
        }
        let mut file = self.open(root)?;
        let bytes = read_image_bytes(&mut file, size)?;
        self.check(&file)?;
        Ok(bytes)
    }
}

fn archive_path(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let path = path.canonicalize().map_err(display)?;
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "图片路径超出本机数据目录。")?;
    if !matches!(relative.components().next(), Some(Component::Normal(folder))
        if folder == "images" || folder == "productions")
    {
        return Err("图片不在本机归档目录中。".into());
    }
    Ok(path)
}

fn read_image_bytes(file: &mut File, size: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(size + 1)
        .read_to_end(&mut bytes)
        .map_err(display)?;
    if bytes.len() as u64 != size {
        return Err("待上传图片文件大小已变化。".into());
    }
    Ok(bytes)
}

fn record_asset(
    root: &Path,
    asset: &mut Asset,
    from: &Path,
    order_directory: Option<&str>,
) -> Result<SourceFile, String> {
    let path = archive_path(root, from)?;
    let mut file = File::open(&path).map_err(display)?;
    let metadata = file.metadata().map_err(display)?;
    let size = metadata.len();
    if !metadata.is_file() || size == 0 || size > MAX_ASSET_BYTES {
        return Err(format!("文件大小超限或为空：{}", asset.name));
    }
    let source = SourceFile {
        path: path.strip_prefix(root).map_err(display)?.into(),
        bytes: size,
        modified: metadata.modified().map_err(display)?,
    };
    let mut header = Vec::new();
    (&mut file)
        .take(64)
        .read_to_end(&mut header)
        .map_err(display)?;
    source.check(&file)?;
    let format = image::guess_format(&header).map_err(display)?;
    let extension = format
        .extensions_str()
        .iter()
        .find(|extension| crate::workflow_qiniu::image_mime(extension).is_some())
        .ok_or_else(|| format!("无法共享此图片格式：{}", asset.name))?;
    asset.bytes = size;
    let name = format!("{}.{extension}", random_hex_pub(16));
    asset.object_name = match order_directory {
        Some(directory) => format!("{directory}/{name}"),
        None => name,
    };
    Ok(source)
}

fn snapshot(
    store: &Store,
    root: &Path,
    number: &str,
    kind: &str,
    previous: Option<&OrderData>,
    use_order_directory: bool,
    operation: &str,
) -> Result<(OrderData, SourceFiles), String> {
    let root = root.canonicalize().map_err(display)?;
    let detail = store
        .get_order_by_number(number)
        .map_err(display)?
        .ok_or("订单不存在。")?;
    let state = db::order_state(store, number)
        .map_err(display)?
        .ok_or("订单不存在。")?;
    let mut assets = Vec::new();
    let mut sources = SourceFiles::new();
    let order_directory = use_order_directory.then(|| order_key_segment(number));
    for image in detail.images {
        let quality = store
            .qiniu_asset_state(&image.id)
            .map_err(display)?
            .and_then(|state| state.quality);
        if kind != "legacy"
            && quality
                .as_deref()
                .is_some_and(|quality| quality != "original")
        {
            return Err("订单含缩图或来源未确认的素材，请重新排单取得原图后上传。".into());
        }
        let mut asset = Asset {
            id: db::remote_id(store, &image.id).map_err(display)?,
            kind: AssetKind::Original,
            name: image.original_name,
            object_name: String::new(),
            bytes: 0,
            image_id: None,
            width: u32::try_from(image.width).ok(),
            height: u32::try_from(image.height).ok(),
            quality,
            remark: Some(image.remark),
            templates: image
                .templates
                .into_iter()
                .map(|template| Template {
                    template_id: template.template_id,
                    quantity: template.quantity,
                })
                .collect(),
        };
        if let Some(stored) = previous.and_then(|order| {
            order
                .assets
                .iter()
                .find(|candidate| candidate.id == asset.id && !candidate.production())
        }) {
            asset.object_name.clone_from(&stored.object_name);
            asset.bytes = stored.bytes;
        } else if image.file_path.is_empty() {
            let Some(remote_obj) = image.remote_object_name.as_ref() else {
                return Err(format!("素材 {} 尚未下载到本机。", asset.name));
            };
            asset.object_name.clone_from(remote_obj);
            asset.bytes = u64::try_from(image.byte_length).unwrap_or(0);
        } else {
            let source = record_asset(
                &root,
                &mut asset,
                Path::new(&image.file_path),
                order_directory.as_deref(),
            )
            .map_err(|error| format!("读取 {} 失败：{error}", asset.name))?;
            sources.insert(asset.id.clone(), source);
        }
        assets.push(asset);
    }
    if kind != "publish" {
        for product in store.list_productions(number).map_err(display)? {
            let path = Path::new(&product.file_path);
            let fallback_name = if product.original_name.is_empty() {
                "production.png"
            } else {
                product.original_name.as_str()
            };
            let mut name = if product.file_path.is_empty() {
                fallback_name.to_owned()
            } else {
                file_name(path, fallback_name)
            };
            let id = db::remote_id(store, &product.id).map_err(display)?;
            if let Some(stripped) = name
                .strip_prefix(&format!("{}_", product.id))
                .or_else(|| name.strip_prefix(&format!("{id}_")))
            {
                name = stripped.to_owned();
            }
            let mut asset = Asset {
                id,
                kind: AssetKind::Production,
                name,
                object_name: String::new(),
                bytes: 0,
                image_id: product
                    .image_id
                    .as_ref()
                    .map(|id| db::remote_id(store, id))
                    .transpose()
                    .map_err(display)?,
                width: None,
                height: None,
                quality: None,
                remark: None,
                templates: Vec::new(),
            };
            if asset.image_id.as_ref().is_some_and(|id| {
                !assets
                    .iter()
                    .any(|asset| !asset.production() && &asset.id == id)
            }) {
                asset.image_id = None;
            }
            if let Some(stored) = previous.and_then(|order| {
                order
                    .assets
                    .iter()
                    .find(|candidate| candidate.id == asset.id && candidate.production())
            }) {
                asset.object_name.clone_from(&stored.object_name);
                asset.bytes = stored.bytes;
            } else if product.file_path.is_empty() {
                let Some(remote_obj) = product.remote_object_name.as_ref() else {
                    continue;
                };
                asset.object_name.clone_from(remote_obj);
                asset.bytes = u64::try_from(product.byte_length).unwrap_or(0);
            } else {
                let source = record_asset(&root, &mut asset, path, order_directory.as_deref())
                    .map_err(|error| format!("读取 {} 失败：{error}", asset.name))?;
                sources.insert(asset.id.clone(), source);
            }
            assets.push(asset);
        }
    }
    if kind == "publish" && assets.is_empty() {
        return Err("订单至少需要一张原图才能发布。".into());
    }
    let metadata = store.order_metadata_by_number(number).map_err(display)?;
    let is_completed = state.local_completed || state.shared_state.as_deref() == Some("completed");
    let completed = kind == "finish" || (kind == "legacy" && is_completed);
    let now = crate::store::now();
    let order = OrderData {
        order_number: number.into(),
        operation_id: operation.into(),
        state: if completed {
            SharedState::Completed
        } else {
            SharedState::Pending
        },
        metadata: metadata.map(|metadata| db::metadata(Some(&metadata))),
        assets,
        updated_at: now.clone(),
        completed_at: completed.then_some(now),
    };
    Ok((order, sources))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Preview {
    reference: String,
    order_number: String,
    updated_at: String,
    local_version: Option<String>,
    changes: Vec<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Outcome {
    pub(crate) updated: usize,
    pub(crate) completed: usize,
    pub(crate) claims_changed: usize,
    pub(crate) templates_updated: usize,
    pub(crate) uploaded_order_numbers: Vec<String>,
    pub(crate) conflicts: Vec<Preview>,
    pub(crate) errors: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Settings {
    role: String,
    target: Option<String>,
    storage_provider: Option<&'static str>,
    device_id: String,
    device_name: String,
    auto_sync: bool,
    poll_seconds: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaimResponse {
    pub(crate) ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) claimed_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) claimed_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) claimed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) message: Option<String>,
}

fn preview(store: &Store, order: &OrderData, reference: String) -> Result<Preview, String> {
    let local = db::order_state(store, &order.order_number).map_err(display)?;
    let current_metadata = store
        .order_metadata_by_number(&order.order_number)
        .map_err(display)?;
    let current = db::metadata(current_metadata.as_deref());
    let empty = serde_json::Map::new();
    let incoming = order.metadata.as_ref().unwrap_or(&empty);
    let mut changes = Vec::new();
    for (key, label) in [
        ("layoutNumber", "排版编号"),
        ("merchantRemark", "商家备注"),
        ("status", "订单状态"),
        ("amount", "金额"),
        ("orderedAt", "下单时间"),
        ("specText", "规格"),
    ] {
        if current.get(key) != incoming.get(key) {
            let text = |data: &serde_json::Map<String, serde_json::Value>| {
                data.get(key)
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("（空）")
                    .to_owned()
            };
            changes.push(format!("{label}：{} → {}", text(&current), text(incoming)));
        }
    }
    let originals = order
        .assets
        .iter()
        .filter(|asset| !asset.production())
        .count();
    let products = order.assets.len() - originals;
    changes.push(format!(
        "远端含 {originals} 张素材、{products} 个成品，使用共享内容会更新本机素材。"
    ));
    Ok(Preview {
        reference,
        order_number: order.order_number.clone(),
        updated_at: order.updated_at.clone(),
        local_version: local.as_ref().map(OrderState::version),
        changes,
    })
}

fn shared_conflict(
    store: &Store,
    target: &str,
    current: Option<&OrderData>,
) -> Result<Preview, String> {
    let current = current.ok_or("共享订单已不存在，本机订单和素材已保留。")?;
    if current.state == SharedState::Completed {
        return Err("共享订单已标记完成，本机订单和素材已保留。".into());
    }
    let reference = serde_json::to_string(&(target, &current.order_number, &current.operation_id))
        .map_err(display)?;
    preview(store, current, reference)
}

pub(crate) fn selected(state: &AppState) -> Result<Backend, String> {
    Backend::current(&state.store, &state.data_root)?
        .ok_or_else(|| "请先在设置 → 共享存储中选择服务并保存配置。".into())
}

pub(crate) fn auto_sync_config(store: &Store) -> (bool, u64) {
    let enabled = db::setting(store, "auto-sync")
        .ok()
        .flatten()
        .is_none_or(|val| val != "false");
    let poll = db::setting(store, "poll-seconds")
        .ok()
        .flatten()
        .and_then(|val| val.parse::<u64>().ok())
        .unwrap_or(60)
        .clamp(10, 60);
    (enabled, poll)
}

#[tauri::command]
pub(crate) fn workflow_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    let storage = crate::workflow_storage::Configuration::load(&state.store, &state.data_root)?;
    let (auto_sync, poll_seconds) = auto_sync_config(&state.store);
    Ok(Settings {
        role: db::role(&state.store),
        target: storage.as_ref().and_then(|configuration| configuration.target()),
        storage_provider: storage.as_ref().map(|configuration| configuration.provider()),
        device_id: db::device_id(&state.store)?,
        device_name: db::device_name(&state.store)?,
        auto_sync,
        poll_seconds,
    })
}

#[tauri::command]
pub(crate) fn workflow_set_role(
    state: State<'_, AppState>,
    role: String,
) -> Result<Settings, String> {
    if !matches!(role.as_str(), "customer" | "production" | "both") {
        return Err("请选择有效的设备角色。".into());
    }
    db::put_setting(&state.store, "role", &role).map_err(display)?;
    workflow_settings(state)
}

#[tauri::command]
pub(crate) fn workflow_set_device_name(
    state: State<'_, AppState>,
    name: String,
) -> Result<Settings, String> {
    db::set_device_name(&state.store, &name)?;
    workflow_settings(state)
}

#[tauri::command]
pub(crate) fn workflow_set_auto_sync(
    state: State<'_, AppState>,
    enabled: bool,
    poll_seconds: Option<u64>,
) -> Result<Settings, String> {
    db::put_setting(
        &state.store,
        "auto-sync",
        if enabled { "true" } else { "false" },
    )
    .map_err(display)?;
    if let Some(secs) = poll_seconds {
        if !(10..=60).contains(&secs) {
            return Err("自动同步间隔应在 10 到 60 秒之间。".into());
        }
        db::put_setting(&state.store, "poll-seconds", &secs.to_string()).map_err(display)?;
    }
    workflow_settings(state)
}

#[tauri::command]
pub(crate) fn workflow_orders(state: State<'_, AppState>) -> Result<Vec<db::OrderRow>, String> {
    db::list(&state.store).map_err(display)
}

#[tauri::command]
pub(crate) fn workflow_set_layout(
    state: State<'_, AppState>,
    order_number: String,
    number: String,
) -> Result<(), String> {
    db::set_layout(&state.store, &order_number, &number)
}

async fn shared_database(root: &Path) -> Result<OrderIndex, String> {
    let config = crate::mysql::load_config(root);
    if !config.valid() {
        return Err("请先在设置 → 共享数据库中保存完整的 MySQL 配置。".into());
    }
    let client = MyClient::new(&config);
    tokio::time::timeout(std::time::Duration::from_secs(15), client.order_index())
        .await
        .map_err(|_| "请确保共享数据库（MySQL）可连接并可用。连接检测超时。".to_string())?
        .map_err(|error| format!("请确保共享数据库（MySQL）可连接并可用。{error}"))
}

async fn run_task(
    state: &AppState,
    backend: &Backend,
    index: &mut OrderIndex,
    task: &Task,
) -> Result<Option<Preview>, String> {
    let order = OrderData::parse(task.payload.as_bytes())?;
    let mut result = run_task_attempt(state, backend, index, task, &order).await;
    if let Err(error) = &result {
        if let Ok(Some(reconnected)) = backend.reconnect_smb_after(error) {
            result = run_task_attempt(state, &reconnected, index, task, &order).await;
        }
    }
    let result = match result {
        Ok(result) => result,
        Err(error) => {
            db::fail_task(&state.store, task, &error).map_err(display)?;
            return Err(error);
        }
    };
    match &result {
        TaskResult::Applied => db::finish_task(
            &state.store,
            task,
            order.state.as_str(),
            &order.operation_id,
        )
        .map_err(display)?,
        _ => db::discard_task(&state.store, task).map_err(display)?,
    }
    if task.source_files.is_none() {
        clear_outbox(&state.data_root, &order.operation_id).await;
    }
    match result {
        TaskResult::Applied => Ok(None),
        TaskResult::Changed(current) => {
            shared_conflict(&state.store, &task.target, current.as_ref()).map(Some)
        }
        TaskResult::SourceChanged(name, error) => Err(format!(
            "无法读取本机归档「{name}」：{error} 请检查素材后重新操作。"
        )),
    }
}

enum TaskResult {
    Applied,
    Changed(Option<OrderData>),
    SourceChanged(String, String),
}

fn check_remote(
    task: &Task,
    order: &OrderData,
    current: Option<OrderData>,
) -> Result<Option<OrderData>, TaskResult> {
    if current
        .as_ref()
        .is_some_and(|row| row.operation_id == order.operation_id)
    {
        Err(TaskResult::Applied)
    } else if !current_matches(current.as_ref(), task.expected_operation_id.as_deref()) {
        Err(TaskResult::Changed(current))
    } else {
        Ok(current)
    }
}

async fn remote_order(
    index: &mut OrderIndex,
    target: &str,
    number: &str,
) -> Result<Option<OrderData>, String> {
    index
        .get(target, number)
        .await?
        .map(OrderData::from_record)
        .transpose()
}

async fn run_task_attempt(
    state: &AppState,
    backend: &Backend,
    index: &mut OrderIndex,
    task: &Task,
    order: &OrderData,
) -> Result<TaskResult, String> {
    let current = remote_order(index, &task.target, &task.number).await?;
    let current = match check_remote(task, order, current) {
        Ok(current) => current,
        Err(result) => return Ok(result),
    };
    let mut sources: Option<SourceFiles> = task
        .source_files
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(display)?;
    for asset in &order.assets {
        if current.as_ref().is_some_and(|row| {
            row.assets
                .iter()
                .any(|saved| saved.id == asset.id && saved.object_name == asset.object_name)
        }) {
            continue;
        }
        let bytes = if let Some(sources) = &mut sources {
            let root = state.data_root.clone();
            let source = sources.remove(&asset.id);
            let size = asset.bytes;
            let read = tokio::task::spawn_blocking(move || {
                let source = source.ok_or("缺少本机归档记录。")?;
                source.read(&root.canonicalize().map_err(display)?, size)
            })
            .await
            .map_err(display)?;
            match read {
                Ok(bytes) => bytes,
                Err(error) => {
                    let current = remote_order(index, &task.target, &task.number).await?;
                    return Ok(match check_remote(task, order, current) {
                        Ok(_) => TaskResult::SourceChanged(asset.name.clone(), error),
                        Err(result) => result,
                    });
                }
            }
        } else {
            let path = outbox_file(&state.data_root, &order.operation_id, &asset.id);
            let size = asset.bytes;
            tokio::task::spawn_blocking(move || {
                let mut file = File::open(path).map_err(display)?;
                read_image_bytes(&mut file, size)
            })
            .await
            .map_err(display)??
        };
        backend
            .put_image(asset.folder(), &asset.object_name, bytes)
            .await?;
    }
    if index
        .write(
            &task.target,
            task.expected_operation_id.as_deref(),
            &order.record(task.payload.clone()),
        )
        .await?
    {
        return Ok(TaskResult::Applied);
    }
    let current = remote_order(index, &task.target, &task.number).await?;
    match check_remote(task, order, current) {
        Ok(_) => Err("暂时无法确认共享写入结果，请重试。".into()),
        Err(result) => Ok(result),
    }
}

fn current_matches(current: Option<&OrderData>, expected: Option<&str>) -> bool {
    match current {
        Some(order) => {
            order.state == SharedState::Pending && expected == Some(order.operation_id.as_str())
        }
        None => expected.is_none(),
    }
}

async fn clear_outbox(root: &Path, operation: &str) {
    let directory = root.join("workflow-outbox").join(operation);
    if let Ok(mut files) = tokio::fs::read_dir(&directory).await {
        while let Ok(Some(file)) = files.next_entry().await {
            let _ = tokio::fs::remove_file(file.path()).await;
        }
        let _ = tokio::fs::remove_dir(&directory).await;
    }
}

type StorageChecks = BTreeMap<String, Result<(), String>>;

async fn check_upload_storage(
    backend: &Backend,
    checks: Option<&mut StorageChecks>,
) -> Result<(), String> {
    if let Some(checks) = checks {
        let target = backend.target();
        if let Some(result) = checks.get(&target) {
            return result.clone();
        }
        let result = backend.check_connection().await;
        checks.insert(target, result.clone());
        return result;
    }
    Ok(())
}

fn normalized_templates(templates: &[Template]) -> Vec<(&str, i64)> {
    let mut list: Vec<(&str, i64)> = templates
        .iter()
        .map(|t| (t.template_id.as_str(), t.quantity))
        .collect();
    list.sort_by(|a, b| a.0.cmp(b.0));
    list
}

fn normalized_remark(remark: Option<&str>) -> &str {
    remark.map(str::trim).unwrap_or("")
}

fn same_original_edits(left: &Asset, right: &Asset) -> bool {
    normalized_templates(&left.templates) == normalized_templates(&right.templates)
        && normalized_remark(left.remark.as_deref()) == normalized_remark(right.remark.as_deref())
}

fn merge_metadata_maps(
    remote: Option<&serde_json::Map<String, serde_json::Value>>,
    local: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    match (remote, local) {
        (None, None) => None,
        (Some(r), None) => Some(r.clone()),
        (None, Some(l)) => Some(l.clone()),
        (Some(r), Some(l)) => {
            let remote_str = serde_json::Value::Object(r.clone()).to_string();
            let local_str = serde_json::Value::Object(l.clone()).to_string();
            let merged = crate::store::merge_order_metadata(Some(&remote_str), &local_str);
            let mut map = db::metadata(Some(&merged));
            for (k, v) in r {
                map.entry(k.clone()).or_insert_with(|| v.clone());
            }
            Some(map)
        }
    }
}

/// 尝试将本机待上传订单与远端待制作订单按素材粒度无损合并。
/// 返回 `Some(merged)` 表示可安全自动合并；返回 `None` 表示存在同一素材的并发冲突修改，需人工确认。
fn merge_publish_data(
    local: &OrderData,
    remote: &OrderData,
    base: Option<&OrderData>,
) -> Option<OrderData> {
    if remote.state != SharedState::Pending {
        return None;
    }
    let remote_originals: BTreeMap<&str, &Asset> = remote
        .assets
        .iter()
        .filter(|a| !a.production())
        .map(|a| (a.id.as_str(), a))
        .collect();
    let local_originals: BTreeMap<&str, &Asset> = local
        .assets
        .iter()
        .filter(|a| !a.production())
        .map(|a| (a.id.as_str(), a))
        .collect();

    let mut merged_assets = Vec::new();
    match base {
        None => {
            // 本机尚未同步过该订单：仅当本机新增的素材 ID 与远端完全不重叠时（如另一台排单机补抓新图）自动追加合并。
            if local_originals.is_empty()
                || local_originals
                    .keys()
                    .any(|id| remote_originals.contains_key(id))
            {
                return None;
            }
            merged_assets.extend(remote.assets.iter().filter(|a| !a.production()).cloned());
            merged_assets.extend(local.assets.iter().filter(|a| !a.production()).cloned());
        }
        Some(base_order) => {
            let base_originals: BTreeMap<&str, &Asset> = base_order
                .assets
                .iter()
                .filter(|a| !a.production())
                .map(|a| (a.id.as_str(), a))
                .collect();

            // 检查本机是否确实相对基准有修改，若本机无任何修改则不主动覆盖远端新版本。
            let local_changed_assets = local_originals.len() != base_originals.len()
                || local_originals.iter().any(|(id, l)| {
                    base_originals
                        .get(id)
                        .is_none_or(|b| !same_original_edits(l, b))
                });
            let local_changed_meta = local.metadata != base_order.metadata;
            if !local_changed_assets && !local_changed_meta {
                return None;
            }

            let mut ordered_ids: Vec<&str> = Vec::new();
            let mut seen_ids = std::collections::HashSet::new();
            for item in remote
                .assets
                .iter()
                .chain(local.assets.iter())
                .filter(|a| !a.production())
            {
                if seen_ids.insert(item.id.as_str()) {
                    ordered_ids.push(item.id.as_str());
                }
            }

            for id in ordered_ids {
                match (
                    base_originals.get(id),
                    local_originals.get(id),
                    remote_originals.get(id),
                ) {
                    (None, Some(l), None) => merged_assets.push((*l).clone()),
                    (None, None, Some(r)) => merged_assets.push((*r).clone()),
                    (None, Some(l), Some(r)) => {
                        if same_original_edits(l, r) {
                            merged_assets.push((*r).clone());
                        } else {
                            return None;
                        }
                    }
                    (Some(b), None, Some(r)) => {
                        // 本机删除了该图：仅当远端未修改该图时才允许删除，否则走冲突确认。
                        if !same_original_edits(b, r) {
                            return None;
                        }
                    }
                    (Some(b), Some(l), None) => {
                        // 远端删除了该图：仅当本机未修改该图时才允许删除，否则走冲突确认。
                        if !same_original_edits(b, l) {
                            return None;
                        }
                    }
                    (Some(b), Some(l), Some(r)) => {
                        let b_tpl = normalized_templates(&b.templates);
                        let l_tpl = normalized_templates(&l.templates);
                        let r_tpl = normalized_templates(&r.templates);
                        let templates = if l_tpl == b_tpl {
                            r.templates.clone()
                        } else if r_tpl == b_tpl || l_tpl == r_tpl {
                            l.templates.clone()
                        } else {
                            return None;
                        };

                        let b_rem = normalized_remark(b.remark.as_deref());
                        let l_rem = normalized_remark(l.remark.as_deref());
                        let r_rem = normalized_remark(r.remark.as_deref());
                        let remark = if l_rem == b_rem {
                            r.remark.clone()
                        } else if r_rem == b_rem || l_rem == r_rem {
                            l.remark.clone()
                        } else {
                            return None;
                        };

                        let mut combined = (*r).clone();
                        combined.templates = templates;
                        combined.remark = remark;
                        merged_assets.push(combined);
                    }
                    (_, None, None) => {}
                }
            }
        }
    }

    // 保留远端可能已存在的历史返工成品引用
    merged_assets.extend(remote.assets.iter().filter(|a| a.production()).cloned());
    if merged_assets.iter().all(|a| a.production()) {
        return None;
    }

    Some(OrderData {
        order_number: local.order_number.clone(),
        operation_id: local.operation_id.clone(),
        state: SharedState::Pending,
        metadata: merge_metadata_maps(remote.metadata.as_ref(), local.metadata.as_ref()),
        assets: merged_assets,
        updated_at: local.updated_at.clone(),
        completed_at: None,
    })
}

async fn upload_one(
    state: &AppState,
    index: &mut OrderIndex,
    number: &str,
    kind: &str,
    checks: Option<&mut StorageChecks>,
) -> Result<Option<Preview>, String> {
    let local = db::order_state(&state.store, number)
        .map_err(display)?
        .ok_or("订单不存在。")?;
    if let Some(task) = db::task(&state.store, number, kind).map_err(display)? {
        if let Ok(order) = OrderData::parse(task.payload.as_bytes()) {
            verify_provider_role(&state.store, &task.target, kind)?;
            let backend = Backend::bound(&state.store, &state.data_root, &task.target)?;
            check_upload_storage(&backend, checks).await?;
            crate::templates::require_shared(state, &backend, order.template_ids()).await?;
            return run_task(state, &backend, index, &task).await;
        }
        // Rebuild an old queued upload from its local originals.
        db::discard_task(&state.store, &task).map_err(display)?;
    }
    if kind == "publish"
        && (local.local_completed
            || local.shared_state.as_deref() == Some("completed")
            || db::task(&state.store, number, "finish")
                .map_err(display)?
                .is_some())
    {
        return Err("这笔订单已标记完成。如需修改请先点击「返工重开」。".into());
    }
    let backend = match local.target.as_deref() {
        Some(target) => Backend::bound(&state.store, &state.data_root, target)?,
        None => selected(state)?,
    };
    let target = backend.target();
    verify_provider_role(&state.store, &target, kind)?;
    check_upload_storage(&backend, checks).await?;
    let previous = remote_order(index, &target, number).await?;
    if kind == "finish" && previous.is_none() {
        return Err("共享数据库里没有这笔订单，请在排单端重新上传后再交付。".into());
    }
    let expected = local.remote_operation_id.as_deref();
    let operation = random_hex_pub(16);
    if !current_matches(previous.as_ref(), expected) {
        if kind == "publish" {
            if let Some(remote) = previous.as_ref() {
                if remote.state == SharedState::Pending {
                    let base = db::synced_snapshot(&state.store, number)
                        .map_err(display)?
                        .and_then(|raw| OrderData::parse(raw.as_bytes()).ok());
                    let (local_draft, sources) = snapshot(
                        &state.store,
                        &state.data_root,
                        number,
                        kind,
                        Some(remote),
                        backend.uses_order_directory(),
                        &operation,
                    )?;
                    if let Some(merged) = merge_publish_data(&local_draft, remote, base.as_ref()) {
                        crate::templates::require_shared(state, &backend, merged.template_ids())
                            .await?;
                        let payload = serde_json::to_string(&merged).map_err(display)?;
                        let task = Task {
                            number: number.into(),
                            target: target.clone(),
                            kind: kind.into(),
                            expected_operation_id: Some(remote.operation_id.clone()),
                            generation: local.generation,
                            payload: payload.clone(),
                            source_files: Some(serde_json::to_string(&sources).map_err(display)?),
                        };
                        db::insert_task(&state.store, &task, &local.version())?;
                        let outcome = run_task(state, &backend, index, &task).await?;
                        if outcome.is_none() {
                            // 将合并后的远端其他客服素材同步回本机（排单端使用懒加载占位，二合一端按需补齐）
                            let eager_originals = db::role(&state.store) != "customer";
                            let downloaded =
                                prepare_import_assets(state, &backend, &merged, eager_originals)
                                    .await?;
                            let refreshed_version = db::order_state(&state.store, number)
                                .map_err(display)?
                                .map(|s| s.version());
                            apply_download(
                                &state.store,
                                &merged,
                                downloaded,
                                ImportAction::Sync,
                                refreshed_version.as_deref(),
                                Some(&target),
                                Some(&payload),
                                None,
                            )?;
                        }
                        return Ok(outcome);
                    }
                }
            }
        }
        return shared_conflict(&state.store, &target, previous.as_ref()).map(Some);
    }
    let (order, sources) = snapshot(
        &state.store,
        &state.data_root,
        number,
        kind,
        previous.as_ref(),
        backend.uses_order_directory(),
        &operation,
    )?;
    crate::templates::require_shared(state, &backend, order.template_ids()).await?;
    let task = Task {
        number: number.into(),
        target,
        kind: kind.into(),
        expected_operation_id: expected.map(str::to_owned),
        generation: local.generation,
        payload: serde_json::to_string(&order).map_err(display)?,
        source_files: Some(serde_json::to_string(&sources).map_err(display)?),
    };
    db::insert_task(&state.store, &task, &local.version())?;
    run_task(state, &backend, index, &task).await
}

fn verify_provider_role(store: &Store, target: &str, kind: &str) -> Result<(), String> {
    if !target.starts_with("qiniu:") {
        return Ok(());
    }
    let (settings, _) = crate::qiniu_settings::load(store)?;
    match (kind, settings.role.as_deref()) {
        (_, Some("both")) | ("publish", Some("customer")) | ("finish", Some("production")) => {
            Ok(())
        }
        ("publish", _) => Err("七牛设备凭证缺少订单发布权限。".into()),
        _ => Err("七牛设备凭证缺少共享成品交付权限。".into()),
    }
}

#[tauri::command]
pub(crate) async fn workflow_upload(
    state: State<'_, AppState>,
    order_numbers: Vec<String>,
) -> Result<Outcome, String> {
    if db::role(&state.store) == "production" {
        return Err("当前是制作端，不能发布待制作订单。".into());
    }
    let _operation = state.workflow_operations.lock().await;
    let mut result = Outcome::default();
    if order_numbers.is_empty() {
        return Ok(result);
    }
    let mut index = shared_database(&state.data_root).await?;
    let mut seen = std::collections::HashSet::new();
    let mut checks = StorageChecks::new();
    for number in order_numbers {
        if !seen.insert(number.clone()) {
            continue;
        }
        match upload_one(&state, &mut index, &number, "publish", Some(&mut checks)).await {
            Ok(None) => {
                result.updated += 1;
                result.uploaded_order_numbers.push(number);
            }
            Ok(Some(conflict)) => result.conflicts.push(conflict),
            Err(error) => result.errors.push(format!("{number}：{error}")),
        }
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn workflow_finish(
    state: State<'_, AppState>,
    order_number: String,
) -> Result<Outcome, String> {
    if db::role(&state.store) == "customer" {
        return Err("当前是排单端，请在制作端或二合一设备标记完成。".into());
    }
    let _operation = state.workflow_operations.lock().await;
    let local = db::order_state(&state.store, &order_number)
        .map_err(display)?
        .ok_or("订单不存在。")?;
    let mut result = Outcome::default();
    let pending = db::task(&state.store, &order_number, "finish").map_err(display)?;
    if local.shared_state.as_deref() == Some("completed") && pending.is_none() {
        return Ok(result);
    }
    if db::task(&state.store, &order_number, "publish")
        .map_err(display)?
        .is_some()
    {
        return Err("这笔订单还有一次待确认的发布。请重试发布，确认共享状态后再标记完成。".into());
    }
    if local.target.is_some() {
        let mut index = shared_database(&state.data_root).await?;
        match upload_one(&state, &mut index, &order_number, "finish", None).await {
            Ok(None) => {}
            Ok(Some(conflict)) => {
                result.conflicts.push(conflict);
                return Ok(result);
            }
            Err(error) => {
                result.errors.push(error);
                return Ok(result);
            }
        }
    } else {
        db::complete_local(&state.store, &order_number).map_err(display)?;
    }
    result.completed = 1;
    Ok(result)
}

fn display_file_name(name: &str, fallback: &str) -> String {
    let sanitized: String = name
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        .take(120)
        .collect();
    let sanitized = sanitized.trim_matches([' ', '.']);
    if sanitized.is_empty() {
        fallback.into()
    } else {
        sanitized.into()
    }
}

struct Download {
    directory: Option<tempfile::TempDir>,
    assets: Vec<ImportedAsset>,
}

fn lazy_import_asset(asset: &Asset) -> ImportedAsset {
    let name = display_file_name(
        &asset.name,
        if asset.production() {
            "production.png"
        } else {
            "photo.png"
        },
    );
    ImportedAsset {
        remote_id: asset.id.clone(),
        image_id: asset.image_id.clone(),
        name,
        path: PathBuf::new(),
        thumb: None,
        remote_object_name: Some(asset.object_name.clone()),
        production: asset.production(),
        bytes: asset.bytes,
        width: asset.width.unwrap_or(0),
        height: asset.height.unwrap_or(0),
        quality: asset.quality.clone(),
        remark: asset.remark.clone(),
        templates: asset
            .templates
            .iter()
            .map(|t| (t.template_id.clone(), t.quantity))
            .collect(),
    }
}

async fn prepare_import_assets(
    state: &AppState,
    backend: &Backend,
    order: &OrderData,
    eager_originals: bool,
) -> Result<Download, String> {
    if eager_originals {
        crate::templates::fetch_missing(state, backend, order.template_ids()).await?;
    }
    let existing = db::existing_remote_files(&state.store, &order.order_number).map_err(display)?;
    let mut directory: Option<tempfile::TempDir> = None;
    let mut assets = Vec::with_capacity(order.assets.len());
    for asset in &order.assets {
        if asset.production() || !eager_originals || existing.contains_key(&asset.id) {
            assets.push(lazy_import_asset(asset));
            continue;
        }
        let dir = match &directory {
            Some(dir) => dir,
            None => directory.insert(download_directory(&state.data_root)?),
        };
        let bytes = backend
            .get_image(asset.folder(), &asset.object_name)
            .await?
            .ok_or_else(|| format!("共享文件缺失：{}", asset.name))?;
        if bytes.len() as u64 != asset.bytes {
            return Err(format!("共享文件校验失败：{}", asset.name));
        }
        assets.push(write_import_file(dir.path(), asset, &bytes)?);
    }
    Ok(Download { directory, assets })
}

async fn download(
    state: &AppState,
    backend: &Backend,
    order: &OrderData,
) -> Result<Download, String> {
    prepare_import_assets(state, backend, order, true).await
}

fn download_directory(root: &Path) -> Result<tempfile::TempDir, String> {
    let base = root.join("images");
    std::fs::create_dir_all(&base).map_err(display)?;
    tempfile::Builder::new()
        .prefix("shared-")
        .tempdir_in(base)
        .map_err(display)
}

fn write_import_file(
    directory: &Path,
    asset: &Asset,
    bytes: &[u8],
) -> Result<ImportedAsset, String> {
    let name = display_file_name(
        &asset.name,
        if asset.production() {
            "production.png"
        } else {
            "photo.png"
        },
    );
    let path = directory.join(format!("{}_{}", asset.id, name));
    std::fs::write(&path, bytes).map_err(display)?;
    let (thumb, width, height) = if asset.production() {
        (None, 0, 0)
    } else {
        let decoded = image::load_from_memory(bytes).map_err(display)?;
        let thumb_path = directory.join(format!("{}.thumb.jpg", asset.id));
        let thumbnail = decoded
            .thumbnail(320, 320)
            .into_rgb8()
            .save(&thumb_path)
            .ok()
            .map(|_| thumb_path);
        (thumbnail, decoded.width(), decoded.height())
    };
    Ok(ImportedAsset {
        remote_id: asset.id.clone(),
        image_id: asset.image_id.clone(),
        name,
        path,
        thumb,
        remote_object_name: Some(asset.object_name.clone()),
        production: asset.production(),
        bytes: asset.bytes,
        width,
        height,
        quality: asset.quality.clone(),
        remark: asset.remark.clone(),
        templates: asset
            .templates
            .iter()
            .map(|t| (t.template_id.clone(), t.quantity))
            .collect(),
    })
}

pub(crate) fn import_legacy(
    state: &AppState,
    source: &Store,
    source_root: &Path,
) -> Result<Vec<(String, usize, usize)>, String> {
    let mut notices = Vec::new();
    for summary in source.list_orders().map_err(display)? {
        let number = summary.order_number;
        if db::order_state(&state.store, &number)
            .map_err(display)?
            .is_some()
        {
            continue;
        }
        let (order, sources) = snapshot(
            source,
            source_root,
            &number,
            "legacy",
            None,
            false,
            &random_hex_pub(16),
        )?;
        let directory = download_directory(&state.data_root)?;
        let mut assets = Vec::new();
        let source_root = source_root.canonicalize().map_err(display)?;
        for asset in &order.assets {
            let bytes = sources[&asset.id].read(&source_root, asset.bytes)?;
            assets.push(write_import_file(directory.path(), asset, &bytes)?);
        }
        let download = Download {
            directory: Some(directory),
            assets,
        };
        let new_images = download
            .assets
            .iter()
            .filter(|asset| !asset.production)
            .count();
        let new_productions = download.assets.len() - new_images;
        apply_download(
            &state.store,
            &order,
            download,
            ImportAction::Sync,
            None,
            None,
            None,
            None,
        )?;
        notices.push((number, new_images, new_productions));
    }
    Ok(notices)
}

#[allow(clippy::too_many_arguments)]
fn apply_download(
    store: &Store,
    order: &OrderData,
    request: Download,
    action: ImportAction,
    expected: Option<&str>,
    target: Option<&str>,
    raw_payload: Option<&str>,
    claim: Option<(Option<&str>, Option<&str>, Option<i64>)>,
) -> Result<(), String> {
    let metadata = order
        .metadata
        .as_ref()
        .map(|value| serde_json::Value::Object(value.clone()).to_string());
    db::import(
        store,
        db::Import {
            number: &order.order_number,
            expected,
            metadata: metadata.as_deref(),
            shared: target
                .map(|target| (target, order.state.as_str(), order.operation_id.as_str())),
            completed: target.is_none() && order.state == SharedState::Completed,
            action,
            assets: &request.assets,
            raw_payload,
            claim,
        },
    )?;
    if let Some(dir) = request.directory {
        let _ = dir.keep();
    }
    Ok(())
}

fn originals_unchanged_since_sync(store: &Store, number: &str) -> bool {
    let Ok(Some(raw)) = db::synced_snapshot(store, number) else {
        return false;
    };
    let Ok(base) = OrderData::parse(raw.as_bytes()) else {
        return false;
    };
    let Ok(Some(detail)) = store.get_order_by_number(number) else {
        return false;
    };
    let base_originals: Vec<&Asset> = base.assets.iter().filter(|a| !a.production()).collect();
    if detail.images.len() != base_originals.len() {
        return false;
    }
    for img in &detail.images {
        let Ok(rid) = db::remote_id(store, &img.id) else {
            return false;
        };
        let Some(base_asset) = base_originals.iter().find(|a| a.id == rid) else {
            return false;
        };
        let mut sorted_local: Vec<(&str, i64)> = img
            .templates
            .iter()
            .map(|t| (t.template_id.as_str(), t.quantity))
            .collect();
        sorted_local.sort_by(|a, b| a.0.cmp(b.0));
        if sorted_local != normalized_templates(&base_asset.templates)
            || img.remark.trim() != normalized_remark(base_asset.remark.as_deref())
        {
            return false;
        }
    }
    true
}

fn active_order_originals_preserved(store: &Store, number: &str, incoming: &OrderData) -> bool {
    let Ok(Some(detail)) = store.get_order_by_number(number) else {
        return true;
    };
    let incoming_ids: std::collections::HashSet<&str> = incoming
        .assets
        .iter()
        .filter(|a| !a.production())
        .map(|a| a.id.as_str())
        .collect();
    detail.images.iter().all(|img| {
        db::remote_id(store, &img.id)
            .map(|rid| incoming_ids.contains(rid.as_str()))
            .unwrap_or(false)
    })
}

#[cfg(test)]
async fn apply_shared_order(
    state: &AppState,
    backend: &Backend,
    order: OrderData,
    active_order: Option<&str>,
    result: &mut Outcome,
) -> Result<(), String> {
    let payload = serde_json::to_string(&order).map_err(display)?;
    apply_shared_order_with_meta(state, backend, order, &payload, None, active_order, result).await
}

async fn apply_shared_order_with_meta(
    state: &AppState,
    backend: &Backend,
    order: OrderData,
    raw_payload: &str,
    claim: Option<(Option<&str>, Option<&str>, Option<i64>)>,
    active_order: Option<&str>,
    result: &mut Outcome,
) -> Result<(), String> {
    let target = backend.target();
    let number = order.order_number.as_str();
    let local = db::order_state(&state.store, number).map_err(display)?;
    let same_target = local.as_ref().and_then(|local| local.target.as_deref()) == Some(&target);
    if same_target
        && local.as_ref().is_some_and(|local| {
            local.remote_operation_id.as_deref() == Some(order.operation_id.as_str())
        })
    {
        if let Some((cb, cn, ca)) = claim {
            if local.as_ref().is_some_and(|st| {
                st.claimed_by.as_deref() != cb
                    || st.claimed_name.as_deref() != cn
                    || st.claimed_at != ca
            }) && db::update_claim_local(&state.store, number, Some(&target), cb, cn, ca)
                .map_err(display)?
            {
                result.claims_changed += 1;
            }
        }
        return Ok(());
    }
    let role = db::role(&state.store);
    if order.state == SharedState::Completed {
        if local
            .as_ref()
            .is_some_and(|st| !same_target && st.target.is_some())
        {
            return Ok(());
        }
        let was_complete = local.as_ref().is_some_and(|st| {
            st.local_completed || st.shared_state.as_deref() == Some("completed")
        });
        let version = local.as_ref().map(OrderState::version);
        let lazy_assets = prepare_import_assets(state, backend, &order, false).await?;
        apply_download(
            &state.store,
            &order,
            lazy_assets,
            ImportAction::Sync,
            version.as_deref(),
            Some(&target),
            Some(raw_payload),
            Some((None, None, None)),
        )?;
        if !was_complete {
            result.completed += 1;
        } else {
            result.updated += 1;
        }
        return Ok(());
    }

    let local_only_production_progress = local.as_ref().is_some_and(|st| {
        same_target
            && !st.local_completed
            && st.generation != st.synced_generation
            && originals_unchanged_since_sync(&state.store, number)
    });
    let safe_while_active = active_order != Some(number)
        || (local
            .as_ref()
            .is_some_and(|st| same_target && !st.local_completed)
            && (local
                .as_ref()
                .is_some_and(|st| st.generation == st.synced_generation)
                || local_only_production_progress)
            && active_order_originals_preserved(&state.store, number, &order));

    if !safe_while_active
        || local.as_ref().is_some_and(|local| {
            !same_target
                || (local.generation != local.synced_generation && !local_only_production_progress)
                || local.local_completed
        })
    {
        result
            .conflicts
            .push(shared_conflict(&state.store, &target, Some(&order))?);
        return Ok(());
    }
    let version = local.as_ref().map(OrderState::version);
    let eager_originals = role != "customer" || local.is_some();
    let downloaded = prepare_import_assets(state, backend, &order, eager_originals).await?;
    apply_download(
        &state.store,
        &order,
        downloaded,
        ImportAction::Sync,
        version.as_deref(),
        Some(&target),
        Some(raw_payload),
        claim,
    )?;
    result.updated += 1;
    Ok(())
}

#[tauri::command]
pub(crate) async fn workflow_claim_order(
    state: State<'_, AppState>,
    order_number: String,
    force: Option<bool>,
) -> Result<ClaimResponse, String> {
    let _operation = state.workflow_operations.lock().await;
    let local = db::order_state(&state.store, &order_number)
        .map_err(display)?
        .ok_or("订单不存在。")?;
    if local.local_completed || local.shared_state.as_deref() == Some("completed") {
        return Ok(ClaimResponse {
            ok: false,
            claimed_by: None,
            claimed_name: None,
            claimed_at: None,
            message: Some("这笔订单已完成，如需修改请先点击「返工重开」。".into()),
        });
    }
    let my_id = db::device_id(&state.store)?;
    let my_name = db::device_name(&state.store)?;
    let now_ms = db::now_ms();
    let Some(target) = local.target.as_deref() else {
        db::update_claim_local(
            &state.store,
            &order_number,
            None,
            Some(&my_id),
            Some(&my_name),
            Some(now_ms),
        )
        .map_err(display)?;
        return Ok(ClaimResponse {
            ok: true,
            claimed_by: Some(my_id),
            claimed_name: Some(my_name),
            claimed_at: Some(now_ms),
            message: None,
        });
    };
    let mut index = shared_database(&state.data_root).await?;
    match index
        .claim(
            target,
            &order_number,
            &my_id,
            &my_name,
            now_ms,
            db::CLAIM_LEASE_MS,
            force.unwrap_or(false),
        )
        .await?
    {
        ClaimResult::Claimed | ClaimResult::NotFound => {
            db::update_claim_local(
                &state.store,
                &order_number,
                Some(target),
                Some(&my_id),
                Some(&my_name),
                Some(now_ms),
            )
            .map_err(display)?;
            Ok(ClaimResponse {
                ok: true,
                claimed_by: Some(my_id),
                claimed_name: Some(my_name),
                claimed_at: Some(now_ms),
                message: None,
            })
        }
        ClaimResult::HeldByOther {
            device_id,
            device_name,
            claimed_at,
        } => {
            db::update_claim_local(
                &state.store,
                &order_number,
                Some(target),
                Some(&device_id),
                Some(&device_name),
                Some(claimed_at),
            )
            .map_err(display)?;
            Ok(ClaimResponse {
                ok: false,
                claimed_by: Some(device_id),
                claimed_name: Some(device_name.clone()),
                claimed_at: Some(claimed_at),
                message: Some(format!("该订单正由「{device_name}」制作中")),
            })
        }
        ClaimResult::Completed => {
            if let Some(remote) = index.get(target, &order_number).await? {
                let _ = db::mark_remote_complete(
                    &state.store,
                    &order_number,
                    target,
                    &remote.operation_id,
                );
            }
            Ok(ClaimResponse {
                ok: false,
                claimed_by: None,
                claimed_name: None,
                claimed_at: None,
                message: Some("该订单已在其他设备标记完成。".into()),
            })
        }
    }
}

#[tauri::command]
pub(crate) async fn workflow_release_order(
    state: State<'_, AppState>,
    order_number: String,
    force: Option<bool>,
) -> Result<(), String> {
    let _operation = state.workflow_operations.lock().await;
    let local = db::order_state(&state.store, &order_number)
        .map_err(display)?
        .ok_or("订单不存在。")?;
    let my_id = db::device_id(&state.store)?;
    if let Some(target) = local.target.as_deref() {
        if crate::mysql::load_config(&state.data_root).valid() {
            let mut index = shared_database(&state.data_root).await?;
            let _ = index
                .release_claim(target, &order_number, &my_id, force.unwrap_or(false))
                .await?;
        }
    }
    db::update_claim_local(&state.store, &order_number, local.target.as_deref(), None, None, None)
        .map_err(display)?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn workflow_reopen(
    state: State<'_, AppState>,
    order_number: String,
) -> Result<(), String> {
    let _operation = state.workflow_operations.lock().await;
    let local = db::order_state(&state.store, &order_number)
        .map_err(display)?
        .ok_or("订单不存在。")?;
    if db::task(&state.store, &order_number, "publish")
        .map_err(display)?
        .is_some()
    {
        return Err("这笔订单有待确认的上传任务，请先处理。".into());
    }
    if let Some(target) = local.target.as_deref() {
        let mut index = shared_database(&state.data_root).await?;
        if let Some(current_record) = index.get(target, &order_number).await? {
            let expected_op = current_record.operation_id.clone();
            let mut order = OrderData::from_record(current_record)?;
            let new_op = random_hex_pub(16);
            order.operation_id.clone_from(&new_op);
            order.state = SharedState::Pending;
            order.completed_at = None;
            order.updated_at = crate::store::now();
            let payload = serde_json::to_string(&order).map_err(display)?;
            let shared = order.record(payload.clone());
            if !index.reopen(target, &expected_op, &shared).await? {
                return Err("共享订单状态已变化，请先同步后重试。".into());
            }
            db::reopen_local(
                &state.store,
                &order_number,
                Some(target),
                Some(&new_op),
                Some(&payload),
            )
            .map_err(display)?;
            return Ok(());
        }
    }
    db::reopen_local(&state.store, &order_number, None, None, None).map_err(display)
}

#[tauri::command]
pub(crate) async fn workflow_download_production(
    state: State<'_, AppState>,
    production_id: String,
) -> Result<crate::commands::ProductionDto, String> {
    let _operation = state.workflow_operations.lock().await;
    let row = state
        .store
        .get_production(&production_id)
        .map_err(display)?
        .ok_or("找不到该成品记录。")?;
    if !row.file_path.is_empty() && Path::new(&row.file_path).is_file() {
        return Ok(crate::commands::ProductionDto {
            id: row.id,
            order_number: row.order_number,
            image_id: row.image_id,
            file_path: row.file_path,
            created_at: row.created_at,
            original_name: row.original_name,
            byte_length: row.byte_length,
            remote_only: false,
            sync_status: None,
            sync_error: None,
        });
    }
    let remote_obj = row
        .remote_object_name
        .as_deref()
        .ok_or("该成品缺少共享存储路径，无法下载。")?;
    let order_state = db::order_state(&state.store, &row.order_number).map_err(display)?;
    let backend = match order_state.and_then(|st| st.target) {
        Some(target) => Backend::bound(&state.store, &state.data_root, &target)?,
        None => selected(&state)?,
    };
    let bytes = backend
        .get_image("production", remote_obj)
        .await?
        .ok_or("共享存储中未找到该成品文件。")?;
    if row.byte_length > 0 && bytes.len() as i64 != row.byte_length {
        return Err("下载的成品文件大小与记录不一致。".into());
    }
    let safe_dir = row
        .order_number
        .replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_");
    let safe_dir = safe_dir.trim_end_matches([' ', '.']);
    let folder = state
        .data_root
        .join("productions")
        .join(if safe_dir.is_empty() { "共享成品" } else { safe_dir });
    std::fs::create_dir_all(&folder).map_err(display)?;
    let clean_name = display_file_name(&row.original_name, "production.png");
    let file_path = folder.join(format!("{}_{}", row.id, clean_name));
    std::fs::write(&file_path, &bytes).map_err(display)?;
    db::save_downloaded_production(&state.store, &row.id, &file_path, bytes.len() as u64)
        .map_err(display)?;
    Ok(crate::commands::ProductionDto {
        id: row.id,
        order_number: row.order_number,
        image_id: row.image_id,
        file_path: file_path.to_string_lossy().into_owned(),
        created_at: row.created_at,
        original_name: clean_name,
        byte_length: bytes.len() as i64,
        remote_only: false,
        sync_status: None,
        sync_error: None,
    })
}

#[tauri::command]
pub(crate) async fn workflow_download_image(
    state: State<'_, AppState>,
    image_id: String,
) -> Result<crate::commands::ImageDto, String> {
    let _operation = state.workflow_operations.lock().await;
    let (order_id, order_number, remote_obj, expected_bytes, original_name): (
        String,
        String,
        Option<String>,
        i64,
        String,
    ) = {
        let conn = state.store.conn.lock().unwrap();
        conn.query_row(
            "SELECT i.order_id, o.order_number, i.remote_object_name, i.byte_length, i.original_name
             FROM images i JOIN orders o ON o.id = i.order_id WHERE i.id = ?1",
            [&image_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .map_err(display)?
    };
    if let Some(detail) = state.store.get_order(&order_id).map_err(display)? {
        if let Some(existing) = detail.images.iter().find(|img| img.id == image_id) {
            if !existing.file_path.is_empty() && Path::new(&existing.file_path).is_file() {
                return Ok(crate::commands::OrderEntryDto {
                    summary: crate::commands::OrderDto {
                        id: detail.id,
                        order_number: detail.order_number,
                        image_count: detail.images.len() as i64,
                        created_at: detail.created_at,
                        updated_at: detail.updated_at,
                        metadata: None,
                    },
                    images: Vec::new(),
                }
                .images
                .into_iter()
                .next()
                .unwrap_or_else(|| crate::commands::ImageDto {
                    id: existing.id.clone(),
                    file_path: existing.file_path.clone(),
                    thumbnail_path: existing.thumb_path.clone(),
                    original_name: existing.original_name.clone(),
                    byte_length: existing.byte_length,
                    width: existing.width,
                    height: existing.height,
                    source: existing.source.clone(),
                    created_at: existing.created_at.clone(),
                    remark: existing.remark.clone(),
                    remote_only: false,
                    source_quality: existing.source_quality.clone(),
                    sync_status: None,
                    sync_error: None,
                    templates: existing
                        .templates
                        .iter()
                        .map(|t| crate::commands::TemplateQtyDto {
                            template_id: t.template_id.clone(),
                            quantity: t.quantity,
                        })
                        .collect(),
                }));
            }
        }
    }
    let remote_obj = remote_obj.ok_or("该素材缺少共享存储路径，无法下载。")?;
    let order_state = db::order_state(&state.store, &order_number).map_err(display)?;
    let backend = match order_state.and_then(|st| st.target) {
        Some(target) => Backend::bound(&state.store, &state.data_root, &target)?,
        None => selected(&state)?,
    };
    let bytes = backend
        .get_image("original", &remote_obj)
        .await?
        .ok_or("共享存储中未找到该原图文件。")?;
    if expected_bytes > 0 && bytes.len() as i64 != expected_bytes {
        return Err("下载的原图文件大小与记录不一致。".into());
    }
    let decoded = image::load_from_memory(&bytes).map_err(display)?;
    let dir = state.store.cloud_import_directory(&order_number);
    std::fs::create_dir_all(&dir).map_err(display)?;
    let clean_name = display_file_name(&original_name, "photo.png");
    let file_path = dir.join(format!("{image_id}_{clean_name}"));
    std::fs::write(&file_path, &bytes).map_err(display)?;
    let thumb_path = dir.join(format!("{image_id}.thumb.jpg"));
    let saved_thumb = decoded
        .thumbnail(320, 320)
        .into_rgb8()
        .save(&thumb_path)
        .ok()
        .map(|_| thumb_path);
    db::save_downloaded_image(
        &state.store,
        &image_id,
        &file_path,
        saved_thumb.as_deref(),
        decoded.width(),
        decoded.height(),
        bytes.len() as u64,
    )
    .map_err(display)?;
    let detail = state
        .store
        .get_order(&order_id)
        .map_err(display)?
        .ok_or("订单不存在。")?;
    let updated = detail
        .images
        .into_iter()
        .find(|img| img.id == image_id)
        .ok_or("素材不存在。")?;
    Ok(crate::commands::ImageDto {
        id: updated.id,
        file_path: updated.file_path,
        thumbnail_path: updated.thumb_path,
        original_name: updated.original_name,
        byte_length: updated.byte_length,
        width: updated.width,
        height: updated.height,
        source: updated.source,
        created_at: updated.created_at,
        remark: updated.remark,
        remote_only: false,
        source_quality: updated.source_quality,
        sync_status: None,
        sync_error: None,
        templates: updated
            .templates
            .into_iter()
            .map(|t| crate::commands::TemplateQtyDto {
                template_id: t.template_id,
                quantity: t.quantity,
            })
            .collect(),
    })
}

#[tauri::command]
pub(crate) async fn workflow_sync(
    state: State<'_, AppState>,
    active_order: Option<String>,
) -> Result<Outcome, String> {
    synchronize(&state, active_order.as_deref()).await
}

pub(crate) async fn synchronize(
    state: &AppState,
    active_order: Option<&str>,
) -> Result<Outcome, String> {
    let _operation = state.workflow_operations.lock().await;
    synchronize_locked(state, active_order, true).await
}

pub(crate) async fn background_poll(state: &AppState) -> Option<Outcome> {
    let (auto_sync, _) = auto_sync_config(&state.store);
    if !auto_sync || !crate::mysql::load_config(&state.data_root).valid() {
        return None;
    }
    if Backend::configured_target(&state.store, &state.data_root)
        .ok()
        .flatten()
        .is_none()
    {
        return None;
    }
    let Ok(_guard) = state.workflow_operations.try_lock() else {
        return None;
    };
    synchronize_locked(state, None, true).await.ok()
}

async fn synchronize_locked(
    state: &AppState,
    active_order: Option<&str>,
    include_templates: bool,
) -> Result<Outcome, String> {
    let mut index = shared_database(&state.data_root).await?;
    let backend = selected(state)?;
    backend.check_connection().await?;
    let target = backend.target();
    let mut response = Outcome::default();
    if include_templates {
        response.templates_updated = crate::templates::sync_shared_quiet(state, &backend).await;
    }
    let mut cursor = db::sync_cursor(&state.store, &target).map_err(display)?;
    let mut can_advance_cursor = true;
    loop {
        let batch: Vec<SharedOrderRow> = index.read_since(&target, cursor, 200).await?;
        if batch.is_empty() {
            break;
        }
        let batch_len = batch.len();
        let mut last_seen_seq = cursor;
        for row in batch {
            last_seen_seq = row.change_seq;
            let number = row.order.number.clone();
            let raw_payload = row.order.payload.clone();
            let claim_tuple = (
                row.claimed_by.as_deref(),
                row.claimed_name.as_deref(),
                row.claimed_at,
            );
            let order = match OrderData::from_record(row.order) {
                Ok(order) => order,
                Err(error) => {
                    response.errors.push(format!("{number}：{error}"));
                    can_advance_cursor = false;
                    continue;
                }
            };
            match apply_shared_order_with_meta(
                state,
                &backend,
                order,
                &raw_payload,
                Some(claim_tuple),
                active_order,
                &mut response,
            )
            .await
            {
                Ok(()) => {
                    if can_advance_cursor && response.conflicts.is_empty() {
                        cursor = row.change_seq;
                        let _ = db::set_sync_cursor(&state.store, &target, cursor);
                    } else {
                        can_advance_cursor = false;
                    }
                }
                Err(error) => {
                    response.errors.push(format!("{number}：{error}"));
                    can_advance_cursor = false;
                }
            }
        }
        if batch_len < 200 || last_seen_seq == 0 {
            break;
        }
        // When a conflict or error blocked advancing the persistent cursor, continue scanning
        // newer items in this run using `last_seen_seq` without persisting past the blocked item.
        if !can_advance_cursor {
            cursor = last_seen_seq;
        }
    }
    Ok(response)
}

#[tauri::command]
pub(crate) async fn workflow_resolve_conflict(
    state: State<'_, AppState>,
    reference: String,
    local_version: Option<String>,
    active_order: Option<String>,
) -> Result<(), String> {
    let _operation = state.workflow_operations.lock().await;
    let (target, number, operation_id): (String, String, String) =
        serde_json::from_str(&reference).map_err(|_| "请选择有效的共享订单。")?;
    let local = db::order_state(&state.store, &number).map_err(display)?;
    if local.as_ref().map(OrderState::version) != local_version {
        return Err("本机订单已变化，请关闭提示后重新操作。".into());
    }
    if db::role(&state.store) == "customer" {
        let local = local.ok_or("排单端只能处理本机订单的上传冲突。")?;
        let allowed_target = match local.target {
            Some(target) => Some(target),
            None => Backend::configured_target(&state.store, &state.data_root)?,
        };
        if allowed_target.as_deref() != Some(&target) {
            return Err("该订单的共享存储已切换，请关闭提示后重新上传。".into());
        }
    }
    let backend = Backend::bound(&state.store, &state.data_root, &target)?;
    let mut index = shared_database(&state.data_root).await?;
    let current = remote_order(&mut index, &target, &number).await?;
    let order = reviewed_order(current, &operation_id)?;
    if active_order.as_deref() == Some(&order.order_number) {
        return Err("这笔订单仍在编辑中，请切换编辑订单后再同步。".into());
    }
    let downloaded = download(&state, &backend, &order).await?;
    let latest = remote_order(&mut index, &target, &number).await?;
    let order = reviewed_order(latest, &operation_id)?;
    let raw_payload = serde_json::to_string(&order).map_err(display)?;
    apply_download(
        &state.store,
        &order,
        downloaded,
        ImportAction::Replace,
        local_version.as_deref(),
        Some(&target),
        Some(&raw_payload),
        None,
    )
}

fn reviewed_order(current: Option<OrderData>, reviewed: &str) -> Result<OrderData, String> {
    let current = current.ok_or("共享订单已不存在，本机订单和素材已保留。")?;
    if current.state == SharedState::Completed {
        return Err("共享订单已标记完成，本机订单和素材已保留。".into());
    }
    if reviewed != current.operation_id {
        return Err("共享订单在确认期间已变化，请关闭提示后重新操作。".into());
    }
    Ok(current)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn workstation(dir: &tempfile::TempDir) -> AppState {
        AppState {
            store: Arc::new(Store::open(dir.path()).unwrap()),
            data_root: dir.path().into(),
            port: 0,
            cloud: Arc::new(crate::cloud::Sync::new()),
            workflow_operations: tokio::sync::Mutex::new(()),
        }
    }

    fn capture_order(state: &AppState, number: &str) {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        state
            .store
            .ingest_image(number, bytes.get_ref(), "image/png", &[], "fixture")
            .unwrap();
    }

    #[tokio::test]
    async fn shared_sync_requires_mysql() {
        let dir = tempfile::tempdir().unwrap();
        let state = workstation(&dir);
        let error = synchronize(&state, None).await.err().unwrap();
        assert!(error.contains("共享数据库"), "{error}");
    }

    #[tokio::test]
    async fn saved_mysql_connection_is_attempted_with_legacy_switch_off() {
        let dir = tempfile::tempdir().unwrap();
        let state = workstation(&dir);
        let (listener, _) = crate::qiniu_transport::tests::local_server();
        let config = crate::mysql::MysqlConfig {
            enabled: false,
            host: "127.0.0.1".into(),
            port: listener.local_addr().unwrap().port(),
            user: "fixture".into(),
            ..Default::default()
        };
        crate::mysql::save_config(&state.data_root, &config).unwrap();
        // Return a connection failure without contacting an actual database.
        drop(listener);
        let error = synchronize(&state, None).await.err().unwrap();
        assert!(error.contains("请确保共享数据库（MySQL）可连接并可用"), "{error}");
    }

    #[tokio::test]
    async fn local_order_can_be_completed_without_an_export() {
        use tauri::Manager;
        let dir = tempfile::tempdir().unwrap();
        let state = workstation(&dir);
        capture_order(&state, "local-no-export");
        let app = tauri::test::mock_builder()
            .manage(state)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let result = workflow_finish(app.state(), "local-no-export".into())
            .await
            .unwrap();
        assert_eq!(result.completed, 1);
        let state = app.state::<AppState>();
        let order = db::order_state(&state.store, "local-no-export")
            .unwrap()
            .unwrap();
        assert!(order.local_completed);
        assert!(state
            .store
            .list_productions("local-no-export")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn completion_reuses_the_uploaded_original_and_preserves_local_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let state = workstation(&dir);
        let number = "订单-001";
        capture_order(&state, number);
        let (published, sources) = snapshot(
            &state.store,
            &state.data_root,
            number,
            "publish",
            None,
            false,
            &random_hex_pub(16),
        )
        .unwrap();
        assert_eq!(sources.len(), 1);
        assert!(!state.data_root.join("workflow-outbox").exists());
        db::set_layout(&state.store, number, "ch-555").unwrap();
        let archive = state.data_root.join("productions");
        std::fs::create_dir(&archive).unwrap();
        let file = archive.join("finished.png");
        let original = &sources[&published.assets[0].id];
        std::fs::copy(state.data_root.join(&original.path), &file).unwrap();
        state
            .store
            .add_production(&random_hex_pub(16), number, None, &file)
            .unwrap();
        let (completed, sources) = snapshot(
            &state.store,
            &state.data_root,
            number,
            "finish",
            Some(&published),
            true,
            &random_hex_pub(16),
        )
        .unwrap();
        assert_eq!(sources.len(), 1);
        assert!(completed.state == SharedState::Completed);
        assert_eq!(completed.assets.len(), 2);
        assert!(!completed.assets[0].object_name.contains('/'));
        assert_eq!(
            completed.assets[0].object_name,
            published.assets[0].object_name
        );
        assert!(completed.assets[1].production());
        assert!(completed.assets[1]
            .object_name
            .starts_with(&format!("{}/", order_key_segment(number))));
        assert!(!outbox_file(
            &state.data_root,
            &completed.operation_id,
            &completed.assets[0].id
        )
        .exists());
        let payload = serde_json::to_string(&completed).unwrap();
        let record = completed.record(payload);
        assert!(record.completed);
        let decoded = OrderData::from_record(record).unwrap();
        assert_eq!(decoded.metadata.unwrap()["layoutNumber"], "ch-555");
    }

    #[test]
    fn order_folders_preserve_standard_ids_and_escape_unsafe_paths() {
        assert_eq!(order_key_segment("001234"), "001234");
        assert_eq!(order_key_segment("A/B"), "~QS9C");
        assert_eq!(order_key_segment(".."), "~Li4");
        assert_ne!(order_key_segment("A/B"), order_key_segment("~QS9C"));
    }

    #[test]
    fn archived_source_survives_restart_and_detects_changes_at_the_same_size() {
        let dir = tempfile::tempdir().unwrap();
        let number = "archive-001";
        let root = dir.path().canonicalize().unwrap();
        let (id, size) = {
            let state = workstation(&dir);
            capture_order(&state, number);
            let local = db::order_state(&state.store, number).unwrap().unwrap();
            let (order, sources) = snapshot(
                &state.store,
                &root,
                number,
                "publish",
                None,
                true,
                &random_hex_pub(16),
            )
            .unwrap();
            let asset = &order.assets[0];
            db::insert_task(
                &state.store,
                &Task {
                    number: number.into(),
                    kind: "publish".into(),
                    target: "fixture".into(),
                    expected_operation_id: None,
                    generation: local.generation,
                    payload: serde_json::to_string(&order).unwrap(),
                    source_files: Some(serde_json::to_string(&sources).unwrap()),
                },
                &local.version(),
            )
            .unwrap();
            (asset.id.clone(), asset.bytes)
        };

        let state = workstation(&dir);
        let task = db::task(&state.store, number, "publish").unwrap().unwrap();
        let sources: SourceFiles =
            serde_json::from_str(task.source_files.as_ref().unwrap()).unwrap();
        let source = &sources[&id];
        assert!(source.path.starts_with("images"));
        assert!(!task
            .payload
            .contains(&source.path.to_string_lossy().replace('\\', "\\\\")));
        let path = root.join(&source.path);
        let mut bytes = source.read(&root, size).unwrap();
        *bytes.last_mut().unwrap() ^= 1;
        std::fs::write(&path, &bytes).unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(source.modified - std::time::Duration::from_secs(10))
            .unwrap();
        assert!(source.read(&root, size).unwrap_err().contains("已变化"));
        std::fs::remove_file(path).unwrap();
        assert!(source.read(&root, size).is_err());
        assert!(!root.join("workflow-outbox").exists());
    }

    fn live_config() -> crate::mysql::MysqlConfig {
        let path =
            std::env::var_os("VAGAGA_TEST_MYSQL_CONFIG").expect("set VAGAGA_TEST_MYSQL_CONFIG");
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    #[tokio::test]
    #[ignore = "requires a dedicated MySQL test database"]
    async fn upload_retry_checks_mysql_before_handling_a_missing_archive() {
        let dir = tempfile::tempdir().unwrap();
        let state = workstation(&dir);
        let config = crate::cloud::CloudConfig {
            endpoint: "http://127.0.0.1:1".into(),
            bucket: "fixture".into(),
            access_key: "fixture".into(),
            secret_key: "fixture".into(),
            ..Default::default()
        };
        let backend = Backend::Nas(config.clone(), config.client().unwrap());
        let mut index = MyClient::new(&live_config()).order_index().await.unwrap();
        for remote_received in [false, true] {
            let number = format!("retry-{}", random_hex_pub(8));
            capture_order(&state, &number);
            let local = db::order_state(&state.store, &number).unwrap().unwrap();
            let (order, sources) = snapshot(
                &state.store,
                &state.data_root,
                &number,
                "publish",
                None,
                backend.uses_order_directory(),
                &random_hex_pub(16),
            )
            .unwrap();
            let task = Task {
                number: number.clone(),
                kind: "publish".into(),
                target: backend.target(),
                expected_operation_id: None,
                generation: local.generation,
                payload: serde_json::to_string(&order).unwrap(),
                source_files: Some(serde_json::to_string(&sources).unwrap()),
            };
            db::insert_task(&state.store, &task, &local.version()).unwrap();
            if remote_received {
                assert!(index
                    .write(&task.target, None, &order.record(task.payload.clone()))
                    .await
                    .unwrap());
            }
            let source = &sources[&order.assets[0].id];
            std::fs::remove_file(state.data_root.join(&source.path)).unwrap();
            let result = run_task(&state, &backend, &mut index, &task).await;
            if remote_received {
                assert!(result.ok().unwrap().is_none());
                let local = db::order_state(&state.store, &number).unwrap().unwrap();
                assert_eq!(
                    local.remote_operation_id.as_deref(),
                    Some(order.operation_id.as_str())
                );
            } else {
                assert!(result.err().unwrap().contains("请检查素材后重新操作"));
                assert!(index.get(&task.target, &number).await.unwrap().is_none());
            }
            assert!(db::task(&state.store, &number, "publish")
                .unwrap()
                .is_none());
            assert!(!state.data_root.join("workflow-outbox").exists());
        }
    }

    #[tokio::test]
    #[ignore = "requires a dedicated MySQL test database"]
    async fn customer_can_apply_an_upload_conflict_and_keeps_local_material_if_remote_finishes() {
        use crate::qiniu_transport::tests::{local_server, receive, reply};
        use tauri::Manager;

        let dir = tempfile::tempdir().unwrap();
        let state = workstation(&dir);
        let (listener, endpoint) = local_server();
        let config = crate::cloud::CloudConfig {
            enabled: true,
            endpoint,
            bucket: "fixture".into(),
            access_key: "fixture".into(),
            secret_key: "fixture".into(),
            ..Default::default()
        };
        std::fs::write(
            crate::cloud::config_path(&state.data_root),
            serde_json::to_vec(&config).unwrap(),
        )
        .unwrap();
        let mysql = live_config();
        crate::mysql::save_config(&state.data_root, &mysql).unwrap();
        db::put_setting(&state.store, "role", "customer").unwrap();
        let mut index = MyClient::new(&mysql).order_index().await.unwrap();
        let target = config.target();
        let number = format!("conflict-{}", random_hex_pub(8));
        capture_order(&state, &number);
        let (mut shared, sources) = snapshot(
            &state.store,
            &state.data_root,
            &number,
            "publish",
            None,
            false,
            &random_hex_pub(16),
        )
        .unwrap();
        let asset = &shared.assets[0];
        let path = format!("GET /fixture/materials/original/{}", asset.object_name);
        let bytes = sources[&asset.id]
            .read(&state.data_root.canonicalize().unwrap(), asset.bytes)
            .unwrap();
        let record = shared.record(serde_json::to_string(&shared).unwrap());
        assert!(index.write(&target, None, &record).await.unwrap());
        let app = tauri::test::mock_builder()
            .manage(state)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();

        let resolve = |conflict: Preview| {
            workflow_resolve_conflict(
                app.state(),
                conflict.reference,
                conflict.local_version,
                None,
            )
        };
        let (serve_first, serve_second) = (path.clone(), path);
        let storage = target.clone();
        let server = std::thread::spawn(move || {
            let probe = || {
                let (socket, _) = receive(&listener, "GET /fixture/?list-type=2&max-keys=1");
                reply(socket, 200, &[], b"<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>");
            };
            probe();
            let (socket, _) = receive(&listener, &serve_first);
            reply(socket, 200, &[], &bytes);
            probe();
            let (socket, _) = receive(&listener, &serve_second);
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                let mut index = MyClient::new(&mysql).order_index().await.unwrap();
                let record = index.get(&storage, &record.number).await.unwrap().unwrap();
                let mut completed = OrderData::from_record(record).unwrap();
                let expected = std::mem::replace(&mut completed.operation_id, random_hex_pub(16));
                completed.state = SharedState::Completed;
                let record = completed.record(serde_json::to_string(&completed).unwrap());
                assert!(index
                    .write(&storage, Some(&expected), &record)
                    .await
                    .unwrap());
            });
            reply(socket, 200, &[], &bytes);
        });
        let first = workflow_upload(app.state(), vec![number.clone()])
            .await
            .unwrap();
        assert_eq!(first.updated, 0);
        assert!(first.errors.is_empty());
        resolve(first.conflicts.into_iter().next().unwrap())
            .await
            .unwrap();
        let state = app.state::<AppState>();
        assert_eq!(state.store.list_orders().unwrap().len(), 2);

        let expected = std::mem::replace(&mut shared.operation_id, random_hex_pub(16));
        let record = shared.record(serde_json::to_string(&shared).unwrap());
        assert!(index
            .write(&target, Some(&expected), &record)
            .await
            .unwrap());
        let second = workflow_upload(app.state(), vec![number.clone()])
            .await
            .unwrap();
        let error = resolve(second.conflicts.into_iter().next().unwrap())
            .await
            .unwrap_err();
        assert!(error.contains("共享订单已标记完成"));
        assert_eq!(state.store.list_orders().unwrap().len(), 2);
        let local = db::order_state(&state.store, &number).unwrap().unwrap();
        assert_eq!(
            local.remote_operation_id.as_deref(),
            Some(expected.as_str())
        );
        server.join().unwrap();
    }

    #[tokio::test]
    async fn download_follows_database_image_reference_for_a_plain_order_number() {
        use crate::qiniu_transport::tests::{local_server, receive, reply};
        let sender_dir = tempfile::tempdir().unwrap();
        let receiver_dir = tempfile::tempdir().unwrap();
        let sender = workstation(&sender_dir);
        let receiver = workstation(&receiver_dir);
        let number = "001234";
        capture_order(&sender, number);
        db::set_layout(&sender.store, number, "ch-555").unwrap();
        let (order, sources) = snapshot(
            &sender.store,
            &sender.data_root,
            number,
            "publish",
            None,
            true,
            &random_hex_pub(16),
        )
        .unwrap();
        let asset = &order.assets[0];
        assert!(
            asset.object_name.starts_with("001234/"),
            "object reference must include the order number: {}",
            asset.object_name
        );
        let bytes = sources[&asset.id]
            .read(&sender.data_root.canonicalize().unwrap(), asset.bytes)
            .unwrap();
        let (listener, endpoint) = local_server();
        let config = crate::cloud::CloudConfig {
            enabled: true,
            endpoint,
            bucket: "fixture".into(),
            access_key: "fixture".into(),
            secret_key: "fixture".into(),
            ..Default::default()
        };
        let (_, name) = asset.object_name.split_once('/').unwrap();
        let path = format!("/fixture/materials/001234/original/{name}");
        let served = bytes.clone();
        let server = std::thread::spawn(move || {
            let (socket, upload) = receive(&listener, &format!("PUT {path}"));
            assert_eq!(upload.body, served);
            reply(socket, 200, &[], b"");
            let (socket, _) = receive(&listener, &format!("GET {path}"));
            reply(socket, 200, &[], &served);
        });
        let backend = Backend::Nas(config.clone(), config.client().unwrap());
        backend
            .put_image(asset.folder(), &asset.object_name, bytes.clone())
            .await
            .unwrap();
        let mut result = Outcome::default();
        let record = order.record(serde_json::to_string(&order).unwrap());
        apply_shared_order(
            &receiver,
            &backend,
            OrderData::from_record(record.clone()).unwrap(),
            None,
            &mut result,
        )
        .await
        .unwrap();
        server.join().unwrap();
        assert_eq!(result.updated, 1);
        let received = receiver.store.get_order_by_number(number).unwrap().unwrap();
        assert_eq!(std::fs::read(&received.images[0].file_path).unwrap(), bytes);
        assert!(receiver
            .store
            .order_metadata_by_number(number)
            .unwrap()
            .unwrap()
            .contains("ch-555"));
        // An unchanged row does not make another request to the file store.
        apply_shared_order(
            &receiver,
            &backend,
            OrderData::from_record(record).unwrap(),
            None,
            &mut result,
        )
        .await
        .unwrap();
        assert_eq!(result.updated, 1);
    }

    #[test]
    fn multi_customer_merge_combines_disjoint_uploads_and_detects_true_conflicts() {
        let make_asset = |id: &str, tpl: &str, qty: i64, remark: &str| Asset {
            id: id.into(),
            kind: AssetKind::Original,
            name: "photo.png".into(),
            object_name: format!("001/{id}.png"),
            bytes: 128,
            image_id: None,
            width: Some(10),
            height: Some(10),
            quality: Some("original".into()),
            remark: Some(remark.into()),
            templates: vec![Template {
                template_id: tpl.into(),
                quantity: qty,
            }],
        };
        let a1 = random_hex_pub(16);
        let a2 = random_hex_pub(16);
        let remote = OrderData {
            order_number: "001".into(),
            operation_id: random_hex_pub(16),
            state: SharedState::Pending,
            metadata: Some(db::metadata(Some(r#"{"amount":"19.90"}"#))),
            assets: vec![make_asset(&a1, "模板爱心.png", 1, "客服A备注")],
            updated_at: "2026-11-26T00:00:00Z".into(),
            completed_at: None,
        };
        let local_new = OrderData {
            order_number: "001".into(),
            operation_id: random_hex_pub(16),
            state: SharedState::Pending,
            metadata: Some(db::metadata(Some(r#"{"layoutNumber":"ch-888"}"#))),
            assets: vec![make_asset(&a2, "草莓.png", 2, "客服B补图")],
            updated_at: "2026-11-26T00:01:00Z".into(),
            completed_at: None,
        };
        // Disjoint uploads without base merge cleanly.
        let merged = merge_publish_data(&local_new, &remote, None).expect("disjoint merge");
        assert_eq!(merged.assets.len(), 2);
        assert_eq!(merged.metadata.as_ref().unwrap()["amount"], "19.90");
        assert_eq!(merged.metadata.as_ref().unwrap()["layoutNumber"], "ch-888");

        // With base = merged, non-overlapping edits on a1 (remote) and a2 (local) merge cleanly.
        let mut remote_v2 = merged.clone();
        remote_v2.operation_id = random_hex_pub(16);
        remote_v2.assets[0].remark = Some("客服A更新备注".into());

        let mut local_v2 = merged.clone();
        local_v2.operation_id = random_hex_pub(16);
        local_v2.assets[1].templates[0].quantity = 5;

        let merged_v2 =
            merge_publish_data(&local_v2, &remote_v2, Some(&merged)).expect("3-way merge");
        assert_eq!(merged_v2.assets[0].remark.as_deref(), Some("客服A更新备注"));
        assert_eq!(merged_v2.assets[1].templates[0].quantity, 5);

        // Concurrent conflicting edit on the SAME asset's templates triggers manual conflict resolution.
        let mut local_conflict = merged.clone();
        local_conflict.assets[0].templates[0].quantity = 3;
        let mut remote_conflict = merged.clone();
        remote_conflict.assets[0].templates[0].quantity = 4;
        assert!(merge_publish_data(&local_conflict, &remote_conflict, Some(&merged)).is_none());
    }

    #[tokio::test]
    async fn completed_order_syncs_to_customer_with_lazy_productions_and_can_reopen() {
        let customer_dir = tempfile::tempdir().unwrap();
        let customer = workstation(&customer_dir);
        db::put_setting(&customer.store, "role", "customer").unwrap();
        let config = crate::cloud::CloudConfig {
            enabled: true,
            endpoint: "http://127.0.0.1:1".into(),
            bucket: "fixture".into(),
            access_key: "fixture".into(),
            secret_key: "fixture".into(),
            ..Default::default()
        };
        let backend = Backend::Nas(config.clone(), config.client().unwrap());
        let orig_id = random_hex_pub(16);
        let prod_id = random_hex_pub(16);
        let completed_order = OrderData {
            order_number: "DONE-100".into(),
            operation_id: random_hex_pub(16),
            state: SharedState::Completed,
            metadata: Some(db::metadata(Some(r#"{"layoutNumber":"yy-100"}"#))),
            assets: vec![
                Asset {
                    id: orig_id.clone(),
                    kind: AssetKind::Original,
                    name: "buyer.png".into(),
                    object_name: format!("DONE-100/{orig_id}.png"),
                    bytes: 200,
                    image_id: None,
                    width: Some(100),
                    height: Some(100),
                    quality: Some("original".into()),
                    remark: None,
                    templates: Vec::new(),
                },
                Asset {
                    id: prod_id.clone(),
                    kind: AssetKind::Production,
                    name: "ch-20261126-100_成品.png".into(),
                    object_name: format!("DONE-100/{prod_id}.png"),
                    bytes: 4096,
                    image_id: Some(orig_id),
                    width: None,
                    height: None,
                    quality: None,
                    remark: None,
                    templates: Vec::new(),
                },
            ],
            updated_at: "2026-11-26T01:00:00Z".into(),
            completed_at: Some("2026-11-26T01:05:00Z".into()),
        };
        let mut outcome = Outcome::default();
        // Endpoint is unreachable (127.0.0.1:1), proving zero network download happens for completed sync!
        apply_shared_order(&customer, &backend, completed_order, None, &mut outcome)
            .await
            .unwrap();
        assert_eq!(outcome.completed, 1);
        let prods = customer.store.list_productions("DONE-100").unwrap();
        assert_eq!(prods.len(), 1);
        assert!(prods[0].file_path.is_empty());
        assert_eq!(prods[0].byte_length, 4096);
        assert!(prods[0].remote_object_name.is_some());

        // Local reopen resets completed state back to pending.
        db::reopen_local(&customer.store, "DONE-100", None, None, None).unwrap();
        let reopened = db::order_state(&customer.store, "DONE-100").unwrap().unwrap();
        assert!(!reopened.local_completed);
        assert_eq!(reopened.shared_state.as_deref(), Some("pending"));
    }
}
