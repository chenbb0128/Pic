use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::mysql::{MyClient, OrderIndex, SharedOrder};
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

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Template {
    template_id: String,
    quantity: i64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum AssetKind {
    Original,
    Production,
}

#[derive(Deserialize, Serialize)]
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

#[derive(Deserialize, Serialize)]
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
            let mut name = file_name(path, "production.png");
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
            let source = record_asset(&root, &mut asset, path, order_directory.as_deref())
                .map_err(|error| format!("读取 {} 失败：{error}", asset.name))?;
            sources.insert(asset.id.clone(), source);
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
    updated: usize,
    completed: usize,
    uploaded_order_numbers: Vec<String>,
    conflicts: Vec<Preview>,
    errors: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Settings {
    role: String,
    target: Option<String>,
    storage_provider: Option<&'static str>,
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

#[tauri::command]
pub(crate) fn workflow_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    let storage = crate::workflow_storage::Configuration::load(&state.store, &state.data_root)?;
    Ok(Settings {
        role: db::role(&state.store),
        target: storage.as_ref().and_then(|configuration| configuration.target()),
        storage_provider: storage.as_ref().map(|configuration| configuration.provider()),
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
        return Err("这笔订单已标记完成。".into());
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
    if !current_matches(previous.as_ref(), expected) {
        return shared_conflict(&state.store, &target, previous.as_ref()).map(Some);
    }
    let operation = random_hex_pub(16);
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
    directory: tempfile::TempDir,
    assets: Vec<ImportedAsset>,
}

async fn download(
    state: &AppState,
    backend: &Backend,
    order: &OrderData,
) -> Result<Download, String> {
    crate::templates::fetch_missing(state, backend, order.template_ids()).await?;
    let directory = download_directory(&state.data_root)?;
    let mut assets = Vec::new();
    for asset in &order.assets {
        let bytes = backend
            .get_image(asset.folder(), &asset.object_name)
            .await?
            .ok_or_else(|| format!("共享文件缺失：{}", asset.name))?;
        if bytes.len() as u64 != asset.bytes {
            return Err(format!("共享文件校验失败：{}", asset.name));
        }
        assets.push(write_import_file(directory.path(), asset, &bytes)?);
    }
    Ok(Download { directory, assets })
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
        let download = Download { directory, assets };
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
        )?;
        notices.push((number, new_images, new_productions));
    }
    Ok(notices)
}

fn apply_download(
    store: &Store,
    order: &OrderData,
    request: Download,
    action: ImportAction,
    expected: Option<&str>,
    target: Option<&str>,
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
        },
    )?;
    let _ = request.directory.keep();
    Ok(())
}

async fn apply_shared_order(
    state: &AppState,
    backend: &Backend,
    order: OrderData,
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
        return Ok(());
    }
    if order.state == SharedState::Completed {
        if same_target
            && db::mark_remote_complete(&state.store, number, &target, &order.operation_id)
                .map_err(display)?
        {
            result.completed += 1;
        }
        return Ok(());
    }
    if active_order == Some(number)
        || local.as_ref().is_some_and(|local| {
            !same_target || local.generation != local.synced_generation || local.local_completed
        })
    {
        result
            .conflicts
            .push(shared_conflict(&state.store, &target, Some(&order))?);
        return Ok(());
    }
    let version = local.as_ref().map(OrderState::version);
    let downloaded = download(state, backend, &order).await?;
    apply_download(
        &state.store,
        &order,
        downloaded,
        ImportAction::Sync,
        version.as_deref(),
        Some(&target),
    )?;
    result.updated += 1;
    Ok(())
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
    if db::role(&state.store) == "customer" {
        return Err("当前是排单端，请在制作端或二合一设备同步订单。".into());
    }
    let mut index = shared_database(&state.data_root).await?;
    let backend = selected(state)?;
    backend.check_connection().await?;
    let mut response = Outcome::default();
    for record in index.read(&backend.target()).await? {
        let number = record.number.clone();
        let order = match OrderData::from_record(record) {
            Ok(order) => order,
            Err(error) => {
                response.errors.push(format!("{number}：{error}"));
                continue;
            }
        };
        if let Err(error) =
            apply_shared_order(state, &backend, order, active_order, &mut response).await
        {
            response.errors.push(format!("{number}：{error}"));
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
    reviewed_order(latest, &operation_id)?;
    apply_download(
        &state.store,
        &order,
        downloaded,
        ImportAction::Replace,
        local_version.as_deref(),
        Some(&target),
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
}
