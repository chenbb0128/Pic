//! 内置模板与本机保存的制作规格。

use std::io::Write;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::{mysql, store::Store, workflow_storage::Backend, AppState};

const BACKGROUND: &str = "background.png";
const PREVIEW: &str = "preview.webp";
const IMAGE_LIMIT: usize = crate::workflow::MAX_ASSET_BYTES as usize;

pub struct Template {
    pub code: &'static str,
    pub name: &'static str,
    /// web 端模板 id（下拉框 option value，中文文件名格式）
    pub web_id: &'static str,
}

pub const TEMPLATES: &[Template] = &[
    Template {
        code: "A01",
        name: "爱心款",
        web_id: "模板爱心.png",
    },
    Template {
        code: "A02",
        name: "爱心横版",
        web_id: "爱心横版.png",
    },
    Template {
        code: "A03",
        name: "爱心+星星混合版",
        web_id: "模板混合.png",
    },
    Template {
        code: "A04",
        name: "粉色款",
        web_id: "模板粉色.png",
    },
    Template {
        code: "A05",
        name: "蓝色款",
        web_id: "模板蓝色.png",
    },
    Template {
        code: "A06",
        name: "黄色款",
        web_id: "模板黄色.png",
    },
    Template {
        code: "A07",
        name: "混合竖版",
        web_id: "甜心派对.png",
    },
    Template {
        code: "A08",
        name: "缤纷糖果版",
        web_id: "缤纷糖果.png",
    },
    Template {
        code: "A09",
        name: "大头混合横版",
        web_id: "I-ME横版大头.png",
    },
    Template {
        code: "A10",
        name: "心动马卡龙款",
        web_id: "爱心心动马卡龙.png",
    },
    Template {
        code: "A11",
        name: "焦糖秋枫混合豹纹",
        web_id: "经典豹纹混合.png",
    },
    Template {
        code: "A12",
        name: "奶油黑粉混合豹纹",
        web_id: "黑粉奶油混合豹纹.png",
    },
];

/// 按商品编号（如 "A01"）查找模板。
pub fn find_by_code(code: &str) -> Option<&'static Template> {
    TEMPLATES.iter().find(|t| t.code == code)
}

/// 按 web 模板 id 查找模板。
pub fn find_by_web_id(web_id: &str) -> Option<&'static Template> {
    TEMPLATES.iter().find(|t| t.web_id == web_id)
}

