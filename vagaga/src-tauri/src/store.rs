//! 本地存储：SQLite 订单/素材/模板关联 + 原图按日期订单归档。
//!
//! 归档语义沿用订单素材台（desktop/local_order_repository.dart）：
//! `图片根/YYYY-MM-DD/<安全订单号>_<内部ID>/<图片ID>.<扩展名>`，逐字节复制，
//! 删除记录保留磁盘文件。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::Local;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::qiniu_store::{self, CaptureQuality};

pub(crate) fn valid_layout_number(number: &str) -> bool {
    let Some((prefix, suffix)) = number.split_once('-') else {
        return false;
    };
    matches!(prefix, "ch" | "yy" | "x")
        && (1..=64).contains(&suffix.len())
        && suffix.bytes().all(|value| value.is_ascii_alphanumeric())
}

pub(crate) struct FileSyncImport<'a> {
    pub target: &'a str,
    pub fingerprint: &'a str,
    pub layout_number: Option<&'a str>,
    pub layout_captured_at: Option<&'a str>,
}

pub(crate) struct PendingFileUpload {
    pub order_number: String,
    pub image_id: String,
    pub may_add: bool,
    pub revision: i64,
}

enum CloudImport<'a> {
    Mysql(&'a str),
    Files(FileSyncImport<'a>),
}

fn merge_file_layout_metadata(current: Option<&str>, incoming: &FileSyncImport<'_>) -> Option<String> {
    let number = incoming.layout_number.filter(|value| valid_layout_number(value))?;
    let captured_at = incoming.layout_captured_at
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok());
    let parsed = current.and_then(|text| serde_json::from_str::<Value>(text).ok());
    if let Some((_, previous_time)) = parsed.as_ref().and_then(layout_metadata) {
        if captured_at <= previous_time {
            return None;
        }
    }
    let mut fields = match parsed {
        Some(Value::Object(fields)) => fields,
        _ => {
            let mut fields = serde_json::Map::new();
            if let Some(text) = current.filter(|text| !text.is_empty()) {
                fields.insert("legacyMetadata".into(), Value::String(text.to_owned()));
            }
            fields
        }
    };
    fields.insert("layoutNumber".into(), Value::String(number.to_owned()));
    match captured_at {
        Some(timestamp) => {
            fields.insert("layoutNumberCapturedAt".into(), Value::String(timestamp.to_rfc3339()));
        }
        None => { fields.remove("layoutNumberCapturedAt"); }
    }
    Some(Value::Object(fields).to_string())
}

fn layout_metadata(value: &Value) -> Option<(&str, Option<chrono::DateTime<chrono::FixedOffset>>)> {
    let number = value
        .get("layoutNumber")?
        .as_str()
        .filter(|value| valid_layout_number(value))?;
    let captured_at = value
        .get("layoutNumberCapturedAt")
        .and_then(Value::as_str)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok());
    Some((number, captured_at))
}

/// Replace the existing order details while keeping the most recent layout number.
fn merge_order_layout_metadata(current: Option<&str>, incoming: &str) -> String {
    let previous = current.and_then(|text| serde_json::from_str::<Value>(text).ok());
    let Some((number, captured_at)) = previous.as_ref().and_then(layout_metadata) else {
        return incoming.to_owned();
    };
    let replacement = serde_json::from_str::<Value>(incoming).ok();
    if replacement
        .as_ref()
        .and_then(layout_metadata)
        .is_some_and(|(_, timestamp)| captured_at.is_none() || timestamp > captured_at)
    {
        return incoming.to_owned();
    }
    let mut fields = match replacement {
        Some(Value::Object(fields)) => fields,
        _ => {
            let mut fields = serde_json::Map::new();
            if !incoming.is_empty() {
                fields.insert("legacyMetadata".into(), Value::String(incoming.to_owned()));
            }
            fields
        }
    };
    fields.insert("layoutNumber".into(), Value::String(number.to_owned()));
    if let Some(timestamp) = captured_at {
        fields.insert("layoutNumberCapturedAt".into(), Value::String(timestamp.to_rfc3339()));
    } else {
        fields.remove("layoutNumberCapturedAt");
    }
    Value::Object(fields).to_string()
}

pub(crate) fn merge_order_metadata_for_id(
    conn: &Connection,
    order_id: &str,
    incoming: Option<&str>,
) -> rusqlite::Result<Option<String>> {
    let Some(incoming) = incoming else {
        return Ok(None);
    };
    let current: Option<String> = conn.query_row(
        "SELECT metadata FROM orders WHERE id = ?1",
        params![order_id],
        |row| row.get(0),
    )?;
    Ok(Some(merge_order_layout_metadata(current.as_deref(), incoming)))
}

pub struct OrderSummary {
    pub id: String,
    pub order_number: String,
    pub image_count: i64,
    pub created_at: String,
    pub updated_at: String,
    pub metadata: Option<String>,
}

pub struct TemplateQty {
    pub template_id: String,
    pub quantity: i64,
}

pub struct OrderImage {
    pub id: String,
    pub order_id: String,
    pub file_path: String,
    pub thumb_path: Option<String>,
    pub original_name: String,
    pub byte_length: i64,
    pub width: i64,
    pub height: i64,
    pub source: String,
    pub created_at: String,
    pub templates: Vec<TemplateQty>,
}

pub struct OrderDetail {
    pub id: String,
    pub order_number: String,
    pub created_at: String,
    pub updated_at: String,
    pub images: Vec<OrderImage>,
}

