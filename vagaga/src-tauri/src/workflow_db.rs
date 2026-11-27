use std::{collections::HashMap, path::PathBuf};

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;

use crate::store::{now, random_hex_pub, valid_layout_number, Store};

pub(crate) const CLAIM_LEASE_MS: i64 = 4 * 60 * 60 * 1000;

pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

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
             remote_operation_id TEXT,
             claimed_by TEXT,
             claimed_name TEXT,
             claimed_at INTEGER
         );
         CREATE TABLE IF NOT EXISTS workflow_synced_snapshots (
             order_number TEXT PRIMARY KEY,
             payload TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS workflow_local_archives (
             order_number TEXT PRIMARY KEY
         );
         CREATE TABLE IF NOT EXISTS workflow_tasks (
             order_number TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL,
             expected INTEGER NOT NULL, generation INTEGER NOT NULL,
             manifest TEXT NOT NULL, error TEXT, expected_operation_id TEXT, source_files TEXT,
             PRIMARY KEY(order_number, kind)
         );
         CREATE TABLE IF NOT EXISTS workflow_remote_ids (
             local_id TEXT PRIMARY KEY, remote_id TEXT NOT NULL
         );
         DROP TRIGGER IF EXISTS workflow_delete_order;
         CREATE TRIGGER workflow_delete_order AFTER DELETE ON orders
         BEGIN
             DELETE FROM workflow_changes WHERE order_number = OLD.order_number;
             DELETE FROM workflow_orders WHERE order_number = OLD.order_number;
             DELETE FROM workflow_synced_snapshots WHERE order_number = OLD.order_number;
             DELETE FROM workflow_tasks WHERE order_number = OLD.order_number;
             DELETE FROM workflow_local_archives WHERE order_number = OLD.order_number;
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
        "ALTER TABLE workflow_orders ADD COLUMN claimed_by TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE workflow_orders ADD COLUMN claimed_name TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE workflow_orders ADD COLUMN claimed_at INTEGER",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE workflow_tasks ADD COLUMN expected_operation_id TEXT",
        [],
    );
    let has_source_files = {
        let mut columns = conn.prepare("PRAGMA table_info(workflow_tasks)")?;
        let names = columns.query_map([], |row| row.get::<_, String>(1))?;
        let mut found = false;
        for name in names {
            found |= name? == "source_files";
        }
        found
    };
    if !has_source_files {
        conn.execute(
            "ALTER TABLE workflow_tasks ADD COLUMN source_files TEXT",
            [],
        )?;
    }
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

pub(crate) fn device_id(store: &Store) -> Result<String, String> {
    if let Ok((qiniu, _)) = crate::qiniu_settings::load(store) {
        if let Some(id) = qiniu.device_id.filter(|id| !id.trim().is_empty()) {
            return Ok(id);
        }
    }
    if let Some(existing) = setting(store, "device-id").map_err(error)? {
        if !existing.trim().is_empty() {
            return Ok(existing);
        }
    }
    let generated = format!("dev-{}", random_hex_pub(6));
    put_setting(store, "device-id", &generated).map_err(error)?;
    Ok(generated)
}

fn default_device_name(fallback_id: &str) -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|name| name.trim().chars().take(40).collect::<String>())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| fallback_id.to_owned())
}

pub(crate) fn device_name(store: &Store) -> Result<String, String> {
    if let Some(saved) = setting(store, "device-name").map_err(error)? {
        let trimmed = saved.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_owned());
        }
    }
    let id = device_id(store)?;
    Ok(default_device_name(&id))
}

pub(crate) fn set_device_name(store: &Store, name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.chars().count() > 40 || trimmed.chars().any(char::is_control) {
        return Err("设备名称最多 40 个字符，且不能包含控制字符。".into());
    }
    if trimmed.is_empty() {
        store
            .conn
            .lock()
            .unwrap()
            .execute("DELETE FROM workflow_settings WHERE key='device-name'", [])
            .map_err(error)?;
    } else {
        put_setting(store, "device-name", trimmed).map_err(error)?;
    }
    device_name(store)
}