/// 注入脚本内嵌用的模板目录 JSON（[{code, name, id}]）。
pub fn catalog_json() -> String {
    serde_json::to_string(
        &TEMPLATES
            .iter()
            .map(|t| serde_json::json!({ "code": t.code, "name": t.name, "id": t.web_id }))
            .collect::<Vec<_>>(),
    )
    .unwrap_or_else(|_| "[]".to_string())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateDto {
    pub code: String,
    pub name: String,
    pub web_id: String,
    pub custom: bool,
    pub enabled: bool,
    pub width: f64,
    pub height: f64,
    pub dpi: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_path: Option<String>,
}

#[derive(Debug)]
pub(crate) struct SavedTemplate {
    pub id: String,
    pub code: String,
    pub name: String,
    pub width: f64,
    pub height: f64,
    pub dpi: u32,
    pub layout: String,
    pub enabled: bool,
    pub updated_at: i64,
}

impl SavedTemplate {
    fn dto(&self, root: &Path) -> TemplateDto {
        TemplateDto {
            code: self.code.clone(),
            name: self.name.clone(),
            web_id: self.id.clone(),
            custom: true,
            enabled: self.enabled,
            width: self.width,
            height: self.height,
            dpi: self.dpi,
            preview_path: Some(
                image_path(root, &self.id, PREVIEW)
                    .to_string_lossy()
                    .into_owned(),
            ),
        }
    }

    pub(crate) fn background_key(&self) -> String {
        format!("templates/{}/{BACKGROUND}", self.id)
    }

    pub(crate) fn preview_key(&self) -> String {
        format!("templates/{}/{PREVIEW}", self.id)
    }

    fn validate(&self) -> Result<Value, String> {
        if !is_saved_id(&self.id)
            || self.code != normalize_code(&self.code)?
            || self.name != normalize_name(&self.name)?
        {
            return Err("模板标识无效。".into());
        }
        if !(20. ..=1000.).contains(&self.width)
            || !(20. ..=1000.).contains(&self.height)
            || !matches!(self.dpi, 150 | 300 | 500 | 600)
        {
            return Err("模板尺寸或打印精度无效。".into());
        }
        validate_layout(&self.layout)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TemplateInput {
    code: String,
    name: String,
    width: f64,
    height: f64,
    dpi: u32,
    layout: Value,
    background_b64: String,
    preview_b64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenTemplate {
    template: TemplateDto,
    layout: Value,
    background_path: String,
}

#[derive(Default, Serialize)]
pub(crate) struct SyncTemplates {
    updated: usize,
    errors: Vec<String>,
}

pub(crate) fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS templates (
            id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
            width REAL NOT NULL, height REAL NOT NULL, dpi INTEGER NOT NULL,
            layout TEXT NOT NULL, enabled BOOLEAN NOT NULL, updated_at INTEGER NOT NULL
        );",
    )
}

fn row_template(row: &rusqlite::Row<'_>) -> rusqlite::Result<SavedTemplate> {
    Ok(SavedTemplate {
        id: row.get(0)?,
        code: row.get(1)?,
        name: row.get(2)?,
        width: row.get(3)?,
        height: row.get(4)?,
        dpi: row.get(5)?,
        layout: row.get(6)?,
        enabled: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

const COLUMNS: &str = "id,code,name,width,height,dpi,layout,enabled,updated_at";

fn local(store: &Store, id: &str) -> Result<Option<SavedTemplate>, String> {
    store
        .conn
        .lock()
        .expect("store mutex poisoned")
        .query_row(
            &format!("SELECT {COLUMNS} FROM templates WHERE id=?1"),
            [id],
            row_template,
        )
        .optional()
        .map_err(display)
}

fn local_list(store: &Store) -> Result<Vec<SavedTemplate>, String> {
    let conn = store.conn.lock().expect("store mutex poisoned");
    let mut query = conn
        .prepare(&format!("SELECT {COLUMNS} FROM templates ORDER BY code"))
        .map_err(display)?;
    let rows = query.query_map([], row_template).map_err(display)?;
    rows.collect::<Result<_, _>>().map_err(display)
}

fn code_owner(store: &Store, code: &str) -> Result<Option<String>, String> {
    store
        .conn
        .lock()
        .expect("store mutex poisoned")
        .query_row("SELECT id FROM templates WHERE code=?1", [code], |row| {
            row.get(0)
        })
        .optional()
        .map_err(display)
}

fn save_record(store: &Store, template: &SavedTemplate) -> Result<(), String> {
    store.conn.lock().expect("store mutex poisoned").execute(
        "INSERT INTO templates(id,code,name,width,height,dpi,layout,enabled,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,updated_at=excluded.updated_at",
        params![template.id,template.code,template.name,template.width,template.height,template.dpi,
            template.layout,template.enabled,template.updated_at],
    ).map_err(display)?;
    Ok(())
}

pub(crate) fn catalog(store: &Store, root: &Path) -> Result<Vec<TemplateDto>, String> {
    let sizes = [
        (144., 210.),
        (210., 144.),
        (144., 210.),
        (144., 210.),
        (144., 210.),
        (144., 210.),
        (144., 210.),
        (144., 210.),
        (210., 144.),
        (144., 210.),
        (144., 210.),
        (144., 210.),
    ];
    let mut entries = TEMPLATES
        .iter()
        .zip(sizes)
        .map(|(item, (width, height))| TemplateDto {
            code: item.code.into(),
            name: item.name.into(),
            web_id: item.web_id.into(),
            custom: false,
            enabled: true,
            width,
            height,
            dpi: 600,
            preview_path: None,
        })
        .collect::<Vec<_>>();
    entries.extend(local_list(store)?.iter().map(|item| item.dto(root)));
    Ok(entries)
}

pub(crate) fn capture_catalog(store: &Store) -> Result<Value, String> {
    let mut entries = TEMPLATES
        .iter()
        .map(|item| serde_json::json!({"id":item.web_id,"code":item.code,"name":item.name}))
        .collect::<Vec<_>>();
    entries.extend(
        local_list(store)?
            .into_iter()
            .filter(|item| item.enabled)
            .map(|item| serde_json::json!({"id":item.id,"code":item.code,"name":item.name})),
    );
    Ok(Value::Array(entries))
}

fn normalize_code(code: &str) -> Result<String, String> {
    let code = code.trim().to_ascii_uppercase();
    if code.len() < 3
        || code.len() > 12
        || !code.starts_with('A')
        || !code[1..].bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("请输入 A13 这样的规格编号。".into());
    }
    if find_by_code(&code).is_some() {
        return Err(format!("规格 {code} 已用于内置模板。"));
    }
    Ok(code)
}

fn normalize_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err("请输入 1 到 80 个字符的模板名称。".into());
    }
    Ok(name.into())
}

fn validate_layout(layout: &str) -> Result<Value, String> {
    let invalid = || "模板排版配置无效。".to_string();
    if layout.len() > 2 * 1024 * 1024 {
        return Err(invalid());
    }
    let layout: Value = serde_json::from_str(layout).map_err(|_| invalid())?;
    let fields = layout.as_object().ok_or_else(invalid)?;
    if fields
        .keys()
        .any(|key| !matches!(key.as_str(), "template" | "states" | "customRows" | "copy"))
    {
        return Err(invalid());
    }
    let template = fields
        .get("template")
        .and_then(Value::as_object)
        .ok_or_else(invalid)?;
    let states = fields
        .get("states")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    let slots = template
        .get("slots")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    if slots.is_empty()
        || states.len() != slots.len()
        || template.contains_key("image")
        || !["w", "h"].iter().all(|key| {
            template
                .get(*key)
                .and_then(Value::as_f64)
                .is_some_and(|n| n > 0.)
        })
    {
        return Err(invalid());
    }
    Ok(layout)
}

pub(crate) fn is_saved_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn image_path(root: &Path, id: &str, name: &str) -> PathBuf {
    root.join("templates").join(id).join(name)
}

fn has_images(root: &Path, id: &str) -> bool {
    image_path(root, id, BACKGROUND).is_file() && image_path(root, id, PREVIEW).is_file()
}

fn image_bytes(bytes: &[u8], format: image::ImageFormat) -> Result<(), String> {
    if bytes.len() > IMAGE_LIMIT || image::guess_format(bytes).ok() != Some(format) {
        return Err("模板图片格式或大小无效。".into());
    }
    image::ImageReader::with_format(std::io::Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(display)?;
    Ok(())
}

fn decode(value: &str) -> Result<Vec<u8>, String> {
    if value.len() > IMAGE_LIMIT.div_ceil(3) * 4 {
        return Err("模板图片太大。".into());
    }
    STANDARD
        .decode(value)
        .map_err(|_| "无法读取模板图片。".into())
}

fn save_images(root: &Path, id: &str, background: &[u8], preview: &[u8]) -> Result<(), String> {
    image_bytes(background, image::ImageFormat::Png)?;
    image_bytes(preview, image::ImageFormat::WebP)?;
    let folder = root.join("templates").join(id);
    std::fs::create_dir_all(&folder).map_err(display)?;
    for (name, bytes) in [(BACKGROUND, background), (PREVIEW, preview)] {
        let mut file = tempfile::NamedTempFile::new_in(&folder).map_err(display)?;
        file.write_all(bytes).map_err(display)?;
        file.persist(folder.join(name)).map_err(display)?;
    }
    Ok(())
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[tauri::command]
pub(crate) async fn save_template(
    state: State<'_, AppState>,
    input: TemplateInput,
) -> Result<TemplateDto, String> {
    let _operation = state.workflow_operations.lock().await;
    save_local(&state.store, &state.data_root, input)
}

fn save_local(store: &Store, root: &Path, input: TemplateInput) -> Result<TemplateDto, String> {
    let template = SavedTemplate {
        id: crate::store::random_hex_pub(16),
        code: normalize_code(&input.code)?,
        name: normalize_name(&input.name)?,
        width: input.width,
        height: input.height,
        dpi: input.dpi,
        layout: serde_json::to_string(&input.layout).map_err(display)?,
        enabled: true,
        updated_at: now(),
    };
    template.validate()?;
    if code_owner(store, &template.code)?.is_some() {
        return Err(format!("规格 {} 已存在。", template.code));
    }
    let background = decode(&input.background_b64)?;
    let preview = decode(&input.preview_b64)?;
    save_images(root, &template.id, &background, &preview)?;
    save_record(store, &template)?;
    Ok(template.dto(root))
}

#[tauri::command]
pub(crate) fn get_template(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<OpenTemplate>, String> {
    let Some(template) = local(&state.store, &id)? else {
        return Ok(None);
    };
    let layout = template.validate()?;
    if !has_images(&state.data_root, &id) {
        return Err(format!(
            "模板 {} 图片缺失，请同步模板后重试。",
            template.code
        ));
    }
    Ok(Some(OpenTemplate {
        template: template.dto(&state.data_root),
        layout,
        background_path: image_path(&state.data_root, &id, BACKGROUND)
            .to_string_lossy()
            .into_owned(),
    }))
}

#[tauri::command]
pub(crate) async fn update_template(
    state: State<'_, AppState>,
    id: String,
    name: String,
    enabled: bool,
) -> Result<TemplateDto, String> {
    let _operation = state.workflow_operations.lock().await;
    let mut template = local(&state.store, &id)?.ok_or("找不到自定义模板。")?;
    template.name = normalize_name(&name)?;
    template.enabled = enabled;
    template.updated_at = now().max(template.updated_at.saturating_add(1));
    save_record(&state.store, &template)?;
    Ok(template.dto(&state.data_root))
}

#[tauri::command]
pub(crate) async fn publish_template(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let _operation = state.workflow_operations.lock().await;
    let backend = crate::workflow::selected(&state)?;
    backend.check_connection().await?;
    publish(&state, &backend, &id).await
}

async fn publish(state: &AppState, backend: &Backend, id: &str) -> Result<(), String> {
    let template = local(&state.store, id)?.ok_or("找不到自定义模板。")?;
    template.validate()?;
    let target = backend.target();
    let mut index = mysql::connect_template_index(&state.data_root).await?;
    let previous = index.find_by_code(&target, &template.code).await?;
    if let Some(previous) = &previous {
        if previous.id != id {
            return Err(format!("共享目录已有规格 {}。", template.code));
        }
        if previous.updated_at > template.updated_at {
            return Err(format!("共享模板 {} 已更新，请先同步模板。", template.code));
        }
    }
    for name in [BACKGROUND, PREVIEW] {
        let path = image_path(&state.data_root, id, name);
        let bytes = tokio::fs::read(path).await.map_err(display)?;
        backend.put_template_image(id, name, bytes).await?;
    }
    index.write(&target, &template, previous.is_some()).await
}

async fn import_one(
    state: &AppState,
    backend: &Backend,
    template: SavedTemplate,
) -> Result<bool, String> {
    template.validate()?;
    if code_owner(&state.store, &template.code)?.is_some_and(|owner| owner != template.id) {
        return Err("本机已有同编号的其他模板。".into());
    }
    let current = local(&state.store, &template.id)?;
    let ready = has_images(&state.data_root, &template.id);
    if current
        .as_ref()
        .is_some_and(|item| item.updated_at >= template.updated_at)
        && ready
    {
        return Ok(false);
    }
    if !ready {
        let background = backend
            .get_template_image(&template.id, BACKGROUND)
            .await?
            .ok_or("共享模板底图缺失。")?;
        let preview = backend
            .get_template_image(&template.id, PREVIEW)
            .await?
            .ok_or("共享模板缩略图缺失。")?;
        save_images(&state.data_root, &template.id, &background, &preview)?;
    }
    if current
        .as_ref()
        .is_none_or(|item| item.updated_at < template.updated_at)
    {
        save_record(&state.store, &template)?;
    }
    Ok(true)
}

#[tauri::command]
pub(crate) async fn sync_templates(state: State<'_, AppState>) -> Result<SyncTemplates, String> {
    let _operation = state.workflow_operations.lock().await;
    let backend = crate::workflow::selected(&state)?;
    backend.check_connection().await?;
    let mut index = mysql::connect_template_index(&state.data_root).await?;
    let mut result = SyncTemplates::default();
    for template in index.list(&backend.target()).await? {
        let code = template.code.clone();
        match import_one(&state, &backend, template).await {
            Ok(true) => result.updated += 1,
            Ok(false) => {}
            Err(error) => result.errors.push(format!("{code}：{error}")),
        }
    }
    Ok(result)
}

pub(crate) async fn require_shared<'a>(
    state: &AppState,
    backend: &Backend,
    ids: impl Iterator<Item = &'a str>,
) -> Result<(), String> {
    let ids = ids
        .filter(|id| is_saved_id(id))
        .collect::<std::collections::BTreeSet<_>>();
    if ids.is_empty() {
        return Ok(());
    }
    let mut index = mysql::connect_template_index(&state.data_root).await?;
    let target = backend.target();
    for id in ids {
        if index.get(&target, id).await?.is_none() {
            let code = local(&state.store, id)?.map_or_else(|| id.to_owned(), |item| item.code);
            return Err(format!("请先在模板中心共享模板 {code}。"));
        }
    }
    Ok(())
}

pub(crate) async fn fetch_missing<'a>(
    state: &AppState,
    backend: &Backend,
    ids: impl Iterator<Item = &'a str>,
) -> Result<(), String> {
    let missing = ids
        .filter(|id| is_saved_id(id))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter_map(|id| match local(&state.store, id) {
            Ok(Some(_)) if has_images(&state.data_root, id) => None,
            Ok(_) => Some(Ok(id)),
            Err(error) => Some(Err(error)),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if missing.is_empty() {
        return Ok(());
    }
    let mut index = mysql::connect_template_index(&state.data_root).await?;
    let target = backend.target();
    for id in missing {
        let template = index
            .get(&target, id)
            .await?
            .ok_or("订单需要的模板尚未共享。")?;
        import_one(state, backend, template).await?;
    }
    Ok(())
}

fn display(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat};

    fn make_image(format: ImageFormat) -> Vec<u8> {
        let mut buffer = std::io::Cursor::new(Vec::new());
        DynamicImage::new_rgba8(8, 8)
            .write_to(&mut buffer, format)
            .unwrap();
        buffer.into_inner()
    }

    fn layout() -> Value {
        serde_json::json!({"template":{"w":1440,"h":2100,"slots":[{}]},"states":[{}]})
    }

    fn template_input(code: &str) -> TemplateInput {
        TemplateInput {
            code: code.into(),
            name: "测试排版".into(),
            width: 144.,
            height: 210.,
            dpi: 600,
            layout: layout(),
            background_b64: STANDARD.encode(make_image(ImageFormat::Png)),
            preview_b64: STANDARD.encode(make_image(ImageFormat::WebP)),
        }
    }

    fn workstation(root: &Path) -> AppState {
        AppState {
            store: std::sync::Arc::new(Store::open(root).unwrap()),
            data_root: root.to_path_buf(),
            port: 0,
            cloud: std::sync::Arc::new(crate::cloud::Sync::new()),
            workflow_operations: tokio::sync::Mutex::new(()),
        }
    }

    #[test]
    fn saved_template_appears_in_capture_catalog_and_disabled_id_remains_available() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let saved = save_local(&store, dir.path(), template_input("a13")).unwrap();
        assert_eq!(saved.code, "A13");
        assert!(has_images(dir.path(), &saved.web_id));
        assert!(save_local(&store, dir.path(), template_input("A13")).is_err());
        assert!(save_local(&store, dir.path(), template_input("A01")).is_err());
        drop(store);

        let store = Store::open(dir.path()).unwrap();
        let catalog = capture_catalog(&store).unwrap();
        assert_eq!(catalog[12]["id"], saved.web_id);
        let mut record = local(&store, &saved.web_id).unwrap().unwrap();
        record.enabled = false;
        save_record(&store, &record).unwrap();
        assert_eq!(
            capture_catalog(&store).unwrap().as_array().unwrap().len(),
            12
        );
        assert!(!local(&store, &saved.web_id).unwrap().unwrap().enabled);
        assert_eq!(record.validate().unwrap(), layout());
    }

    #[test]
    fn invalid_preview_or_order_data_does_not_publish_a_local_template() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let mut input = template_input("A13");
        input.preview_b64 = STANDARD.encode(make_image(ImageFormat::Png));
        assert!(save_local(&store, dir.path(), input).is_err());
        let mut input = template_input("A13");
        input.layout["photos"] = serde_json::json!([null]);
        assert!(save_local(&store, dir.path(), input).is_err());
        assert!(local_list(&store).unwrap().is_empty());
        assert!(!dir.path().join("templates").exists());
    }

    #[tokio::test]
    async fn template_is_added_to_catalog_only_after_both_shared_images_arrive() {
        use crate::qiniu_transport::tests::{local_server, receive, reply};

        let id = "aabbccddeeffaabbccddeeffaabbccdd";
        let dir = tempfile::tempdir().unwrap();
        let state = workstation(dir.path());
        let template = || SavedTemplate {
            id: id.into(),
            code: "A13".into(),
            name: "共享模板".into(),
            width: 144.,
            height: 210.,
            dpi: 600,
            layout: layout().to_string(),
            enabled: true,
            updated_at: 1,
        };
        let (listener, endpoint) = local_server();
        let server = std::thread::spawn(move || {
            let (socket, _) = receive(
                &listener,
                &format!("GET /fixture/templates/{id}/{BACKGROUND}"),
            );
            reply(socket, 200, &[], &make_image(ImageFormat::Png));
            let (socket, _) = receive(&listener, &format!("GET /fixture/templates/{id}/{PREVIEW}"));
            reply(socket, 404, &[], b"<Error><Code>NoSuchKey</Code></Error>");
            let (socket, _) = receive(
                &listener,
                &format!("GET /fixture/templates/{id}/{BACKGROUND}"),
            );
            reply(socket, 200, &[], &make_image(ImageFormat::Png));
            let (socket, _) = receive(&listener, &format!("GET /fixture/templates/{id}/{PREVIEW}"));
            reply(socket, 200, &[], &make_image(ImageFormat::WebP));
        });
        let config = crate::cloud::CloudConfig {
            endpoint,
            bucket: "fixture".into(),
            access_key: "fixture".into(),
            secret_key: "fixture".into(),
            ..Default::default()
        };
        let backend = Backend::Nas(config.clone(), config.client().unwrap());
        assert!(import_one(&state, &backend, template()).await.is_err());
        assert!(local(&state.store, id).unwrap().is_none());
        assert!(import_one(&state, &backend, template()).await.unwrap());
        assert!(!import_one(&state, &backend, template()).await.unwrap());
        assert!(has_images(dir.path(), id));
        assert_eq!(local(&state.store, id).unwrap().unwrap().code, "A13");
        server.join().unwrap();
    }

    #[tokio::test]
    #[ignore = "requires a dedicated MySQL test database"]
    async fn published_template_downloads_to_second_device_through_mysql() {
        use crate::qiniu_transport::tests::{local_server, receive, reply};

        let path = std::env::var_os("VAGAGA_TEST_MYSQL_CONFIG").unwrap();
        let config: mysql::MysqlConfig =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let sender_dir = tempfile::tempdir().unwrap();
        let receiver_dir = tempfile::tempdir().unwrap();
        let sender = workstation(sender_dir.path());
        let receiver = workstation(receiver_dir.path());
        for root in [&sender.data_root, &receiver.data_root] {
            mysql::save_config(root, &config).unwrap();
        }
        let saved = save_local(&sender.store, &sender.data_root, template_input("A13")).unwrap();
        let id = saved.web_id;
        let (listener, endpoint) = local_server();
        let object_root = format!("/fixture/templates/{id}");
        let server = std::thread::spawn(move || {
            for (file, format) in [(BACKGROUND, ImageFormat::Png), (PREVIEW, ImageFormat::WebP)] {
                let (socket, request) = receive(&listener, &format!("PUT {object_root}/{file}"));
                assert_eq!(request.body, make_image(format));
                reply(socket, 200, &[], b"");
            }
            for (file, format) in [(BACKGROUND, ImageFormat::Png), (PREVIEW, ImageFormat::WebP)] {
                let (socket, _) = receive(&listener, &format!("GET {object_root}/{file}"));
                reply(socket, 200, &[], &make_image(format));
            }
        });
        let config = crate::cloud::CloudConfig {
            endpoint,
            bucket: "fixture".into(),
            access_key: "fixture".into(),
            secret_key: "fixture".into(),
            ..Default::default()
        };
        let backend = Backend::Nas(config.clone(), config.client().unwrap());
        assert!(require_shared(&sender, &backend, [id.as_str()].into_iter())
            .await
            .is_err());
        publish(&sender, &backend, &id).await.unwrap();
        require_shared(&sender, &backend, [id.as_str()].into_iter())
            .await
            .unwrap();
        fetch_missing(&receiver, &backend, [id.as_str()].into_iter())
            .await
            .unwrap();
        assert!(has_images(&receiver.data_root, &id));
        assert_eq!(local(&receiver.store, &id).unwrap().unwrap().code, "A13");
        let mut index = mysql::connect_template_index(&sender.data_root)
            .await
            .unwrap();
        assert_eq!(index.list(&backend.target()).await.unwrap().len(), 1);
        assert!(index.list("other-storage").await.unwrap().is_empty());
        server.join().unwrap();
    }
}