pub struct IngestedImage {
    pub image_id: String,
    pub order_id: String,
    pub order_number: String,
    pub file_path: PathBuf,
}

/// 云同步清单里的图片元数据（manifest.json 的 images[] 项）。
pub struct CloudImageMeta {
    pub id: String,
    pub file_name: String,
    pub original_name: String,
    pub byte_length: i64,
    pub width: i64,
    pub height: i64,
    pub source: String,
    pub templates: Vec<TemplateQty>,
}

/// 推送侧定位：图片归档行。
pub struct ImageRow {
    pub order_id: String,
    pub file_path: String,
    pub byte_length: i64,
}

/// 成品记录（制作机导出 / 云端回拉的成品 PNG）。
pub struct ProductionRow {
    pub id: String,
    pub order_number: String,
    pub image_id: Option<String>,
    pub file_path: String,
    pub created_at: String,
}

pub struct Store {
    pub(crate) conn: Mutex<Connection>,
    data_root: PathBuf,
    image_root: PathBuf,
    qiniu_enabled: bool,
}

pub(crate) fn now() -> String {
    Local::now().to_rfc3339()
}

fn now_date() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn random_hex(bytes: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// 对外暴露：随机 hex ID（成品等场景）。
pub fn random_hex_pub(bytes: usize) -> String {
    random_hex(bytes)
}

/// 订单号中的非法路径字符替换为下划线。
fn sanitize_order_number(number: &str) -> String {
    let cleaned: String = number
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        return "order".to_string();
    }
    cleaned.chars().take(40).collect()
}