pub(crate) fn sync_cursor(store: &Store, target: &str) -> rusqlite::Result<u64> {
    let key = format!("cursor:{target}");
    Ok(setting(store, &key)?
        .and_then(|val| val.parse::<u64>().ok())
        .unwrap_or(0))
}

pub(crate) fn set_sync_cursor(store: &Store, target: &str, seq: u64) -> rusqlite::Result<()> {
    let key = format!("cursor:{target}");
    put_setting(store, &key, &seq.to_string())
}

pub(crate) fn synced_snapshot(store: &Store, number: &str) -> rusqlite::Result<Option<String>> {
    store
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT payload FROM workflow_synced_snapshots WHERE order_number=?1",
            [number],
            |row| row.get(0),
        )
        .optional()
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
    pub(crate) claimed_by: Option<String>,
    pub(crate) claimed_name: Option<String>,
    pub(crate) claimed_at: Option<i64>,
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
                COALESCE(c.generation,0), COALESCE(s.synced_generation,0),
                s.claimed_by, s.claimed_name, s.claimed_at
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
                claimed_by: row.get(7)?,
                claimed_name: row.get(8)?,
                claimed_at: row.get(9)?,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) claimed_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) claimed_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) claimed_at: Option<i64>,
    pub(crate) claimed_by_me: bool,
    pub(crate) remote_operation_id: Option<String>,
    pub(crate) local_archived: bool,
}

pub(crate) fn list(store: &Store) -> rusqlite::Result<Vec<OrderRow>> {
    let my_id = device_id(store).unwrap_or_default();
    let expired_before = now_ms().saturating_sub(CLAIM_LEASE_MS);
    let conn = store.conn.lock().unwrap();
    let mut query = conn.prepare(
        "SELECT o.order_number, COALESCE(s.local_completed,0), s.shared_state, t.kind, t.error,
                s.claimed_by, s.claimed_name, s.claimed_at, s.remote_operation_id, a.order_number IS NOT NULL
         FROM orders o LEFT JOIN workflow_orders s USING(order_number)
         LEFT JOIN workflow_local_archives a ON a.order_number=o.order_number
         LEFT JOIN workflow_tasks t ON t.order_number=o.order_number AND t.kind=(
             SELECT kind FROM workflow_tasks WHERE order_number=o.order_number AND kind IN ('publish','finish')
             ORDER BY CASE kind WHEN 'finish' THEN 1 WHEN 'publish' THEN 2 ELSE 3 END LIMIT 1
         )",
    )?;
    let rows = query.query_map([], |r| {
        let local_completed: bool = r.get(1)?;
        let shared_state: Option<String> = r.get(2)?;
        let raw_claimed_by: Option<String> = r.get(5)?;
        let raw_claimed_name: Option<String> = r.get(6)?;
        let raw_claimed_at: Option<i64> = r.get(7)?;
        let active_claim = !local_completed
            && shared_state.as_deref() != Some("completed")
            && raw_claimed_by.as_ref().is_some_and(|id| !id.is_empty())
            && raw_claimed_at.is_none_or(|ts| ts >= expired_before);
        let (claimed_by, claimed_name, claimed_at, claimed_by_me) = if active_claim {
            let by_me = raw_claimed_by.as_deref() == Some(my_id.as_str());
            (raw_claimed_by, raw_claimed_name, raw_claimed_at, by_me)
        } else {
            (None, None, None, false)
        };
        Ok(OrderRow {
            order_number: r.get(0)?,
            local_completed,
            shared_state,
            pending_operation: r.get(3)?,
            error: r.get(4)?,
            claimed_by,
            claimed_name,
            claimed_at,
            claimed_by_me,
            remote_operation_id: r.get(8)?,
            local_archived: r.get(9)?,
        })
    })?;
    rows.collect()
}

