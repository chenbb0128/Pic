use std::fs::{self, File};
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use rusqlite::OptionalExtension;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::{store::Store, AppState};

struct ArchivedImage {
    path: PathBuf,
    order_number: String,
    original_name: String,
    byte_length: u64,
}

impl ArchivedImage {
    fn load(store: &Store, image_id: &str) -> rusqlite::Result<Option<Self>> {
        store.conn.lock().expect("store mutex poisoned").query_row(
            "SELECT images.file_path, orders.order_number, images.original_name, images.byte_length
             FROM images JOIN orders ON orders.id = images.order_id WHERE images.id = ?1",
            [image_id],
            |row| {
                Ok(Self {
                    path: PathBuf::from(row.get::<_, String>(0)?),
                    order_number: row.get(1)?,
                    original_name: row.get(2)?,
                    byte_length: row.get(3)?,
                })
            },
        ).optional()
    }

    fn ready_path(
        &self,
        store: &Store,
        data_root: &Path,
        image_id: &str,
    ) -> Result<PathBuf, String> {
        let root = data_root
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let image_root = root
            .join("images")
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let path = self
            .path
            .canonicalize()
            .map_err(|error| format!("无法打开归档原图：{error}"))?;
        let image_folder = image_root.file_name().is_some_and(|name| {
            name == "images" || (cfg!(windows) && name.eq_ignore_ascii_case("images"))
        });
        if image_root.parent() != Some(root.as_path())
            || !image_folder
            || !path.starts_with(&image_root)
        {
            return Err("原图路径不在图片归档目录内".into());
        }

        let sync = store
            .qiniu_asset_state(image_id)
            .map_err(|error| error.to_string())?;
        let ready = match sync {
            Some(status) if status.state == "synced" => status.file_ready(&path),
            _ => fs::metadata(&path)
                .is_ok_and(|meta| meta.is_file() && meta.len() == self.byte_length),
        };
        if !ready {
            return Err("归档原图不完整，请等图片同步完成后再保存".into());
        }
        Ok(path)
    }
}

#[tauri::command]
pub(crate) async fn save_order_image(
    app: AppHandle,
    state: State<'_, AppState>,
    image_id: String,
) -> Result<Option<String>, String> {
    let image = ArchivedImage::load(&state.store, &image_id)
        .map_err(|error| error.to_string())?
        .ok_or("原图尚未下载完成或已删除")?;
    let source = image.ready_path(&state.store, &state.data_root, &image_id)?;
    let extension = source.extension().and_then(|value| value.to_str());
    let mut dialog = app
        .dialog()
        .file()
        .set_title("另存素材")
        .set_file_name(suggested_filename(
            &image.order_number,
            &image.original_name,
            extension,
        ));
    if let Some(extension) = extension {
        dialog = dialog.add_filter("图片", &[extension]);
    }
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    dialog.save_file(move |selection| {
        let _ = sender.send(selection);
    });
    let destination = receiver
        .await
        .map_err(|_| "无法打开保存对话框")?
        .map(|selection| selection.into_path())
        .transpose()
        .map_err(|error| format!("无法使用选定的保存路径：{error}"))?;

    let store = state.store.clone();
    let data_root = state.data_root.clone();
    tokio::task::spawn_blocking(move || {
        // Sync may have replaced the file while the Save As dialog was open.
        let source = if destination.is_some() {
            let image = ArchivedImage::load(&store, &image_id)
                .map_err(|error| error.to_string())?
                .ok_or("原图尚未下载完成或已删除")?;
            image.ready_path(&store, &data_root, &image_id)?
        } else {
            source
        };
        save_selected(&source, destination)
    })
    .await
    .map_err(|error| format!("无法保存原图：{error}"))?
}

fn suggested_filename(order_number: &str, original_name: &str, extension: Option<&str>) -> String {
    let original_name = original_name.rsplit(['/', '\\']).next().unwrap_or_default();
    let original_stem = Path::new(original_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let order = safe_name_part(crate::shops::platform_number(order_number), "订单");
    let name = safe_name_part(original_stem, "原图");
    match extension {
        Some(extension) => format!("{order}_{name}.{extension}"),
        None => format!("{order}_{name}"),
    }
}

fn safe_name_part(value: &str, fallback: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches([' ', '.']);
    if cleaned.is_empty() {
        fallback.into()
    } else {
        cleaned.into()
    }
}

fn save_selected(source: &Path, destination: Option<PathBuf>) -> Result<Option<String>, String> {
    let Some(destination) = destination else {
        return Ok(None);
    };
    if let Some(extension) = source.extension() {
        if !destination
            .extension()
            .is_some_and(|value| value.eq_ignore_ascii_case(extension))
        {
            return Err(format!("请保留原图扩展名 .{}", extension.to_string_lossy()));
        }
    }

    let directory = destination.parent().ok_or("保存位置无效")?;
    let existing = match fs::symlink_metadata(&destination) {
        Ok(meta) if meta.is_file() => {
            let destination_handle =
                same_file::Handle::from_path(&destination).map_err(save_error)?;
            if same_file::Handle::from_path(source).map_err(save_error)? == destination_handle {
                return Err("请选择与归档原图不同的保存位置".into());
            }
            Some(destination_handle)
        }
        Ok(_) => return Err("请选择普通文件作为保存位置".into()),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => return Err(save_error(error)),
    };

    let mut source = File::open(source).map_err(save_error)?;
    let before = source.metadata().map_err(save_error)?;
    let mut output = tempfile::NamedTempFile::new_in(directory).map_err(save_error)?;
    let bytes_copied = io::copy(&mut source, output.as_file_mut()).map_err(save_error)?;
    let after = source.metadata().map_err(save_error)?;
    if bytes_copied != before.len()
        || after.len() != before.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err("归档原图在保存时发生变化，请重试".into());
    }
    output.as_file().sync_all().map_err(save_error)?;

    // The Windows Save As dialog confirms existing paths. A newly created path
    // must not be overwritten if another process creates it after this check.
    if let Some(existing) = existing {
        if same_file::Handle::from_path(&destination).map_err(save_error)? != existing {
            return Err("目标文件在保存时发生变化，请重新选择保存位置".into());
        }
        // Windows cannot replace an existing file while this handle is open.
        drop(existing);
        output
            .persist(&destination)
            .map_err(|error| save_error(error.error))?;
    } else {
        output
            .persist_noclobber(&destination)
            .map_err(|error| save_error(error.error))?;
    }
    Ok(Some(destination.to_string_lossy().into_owned()))
}