impl Store {
    pub fn open(data_root: &Path) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Self::open_with_qiniu(data_root, false)
    }

    pub(crate) fn open_with_qiniu(data_root: &Path, qiniu_enabled: bool) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        std::fs::create_dir_all(data_root)?;
        let conn = Connection::open(data_root.join("paidan.db"))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS orders (
                 id TEXT PRIMARY KEY,
                 order_number TEXT NOT NULL UNIQUE,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL,
                 cloud_hash TEXT,
                 metadata TEXT
             );
             CREATE TABLE IF NOT EXISTS images (
                 id TEXT PRIMARY KEY,
                 order_id TEXT NOT NULL REFERENCES orders(id),
                 file_path TEXT NOT NULL,
                 original_name TEXT NOT NULL,
                 byte_length INTEGER NOT NULL,
                 width INTEGER NOT NULL,
                 height INTEGER NOT NULL,
                 source TEXT NOT NULL,
                 created_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_images_order ON images(order_id);
            CREATE TABLE IF NOT EXISTS image_templates (
                image_id TEXT NOT NULL REFERENCES images(id),
                template_id TEXT NOT NULL,
                quantity INTEGER NOT NULL,
                PRIMARY KEY (image_id, template_id)
            );
            CREATE TABLE IF NOT EXISTS productions (
                id TEXT PRIMARY KEY,
                order_number TEXT NOT NULL,
                image_id TEXT,
                file_path TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_productions_order ON productions(order_number);
            CREATE TABLE IF NOT EXISTS file_sync_checkpoints (
                target TEXT NOT NULL,
                order_id TEXT NOT NULL REFERENCES orders(id),
                fingerprint TEXT NOT NULL,
                PRIMARY KEY (target, order_id)
            );
            CREATE TABLE IF NOT EXISTS file_sync_pending (
                target TEXT NOT NULL,
                order_number TEXT NOT NULL,
                image_id TEXT NOT NULL,
                may_add INTEGER NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (target, order_number, image_id)
            );",
        )?;
        crate::workflow_db::init(&conn)?;
        // 旧库迁移：images 表补 thumb_path 列（缩略图路径）
        let has_thumb_column: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('images') WHERE name = 'thumb_path'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if has_thumb_column == 0 {
            conn.execute("ALTER TABLE images ADD COLUMN thumb_path TEXT", [])?;
        }
        // 旧库迁移：orders 表补 cloud_hash 列（云同步清单指纹，多机协同）
        let has_cloud_column: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('orders') WHERE name = 'cloud_hash'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if has_cloud_column == 0 {
            conn.execute("ALTER TABLE orders ADD COLUMN cloud_hash TEXT", [])?;
        }
        // 旧库迁移：orders 表补 metadata 列（千帆订单面板透传的状态/金额/规格文本）
        let has_meta_column: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('orders') WHERE name = 'metadata'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if has_meta_column == 0 {
            conn.execute("ALTER TABLE orders ADD COLUMN metadata TEXT", [])?;
        }
        // 旧数据迁移：素材显示名不再带 paidan 字样（幂等）
        let _ = conn.execute(
            "UPDATE images SET original_name = replace(original_name, 'paidan.', 'photo.') WHERE original_name LIKE 'paidan.%'",
            [],
        );
        // 旧数据迁移：素材来源标注 'paidan' → '千帆'（幂等）
        let _ = conn.execute(
            "UPDATE images SET source = '千帆' WHERE source = 'paidan'",
            [],
        );
        let image_root = data_root.join("images");
        std::fs::create_dir_all(&image_root)?;
        qiniu_store::migrate(&conn)?;
        let store = Self {
            conn: Mutex::new(conn),
            data_root: data_root.to_path_buf(),
            image_root,
            qiniu_enabled,
        };
        store.ensure_thumbnails()?;
        Ok(store)
    }

    /// 为存量图片补生成缩略图（一次性迁移，幂等）。
    fn ensure_thumbnails(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let rows: Vec<(String, String)> = {
            let conn = self.conn.lock().expect("store mutex poisoned");
            let mut statement =
                conn.prepare("SELECT id, file_path FROM images WHERE thumb_path IS NULL")?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        for (image_id, file_path) in rows {
            let Ok(bytes) = std::fs::read(&file_path) else { continue };
            let Ok(decoded) = image::load_from_memory(&bytes) else { continue };
            let thumb = decoded.thumbnail(320, 320);
            let thumb_path = PathBuf::from(&file_path).with_extension("thumb.jpg");
            let mut thumb_bytes: Vec<u8> = Vec::new();
            if thumb
                .write_to(&mut std::io::Cursor::new(&mut thumb_bytes), image::ImageFormat::Jpeg)
                .is_err()
            {
                continue;
            }
            if std::fs::write(&thumb_path, thumb_bytes).is_err() {
                continue;
            }
            let conn = self.conn.lock().expect("store mutex poisoned");
            let _ = conn.execute(
                "UPDATE images SET thumb_path = ?1 WHERE id = ?2",
                params![thumb_path.to_string_lossy(), image_id],
            );
        }
        Ok(())
    }

    pub fn image_root(&self) -> &Path {
        &self.image_root
    }

    /// 收件暂存目录（入库失败的现场保留）。
    pub fn incoming_directory(&self) -> PathBuf {
        self.data_root.join("incoming")
    }

    pub(crate) fn find_or_create_order(&self, conn: &Connection, number: &str) -> Result<String, rusqlite::Error> {
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM orders WHERE order_number = ?1",
                params![number],
                |row| row.get(0),
            )
            .ok();
        if let Some(id) = existing {
            return Ok(id);
        }
        let id = random_hex(16);
        let ts = now();
        conn.execute(
            "INSERT INTO orders(id, order_number, created_at, updated_at) VALUES(?1, ?2, ?3, ?3)",
            params![id, number, ts],
        )?;
        Ok(id)
    }

    /// 捕获入库：写入归档目录 + 落库（含模板预置关联）。
    /// 字节先经图片解码校验，非图片或超尺寸直接拒绝。
    pub fn ingest_image(
        &self,
        order_number: &str,
        bytes: &[u8],
        mime: &str,
        templates: &[(String, i64)],
        source: &str,
    ) -> Result<IngestedImage, Box<dyn std::error::Error + Send + Sync>> {
        self.ingest_with_sync(order_number, bytes, mime, templates, source, None, None)
    }

    pub(crate) fn qiniu_enabled(&self) -> bool {
        self.qiniu_enabled
    }

    pub(crate) fn with_qiniu(mut self, enabled: bool) -> Self {
        self.qiniu_enabled = enabled;
        self
    }

    pub(crate) fn ingest_with_sync(
        &self,
        order_number: &str,
        bytes: &[u8],
        mime: &str,
        templates: &[(String, i64)],
        source: &str,
        quality: Option<CaptureQuality>,
        metadata: Option<&str>,
    ) -> Result<IngestedImage, Box<dyn std::error::Error + Send + Sync>> {
        self.ingest(order_number, bytes, mime, templates, source, quality, metadata, true)
    }

    pub(crate) fn ingest_local_capture(
        &self,
        order_number: &str,
        bytes: &[u8],
        mime: &str,
        templates: &[(String, i64)],
        quality: CaptureQuality,
        metadata: Option<&str>,
    ) -> Result<IngestedImage, Box<dyn std::error::Error + Send + Sync>> {
        self.ingest(order_number, bytes, mime, templates, "千帆", Some(quality), metadata, false)
    }

    fn ingest(
        &self,
        order_number: &str,
        bytes: &[u8],
        mime: &str,
        templates: &[(String, i64)],
        source: &str,
        quality: Option<CaptureQuality>,
        metadata: Option<&str>,
        legacy_sync: bool,
    ) -> Result<IngestedImage, Box<dyn std::error::Error + Send + Sync>> {
        if bytes.is_empty() {
            return Err("图片字节为空".into());
        }
        let decoded = image::load_from_memory(bytes)?;
        let (width, height) = {
            use image::GenericImageView;
            let (w, h) = decoded.dimensions();
            (w as i64, h as i64)
        };
        let extension = match mime {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/webp" => "webp",
            "image/gif" => "gif",
            _ => {
                return Err("仅支持 PNG/JPEG/WebP/GIF 图片".into());
            }
        };

        let mut conn = self.conn.lock().expect("store mutex poisoned");
        let tx = conn.transaction()?;
        let order_id = self.find_or_create_order(&tx, order_number)?;
        let image_id = random_hex(16);
        let label = sanitize_order_number(order_number);
        let directory = self
            .image_root
            .join(now_date())
            .join(format!("{label}_{order_id}"));
        std::fs::create_dir_all(&directory)?;
        let file_path = directory.join(format!("{image_id}.{extension}"));
        std::fs::write(&file_path, bytes)?;
        let cleanup_path = file_path.clone();

        // 缩略图：最长边 320px，JPEG q80（列表/详情渲染用，原图仅去制作时读取）
        let thumb_path = directory.join(format!("{image_id}.thumb.jpg"));
        let thumbnail_result = (|| -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            let thumb = decoded.thumbnail(320, 320);
            let mut thumb_bytes: Vec<u8> = Vec::new();
            thumb.write_to(&mut std::io::Cursor::new(&mut thumb_bytes), image::ImageFormat::Jpeg)?;
            std::fs::write(&thumb_path, thumb_bytes)?;
            Ok(())
        })();
        let thumb_path_value = match thumbnail_result {
            Ok(_) => Some(thumb_path.to_string_lossy().to_string()),
            Err(_) => None, // 缩略图失败不阻塞入库，前端回退原图
        };

        let ts = now();
        let result: Result<IngestedImage, Box<dyn std::error::Error + Send + Sync>> = (|| {
            tx.execute(
                "INSERT INTO images(id, order_id, file_path, original_name, byte_length, width, height, source, created_at, thumb_path)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    image_id,
                    order_id,
                    file_path.to_string_lossy(),
                    format!("photo.{extension}"),
                    bytes.len() as i64,
                    width,
                    height,
                    source,
                    ts,
                    thumb_path_value
                ],
            )?;
            for (template_id, quantity) in templates {
                if *quantity < 1 {
                    continue;
                }
                tx.execute(
                    "INSERT OR REPLACE INTO image_templates(image_id, template_id, quantity) VALUES(?1, ?2, ?3)",
                    params![image_id, template_id, quantity],
                )?;
            }
            let metadata = merge_order_metadata_for_id(&tx, &order_id, metadata)?;
            tx.execute(
                "UPDATE orders SET updated_at = ?2, metadata = COALESCE(?3, metadata) WHERE id = ?1",
                params![order_id, now(), metadata],
            )?;
            if let Some(quality) = quality {
                qiniu_store::register_capture(&tx, &image_id, order_number, quality)?;
                if !legacy_sync {
                    tx.execute(
                        "UPDATE qiniu_assets SET state='localOnly' WHERE id=?1",
                        [&image_id],
                    )?;
                }
            }
            tx.commit()?;
            Ok(IngestedImage {
                image_id: image_id.clone(),
                order_id: order_id.clone(),
                order_number: order_number.to_string(),
                file_path,
            })
        })();

        if result.is_err() {
            // 元数据写入失败保留归档副本，与订单素材台语义一致。
            let _ = std::fs::remove_file(&cleanup_path);
            let _ = std::fs::remove_file(&thumb_path);
            return result;
        }
        result
    }

    pub fn list_orders(&self) -> Result<Vec<OrderSummary>, rusqlite::Error> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let mut statement = conn.prepare(
            "SELECT o.id, o.order_number, o.created_at, o.updated_at,
                    (SELECT COUNT(*) FROM images i WHERE i.order_id = o.id) AS image_count,
                    o.metadata
             FROM orders o
             ORDER BY o.updated_at DESC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(OrderSummary {
                id: row.get(0)?,
                order_number: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                image_count: row.get(4)?,
                metadata: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_order(&self, id: &str) -> Result<Option<OrderDetail>, rusqlite::Error> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let order = match conn.query_row(
            "SELECT id, order_number, created_at, updated_at FROM orders WHERE id = ?1",
            params![id],
            |row| {
                Ok(OrderDetail {
                    id: row.get(0)?,
                    order_number: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                    images: Vec::new(),
                })
            },
        ) {
            Ok(order) => order,
            Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
            Err(error) => return Err(error),
        };

        let mut statement = conn.prepare(
            "SELECT id, order_id, file_path, original_name, byte_length, width, height, source, created_at, thumb_path
             FROM images WHERE order_id = ?1 ORDER BY created_at ASC",
        )?;
        let mut images: Vec<OrderImage> = statement
            .query_map(params![id], |row| {
                Ok(OrderImage {
                    id: row.get(0)?,
                    order_id: row.get(1)?,
                    file_path: row.get(2)?,
                    thumb_path: row.get(9)?,
                    original_name: row.get(3)?,
                    byte_length: row.get(4)?,
                    width: row.get(5)?,
                    height: row.get(6)?,
                    source: row.get(7)?,
                    created_at: row.get(8)?,
                    templates: Vec::new(),
                })
            })?
            .collect::<Result<_, _>>()?;

        let mut template_statement =
            conn.prepare("SELECT template_id, quantity FROM image_templates WHERE image_id = ?1")?;
        for image in &mut images {
            let rows = template_statement.query_map(params![image.id], |row| {
                Ok(TemplateQty {
                    template_id: row.get(0)?,
                    quantity: row.get(1)?,
                })
            })?;
            image.templates = rows.collect::<Result<_, _>>()?;
            image.templates.sort_by(|a, b| a.template_id.cmp(&b.template_id));
        }
        drop(template_statement);

        Ok(Some(OrderDetail { images, ..order }))
    }

    /// 更新图片的模板关联与份数（全量替换；份数 <1 视为取消）。
    pub fn set_image_templates(
        &self,
        image_id: &str,
        templates: &[(String, i64)],
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.set_image_templates_and_queue(image_id, templates, None).map(|_| ())
    }

    pub(crate) fn set_image_templates_and_queue(
        &self,
        image_id: &str,
        templates: &[(String, i64)],
        upload: Option<(&str, bool)>,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let mut lock = self.conn.lock().expect("store mutex poisoned");
        let conn = lock.transaction()?;
        let (order_id, order_number): (String, String) = conn.query_row(
            "SELECT i.order_id, o.order_number FROM images i JOIN orders o ON i.order_id = o.id WHERE i.id = ?1",
            [image_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        conn.execute(
            "DELETE FROM image_templates WHERE image_id = ?1",
            params![image_id],
        )?;
        for (template_id, quantity) in templates {
            if *quantity < 1 {
                continue;
            }
            conn.execute(
                "INSERT OR REPLACE INTO image_templates(image_id, template_id, quantity) VALUES(?1, ?2, ?3)",
                params![image_id, template_id, quantity],
            )?;
        }
        conn.execute(
            "UPDATE orders SET updated_at = ?2 WHERE id = ?1",
            params![order_id, now()],
        )?;
        if let Some((target, may_add)) = upload {
            Self::enqueue_file_upload_on(&conn, target, &order_number, image_id, may_add)?;
        }
        conn.commit()?;
        Ok(order_number)
    }

    /// 删除图片记录（磁盘文件保留）。
    pub fn delete_image(&self, image_id: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        conn.execute("DELETE FROM image_templates WHERE image_id = ?1", params![image_id])?;
        conn.execute("DELETE FROM images WHERE id = ?1", params![image_id])?;
        Ok(())
    }

    /* ---------- 云同步（MinIO 多机协同） ---------- */

    /// 推送侧：定位图片归档行（读字节上传 + 找订单）。
    pub fn get_image(&self, image_id: &str) -> Result<Option<ImageRow>, rusqlite::Error> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let row = conn
            .query_row(
                "SELECT order_id, file_path, byte_length FROM images WHERE id = ?1",
                params![image_id],
                |row| {
                    Ok(ImageRow {
                        order_id: row.get(0)?,
                        file_path: row.get(1)?,
                        byte_length: row.get(2)?,
                    })
                },
            )
            .ok();
        Ok(row)
    }

    pub fn order_number_by_id(&self, order_id: &str) -> Result<Option<String>, rusqlite::Error> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        Ok(conn
            .query_row(
                "SELECT order_number FROM orders WHERE id = ?1",
                params![order_id],
                |row| row.get(0),
            )
            .ok())
    }

    /// 推送侧：订单的全部图片元数据（含模板关联 + 归档全路径），用于构建 manifest。
    pub fn cloud_order_images(
        &self,
        order_number: &str,
    ) -> Result<Option<Vec<(CloudImageMeta, PathBuf)>>, rusqlite::Error> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let order_id: Option<String> = conn
            .query_row(
                "SELECT id FROM orders WHERE order_number = ?1",
                params![order_number],
                |row| row.get(0),
            )
            .ok();
        let Some(order_id) = order_id else { return Ok(None) };
        let mut statement = conn.prepare(
            "SELECT id, file_path, original_name, byte_length, width, height, source
             FROM images WHERE order_id = ?1 ORDER BY created_at ASC",
        )?;
        let mut images: Vec<(CloudImageMeta, PathBuf)> = statement
            .query_map(params![order_id], |row| {
                let file_path: String = row.get(1)?;
                let file_name = std::path::Path::new(&file_path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                Ok((
                    CloudImageMeta {
                        id: row.get(0)?,
                        file_name,
                        original_name: row.get(2)?,
                        byte_length: row.get(3)?,
                        width: row.get(4)?,
                        height: row.get(5)?,
                        source: row.get(6)?,
                        templates: Vec::new(),
                    },
                    PathBuf::from(&file_path),
                ))
            })?
            .collect::<Result<_, _>>()?;
        let mut template_statement =
            conn.prepare("SELECT template_id, quantity FROM image_templates WHERE image_id = ?1")?;
        for (image, _) in &mut images {
            let rows = template_statement.query_map(params![image.id], |row| {
                Ok(TemplateQty {
                    template_id: row.get(0)?,
                    quantity: row.get(1)?,
                })
            })?;
            image.templates = rows.collect::<Result<_, _>>()?;
        }
        drop(template_statement);
        Ok(Some(images))
    }

    /// 推送侧：订单最新 updated_at（manifest 版本信息）。
    pub fn order_updated_at_by_number(&self, order_number: &str) -> Result<Option<String>, rusqlite::Error> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        Ok(conn
            .query_row(
                "SELECT updated_at FROM orders WHERE order_number = ?1",
                params![order_number],
                |row| row.get(0),
            )
            .ok())
    }

    /// 拉取侧：本机已知的云清单指纹（订单号 → cloud_hash）。
    pub fn cloud_hashes(&self) -> Result<Vec<(String, Option<String>)>, rusqlite::Error> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let mut statement =
            conn.prepare("SELECT order_number, cloud_hash FROM orders ORDER BY order_number")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect()
    }

    pub(crate) fn file_sync_fingerprints(
        &self,
        target: &str,
    ) -> rusqlite::Result<std::collections::HashMap<String, String>> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let mut statement = conn.prepare(
            "SELECT o.order_number, f.fingerprint FROM file_sync_checkpoints f
             JOIN orders o ON o.id = f.order_id WHERE f.target = ?1",
        )?;
        let rows = statement.query_map([target], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect()
    }

    pub(crate) fn enqueue_file_upload(
        &self, target: &str, order_number: &str, image_id: &str, may_add: bool,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        Self::enqueue_file_upload_on(&conn, target, order_number, image_id, may_add)
    }

    fn enqueue_file_upload_on(
        conn: &Connection, target: &str, order_number: &str, image_id: &str, may_add: bool,
    ) -> rusqlite::Result<()> {
        conn.execute(
            "INSERT INTO file_sync_pending(target, order_number, image_id, may_add) VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(target, order_number, image_id)
             DO UPDATE SET revision=revision+1, may_add=MAX(may_add, excluded.may_add)",
            params![target, order_number, image_id, may_add],
        )?;
        Ok(())
    }

    pub(crate) fn pending_file_uploads(&self, target: &str) -> rusqlite::Result<Vec<PendingFileUpload>> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let mut statement = conn.prepare(
            "SELECT order_number, image_id, may_add, revision FROM file_sync_pending WHERE target=?1 ORDER BY order_number, rowid",
        )?;
        let rows = statement.query_map([target], |row| Ok(PendingFileUpload {
            order_number: row.get(0)?, image_id: row.get(1)?, may_add: row.get(2)?, revision: row.get(3)?,
        }))?;
        rows.collect()
    }

    pub(crate) fn complete_file_upload(
        &self,
        target: &str,
        item: &PendingFileUpload,
    ) -> rusqlite::Result<()> {
        self.conn.lock().expect("store mutex poisoned").execute(
            "DELETE FROM file_sync_pending WHERE target=?1 AND order_number=?2 AND image_id=?3 AND revision=?4",
            params![target, item.order_number, item.image_id, item.revision],
        )?;
        Ok(())
    }

    /// 拉取侧：云端图片落盘目录 数据根/images/YYYY-MM-DD/<安全订单号>_cloud/。
    pub fn cloud_import_directory(&self, order_number: &str) -> PathBuf {
        self.image_root
            .join(now_date())
            .join(format!("{}_cloud", sanitize_order_number(order_number)))
    }

    /// 拉取侧：幂等导入。图片 ID 沿用云端（双机一致）；同号复用本地订单；
    /// 模板关联以 manifest 为准全量替换；返回新增图片数。
    pub fn import_cloud_order(
        &self,
        order_number: &str,
        images: &[(CloudImageMeta, PathBuf)],
        manifest_hash: &str,
        updated_at: &str,
    ) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
        self.import_synced_order(order_number, images, updated_at, CloudImport::Mysql(manifest_hash))
            .map(|count| count.unwrap_or_default())
    }

    pub(crate) fn import_file_order(
        &self,
        order_number: &str,
        images: &[(CloudImageMeta, PathBuf)],
        updated_at: &str,
        state: FileSyncImport<'_>,
    ) -> Result<Option<usize>, Box<dyn std::error::Error + Send + Sync>> {
        self.import_synced_order(order_number, images, updated_at, CloudImport::Files(state))
    }

    fn import_synced_order(
        &self,
        order_number: &str,
        images: &[(CloudImageMeta, PathBuf)],
        updated_at: &str,
        source: CloudImport<'_>,
    ) -> Result<Option<usize>, Box<dyn std::error::Error + Send + Sync>> {
        let mut lock = self.conn.lock().expect("store mutex poisoned");
        let conn = lock.transaction()?;
        if let CloudImport::Files(state) = &source {
            let pending: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM file_sync_pending WHERE target=?1 AND order_number=?2)",
                params![state.target, order_number],
                |row| row.get(0),
            )?;
            if pending {
                return Ok(None);
            }
        }
        let order_id = self.find_or_create_order(&conn, order_number)?;
        let mut new_images = 0usize;
        for (meta, path) in images {
            let owner: Option<String> = conn.query_row(
                "SELECT order_id FROM images WHERE id = ?1",
                params![meta.id],
                |row| row.get(0),
            ).optional()?;
            if owner.as_ref().is_some_and(|id| id != &order_id) {
                return Err("同步素材 ID 属于另一订单".into());
            }
            if owner.is_none() {
                // 缩略图：与入库一致（失败不阻塞导入，前端回退原图）
                let thumb_path = path.with_extension("thumb.jpg");
                let thumb_path_value = (|| -> Option<String> {
                    let bytes = std::fs::read(path).ok()?;
                    let decoded = image::load_from_memory(&bytes).ok()?;
                    let thumb = decoded.thumbnail(320, 320);
                    let mut thumb_bytes: Vec<u8> = Vec::new();
                    thumb
                        .write_to(&mut std::io::Cursor::new(&mut thumb_bytes), image::ImageFormat::Jpeg)
                        .ok()?;
                    std::fs::write(&thumb_path, thumb_bytes).ok()?;
                    Some(thumb_path.to_string_lossy().to_string())
                })();
                conn.execute(
                    "INSERT INTO images(id, order_id, file_path, original_name, byte_length, width, height, source, created_at, thumb_path)
                     VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    params![
                        meta.id,
                        order_id,
                        path.to_string_lossy(),
                        meta.original_name,
                        meta.byte_length,
                        meta.width,
                        meta.height,
                        meta.source,
                        now(),
                        thumb_path_value
                    ],
                )?;
                new_images += 1;
            }
            // 模板关联以云端清单为准（全量替换，含已存在图片的份数更新）
            conn.execute(
                "DELETE FROM image_templates WHERE image_id = ?1",
                params![meta.id],
            )?;
            for template in &meta.templates {
                if template.quantity < 1 {
                    continue;
                }
                conn.execute(
                    "INSERT OR REPLACE INTO image_templates(image_id, template_id, quantity) VALUES(?1, ?2, ?3)",
                    params![meta.id, template.template_id, template.quantity],
                )?;
            }
        }
        match source {
            CloudImport::Mysql(watermark) => {
                conn.execute(
                    "UPDATE orders SET updated_at = ?2, cloud_hash = ?3 WHERE id = ?1",
                    params![order_id, updated_at, watermark],
                )?;
            }
            CloudImport::Files(state) => {
                let previous: Option<String> = conn.query_row(
                    "SELECT metadata FROM orders WHERE id=?1", [&order_id], |row| row.get(0),
                )?;
                let updated_meta = merge_file_layout_metadata(previous.as_deref(), &state);
                conn.execute(
                    "UPDATE orders SET updated_at=MAX(updated_at, ?2), metadata=COALESCE(?3, metadata) WHERE id=?1",
                    params![order_id, updated_at, updated_meta],
                )?;
                conn.execute(
                    "INSERT INTO file_sync_checkpoints(target, order_id, fingerprint) VALUES(?1, ?2, ?3)
                     ON CONFLICT(target, order_id) DO UPDATE SET fingerprint=excluded.fingerprint",
                    params![state.target, order_id, state.fingerprint],
                )?;
            }
        }
        conn.commit()?;
        Ok(Some(new_images))
    }

    /// 读取订单元数据（推送 MySQL 用）。
    pub fn order_metadata_by_number(
        &self,
        order_number: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        Ok(conn
            .query_row(
                "SELECT metadata FROM orders WHERE order_number = ?1",
                params![order_number],
                |row| row.get(0),
            )
            .ok())
    }

    /// 千帆面板元数据写入（状态/金额/规格文本，制作端悬浮卡展示）。
    pub fn set_order_metadata(
        &self,
        order_number: &str,
        metadata: &str,
    ) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let current = conn
            .query_row(
                "SELECT metadata FROM orders WHERE order_number = ?1",
                params![order_number],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        let metadata = merge_order_layout_metadata(current.as_deref(), metadata);
        conn.execute(
            "UPDATE orders SET metadata = ?2 WHERE order_number = ?1",
            params![order_number, metadata],
        )?;
        Ok(())
    }

    /// 推送后回填水位（PG updated_at 文本），避免下次轮询重复拉取。
    pub fn set_cloud_hash(&self, order_number: &str, hash: &str) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        conn.execute(
            "UPDATE orders SET cloud_hash = ?2 WHERE order_number = ?1",
            params![order_number, hash],
        )?;
        Ok(())
    }

    /// 按订单号取详情（先查 id 再复用 get_order，注意释放锁避免重入）。
    pub fn get_order_by_number(
        &self,
        order_number: &str,
    ) -> Result<Option<OrderDetail>, rusqlite::Error> {
        let order_id: Option<String> = {
            let conn = self.conn.lock().expect("store mutex poisoned");
            conn.query_row(
                "SELECT id FROM orders WHERE order_number = ?1",
                params![order_number],
                |row| row.get::<_, String>(0),
            )
            .ok()
        };
        match order_id {
            Some(id) => self.get_order(&id),
            None => Ok(None),
        }
    }

    /* ---------- 成品 ---------- */

    pub fn production_exists(&self, id: &str) -> Result<bool, rusqlite::Error> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM productions WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    pub fn add_production(
        &self,
        id: &str,
        order_number: &str,
        image_id: Option<&str>,
        file_path: &Path,
    ) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        conn.execute(
            "INSERT OR IGNORE INTO productions(id, order_number, image_id, file_path, created_at) VALUES(?1, ?2, ?3, ?4, ?5)",
            params![id, order_number, image_id, file_path.to_string_lossy(), now()],
        )?;
        Ok(())
    }

    pub fn list_productions(&self, order_number: &str) -> Result<Vec<ProductionRow>, rusqlite::Error> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let mut statement = conn.prepare(
            "SELECT id, order_number, image_id, file_path, created_at FROM productions
             WHERE order_number = ?1 ORDER BY created_at ASC",
        )?;
        let rows = statement.query_map(params![order_number], |row| {
            Ok(ProductionRow {
                id: row.get(0)?,
                order_number: row.get(1)?,
                image_id: row.get(2)?,
                file_path: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    /// 删除订单记录（磁盘图片保留）。
    pub fn delete_order(&self, id: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut lock = self.conn.lock().expect("store mutex poisoned");
        let conn = lock.transaction()?;
        conn.execute(
            "DELETE FROM image_templates WHERE image_id IN (SELECT id FROM images WHERE order_id = ?1)",
            params![id],
        )?;
        conn.execute("DELETE FROM images WHERE order_id = ?1", params![id])?;
        conn.execute("DELETE FROM file_sync_checkpoints WHERE order_id = ?1", params![id])?;
        conn.execute(
            "DELETE FROM file_sync_pending WHERE order_number = (SELECT order_number FROM orders WHERE id = ?1)",
            params![id],
        )?;
        conn.execute("DELETE FROM orders WHERE id = ?1", params![id])?;
        conn.commit()?;
        Ok(())
    }

    pub fn read_image_bytes(&self, image_id: &str) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let path: String = conn.query_row(
            "SELECT file_path FROM images WHERE id = ?1",
            params![image_id],
            |row| row.get(0),
        )?;
        Ok(std::fs::read(path)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn recapture_keeps_layout_number_until_a_new_number_is_supplied() {
        let (store, root) = open_store();
        let capture = |metadata| {
            store
                .ingest_with_sync(
                    "layout-number-order",
                    PNG_BYTES,
                    "image/png",
                    &[],
                    "test",
                    Some(CaptureQuality::Original),
                    metadata,
                )
                .unwrap();
        };
        let layout_number = || {
            let metadata = store
                .order_metadata_by_number("layout-number-order")
                .unwrap()
                .unwrap();
            serde_json::from_str::<serde_json::Value>(&metadata).unwrap()["layoutNumber"].clone()
        };
        capture(Some(r#"{"status":"待发货","layoutNumber":"ch-00017"}"#));
        capture(Some(r#"{"status":"待收货"}"#));
        assert_eq!(layout_number(), "ch-00017");
        capture(Some(r#"{"layoutNumber":"yy-00023"}"#));
        assert_eq!(layout_number(), "yy-00023");
        let jobs = store.qiniu_due_uploads().unwrap();
        assert_eq!(jobs.len(), 2);
        for job in jobs {
            let metadata = serde_json::from_str::<Value>(job.metadata.as_deref().unwrap()).unwrap();
            assert_eq!(metadata["layoutNumber"], "yy-00023");
        }
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn qiniu_snapshot_does_not_replace_a_more_recent_local_layout_number() {
        let (store, root) = open_store();
        const ORDER: &str = "layout-number-snapshot";
        let latest = r#"{"layoutNumber":"yy-00023","layoutNumberCapturedAt":"2026-11-20T03:00:00.099Z"}"#;
        store
            .ingest_with_sync(
                ORDER,
                PNG_BYTES,
                "image/png",
                &[],
                "test",
                Some(CaptureQuality::Original),
                Some(latest),
            )
            .unwrap();
        let mut remote = crate::qiniu_transport::RemoteOrder {
            order_number: ORDER.into(),
            version: 1,
            deleted: false,
            metadata: Some(
                r#"{"layoutNumber":"ch-00017","layoutNumberCapturedAt":"2026-11-20T03:00:00.010Z"}"#
                    .into(),
            ),
            assets: Vec::new(),
        };
        let layout_number = || {
            let metadata = store.order_metadata_by_number(ORDER).unwrap().unwrap();
            serde_json::from_str::<serde_json::Value>(&metadata).unwrap()["layoutNumber"].clone()
        };
        store.qiniu_apply_snapshot(&remote, &[]).unwrap();
        assert_eq!(layout_number(), "yy-00023");
        remote.version = 2;
        remote.metadata = Some(
            r#"{"layoutNumber":"x-00902","layoutNumberCapturedAt":"2026-11-20T03:00:00.122Z"}"#
                .into(),
        );
        store.qiniu_apply_snapshot(&remote, &[]).unwrap();
        assert_eq!(layout_number(), "x-00902");
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn qiniu_enqueues_only_new_originals_and_survives_reopen() {
        use crate::qiniu_store::CaptureQuality;
        let (store, root) = open_store();
        store.ingest_image("before", PNG_BYTES, "image/png", &[], "test").unwrap();
        let original = store.ingest_with_sync("new", PNG_BYTES, "image/png", &[], "test",
            Some(CaptureQuality::Original), None).unwrap();
        let scaled = store.ingest_with_sync("new", PNG_BYTES, "image/png", &[], "test",
            Some(CaptureQuality::Scaled), None).unwrap();
        drop(store);
        let store = Store::open(&root).unwrap();
        let jobs = store.qiniu_due_uploads().unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].id, original.image_id);
        assert_eq!(store.qiniu_asset_state(&scaled.image_id).unwrap().unwrap().state, "localOnly");
    }

    const PNG_BYTES: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    fn open_store() -> (Store, PathBuf) {
        let root = std::env::temp_dir().join(format!("paidan-store-test-{}", random_hex(6)));
        let store = Store::open(&root).expect("open store");
        (store, root)
    }

    #[test]
    fn 同号复用订单且模板关联可替换() {
        let (store, root) = open_store();
        let ingested = store
            .ingest_image(
                "610",
                PNG_BYTES,
                "image/png",
                &[("模板爱心.png".to_string(), 2)],
                "paidan",
            )
            .expect("ingest");
        store
            .ingest_image("610", PNG_BYTES, "image/png", &[], "paidan")
            .expect("ingest 2");

        let detail = store.get_order(&ingested.order_id).expect("get").expect("存在");
        assert_eq!(detail.order_number, "610");
        assert_eq!(detail.images.len(), 2);
        let templates = store
            .get_order(&ingested.order_id)
            .unwrap()
            .unwrap()
            .images
            .into_iter()
            .find(|i| i.id == ingested.image_id)
            .unwrap()
            .templates;
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0].template_id, "模板爱心.png");
        assert_eq!(templates[0].quantity, 2);

        store
            .set_image_templates(
                &ingested.image_id,
                &[("模板粉色.png".to_string(), 3)],
            )
            .expect("set");
        let detail = store.get_order(&ingested.order_id).unwrap().unwrap();
        let updated = detail.images.iter().find(|i| i.id == ingested.image_id).unwrap();
        assert_eq!(updated.templates[0].template_id, "模板粉色.png");
        assert_eq!(updated.templates[0].quantity, 3);

        drop(store);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn 非图片字节被拒绝() {
        let (store, root) = open_store();
        let result = store.ingest_image("610", b"not an image", "image/png", &[], "paidan");
        assert!(result.is_err());
        assert!(store.list_orders().unwrap().is_empty());
        drop(store);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn 删除订单保留磁盘文件() {
        let (store, root) = open_store();
        let ingested = store
            .ingest_image("610", PNG_BYTES, "image/png", &[], "paidan")
            .expect("ingest");
        let path = ingested.file_path.clone();
        store.delete_order(&ingested.order_id).expect("delete");
        assert!(store.list_orders().unwrap().is_empty());
        assert!(path.exists(), "归档文件应保留");
        drop(store);
        fs::remove_dir_all(root).expect("cleanup");
    }
}