pub(crate) fn archive_local(store: &Store, numbers: &[String], archived: bool) -> rusqlite::Result<()> {
    if numbers.is_empty() {
        return Ok(());
    }
    let mut conn = store.conn.lock().unwrap();
    let tx = conn.transaction()?;
    let sql = if archived {
        "INSERT OR IGNORE INTO workflow_local_archives(order_number) VALUES (?1)"
    } else {
        "DELETE FROM workflow_local_archives WHERE order_number=?1"
    };
    for number in numbers {
        tx.execute(sql, [number])?;
    }
    tx.commit()
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
    pub(crate) payload: String,
    pub(crate) source_files: Option<String>,
}

pub(crate) fn task(store: &Store, number: &str, kind: &str) -> rusqlite::Result<Option<Task>> {
    store.conn.lock().unwrap().query_row(
        "SELECT target, expected_operation_id, generation, manifest, source_files FROM workflow_tasks WHERE order_number=?1 AND kind=?2",
        params![number, kind],
        |r| Ok(Task { number: number.into(), kind: kind.into(), target: r.get(0)?,
            expected_operation_id: r.get(1)?, generation: r.get(2)?, payload: r.get(3)?, source_files: r.get(4)? }),
    ).optional()
}

pub(crate) fn insert_task(store: &Store, task: &Task, local_version: &str) -> Result<(), String> {
    let mut conn = store.conn.lock().unwrap();
    let tx = conn.transaction().map_err(error)?;
    verify_version(&tx, &task.number, Some(local_version))?;
    tx.execute(
        "INSERT INTO workflow_tasks(order_number,kind,target,expected,generation,manifest,expected_operation_id,source_files)
         VALUES (?1,?2,?3,0,?4,?5,?6,?7)",
        params![
            task.number,
            task.kind,
            task.target,
            task.generation,
            task.payload,
            task.expected_operation_id,
            task.source_files,
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
        if state == "completed" {
            tx.execute(
                "UPDATE workflow_orders SET claimed_by=NULL, claimed_name=NULL, claimed_at=NULL WHERE order_number=?1",
                [&task.number],
            )?;
        }
        tx.execute(
            "INSERT INTO workflow_synced_snapshots(order_number, payload) VALUES (?1, ?2)
             ON CONFLICT(order_number) DO UPDATE SET payload = excluded.payload",
            params![task.number, task.payload],
        )?;
    }
    tx.execute(
        "DELETE FROM workflow_tasks WHERE order_number=?1 AND kind=?2",
        params![task.number, task.kind],
    )?;
    tx.commit()
}

pub(crate) fn update_claim_local(
    store: &Store,
    number: &str,
    target: Option<&str>,
    claimed_by: Option<&str>,
    claimed_name: Option<&str>,
    claimed_at: Option<i64>,
) -> rusqlite::Result<bool> {
    let conn = store.conn.lock().unwrap();
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM orders WHERE order_number=?1)",
        [number],
        |r| r.get(0),
    )?;
    if !exists {
        return Ok(false);
    }
    conn.execute(
        "INSERT INTO workflow_orders(order_number, target, claimed_by, claimed_name, claimed_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(order_number) DO UPDATE SET
            target = COALESCE(excluded.target, workflow_orders.target),
            claimed_by = excluded.claimed_by,
            claimed_name = excluded.claimed_name,
            claimed_at = excluded.claimed_at",
        params![number, target, claimed_by, claimed_name, claimed_at],
    )?;
    Ok(true)
}

