use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;

use crate::store::{now, random_hex_pub, valid_layout_number, Store};

pub(crate) fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS workflow_settings (
             key TEXT PRIMARY KEY, value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS workflow_changes (
             order_number TEXT PRIMARY KEY, generation INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS workflow_orders (
             order_number TEXT PRIMARY KEY, local_completed INTEGER NOT NULL DEFAULT 0,
             target TEXT, revision INTEGER NOT NULL DEFAULT 0, shared_state TEXT,
             synced_generation INTEGER NOT NULL DEFAULT 0,
             remote_operation_id TEXT
         );
         CREATE TABLE IF NOT EXISTS workflow_tasks (
             order_number TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL,
             expected INTEGER NOT NULL, generation INTEGER NOT NULL,
             manifest TEXT NOT NULL, error TEXT, expected_operation_id TEXT,
             PRIMARY KEY(order_number, kind)
         );
         CREATE TABLE IF NOT EXISTS workflow_remote_ids (
             local_id TEXT PRIMARY KEY, remote_id TEXT NOT NULL
         );
         CREATE TRIGGER IF NOT EXISTS workflow_delete_order AFTER DELETE ON orders
         BEGIN
             DELETE FROM workflow_changes WHERE order_number = OLD.order_number;
             DELETE FROM workflow_orders WHERE order_number = OLD.order_number;
             DELETE FROM workflow_tasks WHERE order_number = OLD.order_number;
         END;",
    )?;
    // Existing installations have the original numeric revision schema. Keep the
    // columns for SQLite compatibility, but stop using that value as a workflow
    // version and add the operation-id fields used by the current protocol.
    let _ = conn.execute(
        "ALTER TABLE workflow_orders ADD COLUMN remote_operation_id TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE workflow_tasks ADD COLUMN expected_operation_id TEXT",
        [],
    );
    conn.execute("UPDATE workflow_orders SET revision=0", [])?;
    conn.execute("UPDATE workflow_tasks SET expected=0", [])?;
    let order = |row: &str| format!("SELECT order_number FROM orders WHERE id={row}.order_id");
    let template = |row: &str| {
        format!(
            "SELECT o.order_number FROM orders o JOIN images i ON i.order_id=o.id WHERE i.id={row}.image_id"
        )
    };
    for (name, event, table, number) in [
        (
            "order_insert",
            "INSERT",
            "orders",
            "SELECT NEW.order_number".to_owned(),
        ),
        (
            "order_metadata",
            "UPDATE OF metadata",
            "orders",
            "SELECT NEW.order_number WHERE NEW.metadata IS NOT OLD.metadata".to_owned(),
        ),
        ("image_insert", "INSERT", "images", order("NEW")),
        ("image_update", "UPDATE", "images", order("NEW")),
        ("image_delete", "DELETE", "images", order("OLD")),
        (
            "template_insert",
            "INSERT",
            "image_templates",
            template("NEW"),
        ),
        (
            "template_update",
            "UPDATE",
            "image_templates",
            template("NEW"),
        ),
        (
            "template_delete",
            "DELETE",
            "image_templates",
            template("OLD"),
        ),
        (
            "production_insert",
            "INSERT",
            "productions",
            "SELECT NEW.order_number".to_owned(),
        ),
        (
            "production_update",
            "UPDATE",
            "productions",
            "SELECT NEW.order_number".to_owned(),
        ),
        (
            "production_delete",
            "DELETE",
            "productions",
            "SELECT OLD.order_number".to_owned(),
        ),
    ] {
        conn.execute_batch(&format!(
            "CREATE TRIGGER IF NOT EXISTS workflow_{name} AFTER {event} ON {table}
             BEGIN
                INSERT INTO workflow_changes(order_number,generation)
                SELECT *,1 FROM ({number}) WHERE 1
                ON CONFLICT(order_number) DO UPDATE SET generation=generation+1;
             END;"
        ))?;
    }
    Ok(())
}

pub(crate) fn setting(store: &Store, key: &str) -> rusqlite::Result<Option<String>> {
    store
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT value FROM workflow_settings WHERE key=?1",
            [key],
            |r| r.get(0),
        )
        .optional()
}

