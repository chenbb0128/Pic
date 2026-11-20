use std::io::Write;
use std::path::{Path, PathBuf};

/// Business data always lives beside this executable; never migrate or fall back.
pub fn for_executable(executable: &Path) -> Result<PathBuf, String> {
    if !executable.is_absolute() {
        return Err("无法确定程序的绝对路径，不能创建本地数据目录。".into());
    }
    let parent = executable
        .parent()
        .ok_or_else(|| "无法确定程序所在目录。".to_string())?;
    let root = parent.join("data");
    let probe = root.join(format!(".write-test-{:016x}", rand::random::<u64>()));
    let writable = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(&root)?;
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&probe)?;
        file.write_all(b"ok")?;
        drop(file);
        std::fs::remove_file(&probe)
    })();
    if let Err(error) = writable {
        let _ = std::fs::remove_file(&probe);
        return Err(format!(
            "无法写入程序旁的数据目录 {}：{error}。请将程序放到可写目录后重新启动。",
            root.display()
        ));
    }
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("paidan-data-dir-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn fresh_executable_directory_starts_with_empty_local_orders() {
        let root = fixture();
        let executable_dir = root.join("订单中心 portable");
        std::fs::create_dir_all(&executable_dir).unwrap();
        let data = for_executable(&executable_dir.join("vagaga.exe")).unwrap();
        assert_eq!(data, executable_dir.join("data"));
        assert_eq!(std::fs::read_dir(&data).unwrap().count(), 0);
        let store = crate::store::Store::open(&data).unwrap();
        assert!(store.list_orders().unwrap().is_empty());
    }

    #[test]
    fn existing_executable_local_data_is_preserved() {
        let root = fixture();
        let data = root.join("data");
        std::fs::create_dir(&data).unwrap();
        let config = data.join("mysql.json");
        std::fs::write(&config, "existing-config").unwrap();
        assert_eq!(for_executable(&root.join("vagaga.exe")).unwrap(), data);
        assert_eq!(std::fs::read_to_string(config).unwrap(), "existing-config");
        assert_eq!(std::fs::read_dir(&data).unwrap().count(), 1);
    }

    #[test]
    fn blocked_data_directory_fails_instead_of_using_another_location() {
        let root = fixture();
        let blocked = root.join("data");
        std::fs::write(&blocked, "this is a file").unwrap();
        let error = for_executable(&root.join("vagaga.exe")).unwrap_err();
        assert!(error.contains(&blocked.to_string_lossy().to_string()));
        assert_eq!(std::fs::read_to_string(blocked).unwrap(), "this is a file");
    }
}