pub(crate) fn reopen_local(
    store: &Store,
    number: &str,
    target: Option<&str>,
    operation_id: Option<&str>,
    payload: Option<&str>,
) -> rusqlite::Result<()> {
    let mut conn = store.conn.lock().unwrap();
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM workflow_local_archives WHERE order_number=?1", [number])?;
    let generation: i64 = tx
        .query_row(
            "SELECT COALESCE(generation, 0) FROM workflow_changes WHERE order_number=?1",
            [number],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0);
    tx.execute(
        "DELETE FROM workflow_tasks WHERE order_number=?1 AND kind='finish'",
        [number],
    )?;
    if let (Some(target), Some(op_id)) = (target, operation_id) {
        tx.execute(
            "INSERT INTO workflow_orders(order_number, local_completed, target, shared_state, synced_generation, remote_operation_id, claimed_by, claimed_name, claimed_at)
             VALUES (?1, 0, ?2, 'pending', ?3, ?4, NULL, NULL, NULL)
             ON CONFLICT(order_number) DO UPDATE SET
                local_completed = 0,
                target = excluded.target,
                shared_state = 'pending',
                synced_generation = excluded.synced_generation,
                remote_operation_id = excluded.remote_operation_id,
                claimed_by = NULL,
                claimed_name = NULL,
                claimed_at = NULL",
            params![number, target, generation, op_id],
        )?;
    } else {
        tx.execute(
            "INSERT INTO workflow_orders(order_number, local_completed, claimed_by, claimed_name, claimed_at)
             VALUES (?1, 0, NULL, NULL, NULL)
             ON CONFLICT(order_number) DO UPDATE SET
                local_completed = 0,
                shared_state = CASE WHEN workflow_orders.target IS NULL THEN NULL ELSE 'pending' END,
                claimed_by = NULL,
                claimed_name = NULL,
                claimed_at = NULL",
            [number],
        )?;
    }
    if let Some(payload) = payload {
        tx.execute(
            "INSERT INTO workflow_synced_snapshots(order_number, payload) VALUES (?1, ?2)
             ON CONFLICT(order_number) DO UPDATE SET payload = excluded.payload",
            params![number, payload],
        )?;
    }
    tx.commit()
}