pub(crate) fn put_setting(store: &Store, key: &str, value: &str) -> rusqlite::Result<()> {
    store.conn.lock().unwrap().execute(
        "INSERT INTO workflow_settings(key,value) VALUES (?1,?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub(crate) fn role(store: &Store) -> String {
    setting(store, "role")
        .ok()
        .flatten()
        .unwrap_or_else(|| "both".into())
}

pub(crate) fn set_layout(store: &Store, number: &str, layout: &str) -> Result<(), String> {
    if !layout.is_empty() && !valid_layout_number(layout) {
        return Err("排版编号格式无效。".into());
    }
    let conn = store.conn.lock().unwrap();
    let previous: Option<String> = conn
        .query_row(
            "SELECT metadata FROM orders WHERE order_number=?1",
            [number],
            |row| row.get(0),
        )
        .map_err(error)?;
    let mut fields = metadata(previous.as_deref());
    if fields
        .get("layoutNumber")
        .and_then(serde_json::Value::as_str)
        == Some(layout)
        || (layout.is_empty() && !fields.contains_key("layoutNumber"))
    {
        return Ok(());
    }
    if layout.is_empty() {
        fields.remove("layoutNumber");
    } else {
        fields.insert("layoutNumber".into(), layout.into());
    }
    fields.insert("layoutNumberCapturedAt".into(), now().into());
    conn.execute(
        "UPDATE orders SET metadata=?2, updated_at=?3 WHERE order_number=?1",
        params![number, serde_json::Value::Object(fields).to_string(), now()],
    )
    .map_err(error)?;
    Ok(())
}

pub(crate) fn metadata(value: Option<&str>) -> serde_json::Map<String, serde_json::Value> {
    match value.and_then(|value| serde_json::from_str(value).ok()) {
        Some(serde_json::Value::Object(fields)) => fields,
        _ => value
            .map(|value| serde_json::Map::from_iter([("legacyMetadata".into(), value.into())]))
            .unwrap_or_default(),
    }
}

#[derive(Clone)]
pub(crate) struct OrderState {
    id: String,
    pub(crate) local_completed: bool,
    pub(crate) target: Option<String>,
    pub(crate) shared_state: Option<String>,
    pub(crate) remote_operation_id: Option<String>,
    pub(crate) generation: i64,
    pub(crate) synced_generation: i64,
}

impl OrderState {
    pub(crate) fn version(&self) -> String {
        format!("{}:{}", self.id, self.generation)
    }
}

fn read_state(conn: &Connection, number: &str) -> rusqlite::Result<Option<OrderState>> {
    conn.query_row(
        "SELECT o.id, COALESCE(s.local_completed,0), s.target,
                s.shared_state, s.remote_operation_id,
                COALESCE(c.generation,0), COALESCE(s.synced_generation,0)
         FROM orders o LEFT JOIN workflow_orders s USING(order_number)
         LEFT JOIN workflow_changes c USING(order_number) WHERE o.order_number=?1",
        [number],
        |row| {
            Ok(OrderState {
                id: row.get(0)?,
                local_completed: row.get(1)?,
                target: row.get(2)?,
                shared_state: row.get(3)?,
                remote_operation_id: row.get(4)?,
                generation: row.get(5)?,
                synced_generation: row.get(6)?,
            })
        },
    )
    .optional()
}

pub(crate) fn order_state(store: &Store, number: &str) -> rusqlite::Result<Option<OrderState>> {
    read_state(&store.conn.lock().unwrap(), number)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OrderRow {
    pub(crate) order_number: String,
    pub(crate) local_completed: bool,
    pub(crate) shared_state: Option<String>,
    pub(crate) pending_operation: Option<String>,
    pub(crate) error: Option<String>,
}

pub(crate) fn list(store: &Store) -> rusqlite::Result<Vec<OrderRow>> {
    let conn = store.conn.lock().unwrap();
    let mut query = conn.prepare(
        "SELECT o.order_number, COALESCE(s.local_completed,0), s.shared_state, t.kind, t.error
         FROM orders o LEFT JOIN workflow_orders s USING(order_number)
         LEFT JOIN workflow_tasks t ON t.order_number=o.order_number AND t.kind=(
             SELECT kind FROM workflow_tasks WHERE order_number=o.order_number AND kind IN ('publish','finish')
             ORDER BY CASE kind WHEN 'finish' THEN 1 WHEN 'publish' THEN 2 ELSE 3 END LIMIT 1
         )",
    )?;
    let rows = query.query_map([], |r| {
        Ok(OrderRow {
            order_number: r.get(0)?,
            local_completed: r.get(1)?,
            shared_state: r.get(2)?,
            pending_operation: r.get(3)?,
            error: r.get(4)?,
        })
    })?;
    rows.collect()
}

pub(crate) fn complete_local(store: &Store, number: &str) -> rusqlite::Result<()> {
    let conn = store.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO workflow_orders(order_number,local_completed) VALUES (?1,1)
         ON CONFLICT(order_number) DO UPDATE SET local_completed=1",
        [number],
    )?;
    Ok(())
}

pub(crate) struct Task {
    pub(crate) number: String,
    pub(crate) kind: String,
    pub(crate) target: String,
    pub(crate) expected_operation_id: Option<String>,
    pub(crate) generation: i64,
    pub(crate) manifest: String,
}

pub(crate) fn task(store: &Store, number: &str, kind: &str) -> rusqlite::Result<Option<Task>> {
    store.conn.lock().unwrap().query_row(
        "SELECT target, expected_operation_id, generation, manifest FROM workflow_tasks WHERE order_number=?1 AND kind=?2",
        params![number, kind],
        |r| Ok(Task { number: number.into(), kind: kind.into(), target: r.get(0)?,
            expected_operation_id: r.get(1)?, generation: r.get(2)?, manifest: r.get(3)? }),
    ).optional()
}

pub(crate) fn insert_task(store: &Store, task: &Task, local_version: &str) -> Result<(), String> {
    let mut conn = store.conn.lock().unwrap();
    let tx = conn.transaction().map_err(error)?;
    verify_version(&tx, &task.number, Some(local_version))?;
    tx.execute(
        "INSERT INTO workflow_tasks(order_number,kind,target,expected,generation,manifest,expected_operation_id)
         VALUES (?1,?2,?3,0,?4,?5,?6)",
        params![
            task.number,
            task.kind,
            task.target,
            task.generation,
            task.manifest,
            task.expected_operation_id,
        ],
    )
    .map_err(error)?;
    if task.kind == "finish" {
        tx.execute(
            "INSERT INTO workflow_orders(order_number,local_completed) VALUES (?1,1)
             ON CONFLICT(order_number) DO UPDATE SET local_completed=1",
            [&task.number],
        )
        .map_err(error)?;
    }
    tx.commit().map_err(error)
}

pub(crate) fn fail_task(store: &Store, task: &Task, message: &str) -> rusqlite::Result<()> {
    store.conn.lock().unwrap().execute(
        "UPDATE workflow_tasks SET error=?3 WHERE order_number=?1 AND kind=?2",
        params![task.number, task.kind, message],
    )?;
    Ok(())
}

pub(crate) fn finish_task(
    store: &Store,
    task: &Task,
    state: &str,
    operation_id: &str,
) -> rusqlite::Result<()> {
    let mut conn = store.conn.lock().unwrap();
    let tx = conn.transaction()?;
    if read_state(&tx, &task.number)?.is_some() {
        set_shared(
            &tx,
            &task.number,
            &task.target,
            state,
            operation_id,
            task.generation,
        )?;
    }
    tx.execute(
        "DELETE FROM workflow_tasks WHERE order_number=?1 AND kind=?2",
        params![task.number, task.kind],
    )?;
    tx.commit()
}

pub(crate) fn discard_task(store: &Store, task: &Task) -> rusqlite::Result<()> {
    store.conn.lock().unwrap().execute(
        "DELETE FROM workflow_tasks WHERE order_number=?1 AND kind=?2 AND manifest=?3",
        params![task.number, task.kind, task.manifest],
    )?;
    Ok(())
}

pub(crate) fn has_tasks(conn: &Connection, number: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM workflow_tasks WHERE order_number=?1 AND kind IN ('publish','finish'))",
        [number],
        |r| r.get(0),
    )
}

