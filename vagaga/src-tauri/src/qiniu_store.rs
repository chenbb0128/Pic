use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

use crate::qiniu_transport::{RemoteOrder, Template, UploadRequest};
use crate::store::{merge_order_metadata_for_id, now, random_hex_pub, Store};

#[derive(Clone, Copy)]
pub(crate) enum CaptureQuality {
    Original,
    Scaled,
    Unknown,
}

impl CaptureQuality {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Original => "original",
            Self::Scaled => "scaled",
            Self::Unknown => "unknown",
        }
    }
}

pub(crate) struct AssetState {
    pub quality: Option<String>,
    pub state: String,
    pub error: Option<String>,
    byte_length: Option<u64>,
    file_mtime_ns: Option<i64>,
}

impl AssetState {
    pub(crate) fn file_ready(&self, path: &Path) -> bool {
        std::fs::metadata(path).is_ok_and(|meta| {
            meta.is_file()
                && self.byte_length.is_none_or(|size| meta.len() == size)
                && self
                    .file_mtime_ns
                    .is_none_or(|mtime| modified_ns(&meta) == Some(mtime))
        })
    }
}

pub(crate) struct UploadJob {
    pub id: String,
    pub kind: String,
    pub order_number: String,
    pub path: PathBuf,
    pub file_name: String,
    pub width: u32,
    pub height: u32,
    pub source_image_id: Option<String>,
    pub metadata: Option<String>,
    pub attempts: u32,
    pub request: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub(crate) enum Mutation {
    Templates {
        image_id: String,
        templates: Vec<Template>,
    },
    DeleteImage {
        image_id: String,
    },
    DeleteOrder,
}

impl Mutation {
    fn image_id(&self) -> Option<&str> {
        match self {
            Self::Templates { image_id, .. } | Self::DeleteImage { image_id } => Some(image_id),
            Self::DeleteOrder => None,
        }
    }
}

pub(crate) struct MutationJob {
    pub id: String,
    pub order_number: String,
    pub version: u64,
    pub operation: Mutation,
    pub attempts: u32,
}

pub(crate) struct SnapshotJob {
    pub order: RemoteOrder,
    pub attempts: u32,
    pub error: Option<String>,
}

pub(crate) fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS qiniu_settings (
            singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
            settings TEXT NOT NULL, credential BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS qiniu_assets (
            id TEXT PRIMARY KEY, order_number TEXT NOT NULL,
            kind TEXT NOT NULL, quality TEXT, state TEXT NOT NULL, error TEXT,
            sha256 TEXT, byte_length INTEGER, file_mtime_ns INTEGER,
            request TEXT, attempts INTEGER NOT NULL DEFAULT 0,
            retry_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS qiniu_assets_queue ON qiniu_assets(state, retry_at);
        CREATE INDEX IF NOT EXISTS qiniu_assets_order ON qiniu_assets(order_number);
        CREATE TABLE IF NOT EXISTS qiniu_order_versions (
            order_number TEXT PRIMARY KEY, applied INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS qiniu_snapshots (
            order_number TEXT PRIMARY KEY, version INTEGER NOT NULL, payload TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, error TEXT
        );
        CREATE TABLE IF NOT EXISTS qiniu_mutations (
            id TEXT PRIMARY KEY, order_number TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
            error TEXT, conflict INTEGER NOT NULL DEFAULT 0, committed_version INTEGER
        );
        UPDATE qiniu_assets SET state = 'pending' WHERE state = 'uploading';",
    )?;
    // Development installations may already have created the first queue schema.
    for (table, column) in [
        ("qiniu_assets", "file_mtime_ns"),
        ("qiniu_mutations", "committed_version"),
    ] {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",
            [table, column],
            |row| row.get(0),
        )?;
        if !exists {
            conn.execute(
                &format!("ALTER TABLE {table} ADD COLUMN {column} INTEGER"),
                [],
            )?;
        }
    }
    Ok(())
}

pub(crate) fn register_capture(
    tx: &Transaction<'_>,
    id: &str,
    number: &str,
    quality: CaptureQuality,
) -> rusqlite::Result<()> {
    let (state, error) = match quality {
        CaptureQuality::Original => ("pending", None),
        CaptureQuality::Scaled => ("localOnly", Some("千帆仅返回缩略图，请重新获取原图后排单")),
        CaptureQuality::Unknown => (
            "localOnly",
            Some("无法确认图片来源，请在千帆打开原图后重新排单"),
        ),
    };
    tx.execute(
        "INSERT INTO qiniu_assets (id,order_number,kind,quality,state,error)
         VALUES (?1,?2,'original',?3,?4,?5)",
        params![id, number, quality.label(), state, error],
    )?;
    Ok(())
}

fn epoch() -> i64 {
    chrono::Utc::now().timestamp()
}

fn modified_ns(meta: &std::fs::Metadata) -> Option<i64> {
    let time = meta.modified().ok()?;
    i64::try_from(time.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos()).ok()
}

pub(crate) fn retry_at(attempts: u32, retryable: bool) -> i64 {
    if !retryable {
        return i64::MAX;
    }
    let delay = match attempts {
        0 => 5,
        1 => 15,
        2 => 60,
        _ => 295,
    };
    epoch() + delay + i64::from(rand::random::<u8>() % 5)
}

fn encode<T: Serialize>(value: &T) -> rusqlite::Result<String> {
    serde_json::to_string(value).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
}

fn decode<T: serde::de::DeserializeOwned>(value: &str) -> rusqlite::Result<T> {
    serde_json::from_str(value).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn version(conn: &Connection, number: &str) -> rusqlite::Result<Option<u64>> {
    conn.query_row(
        "SELECT applied FROM qiniu_order_versions WHERE order_number=?1",
        [number],
        |row| row.get(0),
    )
    .optional()
}

fn replace_templates(conn: &Connection, id: &str, templates: &[Template]) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM image_templates WHERE image_id=?1", [id])?;
    for template in templates {
        if template.quantity > 0 {
            conn.execute(
                "INSERT OR REPLACE INTO image_templates(image_id,template_id,quantity) VALUES(?1,?2,?3)",
                params![id, template.template_id, template.quantity],
            )?;
        }
    }
    Ok(())
}

fn delete_image(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM image_templates WHERE image_id=?1", [id])?;
    conn.execute("DELETE FROM images WHERE id=?1", [id])?;
    Ok(())
}

fn queue_mutation(
    tx: &Transaction<'_>,
    number: &str,
    current: u64,
    mutation: &Mutation,
) -> Result<(), String> {
    // A pending change keeps its expected version and request ID until it is acknowledged.
    let outstanding: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM qiniu_mutations WHERE order_number=?1 AND conflict=0)",
            [number],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if outstanding {
        return Err("此订单还有一次修改待同步，请先同步或检查失败原因".into());
    }
    tx.execute(
        "DELETE FROM qiniu_mutations WHERE order_number=?1 AND conflict=1
          AND COALESCE(json_extract(payload,'$.Templates.image_id'),
                       json_extract(payload,'$.DeleteImage.image_id')) IS ?2",
        params![number, mutation.image_id()],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO qiniu_mutations(id,order_number,version,payload) VALUES(?1,?2,?3,?4)",
        params![
            random_hex_pub(16),
            number,
            current,
            encode(mutation).map_err(|e| e.to_string())?
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

impl Store {
    pub(crate) fn read_qiniu_settings(&self) -> rusqlite::Result<Option<(String, Vec<u8>)>> {
        self.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT settings,credential FROM qiniu_settings WHERE singleton=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
    }

    pub(crate) fn write_qiniu_settings(
        &self,
        settings: &str,
        credential: &[u8],
    ) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT OR REPLACE INTO qiniu_settings(singleton,settings,credential) VALUES(1,?1,?2)",
            params![settings, credential],
        )?;
        Ok(())
    }

    pub(crate) fn qiniu_due_uploads(&self) -> rusqlite::Result<Vec<UploadJob>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = conn.prepare(
            "SELECT a.id,a.kind,a.order_number,COALESCE(i.file_path,p.file_path),
                COALESCE(i.original_name,''),COALESCE(i.width,0),COALESCE(i.height,0),p.image_id,
                o.metadata,a.attempts,a.request
             FROM qiniu_assets a
             LEFT JOIN images i ON i.id=a.id AND a.kind='original'
             LEFT JOIN productions p ON p.id=a.id AND a.kind='production'
             JOIN orders o ON o.order_number=a.order_number
             WHERE a.state IN ('pending','failed') AND a.retry_at <= ?1
                AND (i.id IS NOT NULL OR p.id IS NOT NULL)
                AND NOT EXISTS(SELECT 1 FROM qiniu_mutations m WHERE m.order_number=a.order_number
                    AND m.conflict=0 AND json_extract(m.payload,'$')='DeleteOrder')
                AND (p.image_id IS NULL OR EXISTS
                    (SELECT 1 FROM qiniu_assets image WHERE image.id=p.image_id AND image.state='synced'))
             ORDER BY a.retry_at,a.rowid LIMIT 2",
        )?;
        let rows = sql.query_map([epoch()], |row| {
            Ok(UploadJob {
                id: row.get(0)?,
                kind: row.get(1)?,
                order_number: row.get(2)?,
                path: PathBuf::from(row.get::<_, String>(3)?),
                file_name: row.get(4)?,
                width: row.get(5)?,
                height: row.get(6)?,
                source_image_id: row.get(7)?,
                metadata: row.get(8)?,
                attempts: row.get(9)?,
                request: row.get(10)?,
            })
        })?;
        rows.collect()
    }