pub(crate) fn save_downloaded_production(
    store: &Store,
    production_id: &str,
    file_path: &std::path::Path,
    byte_length: u64,
) -> rusqlite::Result<()> {
    let mut conn = store.conn.lock().unwrap();
    let tx = conn.transaction()?;
    let order_number: Option<String> = tx
        .query_row(
            "SELECT order_number FROM productions WHERE id=?1",
            [production_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(order_number) = order_number else {
        return Ok(());
    };
    let was_clean = read_state(&tx, &order_number)?
        .is_some_and(|st| st.generation == st.synced_generation);
    tx.execute(
        "UPDATE productions SET file_path=?2, byte_length=?3 WHERE id=?1",
        params![production_id, file_path.to_string_lossy(), byte_length as i64],
    )?;
    if was_clean {
        tx.execute(
            "UPDATE workflow_orders SET synced_generation = COALESCE(
                (SELECT generation FROM workflow_changes WHERE order_number=?1), 0
             ) WHERE order_number=?1",
            [&order_number],
        )?;
    }
    tx.commit()
}

pub(crate) fn save_downloaded_image(
    store: &Store,
    image_id: &str,
    file_path: &std::path::Path,
    thumb_path: Option<&std::path::Path>,
    width: u32,
    height: u32,
    byte_length: u64,
) -> rusqlite::Result<()> {
    let mut conn = store.conn.lock().unwrap();
    let tx = conn.transaction()?;
    let order_number: Option<String> = tx
        .query_row(
            "SELECT o.order_number FROM images i JOIN orders o ON o.id=i.order_id WHERE i.id=?1",
            [image_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(order_number) = order_number else {
        return Ok(());
    };
    let was_clean = read_state(&tx, &order_number)?
        .is_some_and(|st| st.generation == st.synced_generation);
    tx.execute(
        "UPDATE images SET file_path=?2, thumb_path=?3, width=?4, height=?5, byte_length=?6 WHERE id=?1",
        params![
            image_id,
            file_path.to_string_lossy(),
            thumb_path.map(|p| p.to_string_lossy().into_owned()),
            width as i64,
            height as i64,
            byte_length as i64,
        ],
    )?;
    if was_clean {
        tx.execute(
            "UPDATE workflow_orders SET synced_generation = COALESCE(
                (SELECT generation FROM workflow_changes WHERE order_number=?1), 0
             ) WHERE order_number=?1",
            [&order_number],
        )?;
    }
    tx.commit()
}

pub(crate) fn discard_task(store: &Store, task: &Task) -> rusqlite::Result<()> {
    store.conn.lock().unwrap().execute(
        "DELETE FROM workflow_tasks WHERE order_number=?1 AND kind=?2 AND manifest=?3",
        params![task.number, task.kind, task.payload],
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
        "UPDATE workflow_orders
         SET shared_state='completed', revision=0, remote_operation_id=?3,
             claimed_by=NULL, claimed_name=NULL, claimed_at=NULL
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
    pub(crate) remote_object_name: Option<String>,
    pub(crate) production: bool,
    pub(crate) bytes: u64,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) quality: Option<String>,
    pub(crate) remark: Option<String>,
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
    pub(crate) raw_payload: Option<&'a str>,
    pub(crate) claim: Option<(Option<&'a str>, Option<&'a str>, Option<i64>)>,
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

fn remove_current_originals_and_synced_productions(
    conn: &Transaction<'_>,
    number: &str,
    id: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM qiniu_assets WHERE id IN (
            SELECT id FROM images WHERE order_id=?1
            UNION
            SELECT p.id FROM productions p JOIN workflow_remote_ids m ON m.local_id=p.id WHERE p.order_number=?2
        )",
        params![id, number],
    )?;
    conn.execute(
        "DELETE FROM workflow_remote_ids WHERE local_id IN (
            SELECT id FROM images WHERE order_id=?1
            UNION
            SELECT id FROM productions WHERE order_number=?2 AND id IN (SELECT local_id FROM workflow_remote_ids)
        )",
        params![id, number],
    )?;
    conn.execute(
        "DELETE FROM image_templates WHERE image_id IN (SELECT id FROM images WHERE order_id=?1)",
        [id],
    )?;
    conn.execute("DELETE FROM images WHERE order_id=?1", [id])?;
    conn.execute(
        "DELETE FROM productions WHERE order_number=?1 AND id IN (SELECT local_id FROM workflow_remote_ids) OR (order_number=?1 AND file_path='')",
        [number],
    )?;
    Ok(())
}

pub(crate) fn existing_remote_files(
    store: &Store,
    number: &str,
) -> rusqlite::Result<HashMap<String, (String, Option<String>, i64, i64)>> {
    let conn = store.conn.lock().unwrap();
    let mut files = HashMap::new();
    let mut img_q = conn.prepare(
        "SELECT COALESCE(m.remote_id, i.id), i.file_path, i.thumb_path, i.width, i.height
         FROM images i
         JOIN orders o ON o.id = i.order_id
         LEFT JOIN workflow_remote_ids m ON m.local_id = i.id
         WHERE o.order_number = ?1 AND i.file_path <> ''",
    )?;
    for row in img_q.query_map([number], |r| {
        Ok((
            r.get::<_, String>(0)?,
            (
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
            ),
        ))
    })? {
        let (remote_id, info) = row?;
        if std::path::Path::new(&info.0).is_file() {
            files.insert(remote_id, info);
        }
    }
    let mut prod_q = conn.prepare(
        "SELECT COALESCE(m.remote_id, p.id), p.file_path
         FROM productions p
         LEFT JOIN workflow_remote_ids m ON m.local_id = p.id
         WHERE p.order_number = ?1 AND p.file_path <> ''",
    )?;
    for row in prod_q.query_map([number], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })? {
        let (remote_id, path) = row?;
        if std::path::Path::new(&path).is_file() {
            files.insert(remote_id, (path, None, 0, 0));
        }
    }
    Ok(files)
}