pub(crate) fn mark_remote_complete(
    store: &Store,
    number: &str,
    target: &str,
    operation_id: &str,
) -> rusqlite::Result<bool> {
    let conn = store.conn.lock().unwrap();
    Ok(conn.execute(
        "UPDATE workflow_orders SET shared_state='completed',revision=0,remote_operation_id=?3
         WHERE order_number=?1 AND target=?2 AND COALESCE(remote_operation_id,'')<>?3",
        params![number, target, operation_id],
    )? > 0)
}

fn set_shared(
    conn: &Connection,
    number: &str,
    target: &str,
    state: &str,
    operation_id: &str,
    generation: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO workflow_orders(order_number,target,shared_state,revision,synced_generation,remote_operation_id) VALUES (?1,?2,?3,0,?4,?5)
         ON CONFLICT(order_number) DO UPDATE SET target=excluded.target,shared_state=excluded.shared_state,
             revision=0,synced_generation=excluded.synced_generation,
             remote_operation_id=excluded.remote_operation_id",
        params![number, target, state, generation, operation_id],
    )?;
    Ok(())
}

pub(crate) fn remote_id(store: &Store, local_id: &str) -> rusqlite::Result<String> {
    Ok(store
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT remote_id FROM workflow_remote_ids WHERE local_id=?1",
            [local_id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or_else(|| local_id.into()))
}

pub(crate) struct ImportedAsset {
    pub(crate) remote_id: String,
    pub(crate) image_id: Option<String>,
    pub(crate) name: String,
    pub(crate) path: PathBuf,
    pub(crate) thumb: Option<PathBuf>,
    pub(crate) production: bool,
    pub(crate) bytes: u64,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) quality: Option<String>,
    pub(crate) templates: Vec<(String, i64)>,
}