    pub(crate) fn qiniu_begin_upload(&self, id: &str) -> rusqlite::Result<bool> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.execute(
            "UPDATE qiniu_assets SET state='uploading',error=NULL
             WHERE id=?1 AND state IN ('pending','failed') AND NOT EXISTS
              (SELECT 1 FROM qiniu_mutations m WHERE m.order_number=qiniu_assets.order_number
                AND m.conflict=0 AND json_extract(m.payload,'$')='DeleteOrder')",
            [id],
        )? == 1)
    }

    pub(crate) fn qiniu_save_upload_request(
        &self,
        id: &str,
        value: &UploadRequest,
    ) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE qiniu_assets SET request=?2 WHERE id=?1",
            params![id, encode(value)?],
        )?;
        Ok(())
    }

    pub(crate) fn qiniu_upload_done(&self, request: &UploadRequest) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE qiniu_assets SET state='synced',error=NULL,sha256=?2,byte_length=?3,request=NULL
             WHERE id=?1",
            params![request.asset_id, request.sha256, request.byte_length],
        )?;
        Ok(())
    }

    pub(crate) fn qiniu_upload_failed(
        &self,
        id: &str,
        error: &str,
        next: i64,
    ) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE qiniu_assets SET state='failed',error=?2,retry_at=?3,attempts=attempts+1
             WHERE id=?1 AND state='uploading'",
            params![id, error, next],
        )?;
        Ok(())
    }

    pub(crate) fn qiniu_asset_state(&self, id: &str) -> rusqlite::Result<Option<AssetState>> {
        self.conn.lock().unwrap().query_row(
            "SELECT quality,state,error,byte_length,file_mtime_ns FROM qiniu_assets WHERE id=?1", [id],
            |row| Ok(AssetState {
                quality: row.get(0)?, state: row.get(1)?, error: row.get(2)?,
                byte_length: row.get(3)?, file_mtime_ns: row.get(4)?,
            }),
        ).optional()
    }

    pub(crate) fn qiniu_upload_templates(&self, id: &str) -> rusqlite::Result<Vec<Template>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = conn.prepare(
            "SELECT template_id,quantity FROM image_templates WHERE image_id=?1 ORDER BY template_id",
        )?;
        let rows = sql.query_map([id], |row| {
            Ok(Template {
                template_id: row.get(0)?,
                quantity: row.get(1)?,
            })
        })?;
        rows.collect()
    }

    pub(crate) fn add_qiniu_production(
        &self,
        id: &str,
        number: &str,
        source: Option<&str>,
        path: &Path,
        can_upload: bool,
    ) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let remote_order = version(&tx, number)?.is_some()
            || tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM qiniu_assets WHERE order_number=?1 AND kind='original'
             AND state IN ('pending','uploading','synced','failed'))",
                [number],
                |row| row.get::<_, bool>(0),
            )?;
        let source_can_sync = match source {
            Some(source) => tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM qiniu_assets WHERE id=?1 AND order_number=?2
                 AND kind='original' AND state <> 'localOnly')",
                params![source, number],
                |row| row.get::<_, bool>(0),
            )?,
            None => true,
        };
        let (state, error) = if can_upload && remote_order && source_can_sync {
            ("pending", None)
        } else {
            (
                "localOnly",
                Some("此成品保存在本机，当前设备或来源素材未关联七牛同步"),
            )
        };
        tx.execute(
            "INSERT INTO productions(id,order_number,image_id,file_path,created_at) VALUES(?1,?2,?3,?4,?5)",
            params![id, number, source, path.to_string_lossy(), now()],
        )?;
        tx.execute(
            "INSERT INTO qiniu_assets(id,order_number,kind,state,error) VALUES(?1,?2,'production',?3,?4)",
            params![id, number, state, error],
        )?;
        tx.commit()
    }

    pub(crate) fn qiniu_set_templates(
        &self,
        id: &str,
        templates: Vec<Template>,
    ) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let (order_id, number): (String, String) = tx.query_row(
            "SELECT i.order_id,o.order_number FROM images i JOIN orders o ON o.id=i.order_id WHERE i.id=?1",
            [id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|e| e.to_string())?;
        let state: Option<(String, bool)> = tx
            .query_row(
                "SELECT state,request IS NOT NULL FROM qiniu_assets WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        match state
            .as_ref()
            .map(|(state, attempted)| (state.as_str(), *attempted))
        {
            Some(("synced", _)) => {
                let current = version(&tx, &number)
                    .map_err(|e| e.to_string())?
                    .ok_or("请先同步订单最新版本再修改模板")?;
                queue_mutation(
                    &tx,
                    &number,
                    current,
                    &Mutation::Templates {
                        image_id: id.to_owned(),
                        templates: templates.clone(),
                    },
                )?;
            }
            Some(("uploading", _)) => {
                return Err("此素材正在同步，请完成后再修改模板".into());
            }
            Some((_, true)) => {
                return Err(
                    "此素材尚未同步成功。可在设置中重试，或确认删除本地记录后重新排单".into(),
                );
            }
            _ => {}
        }
        replace_templates(&tx, id, &templates).map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE orders SET updated_at=?2 WHERE id=?1",
            params![order_id, now()],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub(crate) fn qiniu_delete(
        &self,
        id: &str,
        whole_order: bool,
        can_remote: bool,
    ) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let lookup = if whole_order {
            "SELECT order_number FROM orders WHERE id=?1"
        } else {
            "SELECT o.order_number FROM orders o JOIN images i ON i.order_id=o.id WHERE i.id=?1"
        };
        let number: String = tx
            .query_row(lookup, [id], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        let predicate = if whole_order {
            "order_number=?1"
        } else {
            "id=?1"
        };
        let key = if whole_order { number.as_str() } else { id };
        let (published, transferring): (bool, bool) = tx
            .query_row(
                &format!(
                    "SELECT
                EXISTS(SELECT 1 FROM qiniu_assets WHERE {predicate} AND state='synced'),
                EXISTS(SELECT 1 FROM qiniu_assets WHERE {predicate}
                  AND (state='uploading' OR (state='pending' AND request IS NOT NULL)
                       OR (state='failed' AND request IS NOT NULL AND retry_at < 9223372036854775807)))"
                ),
                [key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|e| e.to_string())?;
        if transferring {
            return Err("有素材正在同步，请完成后再删除".into());
        }
        let remote_version = version(&tx, &number).map_err(|e| e.to_string())?;
        let staged: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM qiniu_snapshots WHERE order_number=?1)",
                [&number],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if published || (whole_order && (remote_version.is_some() || staged)) {
            if !can_remote {
                return Err("当前设备没有删除云端素材的权限".into());
            }
            let current = remote_version.ok_or("请先同步订单最新版本再删除")?;
            let operation = if whole_order {
                Mutation::DeleteOrder
            } else {
                Mutation::DeleteImage {
                    image_id: id.to_owned(),
                }
            };
            queue_mutation(&tx, &number, current, &operation)?;
        } else if whole_order {
            tx.execute("DELETE FROM image_templates WHERE image_id IN (SELECT id FROM images WHERE order_id=?1)", [id])
                .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM images WHERE order_id=?1", [id])
                .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM orders WHERE id=?1", [id])
                .map_err(|e| e.to_string())?;
            tx.execute(
                "DELETE FROM qiniu_assets WHERE order_number=?1 AND kind='original'",
                [&number],
            )
            .map_err(|e| e.to_string())?;
        } else {
            delete_image(&tx, id).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM qiniu_assets WHERE id=?1", [id])
                .map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE qiniu_assets SET state='localOnly',error='源素材已删除'
                 WHERE state IN ('pending','failed') AND id IN (SELECT id FROM productions WHERE image_id=?1)",
                [id],
            ).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub(crate) fn qiniu_due_mutations(&self) -> rusqlite::Result<Vec<MutationJob>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = conn.prepare(
            "SELECT id,order_number,version,payload,attempts FROM qiniu_mutations
             WHERE retry_at<=?1 AND conflict=0 AND committed_version IS NULL ORDER BY rowid LIMIT 20",
        )?;
        let rows = sql.query_map([epoch()], |row| {
            Ok(MutationJob {
                id: row.get(0)?,
                order_number: row.get(1)?,
                version: row.get(2)?,
                operation: decode(&row.get::<_, String>(3)?)?,
                attempts: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub(crate) fn qiniu_mutation_done(&self, id: &str, committed: u64) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE qiniu_mutations SET committed_version=?2,error=NULL WHERE id=?1",
            params![id, committed],
        )?;
        // The pull worker may have applied that snapshot while the response was in flight.
        conn.execute(
            "DELETE FROM qiniu_mutations WHERE id=?1 AND committed_version <=
                (SELECT applied FROM qiniu_order_versions WHERE order_number=qiniu_mutations.order_number)",
            [id],
        )?;
        Ok(())
    }

    pub(crate) fn qiniu_mutation_failed(
        &self,
        id: &str,
        error: &str,
        next: i64,
        conflict: bool,
    ) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE qiniu_mutations SET error=?2,retry_at=?3,conflict=?4,attempts=attempts+1 WHERE id=?1",
            params![id, error, next, conflict],
        )?;
        Ok(())
    }

    pub(crate) fn qiniu_needs_snapshot(&self, number: &str, remote: u64) -> rusqlite::Result<bool> {
        let conn = self.conn.lock().unwrap();
        let staged: Option<u64> = conn
            .query_row(
                "SELECT version FROM qiniu_snapshots WHERE order_number=?1",
                [number],
                |row| row.get(0),
            )
            .optional()?;
        if staged.is_some_and(|v| v >= remote) {
            return Ok(false);
        }
        if version(&conn, number)? != Some(remote) {
            return Ok(true);
        }
        let mut sql = conn.prepare(
            "SELECT COALESCE(i.file_path,p.file_path),a.byte_length,a.file_mtime_ns FROM qiniu_assets a
             LEFT JOIN images i ON i.id=a.id AND a.kind='original'
             LEFT JOIN productions p ON p.id=a.id AND a.kind='production'
             WHERE a.order_number=?1 AND a.state='synced'",
        )?;
        let rows = sql.query_map([number], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<u64>>(1)?,
                row.get::<_, Option<i64>>(2)?,
            ))
        })?;
        for row in rows {
            let (path, bytes, mtime) = row?;
            let meta = path.and_then(|p| std::fs::metadata(p).ok());
            if !meta.is_some_and(|m| Some(m.len()) == bytes && modified_ns(&m) == mtime) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub(crate) fn qiniu_stage_snapshot(&self, order: &RemoteOrder) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        if !order.deleted {
            self.find_or_create_order(&tx, &order.order_number)?;
        }
        tx.execute(
            "INSERT INTO qiniu_snapshots(order_number,version,payload) VALUES(?1,?2,?3)
             ON CONFLICT(order_number) DO UPDATE SET version=excluded.version,payload=excluded.payload,
             attempts=0,retry_at=0,error=NULL WHERE excluded.version>qiniu_snapshots.version",
            params![order.order_number, order.version, encode(order)?],
        )?;
        tx.commit()
    }

    pub(crate) fn qiniu_pending_snapshot(
        &self,
        number: &str,
    ) -> rusqlite::Result<Option<SnapshotJob>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT payload,attempts,error FROM qiniu_snapshots WHERE order_number=?1",
            [number],
            |row| {
                Ok(SnapshotJob {
                    order: decode(&row.get::<_, String>(0)?)?,
                    attempts: row.get(1)?,
                    error: row.get(2)?,
                })
            },
        )
        .optional()
    }

    pub(crate) fn qiniu_due_snapshots(&self) -> rusqlite::Result<Vec<SnapshotJob>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = conn.prepare(
            "SELECT payload,attempts,error FROM qiniu_snapshots WHERE retry_at <= ?1
             ORDER BY retry_at, rowid LIMIT 2",
        )?;
        let rows = sql.query_map([epoch()], |row| {
            Ok(SnapshotJob {
                order: decode(&row.get::<_, String>(0)?)?,
                attempts: row.get(1)?,
                error: row.get(2)?,
            })
        })?;
        rows.collect()
    }

    pub(crate) fn qiniu_snapshot_failed(
        &self,
        number: &str,
        error: &str,
        next: i64,
    ) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE qiniu_snapshots SET error=?2,retry_at=?3,attempts=attempts+1 WHERE order_number=?1",
            params![number, error, next],
        )?;
        Ok(())
    }

    pub(crate) fn qiniu_asset_path(
        &self,
        id: &str,
        kind: &str,
    ) -> rusqlite::Result<Option<String>> {
        let table = if kind == "original" {
            "images"
        } else {
            "productions"
        };
        self.conn
            .lock()
            .unwrap()
            .query_row(
                &format!("SELECT file_path FROM {table} WHERE id=?1"),
                [id],
                |row| row.get(0),
            )
            .optional()
    }

    pub(crate) fn qiniu_apply_snapshot(
        &self,
        order: &RemoteOrder,
        files: &[(String, PathBuf, Option<PathBuf>)],
    ) -> rusqlite::Result<(usize, usize)> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let mut new_images = 0;
        let mut new_productions = 0;
        tx.execute(
            "DELETE FROM qiniu_mutations WHERE order_number=?1 AND committed_version<=?2",
            params![order.order_number, order.version],
        )?;
        let original_count = order
            .assets
            .iter()
            .filter(|a| a.kind == "original" && !a.deleted)
            .count();
        if !order.deleted {
            let order_id = self.find_or_create_order(&tx, &order.order_number)?;
            for asset in &order.assets {
                if asset.deleted {
                    continue;
                }
                let Some((_, path, thumb)) = files.iter().find(|(id, _, _)| id == &asset.id) else {
                    return Err(rusqlite::Error::InvalidQuery);
                };
                if asset.kind == "original" {
                    new_images += tx.execute(
                        "INSERT OR IGNORE INTO images(id,order_id,file_path,original_name,byte_length,width,height,
                         source,created_at,thumb_path) VALUES(?1,?2,?3,?4,?5,?6,?7,'七牛同步',?8,?9)",
                        params![asset.id, order_id, path.to_string_lossy(), asset.file_name, asset.byte_length,
                            asset.width, asset.height, asset.created_at, thumb.as_ref().map(|p| p.to_string_lossy())],
                    )?;
                    tx.execute(
                        "UPDATE images SET file_path=?2,thumb_path=?3 WHERE id=?1 AND order_id=?4",
                        params![
                            asset.id,
                            path.to_string_lossy(),
                            thumb.as_ref().map(|p| p.to_string_lossy()),
                            order_id
                        ],
                    )?;
                    let local_draft: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM qiniu_mutations WHERE order_number=?1
                         AND json_extract(payload,'$.Templates.image_id')=?2)",
                        params![order.order_number, asset.id],
                        |row| row.get(0),
                    )?;
                    if !local_draft {
                        replace_templates(&tx, &asset.id, &asset.templates)?;
                    }
                } else {
                    new_productions += tx.execute(
                        "INSERT OR IGNORE INTO productions(id,order_number,image_id,file_path,created_at)
                         VALUES(?1,?2,?3,?4,?5)",
                        params![asset.id, order.order_number, asset.source_image_id, path.to_string_lossy(), asset.created_at],
                    )?;
                    tx.execute(
                        "UPDATE productions SET file_path=?2 WHERE id=?1 AND order_number=?3",
                        params![asset.id, path.to_string_lossy(), order.order_number],
                    )?;
                }
                tx.execute(
                    "INSERT INTO qiniu_assets(id,order_number,kind,quality,state,sha256,byte_length,file_mtime_ns)
                     VALUES(?1,?2,?3,?4,'synced',?5,?6,?7)
                     ON CONFLICT(id) DO UPDATE SET state='synced',error=NULL,
                        sha256=excluded.sha256,byte_length=excluded.byte_length,
                        file_mtime_ns=excluded.file_mtime_ns,request=NULL",
                    params![asset.id, order.order_number, asset.kind,
                        (asset.kind == "original").then_some("original"), asset.sha256, asset.byte_length,
                        std::fs::metadata(path).ok().as_ref().and_then(modified_ns)],
                )?;
            }
            let metadata = merge_order_metadata_for_id(&tx, &order_id, order.metadata.as_deref())?;
            tx.execute(
                "UPDATE orders SET updated_at=?2,metadata=COALESCE(?3,metadata) WHERE id=?1",
                params![order_id, now(), metadata],
            )?;
        }
        // A remote delete only removes records managed by this mode. Legacy originals
        // sharing an order number and all archived files remain available locally.
        let managed = {
            let mut query = tx.prepare(
                "SELECT id,kind FROM qiniu_assets WHERE order_number=?1 AND state='synced'",
            )?;
            let rows = query.query_map([&order.order_number], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (id, kind) in managed {
            if order.deleted
                || order
                    .assets
                    .iter()
                    .any(|asset| asset.id == id && asset.deleted)
            {
                if kind == "original" {
                    tx.execute(
                        "UPDATE qiniu_assets SET state='localOnly',error='源素材已在云端删除'
                         WHERE state IN ('pending','uploading','failed')
                           AND id IN (SELECT id FROM productions WHERE image_id=?1)",
                        [&id],
                    )?;
                    delete_image(&tx, &id)?;
                } else {
                    tx.execute("DELETE FROM productions WHERE id=?1", [&id])?;
                }
                tx.execute("DELETE FROM qiniu_assets WHERE id=?1", [&id])?;
            }
        }
        if order.deleted || (original_count == 0 && order.assets.iter().all(|a| a.deleted)) {
            tx.execute(
                "DELETE FROM orders WHERE order_number=?1
                 AND NOT EXISTS(SELECT 1 FROM images WHERE order_id=orders.id)
                 AND NOT EXISTS(SELECT 1 FROM productions WHERE order_number=orders.order_number)",
                [&order.order_number],
            )?;
        }
        if order.deleted {
            tx.execute(
                "UPDATE qiniu_assets SET state='localOnly',error='云端订单已删除'
                 WHERE order_number=?1 AND state IN ('pending','uploading','failed')",
                [&order.order_number],
            )?;
        }
        tx.execute(
            "INSERT INTO qiniu_order_versions(order_number,applied) VALUES(?1,?2)
             ON CONFLICT(order_number) DO UPDATE SET applied=MAX(applied,excluded.applied)",
            params![order.order_number, order.version],
        )?;
        tx.execute(
            "DELETE FROM qiniu_snapshots WHERE order_number=?1 AND version<=?2",
            params![order.order_number, order.version],
        )?;
        tx.commit()?;
        Ok((new_images, new_productions))
    }

    pub(crate) fn qiniu_retry(&self) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute_batch(
            "UPDATE qiniu_assets SET retry_at=0,state='pending',error=NULL WHERE state='failed';
             UPDATE qiniu_snapshots SET retry_at=0,error=NULL;
             UPDATE qiniu_mutations SET retry_at=0,error=NULL WHERE conflict=0;",
        )
    }

    pub(crate) fn qiniu_counts(&self) -> rusqlite::Result<(u64, u64, u64, Option<String>)> {
        self.conn.lock().unwrap().query_row(
            "SELECT (SELECT COUNT(*) FROM qiniu_assets WHERE state IN ('pending','uploading'))
               + (SELECT COUNT(*) FROM qiniu_mutations WHERE error IS NULL),
              (SELECT COUNT(*) FROM qiniu_assets WHERE state='failed')
               + (SELECT COUNT(*) FROM qiniu_mutations WHERE error IS NOT NULL)
               + (SELECT COUNT(*) FROM qiniu_snapshots WHERE error IS NOT NULL),
              (SELECT COUNT(*) FROM qiniu_snapshots WHERE error IS NULL),
              COALESCE((SELECT error FROM qiniu_mutations WHERE error IS NOT NULL ORDER BY rowid DESC LIMIT 1),
               (SELECT error FROM qiniu_assets WHERE state='failed' ORDER BY rowid DESC LIMIT 1),
               (SELECT error FROM qiniu_snapshots WHERE error IS NOT NULL ORDER BY rowid DESC LIMIT 1))",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
    }
}
