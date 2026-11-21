//! 前端 invoke 命令与业务动作（剪贴板/去制作）。

use serde::{Deserialize, Serialize};
use tauri::State;
use tauri_plugin_opener::OpenerExt;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;

use crate::store::{OrderDetail, OrderSummary};
use crate::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderDto {
    pub id: String,
    pub order_number: String,
    pub image_count: i64,
    pub created_at: String,
    pub updated_at: String,
    pub metadata: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateQtyDto {
    pub template_id: String,
    pub quantity: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageDto {
    pub id: String,
    pub file_path: String,
    pub thumbnail_path: Option<String>,
    pub original_name: String,
    pub byte_length: i64,
    pub width: i64,
    pub height: i64,
    pub source: String,
    pub created_at: String,
    pub templates: Vec<TemplateQtyDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_quality: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderDetailDto {
    pub id: String,
    pub order_number: String,
    pub created_at: String,
    pub updated_at: String,
    pub images: Vec<ImageDto>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateDto {
    pub code: String,
    pub name: String,
    pub web_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub data_root: String,
    pub cdp_port: u16,
    pub templates: Vec<TemplateDto>,
}

fn order_to_dto(order: &OrderSummary) -> OrderDto {
    OrderDto {
        id: order.id.clone(),
        order_number: order.order_number.clone(),
        image_count: order.image_count,
        metadata: order.metadata.clone(),
        created_at: order.created_at.clone(),
        updated_at: order.updated_at.clone(),
    }
}

fn image_to_dto(image: &crate::store::OrderImage) -> ImageDto {
    ImageDto {
        id: image.id.clone(),
        file_path: image.file_path.clone(),
        thumbnail_path: image.thumb_path.clone(),
        original_name: image.original_name.clone(),
        byte_length: image.byte_length,
        width: image.width,
        height: image.height,
        source: image.source.clone(),
        created_at: image.created_at.clone(),
        source_quality: None,
        sync_status: None,
        sync_error: None,
        templates: image
            .templates
            .iter()
            .map(|t| TemplateQtyDto {
                template_id: t.template_id.clone(),
                quantity: t.quantity,
            })
            .collect(),
    }
}

fn detail_to_dto(order: OrderDetail) -> OrderDetailDto {
    OrderDetailDto {
        id: order.id,
        order_number: order.order_number,
        created_at: order.created_at,
        updated_at: order.updated_at,
        images: order.images.iter().map(image_to_dto).collect(),
    }
}

#[tauri::command]
pub fn list_orders(state: State<'_, AppState>) -> Result<Vec<OrderDto>, String> {
    state
        .store
        .list_orders()
        .map(|orders| orders.iter().map(order_to_dto).collect())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_order(state: State<'_, AppState>, id: String) -> Result<Option<OrderDetailDto>, String> {
    let detail = state
        .store
        .get_order(&id)
        .map_err(|error| error.to_string())?;
    let Some(detail) = detail else { return Ok(None) };
    let mut detail = detail_to_dto(detail);
    for image in &mut detail.images {
        if let Some(status) = state.store.qiniu_asset_state(&image.id).map_err(|e| e.to_string())? {
            image.source_quality = status.quality;
        }
    }
    Ok(Some(detail))
}

#[tauri::command]
pub fn set_image_templates(
    state: State<'_, AppState>,
    image_id: String,
    templates: Vec<TemplateQtyDto>,
) -> Result<(), String> {
    let mapped: Vec<_> = templates.into_iter().map(|entry| (entry.template_id, entry.quantity)).collect();
    state.store.set_image_templates(&image_id, &mapped).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_image(state: State<'_, AppState>, image_id: String) -> Result<(), String> {
    state.store.delete_image(&image_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn delete_order(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let _operation = state.workflow_operations.lock().await;
    if let Some(order) = state.store.get_order(&id).map_err(|error| error.to_string())? {
        let conn = state.store.conn.lock().unwrap();
        if crate::workflow_db::has_tasks(&conn, &order.order_number).map_err(|error| error.to_string())? {
            return Err("这笔订单有待上传操作，请先确认上传结果。".into());
        }
    }
    state.store.delete_order(&id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        data_root: state.data_root.to_string_lossy().to_string(),
        cdp_port: state.port,
        templates: crate::templates::TEMPLATES
            .iter()
            .map(|t| TemplateDto {
                code: t.code.to_string(),
                name: t.name.to_string(),
                web_id: t.web_id.to_string(),
            })
            .collect(),
    }
}

/// 把素材图写入系统剪贴板（RGBA 位图），供在 web 上传区 Ctrl+V。
#[tauri::command]
pub fn copy_image_to_clipboard(state: State<'_, AppState>, image_id: String) -> Result<(), String> {
    let bytes = state.store.read_image_bytes(&image_id).map_err(|e| e.to_string())?;
    let decoded = image::load_from_memory(&bytes).map_err(|error| error.to_string())?;
    let rgba = decoded.to_rgba8();
    let (width, height) = rgba.dimensions();
    let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
    clipboard
        .set_image(arboard::ImageData {
            width: width as usize,
            height: height as usize,
            bytes: rgba.into_raw().into(),
        })
        .map_err(|error| error.to_string())
}

/// 系统默认程序打开本地文件（成品图查看）。
#[tauri::command]
pub fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|error: tauri_plugin_opener::Error| error.to_string())
}

/* ---------- MySQL 多机协同 ---------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductionDto {
    pub id: String,
    pub order_number: String,
    pub image_id: Option<String>,
    pub file_path: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync_error: Option<String>,
}

#[tauri::command]
pub fn get_mysql_config(state: State<'_, AppState>) -> crate::mysql::MysqlConfig {
    crate::mysql::load_config(&state.data_root)
}

#[tauri::command]
pub fn save_mysql_config(
    state: State<'_, AppState>,
    config: crate::mysql::MysqlConfig,
) -> Result<(), String> {
    crate::mysql::save_config(&state.data_root, &config)
}

#[tauri::command]
pub async fn mysql_test(config: crate::mysql::MysqlConfig) -> Result<String, String> {
    if !config.valid() {
        return Err("请填写完整的主机、用户名与数据库名。".into());
    }
    crate::mysql::MyClient::new(&config).test().await
}

#[tauri::command]
pub(crate) async fn mysql_sync_now(
    state: State<'_, AppState>,
    active_order: Option<String>,
) -> Result<crate::workflow::Outcome, String> {
    crate::workflow::synchronize(&state, active_order.as_deref(), true).await
}

/// 成品保存到本机，交付时再上传。
#[tauri::command]
pub async fn save_production(
    state: State<'_, AppState>,
    order_number: Option<String>,
    data_b64: String,
    file_name: String,
    image_id: Option<String>,
) -> Result<ProductionDto, String> {
    let bytes = B64.decode(&data_b64).map_err(|error| format!("成品数据解码失败：{error}"))?;
    if file_name.is_empty() || file_name.chars().count() > 160
        || file_name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        || file_name.chars().any(char::is_control)
    {
        return Err("成品文件名无效".into());
    }
    let id = crate::store::random_hex_pub(16);
    let directory_name = order_number.as_deref().map(|number| {
        number.replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_")
    });
    let directory_name = directory_name.as_deref().and_then(|name| {
        let trimmed = name.trim_end_matches([' ', '.']);
        (!trimmed.is_empty()).then_some(trimmed)
    }).unwrap_or("未关联");
    let directory = state.data_root.join("productions").join(directory_name);
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = directory.join(format!("{id}_{file_name}"));
    std::fs::write(&path, &bytes).map_err(|error| format!("成品写入失败：{error}"))?;
    let order = order_number.clone().unwrap_or_default();
    state.store.add_production(&id, &order, image_id.as_deref(), &path)
        .map_err(|error| error.to_string())?;
    Ok(ProductionDto {
        id,
        order_number: order,
        image_id,
        file_path: path.to_string_lossy().to_string(),
        created_at: crate::store::now(),
        sync_status: None,
        sync_error: None,
    })
}

#[tauri::command]
pub fn list_productions(
    state: State<'_, AppState>,
    order_number: String,
) -> Result<Vec<ProductionDto>, String> {
    let rows = state.store.list_productions(&order_number).map_err(|e| e.to_string())?;
    rows.into_iter().map(|row| {
        let sync = state.store.qiniu_asset_state(&row.id).map_err(|e| e.to_string())?;
        Ok(ProductionDto {
            id: row.id, order_number: row.order_number, image_id: row.image_id,
            file_path: row.file_path, created_at: row.created_at,
            sync_status: sync.as_ref().map(|status| status.state.clone()),
            sync_error: sync.and_then(|status| status.error),
        })
    }).collect()
}

/* ---------- 文件存储同步 ---------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudNoticeDto {
    pub order_number: String,
    pub new_images: usize,
}

#[tauri::command]
pub fn get_cloud_config(state: State<'_, AppState>) -> crate::cloud::CloudConfig {
    crate::cloud::load_config(&state.data_root)
}

#[tauri::command]
pub async fn save_cloud_config(
    state: State<'_, AppState>,
    config: crate::cloud::CloudConfig,
) -> Result<(), String> {
    let _guard = state.workflow_operations.lock().await;
    state.cloud.save(&state.data_root, &config).await
}

#[tauri::command]
pub async fn cloud_test(config: crate::cloud::CloudConfig) -> Result<String, String> {
    config.test().await
}

#[tauri::command]
pub async fn cloud_sync_now(state: State<'_, AppState>) -> Result<Vec<CloudNoticeDto>, String> {
    let _guard = state.workflow_operations.lock().await;
    let config = crate::cloud::load_config(&state.data_root);
    let temporary = tempfile::tempdir().map_err(|error| error.to_string())?;
    let imported = crate::store::Store::open(temporary.path()).map_err(|error| error.to_string())?;
    crate::cloud::import_legacy(&imported, &config).await?;
    Ok(crate::workflow::import_legacy(&state, &imported, temporary.path())?
        .into_iter().map(|(order_number, new_images, _)| CloudNoticeDto {
            order_number, new_images,
        }).collect())
}

/// AI 抠图返回：成品 PNG（base64）+ 是否命中本地缓存。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CutoutDto {
    pub png_b64: String,
    pub cached: bool,
}

/// AI 抠图：图片字节（base64 编码传输）→ sha256 缓存 / PicWish → PNG base64。
#[tauri::command]
pub async fn cutout_image_bytes(
    state: State<'_, AppState>,
    data_b64: String,
) -> Result<CutoutDto, String> {
    let bytes = B64.decode(&data_b64).map_err(|error| format!("图片数据解码失败：{error}"))?;
    let config = crate::cutout::load_config(&state.data_root);
    let client = crate::cutout::CutoutClient::new(&config, state.data_root.join("cutout"));
    let result = client.cutout(bytes).await?;
    Ok(CutoutDto { png_b64: result.png_b64, cached: result.cached })
}

#[tauri::command]
pub fn get_cutout_config(state: State<'_, AppState>) -> crate::cutout::CutoutConfig {
    crate::cutout::load_config(&state.data_root)
}

#[tauri::command]
pub fn save_cutout_config(
    state: State<'_, AppState>,
    config: crate::cutout::CutoutConfig,
) -> Result<(), String> {
    crate::cutout::save_config(&state.data_root, &config)
}

/// 去制作：素材图进剪贴板 + 打开对应模板的 web 编辑页。
#[tauri::command]
pub fn make_page(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    image_id: String,
    template_id: String,
) -> Result<(), String> {
    let bytes = state.store.read_image_bytes(&image_id).map_err(|e| e.to_string())?;
    let decoded = image::load_from_memory(&bytes).map_err(|error| error.to_string())?;
    let rgba = decoded.to_rgba8();
    let (width, height) = rgba.dimensions();
    let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
    clipboard
        .set_image(arboard::ImageData {
            width: width as usize,
            height: height as usize,
            bytes: rgba.into_raw().into(),
        })
        .map_err(|error| error.to_string())?;
    let encoded = urlencoding::encode(&template_id);
    let url = format!("https://pic.pdurl.cn/tools/heart-star?template={encoded}");
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error: tauri_plugin_opener::Error| error.to_string())
}
