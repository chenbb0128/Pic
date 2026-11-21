use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::store::{random_hex_pub, Store};
use crate::workflow_db::{self as db, ImportAction, ImportedAsset, OrderState, Task};
use crate::workflow_storage::Backend;
use crate::AppState;

const MAX_ASSET_BYTES: u64 = 104_857_600;

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
    sha256: String,
    bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    image_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    quality: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    templates: Vec<Template>,
}

impl Asset {
    fn production(&self) -> bool {
        matches!(self.kind, AssetKind::Production)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u32,
    order_number: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    revision: Option<u64>,
    operation_id: String,
    state: SharedState,
    metadata: Option<serde_json::Map<String, serde_json::Value>>,
    assets: Vec<Asset>,
    updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    completed_at: Option<String>,
    local_completed: bool,
}

impl Manifest {
    fn mysql_order(&self) -> crate::mysql::SharedOrder {
        crate::mysql::SharedOrder {
            number: self.order_number.clone(),
            revision: self.revision.unwrap_or(0),
            operation_id: self.operation_id.clone(),
            metadata: self.metadata.clone().map(serde_json::Value::Object),
            completed: self.state == SharedState::Completed,
        }
    }

    fn parse(bytes: &[u8]) -> Result<Self, String> {
        let manifest: Self = serde_json::from_slice(bytes).map_err(display)?;
        if manifest.schema_version != 1
            || manifest.order_number.trim().is_empty()
            || manifest.order_number.len() > 256
            || !hex_id(&manifest.operation_id, 32)
        {
            return Err("共享订单清单无效或版本不兼容。".into());
        }
        let mut ids = std::collections::HashSet::new();
        if manifest.assets.iter().any(|asset| {
            !hex_id(&asset.sha256, 64)
                || asset.bytes == 0
                || asset.bytes > MAX_ASSET_BYTES
                || !hex_id(&asset.id, 32)
                || !ids.insert(asset.id.as_str())
        }) {
            return Err("共享订单包含无效或重复的素材记录。".into());
        }
        Ok(manifest)
    }
}

fn hash(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
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

fn outbox_file(root: &Path, operation: &str, digest: &str) -> PathBuf {
    root.join("workflow-outbox").join(operation).join(digest)
}

fn file_name(path: &Path, fallback: &str) -> String {
    path.file_name()
        .and_then(|part| part.to_str())
        .unwrap_or(fallback)
        .to_owned()
}

fn stage_asset(root: &Path, operation: &str, asset: &mut Asset, from: &Path) -> Result<(), String> {
    let size = std::fs::metadata(from)
        .map_err(|err| format!("读取 {} 失败：{err}", asset.name))?
        .len();
    if size == 0 || size > MAX_ASSET_BYTES {
        return Err(format!("文件大小超限或为空：{}", asset.name));
    }
    let bytes = std::fs::read(from).map_err(display)?;
    if bytes.len() as u64 != size {
        return Err(format!("文件在读取期间发生变化：{}", asset.name));
    }
    asset.bytes = size;
    asset.sha256 = hash(&bytes);
    let destination = outbox_file(root, operation, &asset.sha256);
    let parent = destination.parent().expect("outbox asset directory");
    std::fs::create_dir_all(parent).map_err(display)?;
    if !destination.exists() {
        let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(display)?;
        temporary.write_all(&bytes).map_err(display)?;
        temporary.as_file().sync_all().map_err(display)?;
        temporary.persist_noclobber(destination).map_err(display)?;
    }
    Ok(())
}

fn snapshot(
    store: &Store,
    root: &Path,
    number: &str,
    kind: &str,
    include_remote_revision: bool,
    operation: &str,
) -> Result<Manifest, String> {
    let detail = store
        .get_order_by_number(number)
        .map_err(display)?
        .ok_or("订单不存在。")?;
    let state = db::order_state(store, number)
        .map_err(display)?
        .ok_or("订单不存在。")?;
    let mut assets = Vec::new();
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
            sha256: String::new(),
            bytes: 0,
            image_id: None,
            width: u32::try_from(image.width).ok(),
            height: u32::try_from(image.height).ok(),
            quality,
            templates: image
                .templates
                .into_iter()
                .map(|template| Template {
                    template_id: template.template_id,
                    quantity: template.quantity,
                })
                .collect(),
        };
        stage_asset(root, operation, &mut asset, Path::new(&image.file_path))?;
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
                sha256: String::new(),
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
                templates: Vec::new(),
            };
            if asset.image_id.as_ref().is_some_and(|id| {
                !assets
                    .iter()
                    .any(|asset| !asset.production() && &asset.id == id)
            }) {
                asset.image_id = None;
            }
            stage_asset(root, operation, &mut asset, path)?;
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
    Ok(Manifest {
        schema_version: 1,
        order_number: number.into(),
        // This is a remote protocol timestamp for MySQL/七牛 compatibility,
        // not a value persisted in the local workflow database.
        revision: include_remote_revision
            .then(|| chrono::Utc::now().timestamp_millis().max(1) as u64),
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
        local_completed: kind == "finish" || is_completed,
    })
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
pub(crate) struct Settings {
    role: String,
    target: Option<String>,
}

fn preview(store: &Store, manifest: &Manifest, reference: String) -> Result<Preview, String> {
    let local = db::order_state(store, &manifest.order_number).map_err(display)?;
    let current_metadata = store
        .order_metadata_by_number(&manifest.order_number)
        .map_err(display)?;
    let current = db::metadata(current_metadata.as_deref());
    let empty = serde_json::Map::new();
    let incoming = manifest.metadata.as_ref().unwrap_or(&empty);
    let mut changes = Vec::new();
    for (key, label) in [
        ("layoutNumber", "排版编号"),
        ("merchantRemark", "商家备注"),
        ("status", "订单状态"),
        ("amount", "金额"),
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
    let originals = manifest
        .assets
        .iter()
        .filter(|asset| !asset.production())
        .count();
    let products = manifest.assets.len() - originals;
    changes.push(format!(
        "远端含 {originals} 张素材、{products} 个成品，使用共享内容会更新本机素材。"
    ));
    Ok(Preview {
        reference,
        order_number: manifest.order_number.clone(),
        updated_at: manifest.updated_at.clone(),
        local_version: local.as_ref().map(OrderState::version),
        changes,
    })
}

fn selected(state: &AppState) -> Result<Backend, String> {
    Backend::current(&state.store, &state.data_root)?
        .ok_or_else(|| "请先在设置中启用共享存储。".into())
}

#[tauri::command]
pub(crate) fn workflow_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(Settings {
        role: db::role(&state.store),
        target: Backend::configured_target(&state.store, &state.data_root)?,
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

async fn run_task(
    state: &AppState,
    backend: &Backend,
    task: &Task,
    checked_capability: bool,
) -> Result<(), String> {
    let result = run_task_attempt(state, backend, task, checked_capability).await;
    if let Err(error) = &result {
        if let Some(reconnected) = backend.reconnect_smb_after(error)? {
            return run_task_attempt(state, &reconnected, task, checked_capability).await;
        }
    }
    result
}

async fn run_task_attempt(
    state: &AppState,
    backend: &Backend,
    task: &Task,
    checked_capability: bool,
) -> Result<(), String> {
    let manifest = Manifest::parse(task.manifest.as_bytes())?;
    let key = backend.key_for_order(&task.number)?;
    let result: Result<bool, String> = async {
        if let Some(bytes) = backend.latest(&key).await? {
            let latest = Manifest::parse(&bytes)?;
            if latest.state == SharedState::Completed {
                return Ok(false);
            }
            if latest.operation_id != manifest.operation_id
                && task.expected_operation_id.as_deref() != Some(latest.operation_id.as_str())
            {
                return Ok(false);
            }
        }
        if task.expected_operation_id.is_none() && !checked_capability {
            check_capability(backend).await?;
        }
        for asset in &manifest.assets {
            let bytes = tokio::fs::read(outbox_file(
                &state.data_root,
                &manifest.operation_id,
                &asset.sha256,
            ))
            .await
            .map_err(display)?;
            if bytes.len() as u64 != asset.bytes || hash(&bytes) != asset.sha256 {
                return Err("待上传文件与清单不一致。".into());
            }
            backend.put_blob(&asset.sha256, bytes).await?;
        }
        backend
            .commit(
                &key,
                task.expected_operation_id.as_deref(),
                &manifest.operation_id,
                task.manifest.as_bytes().to_vec(),
            )
            .await
    }
    .await;
    let applied = match result {
        Ok(applied) => applied,
        Err(error) => {
            db::fail_task(&state.store, task, &error).map_err(display)?;
            return Err(error);
        }
    };
    if applied {
        db::finish_task(
            &state.store,
            task,
            manifest.state.as_str(),
            &manifest.operation_id,
        )
        .map_err(display)?;
    } else {
        db::discard_task(&state.store, task).map_err(display)?;
    }
    clear_outbox(&state.data_root, &manifest.operation_id).await;
    if applied {
        Ok(())
    } else {
        Err("共享订单内容已变化。请先同步，成品和本机修改会保留。".into())
    }
}

async fn check_capability(backend: &Backend) -> Result<(), String> {
    backend
        .test()
        .await
        .map_err(|error| format!("共享存储未通过多人写入测试：{error}"))
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

async fn upload_one(state: &AppState, number: &str, kind: &str) -> Result<Option<String>, String> {
    let local = db::order_state(&state.store, number)
        .map_err(display)?
        .ok_or("订单不存在。")?;
    if let Some(task) = db::task(&state.store, number, kind).map_err(display)? {
        verify_provider_role(&state.store, &task.target, kind)?;
        run_bound_task(state, &task).await?;
        return Ok(publish_mysql(state, &task).await.err());
    }
    if kind == "publish"
        && (local.local_completed || local.shared_state.as_deref() == Some("completed"))
    {
        return Err("这笔订单已标记完成。".into());
    }
    let fresh_backend = if local.target.is_none() {
        Some(selected(state)?)
    } else {
        None
    };
    let target = fresh_backend
        .as_ref()
        .map(Backend::target)
        .or_else(|| local.target.clone())
        .ok_or("请先配置共享存储。")?;
    verify_provider_role(&state.store, &target, kind)?;
    let checked_capability = kind == "publish" && fresh_backend.is_some();
    if let Some(backend) = fresh_backend.as_ref().filter(|_| checked_capability) {
        check_capability(backend).await?;
    }
    let operation = random_hex_pub(16);
    let stage = || -> Result<Task, String> {
        let manifest = snapshot(
            &state.store,
            &state.data_root,
            number,
            kind,
            target.starts_with("qiniu:"),
            &operation,
        )?;
        let task = Task {
            number: number.into(),
            target,
            kind: kind.into(),
            expected_operation_id: local.remote_operation_id.clone(),
            generation: local.generation,
            manifest: serde_json::to_string(&manifest).map_err(display)?,
        };
        db::insert_task(&state.store, &task, &local.version())?;
        Ok(task)
    };
    let task = match stage() {
        Ok(task) => task,
        Err(error) => {
            clear_outbox(&state.data_root, &operation).await;
            return Err(error);
        }
    };
    match fresh_backend {
        Some(backend) => run_task(state, &backend, &task, checked_capability).await,
        None => run_bound_task(state, &task).await,
    }?;
    Ok(publish_mysql(state, &task).await.err())
}

async fn publish_mysql(state: &AppState, task: &Task) -> Result<(), String> {
    let config = crate::mysql::load_config(&state.data_root);
    if !config.enabled {
        return Ok(());
    }
    let manifest = Manifest::parse(task.manifest.as_bytes())?;
    let client = crate::mysql::MyClient::new(&config);
    client
        .order_index()
        .await?
        .write(&task.target, &manifest.mysql_order())
        .await?;
    Ok(())
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

async fn run_bound_task(state: &AppState, task: &Task) -> Result<(), String> {
    let backend = match Backend::bound(&state.store, &state.data_root, &task.target) {
        Ok(backend) => backend,
        Err(error) => {
            db::fail_task(&state.store, task, &error).map_err(display)?;
            return Err(error);
        }
    };
    run_task(state, &backend, task, false).await
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
    let mut seen = std::collections::HashSet::new();
    for number in order_numbers {
        if !seen.insert(number.clone()) {
            continue;
        }
        match upload_one(&state, &number, "publish").await {
            Ok(warning) => {
                result.updated += 1;
                result.uploaded_order_numbers.push(number.clone());
                if let Some(warning) = warning {
                    result.errors.push(format!(
                        "{number} 已发布，{warning}。可在共享数据库设置中重新同步。"
                    ));
                }
            }
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
    if local.target.is_none()
        && db::task(&state.store, &order_number, "publish")
            .map_err(display)?
            .is_some()
    {
        return Err("这笔订单还有一次待确认的发布。请重试发布，确认共享状态后再标记完成。".into());
    }
    if local.target.is_some() {
        match upload_one(&state, &order_number, "finish").await {
            Ok(Some(warning)) => result.errors.push(format!(
                "共享交付已完成，{warning}。可在共享数据库设置中重新同步。"
            )),
            Ok(None) => {}
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

fn remote_reference(target: &str, key: &str, operation_id: &str) -> String {
    format!("{target}:{key}:{operation_id}")
}

async fn load_manifest(backend: &Backend, key: &str) -> Result<Option<Manifest>, String> {
    let Some(bytes) = backend.latest(key).await? else {
        return Ok(None);
    };
    let manifest = Manifest::parse(&bytes)?;
    if backend.key_for_order(&manifest.order_number)?.as_str() != key
        || (backend.requires_remote_revision() && manifest.revision.unwrap_or(0) == 0)
    {
        return Err("共享清单与订单位置不符。".into());
    }
    Ok(Some(manifest))
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
    manifest: &Manifest,
) -> Result<Download, String> {
    let directory = download_directory(&state.data_root)?;
    let mut assets = Vec::new();
    for asset in &manifest.assets {
        let bytes = backend
            .get_blob(&asset.sha256)
            .await?
            .ok_or_else(|| format!("共享文件缺失：{}", asset.name))?;
        if bytes.len() as u64 != asset.bytes || hash(&bytes) != asset.sha256 {
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
    for order in source.list_orders().map_err(display)? {
        let number = order.order_number;
        if db::order_state(&state.store, &number)
            .map_err(display)?
            .is_some()
        {
            continue;
        }
        let manifest = snapshot(
            source,
            source_root,
            &number,
            "legacy",
            false,
            &random_hex_pub(16),
        )?;
        let directory = download_directory(&state.data_root)?;
        let mut assets = Vec::new();
        for asset in &manifest.assets {
            let bytes = std::fs::read(outbox_file(
                source_root,
                &manifest.operation_id,
                &asset.sha256,
            ))
            .map_err(display)?;
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
            &manifest,
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
    manifest: &Manifest,
    request: Download,
    action: ImportAction,
    expected: Option<&str>,
    target: Option<&str>,
) -> Result<(), String> {
    let metadata = manifest
        .metadata
        .as_ref()
        .map(|value| serde_json::Value::Object(value.clone()).to_string());
    db::import(
        store,
        db::Import {
            number: &manifest.order_number,
            expected,
            metadata: metadata.as_deref(),
            shared: target.map(|target| (target, manifest.state.as_str(), manifest.operation_id.as_str())),
            completed: target.is_none() && manifest.local_completed,
            action,
            assets: &request.assets,
        },
    )?;
    let _ = request.directory.keep();
    Ok(())
}

#[cfg(test)]
async fn sync_one(
    state: &AppState,
    backend: &Backend,
    key: &str,
    active_order: Option<&str>,
    result: &mut Outcome,
) -> Result<(), String> {
    let Some(manifest) = load_manifest(backend, key).await? else {
        return Ok(());
    };
    apply_shared_order(state, backend, manifest, key, active_order, result).await
}

async fn apply_shared_order(
    state: &AppState,
    backend: &Backend,
    manifest: Manifest,
    key: &str,
    active_order: Option<&str>,
    result: &mut Outcome,
) -> Result<(), String> {
    let target = backend.target();
    let number = manifest.order_number.as_str();
    let local = db::order_state(&state.store, number).map_err(display)?;
    let same_target = local.as_ref().and_then(|local| local.target.as_deref()) == Some(&target);
    if same_target
        && local.as_ref().is_some_and(|local| {
            local.remote_operation_id.as_deref() == Some(manifest.operation_id.as_str())
        })
    {
        return Ok(());
    }
    if manifest.state == SharedState::Completed {
        if same_target
            && db::mark_remote_complete(&state.store, number, &target, &manifest.operation_id)
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
        result.conflicts.push(preview(
            &state.store,
            &manifest,
            remote_reference(&target, key, &manifest.operation_id),
        )?);
        return Ok(());
    }
    let version = local.as_ref().map(OrderState::version);
    let downloaded = download(state, backend, &manifest).await?;
    apply_download(
        &state.store,
        &manifest,
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
    synchronize(&state, active_order.as_deref(), false).await
}

pub(crate) async fn synchronize(
    state: &AppState,
    active_order: Option<&str>,
    require_mysql: bool,
) -> Result<Outcome, String> {
    let _operation = state.workflow_operations.lock().await;
    if db::role(&state.store) == "customer" {
        return Err("当前是排单端，请在制作端或二合一设备同步订单。".into());
    }
    let backend = selected(state)?;
    let mut response = Outcome::default();
    let target = backend.target();
    let config = crate::mysql::load_config(&state.data_root);
    let client = crate::mysql::MyClient::new(&config);
    let mut index = None;
    let mut indexed = std::collections::HashMap::new();
    if config.enabled {
        let connection = async {
            let mut order_index = client.order_index().await?;
            indexed = order_index.read(&target).await?;
            Ok::<_, String>(order_index)
        }
        .await;
        match connection {
            Ok(connection) => index = Some(connection),
            Err(error) if require_mysql => return Err(error),
            Err(error) => response.errors.push(error),
        }
    } else if require_mysql {
        return Err("请先启用共享数据库。".into());
    }
    let keys = backend.list_orders().await?;
    for key in keys.into_iter().filter(|key| hex_id(key, 64)) {
        let manifest = match load_manifest(&backend, &key).await {
            Ok(Some(manifest)) => manifest,
            Ok(None) => continue,
            Err(error) => {
                response.errors.push(error);
                continue;
            }
        };
        if let Some(order_index) = &mut index {
            let current = manifest.mysql_order();
            if indexed.get(&current.number) != Some(&current) {
                if let Err(error) = order_index.write(&target, &current).await {
                    response.errors.push(error);
                    index = None;
                }
            }
        }
        if let Err(error) =
            apply_shared_order(state, &backend, manifest, &key, active_order, &mut response).await
        {
            response.errors.push(error);
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
    let pieces: Vec<_> = reference.rsplitn(3, ':').collect();
    let [operation_id, key, target] = pieces.as_slice() else {
        return Err("请选择有效的共享订单。".into());
    };
    let backend = Backend::bound(&state.store, &state.data_root, target)?;
    let manifest = load_manifest(&backend, key)
        .await?
        .ok_or("远端订单已不存在。")?;
    if operation_id != &manifest.operation_id
        || manifest.state != SharedState::Pending
    {
        return Err("远端订单已更新，请重新同步。".into());
    }
    if active_order.as_deref() == Some(&manifest.order_number) {
        return Err("这笔订单仍在编辑中，请切换编辑订单后再同步。".into());
    }
    let downloaded = download(&state, &backend, &manifest).await?;
    apply_download(
        &state.store,
        &manifest,
        downloaded,
        ImportAction::Replace,
        local_version.as_deref(),
        Some(target),
    )
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
    fn shared_completion_manifest_does_not_require_an_export() {
        let dir = tempfile::tempdir().unwrap();
        let state = workstation(&dir);
        capture_order(&state, "shared-no-export");
        let manifest = snapshot(
            &state.store,
            &state.data_root,
            "shared-no-export",
            "finish",
            true,
            &random_hex_pub(16),
        )
        .unwrap();
        assert!(manifest.state == SharedState::Completed && manifest.local_completed);
        assert!(manifest.revision.is_some());
        assert_eq!(manifest.assets.len(), 1);
        assert!(!manifest.assets[0].production());
        assert!(manifest.mysql_order().completed);
    }

    #[test]
    fn nas_manifest_contains_metadata_without_a_revision_field() {
        let dir = tempfile::tempdir().unwrap();
        let state = workstation(&dir);
        capture_order(&state, "nas-flat-manifest");
        let manifest = snapshot(
            &state.store,
            &state.data_root,
            "nas-flat-manifest",
            "publish",
            false,
            &random_hex_pub(16),
        )
        .unwrap();
        let json = serde_json::to_value(manifest).unwrap();
        assert!(json.get("revision").is_none());
        assert_eq!(json["orderNumber"], "nas-flat-manifest");
    }

    #[tokio::test]
    #[ignore = "uses a configured NAS in an isolated fixture prefix"]
    async fn nas_two_workstations_publish_and_complete() {
        use crate::cloud::load_config;
        let config_dir = std::env::var_os("VAGAGA_TEST_NAS_CONFIG_DIR").unwrap();
        let mut config = load_config(Path::new(&config_dir));
        config.enabled = true;
        // Each workflow command opens its own storage client.
        let connect = || Backend::Nas(config.clone(), config.client().unwrap());
        connect().test().await.unwrap();
        let online_a = tempfile::tempdir().unwrap();
        let online_b = tempfile::tempdir().unwrap();
        let offline = tempfile::tempdir().unwrap();
        let a = workstation(&online_a);
        let b = workstation(&online_b);
        let c = workstation(&offline);
        let number = format!("FIXTURE-{}", random_hex_pub(16));
        let key = number.clone();
        let fixture_file = online_a.path().join("red.png");
        image::RgbImage::from_fn(10, 10, |x, y| {
            image::Rgb([rand::random(), x as u8, y as u8])
        })
        .save(&fixture_file)
        .unwrap();
        let original = std::fs::read(&fixture_file).unwrap();
        a.store
            .ingest_image(
                &number,
                &original,
                "image/png",
                &[("A01".into(), 2)],
                "fixture",
            )
            .unwrap();
        db::set_layout(&a.store, &number, "ch-555").unwrap();
        let make_task = |vm: &AppState, backend: &Backend, kind: &str, operation: String| {
            let local = db::order_state(&vm.store, &number).unwrap().unwrap();
            let manifest = snapshot(
                &vm.store,
                &vm.data_root,
                &number,
                kind,
                backend.target().starts_with("qiniu:"),
                &operation,
            )
            .unwrap();
            let task = Task {
                number: number.clone(),
                kind: kind.into(),
                target: backend.target(),
                expected_operation_id: local.remote_operation_id.clone(),
                generation: local.generation,
                manifest: serde_json::to_string(&manifest).unwrap(),
            };
            db::insert_task(&vm.store, &task, &local.version()).unwrap();
            task
        };
        {
            let backend = connect();
            run_task(
                &a,
                &backend,
                &make_task(&a, &backend, "publish", random_hex_pub(16)),
                false,
            )
            .await
            .unwrap();
        }
        let mut received = Outcome::default();
        sync_one(&b, &connect(), &key, None, &mut received)
            .await
            .unwrap();
        assert_eq!(received.updated, 1);
        let incoming = b.store.get_order_by_number(&number).unwrap().unwrap();
        assert_eq!(
            std::fs::read(&incoming.images[0].file_path).unwrap(),
            original
        );
        assert_eq!(incoming.images[0].templates[0].quantity, 2);
        assert!(b
            .store
            .order_metadata_by_number(&number)
            .unwrap()
            .unwrap()
            .contains("ch-555"));
        let result_path = online_b.path().join("result.png");
        image::RgbImage::from_fn(5, 5, |x, y| image::Rgb([x as u8, rand::random(), y as u8]))
            .save(&result_path)
            .unwrap();
        let production = std::fs::read(&result_path).unwrap();
        b.store
            .add_production(
                &random_hex_pub(16),
                &number,
                Some(&incoming.images[0].id),
                &result_path,
            )
            .unwrap();
        {
            let backend = connect();
            run_task(
                &b,
                &backend,
                &make_task(&b, &backend, "finish", random_hex_pub(16)),
                false,
            )
            .await
            .unwrap();
        }
        let mut completion = Outcome::default();
        sync_one(&a, &connect(), &key, None, &mut completion)
            .await
            .unwrap();
        assert_eq!(completion.completed, 1);
        assert!(a.store.list_productions(&number).unwrap().is_empty());
        sync_one(&c, &connect(), &key, None, &mut Outcome::default())
            .await
            .unwrap();
        assert!(c.store.list_orders().unwrap().is_empty());
        connect()
            .clean_fixture(&key, &[hash(original), hash(production)])
            .await
            .unwrap();
    }
}
