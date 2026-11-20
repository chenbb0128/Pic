use std::path::Path;

pub fn configure(scope: &tauri::scope::fs::Scope, data_root: &Path) -> tauri::Result<()> {
    // $EXE is unsupported by Tauri's Windows path resolver. Use the same actual
    // data root as storage, including directories created after startup.
    scope.allow_directory(data_root.join("images"), true)?;
    scope.allow_directory(data_root.join("productions"), true)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::Manager;

    fn configured_scope(data_root: &Path) -> tauri::scope::fs::Scope {
        let config: tauri::Config = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().app.security.asset_protocol = config.app.security.asset_protocol;
        let app = tauri::test::mock_builder().build(context).unwrap();
        let scope = app.asset_protocol_scope();
        configure(&scope, data_root).unwrap();
        scope
    }

    fn fixture() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("paidan-assets-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_file(root: &Path, name: &str) -> std::path::PathBuf {
        let path = root.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"fixture").unwrap();
        path
    }

    #[test]
    fn exe_local_original_thumbnail_and_new_production_are_readable() {
        let root = fixture();
        let data = root.join("portable [订单中心]/data");
        std::fs::create_dir_all(&data).unwrap();
        // Startup grants access before the first capture or export creates subdirectories.
        let scope = configured_scope(&data);
        let original = write_file(&data, "images/2026-11-19/order-one/photo.jpg");
        let thumbnail = write_file(&data, "images/2026-11-19/order-one/photo.thumb.jpg");
        let production = write_file(&data, "productions/order-one/result.png");
        assert!(scope.is_allowed(&original), "EXE-local original image must be readable");
        assert!(scope.is_allowed(&thumbnail), "EXE-local thumbnail must be readable");
        assert!(scope.is_allowed(&production), "newly exported production must be readable");
        assert!(!scope.is_allowed(write_file(&data, "mysql.json")));
        assert!(!scope.is_allowed(write_file(&root, "other-app/photo.jpg")));
    }

    #[test]
    fn moved_application_grants_only_its_own_image_directory() {
        let root = fixture();
        let previous = root.join("previous/data");
        let current = root.join("moved/data");
        let old_image = write_file(&previous, "images/order/photo.jpg");
        let new_image = write_file(&current, "images/order/photo.jpg");
        let scope = configured_scope(&current);
        assert!(scope.is_allowed(new_image));
        assert!(!scope.is_allowed(old_image));
    }
}