pub(crate) enum ImportAction {
    Sync,
    Replace,
}

pub(crate) struct Import<'a> {
    pub(crate) number: &'a str,
    pub(crate) expected: Option<&'a str>,
    pub(crate) metadata: Option<&'a str>,
    pub(crate) shared: Option<(&'a str, &'a str, &'a str)>,
    pub(crate) completed: bool,
    pub(crate) action: ImportAction,
    pub(crate) assets: &'a [ImportedAsset],
}

fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn verify_version(
    conn: &Connection,
    number: &str,
    expected: Option<&str>,
) -> Result<Option<OrderState>, String> {
    let state = read_state(conn, number).map_err(error)?;
    if state.as_ref().map(OrderState::version).as_deref() != expected {
        return Err("订单在下载或确认期间发生变化，请重新预览。".into());
    }
    Ok(state)
}

fn remove_current_files(conn: &Transaction<'_>, number: &str, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM qiniu_assets WHERE id IN
        (SELECT id FROM images WHERE order_id=?1 UNION SELECT id FROM productions WHERE order_number=?2)", params![id, number])?;
    conn.execute("DELETE FROM workflow_remote_ids WHERE local_id IN
        (SELECT id FROM images WHERE order_id=?1 UNION SELECT id FROM productions WHERE order_number=?2)", params![id, number])?;
    conn.execute(
        "DELETE FROM image_templates WHERE image_id IN (SELECT id FROM images WHERE order_id=?1)",
        [id],
    )?;
    conn.execute("DELETE FROM images WHERE order_id=?1", [id])?;
    conn.execute("DELETE FROM productions WHERE order_number=?1", [number])?;
    Ok(())
}

pub(crate) fn import(store: &Store, request: Import<'_>) -> Result<(), String> {
    let mut conn = store.conn.lock().unwrap();
    let tx = conn.transaction().map_err(error)?;
    let current = verify_version(&tx, request.number, request.expected)?;
    let number = request.number.to_owned();
    let copy = |number: &str| format!("{number}~副本-{}", random_hex_pub(6));
    match request.action {
        ImportAction::Replace => {
            if let Some(current) = &current {
                if has_tasks(&tx, &number).map_err(error)? {
                    return Err("这笔订单有尚未确认的上传，请先处理待上传操作。".into());
                }
                let preserved = copy(&number);
                tx.execute(
                    "UPDATE orders SET order_number=?2 WHERE id=?1",
                    params![current.id, preserved],
                )
                .map_err(error)?;
                tx.execute(
                    "UPDATE productions SET order_number=?2 WHERE order_number=?1",
                    params![number, preserved],
                )
                .map_err(error)?;
                if current.local_completed || current.shared_state.as_deref() == Some("completed") {
                    tx.execute(
                        "INSERT INTO workflow_orders(order_number,local_completed) VALUES (?1,1)",
                        [&preserved],
                    )
                    .map_err(error)?;
                }
                tx.execute(
                    "DELETE FROM workflow_orders WHERE order_number=?1",
                    [&number],
                )
                .map_err(error)?;
                if request.shared.is_none() {
                    if let (Some(target), Some(state)) = (&current.target, &current.shared_state) {
                        set_shared(
                            &tx,
                            &number,
                            target,
                            state,
                            current.remote_operation_id.as_deref().unwrap_or_default(),
                            current.synced_generation,
                        )
                        .map_err(error)?;
                    }
                }
            }
        }
        ImportAction::Sync => {
            if let Some(current) = &current {
                remove_current_files(&tx, &number, &current.id).map_err(error)?;
            }
        }
    }
    let order_id = store.find_or_create_order(&tx, &number).map_err(error)?;
    tx.execute(
        "UPDATE orders SET metadata=?2,updated_at=?3 WHERE id=?1",
        params![order_id, request.metadata, now()],
    )
    .map_err(error)?;
    for asset in request.assets.iter().filter(|asset| !asset.production) {
        let id = random_hex_pub(16);
        tx.execute(
            "INSERT INTO images(id,order_id,file_path,original_name,byte_length,width,height,source,created_at,thumb_path)
             VALUES(?1,?2,?3,?4,?5,?6,?7,'共享存储',?8,?9)",
            params![id, order_id, asset.path.to_string_lossy(), asset.name, asset.bytes, asset.width,
                asset.height, now(), asset.thumb.as_deref().map(|p| p.to_string_lossy())],
        ).map_err(error)?;
        tx.execute(
            "INSERT INTO workflow_remote_ids(local_id,remote_id) VALUES (?1,?2)",
            params![id, asset.remote_id],
        )
        .map_err(error)?;
        if let Some(quality) = &asset.quality {
            use crate::qiniu_store::CaptureQuality;
            let quality = match quality.as_str() {
                "original" => CaptureQuality::Original,
                "scaled" => CaptureQuality::Scaled,
                _ => CaptureQuality::Unknown,
            };
            crate::qiniu_store::register_capture(&tx, &id, &number, quality).map_err(error)?;
            tx.execute(
                "UPDATE qiniu_assets SET state='localOnly' WHERE id=?1",
                [&id],
            )
            .map_err(error)?;
        }
        for (template, quantity) in &asset.templates {
            tx.execute("INSERT OR REPLACE INTO image_templates(image_id,template_id,quantity) VALUES (?1,?2,?3)", params![id,template,quantity]).map_err(error)?;
        }
    }
    for asset in request.assets.iter().filter(|asset| asset.production) {
        let id = random_hex_pub(16);
        let duplicate = tx
            .query_row(
                "SELECT 1 FROM productions p LEFT JOIN workflow_remote_ids m ON m.local_id=p.id
             WHERE p.order_number=?1 AND COALESCE(m.remote_id,p.id)=?2",
                params![number, asset.remote_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(error)?
            .is_some();
        if duplicate {
            continue;
        }
        let image_id: Option<String> = if let Some(image_id) = &asset.image_id {
            tx.query_row(
                "SELECT i.id FROM images i LEFT JOIN workflow_remote_ids m ON m.local_id=i.id
                 WHERE i.order_id=?1 AND COALESCE(m.remote_id,i.id)=?2",
                params![order_id, image_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(error)?
        } else {
            None
        };
        tx.execute("INSERT INTO productions(id,order_number,image_id,file_path,created_at) VALUES(?1,?2,?3,?4,?5)",
            params![id, number, image_id, asset.path.to_string_lossy(), now()]).map_err(error)?;
        tx.execute(
            "INSERT INTO workflow_remote_ids(local_id,remote_id) VALUES (?1,?2)",
            params![id, asset.remote_id],
        )
        .map_err(error)?;
    }
    if let Some((target, shared_state, operation_id)) = request.shared {
        let state = read_state(&tx, &number)
            .map_err(error)?
            .ok_or("订单记录不存在")?;
        set_shared(
            &tx,
            &number,
            target,
            shared_state,
            operation_id,
            state.generation,
        )
        .map_err(error)?;
    }
    if request.completed {
        tx.execute(
            "INSERT INTO workflow_orders(order_number,local_completed) VALUES (?1,1)
         ON CONFLICT(order_number) DO UPDATE SET local_completed=1",
            [&number],
        )
        .map_err(error)?;
    }
    tx.commit().map_err(error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editing_a_layout_invalidates_a_previously_reviewed_version() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        let conn = store.conn.lock().unwrap();
        store.find_or_create_order(&conn, "A01").unwrap();
        drop(conn);
        let before = order_state(&store, "A01").unwrap().unwrap();
        set_layout(&store, "A01", "ch-005").unwrap();
        let after = order_state(&store, "A01").unwrap().unwrap();
        assert_ne!(before.version(), after.version());
        assert!(store
            .order_metadata_by_number("A01")
            .unwrap()
            .unwrap()
            .contains("ch-005"));
    }

    #[test]
    fn shared_state_keeps_operation_id_without_a_local_revision() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        store
            .find_or_create_order(&store.conn.lock().unwrap(), "A01")
            .unwrap();
        let local = order_state(&store, "A01").unwrap().unwrap();
        import(
            &store,
            Import {
                number: "A01",
                expected: Some(&local.version()),
                metadata: None,
                shared: Some(("nas:test", "pending", "operation-1")),
                completed: false,
                action: ImportAction::Sync,
                assets: &[],
            },
        )
        .unwrap();
        let current = order_state(&store, "A01").unwrap().unwrap();
        assert_eq!(current.remote_operation_id.as_deref(), Some("operation-1"));
    }

    #[test]
    fn pending_finish_survives_restart_and_blocks_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        store
            .find_or_create_order(&store.conn.lock().unwrap(), "A01")
            .unwrap();
        let local = order_state(&store, "A01").unwrap().unwrap();
        insert_task(
            &store,
            &Task {
                number: "A01".into(),
                kind: "finish".into(),
                target: "nas".into(),
                expected_operation_id: None,
                generation: local.generation,
                manifest: "{}".into(),
            },
            &local.version(),
        )
        .unwrap();
        drop(store);
        let store = Store::open(directory.path()).unwrap();
        assert!(order_state(&store, "A01").unwrap().unwrap().local_completed);
        assert!(task(&store, "A01", "finish").unwrap().is_some());
        let result = import(
            &store,
            Import {
                number: "A01",
                expected: Some(&local.version()),
                metadata: None,
                shared: None,
                completed: false,
                action: ImportAction::Replace,
                assets: &[],
            },
        );
        assert!(result.unwrap_err().contains("待上传"));
        assert_eq!(store.list_orders().unwrap().len(), 1);
    }

    #[test]
    fn replace_creates_a_local_copy_and_does_not_accept_stale_preview() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        store
            .find_or_create_order(&store.conn.lock().unwrap(), "A01")
            .unwrap();
        let old_version = order_state(&store, "A01").unwrap().unwrap().version();
        set_layout(&store, "A01", "ch-111").unwrap();
        let new_version = order_state(&store, "A01").unwrap().unwrap().version();
        let restore = |version: &str| {
            import(
                &store,
                Import {
                    number: "A01",
                    expected: Some(version),
                    metadata: Some(r#"{"layoutNumber":"x-222"}"#),
                    shared: None,
                    completed: false,
                    action: ImportAction::Replace,
                    assets: &[],
                },
            )
        };
        assert!(restore(&old_version).is_err());
        restore(&new_version).unwrap();
        let orders = store.list_orders().unwrap();
        assert_eq!(orders.len(), 2);
        assert!(orders
            .iter()
            .any(|order| order.order_number.starts_with("A01~副本-")
                && order
                    .metadata
                    .as_deref()
                    .is_some_and(|metadata| metadata.contains("ch-111"))));
        assert!(store
            .order_metadata_by_number("A01")
            .unwrap()
            .unwrap()
            .contains("x-222"));
    }
}