pub(crate) fn import(store: &Store, request: Import<'_>) -> Result<(), String> {
    let mut conn = store.conn.lock().unwrap();
    let tx = conn.transaction().map_err(error)?;
    let current = verify_version(&tx, request.number, request.expected)?;
    if current.is_some() && has_tasks(&tx, request.number).map_err(error)? {
        return Err("这笔订单有尚未确认的上传，请先处理待上传操作。".into());
    }
    let number = request.number.to_owned();
    let mut previous_remarks = HashMap::new();
    let mut previous_files: HashMap<String, (String, Option<String>, i64, i64)> = HashMap::new();
    let mut had_unsynced_local_productions = false;
    let copy = |number: &str| format!("{number}~副本-{}", random_hex_pub(6));
    match request.action {
        ImportAction::Replace => {
            if let Some(current) = &current {
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
                // Older publishers omit the field. Keep matching notes when refreshing from them.
                let mut query = tx.prepare(
                    "SELECT COALESCE(m.remote_id, i.id), i.remark FROM images i
                     LEFT JOIN workflow_remote_ids m ON m.local_id=i.id
                     WHERE i.order_id=?1 AND i.remark<>''",
                ).map_err(error)?;
                previous_remarks = query.query_map([&current.id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                }).map_err(error)?.collect::<rusqlite::Result<_>>().map_err(error)?;

                let mut files_q = tx.prepare(
                    "SELECT COALESCE(m.remote_id, i.id), i.file_path, i.thumb_path, i.width, i.height
                     FROM images i
                     LEFT JOIN workflow_remote_ids m ON m.local_id=i.id
                     WHERE i.order_id=?1 AND i.file_path<>''",
                ).map_err(error)?;
                for row in files_q.query_map([&current.id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        (
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, i64>(4)?,
                        ),
                    ))
                }).map_err(error)? {
                    let (rid, info) = row.map_err(error)?;
                    previous_files.insert(rid, info);
                }

                let mut prod_q = tx.prepare(
                    "SELECT COALESCE(m.remote_id, p.id), p.file_path, m.remote_id IS NOT NULL
                     FROM productions p
                     LEFT JOIN workflow_remote_ids m ON m.local_id=p.id
                     WHERE p.order_number=?1",
                ).map_err(error)?;
                let mut synced_prod_ids = Vec::new();
                for row in prod_q.query_map([&number], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, bool>(2)?,
                    ))
                }).map_err(error)? {
                    let (rid, fpath, is_synced) = row.map_err(error)?;
                    if !fpath.is_empty() {
                        previous_files.insert(rid.clone(), (fpath.clone(), None, 0, 0));
                    }
                    if is_synced || fpath.is_empty() {
                        synced_prod_ids.push(rid);
                    } else {
                        had_unsynced_local_productions = true;
                    }
                }
                drop(prod_q);

                remove_current_originals_and_synced_productions(&tx, &number, &current.id).map_err(error)?;
                for rid in synced_prod_ids {
                    tx.execute(
                        "DELETE FROM productions WHERE order_number=?1 AND id=?2",
                        params![number, rid],
                    )
                    .map_err(error)?;
                }
            }
        }
    }
    let order_id = store.find_or_create_order(&tx, &number).map_err(error)?;
    let merged_meta = match (&request.action, request.metadata) {
        (ImportAction::Sync, Some(incoming)) => {
            crate::store::merge_order_metadata_for_id(&tx, &order_id, Some(incoming)).map_err(error)?
        }
        (_, meta) => meta.map(str::to_owned),
    };
    tx.execute(
        "UPDATE orders SET metadata=?2,updated_at=?3 WHERE id=?1",
        params![order_id, merged_meta, now()],
    )
    .map_err(error)?;
    for asset in request.assets.iter().filter(|asset| !asset.production) {
        let id = random_hex_pub(16);
        let remark = asset.remark.as_deref()
            .or_else(|| previous_remarks.get(&asset.remote_id).map(String::as_str))
            .unwrap_or_default();
        let (file_path, thumb_path, width, height) = if !asset.path.as_os_str().is_empty() {
            (
                asset.path.to_string_lossy().into_owned(),
                asset.thumb.as_deref().map(|p| p.to_string_lossy().into_owned()),
                asset.width as i64,
                asset.height as i64,
            )
        } else if let Some((existing_path, existing_thumb, w, h)) = previous_files.get(&asset.remote_id) {
            (
                existing_path.clone(),
                existing_thumb.clone(),
                if asset.width > 0 { asset.width as i64 } else { *w },
                if asset.height > 0 { asset.height as i64 } else { *h },
            )
        } else {
            (String::new(), None, asset.width as i64, asset.height as i64)
        };
        tx.execute(
            "INSERT INTO images(id,order_id,file_path,original_name,byte_length,width,height,source,created_at,thumb_path,remark,remote_object_name)
             VALUES(?1,?2,?3,?4,?5,?6,?7,'共享存储',?8,?9,?10,?11)",
            params![id, order_id, file_path, asset.name, asset.bytes, width,
                height, now(), thumb_path, remark, asset.remote_object_name],
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
        let file_path = if !asset.path.as_os_str().is_empty() {
            asset.path.to_string_lossy().into_owned()
        } else if let Some((existing_path, _, _, _)) = previous_files.get(&asset.remote_id) {
            existing_path.clone()
        } else {
            String::new()
        };
        tx.execute(
            "INSERT INTO productions(id,order_number,image_id,file_path,created_at,remote_object_name,byte_length,original_name)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                id,
                number,
                image_id,
                file_path,
                now(),
                asset.remote_object_name,
                asset.bytes as i64,
                asset.name
            ],
        ).map_err(error)?;
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
        let synced_gen = if had_unsynced_local_productions {
            state.generation.saturating_sub(1)
        } else {
            state.generation
        };
        set_shared(
            &tx,
            &number,
            target,
            shared_state,
            operation_id,
            synced_gen,
        )
        .map_err(error)?;
        if shared_state == "completed" {
            tx.execute(
                "UPDATE workflow_orders SET local_completed=0, claimed_by=NULL, claimed_name=NULL, claimed_at=NULL WHERE order_number=?1",
                [&number],
            )
            .map_err(error)?;
        } else if matches!(request.action, ImportAction::Sync) {
            tx.execute(
                "UPDATE workflow_orders SET local_completed=0 WHERE order_number=?1",
                [&number],
            )
            .map_err(error)?;
        }
    }
    if let Some((claimed_by, claimed_name, claimed_at)) = request.claim {
        tx.execute(
            "UPDATE workflow_orders SET claimed_by=?2, claimed_name=?3, claimed_at=?4 WHERE order_number=?1",
            params![number, claimed_by, claimed_name, claimed_at],
        )
        .map_err(error)?;
    }
    if let Some(raw_payload) = request.raw_payload {
        tx.execute(
            "INSERT INTO workflow_synced_snapshots(order_number, payload) VALUES (?1, ?2)
             ON CONFLICT(order_number) DO UPDATE SET payload = excluded.payload",
            params![number, raw_payload],
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
                raw_payload: None,
                claim: None,
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
                payload: "{}".into(),
                source_files: None,
            },
            &local.version(),
        )
        .unwrap();
        store
            .conn
            .lock()
            .unwrap()
            .execute("ALTER TABLE workflow_tasks DROP COLUMN source_files", [])
            .unwrap();
        drop(store);
        let store = Store::open(directory.path()).unwrap();
        assert!(order_state(&store, "A01").unwrap().unwrap().local_completed);
        assert!(task(&store, "A01", "finish")
            .unwrap()
            .unwrap()
            .source_files
            .is_none());
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
                raw_payload: None,
                claim: None,
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
                    raw_payload: None,
                    claim: None,
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