fn save_error(error: io::Error) -> String {
    format!("无法保存原图：{error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_the_archived_file_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.jpg");
        let destination = dir.path().join("saved.jpg");
        let original = b"\xff\xd8\x00\x80\xff\xd9";
        std::fs::write(&source, original).unwrap();

        assert!(save_selected(&source, Some(destination.clone()))
            .unwrap()
            .is_some());

        assert_eq!(std::fs::read(destination).unwrap(), original);
    }

    #[test]
    fn returns_none_when_the_dialog_is_canceled() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.jpg");

        assert_eq!(save_selected(&source, None).unwrap(), None);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn replaces_a_confirmed_destination_without_touching_the_source() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.jpg");
        let destination = dir.path().join("existing.jpg");
        std::fs::write(&source, b"new file").unwrap();
        std::fs::write(&destination, b"previous, longer file").unwrap();

        save_selected(&source, Some(destination.clone())).unwrap();

        assert_eq!(std::fs::read(destination).unwrap(), b"new file");
        assert_eq!(std::fs::read(source).unwrap(), b"new file");
    }

    #[test]
    fn rejects_a_hard_link_to_the_source() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.jpg");
        let alias = dir.path().join("alias.jpg");
        std::fs::write(&source, b"original").unwrap();
        std::fs::hard_link(&source, &alias).unwrap();

        assert!(save_selected(&source, Some(alias.clone())).is_err());
        assert_eq!(std::fs::read(alias).unwrap(), b"original");
    }

    #[cfg(windows)]
    #[test]
    fn rejects_the_source_with_different_case_on_windows() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.jpg");
        std::fs::write(&source, b"original").unwrap();

        assert!(save_selected(&source, Some(dir.path().join("SOURCE.JPG"))).is_err());
        assert_eq!(std::fs::read(source).unwrap(), b"original");
    }

    #[test]
    fn suggests_the_order_and_original_name_with_the_archive_extension() {
        assert_eq!(
            suggested_filename("2026/123", "old/path/客户照片.jpeg", Some("webp")),
            "2026_123_客户照片.webp"
        );
    }

    #[test]
    fn rejects_an_image_record_pointing_outside_the_archive() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        fs::create_dir_all(dir.path().join("images")).unwrap();
        let outside = dir.path().join("images/../elsewhere.jpg");
        fs::write(&outside, b"same length").unwrap();
        let image = catalogued_image(&store, &outside, 11);

        assert!(image.ready_path(&store, dir.path(), "image-1").is_err());
    }

    #[test]
    fn verifies_synced_files_against_qiniu_size_and_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let path = dir.path().join("images/fixture.jpg");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"latest").unwrap();
        let image = catalogued_image(&store, &path, 3);
        let current_mtime = fs::metadata(&path).unwrap().modified().unwrap();
        let ns = current_mtime
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos() as i64;
        store.conn.lock().unwrap().execute(
            "INSERT INTO qiniu_assets(id, order_number, kind, state, byte_length, file_mtime_ns)
             VALUES('image-1', 'order-number', 'original', 'synced', 6, ?1)",
            [ns],
        ).unwrap();

        let ready = || image.ready_path(&store, dir.path(), "image-1");
        assert_eq!(ready().unwrap(), path.canonicalize().unwrap());

        store
            .conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE qiniu_assets SET file_mtime_ns = ?1 WHERE id = 'image-1'",
                [ns - 1],
            )
            .unwrap();
        assert!(ready().is_err());

        store
            .conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE qiniu_assets SET file_mtime_ns = ?1, byte_length = 5 WHERE id = 'image-1'",
                [ns],
            )
            .unwrap();
        assert!(ready().is_err());
    }

    fn catalogued_image(store: &Store, path: &Path, length: u64) -> ArchivedImage {
        {
            let conn = store.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO orders(id, order_number, created_at, updated_at)
                 VALUES('order-1', 'order-number', '', '')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO images(id, order_id, file_path, original_name, byte_length, width, height, source, created_at)
                 VALUES('image-1', 'order-1', ?1, 'fixture.jpg', ?2, 1, 1, 'fixture', '')",
                rusqlite::params![path.to_string_lossy(), length],
            ).unwrap();
        }
        ArchivedImage::load(store, "image-1").unwrap().unwrap()
    }
}
