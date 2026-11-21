use std::path::Path;

use sha2::{Digest, Sha256};

use crate::{cloud, qiniu_settings, store, workflow_db, workflow_qiniu::Qiniu};

// The bucket itself is the storage namespace.  Keep the workflow layout flat so
// operators can inspect one current manifest per order without a revision tree.
const ROOT: &str = "";

fn object_key(path: impl AsRef<str>) -> String {
    let path = path.as_ref().trim_start_matches('/');
    if ROOT.is_empty() {
        path.to_owned()
    } else {
        format!("{ROOT}/{path}")
    }
}

fn order_manifest_key(order_number: &str) -> Result<String, String> {
    let order_number = order_number.trim();
    if order_number.is_empty()
        || order_number == "."
        || order_number == ".."
        || order_number.len() > 256
        || order_number.chars().any(|ch| {
            ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        || order_number.ends_with(['.', ' '])
        || matches!(order_number.split('.').next().unwrap_or("").to_ascii_uppercase().as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "COM3" | "COM4" | "COM5"
                | "COM6" | "COM7" | "COM8" | "COM9" | "LPT1" | "LPT2" | "LPT3" | "LPT4"
                | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9")
    {
        return Err("订单编号不能作为共享存储路径。".into());
    }
    Ok(object_key(format!("orders/{order_number}/manifest.json")))
}

fn order_hash(order_number: &str) -> String {
    format!("{:x}", Sha256::digest(order_number.as_bytes()))
}

pub(crate) enum Backend {
    Nas(cloud::CloudConfig, cloud::FileStorage),
    Qiniu(Qiniu),
}

impl Backend {
    pub(crate) fn configured_target(
        store: &store::Store,
        root: &Path,
    ) -> Result<Option<String>, String> {
        let (qiniu, _) = qiniu_settings::load(store)?;
        if qiniu.enabled {
            return Ok(Qiniu::configured_target(&qiniu));
        }
        let config = cloud::load_config(root);
        Ok(config.enabled.then(|| config.target()))
    }

    pub(crate) fn current(store: &store::Store, root: &Path) -> Result<Option<Self>, String> {
        if qiniu_settings::load(store)?.0.enabled {
            return Qiniu::new(store).map(Self::Qiniu).map(Some);
        }
        let config = cloud::load_config(root);
        if !config.enabled {
            return Ok(None);
        }
        let backend = Self::nas(config)?;
        backend.remember(store)?;
        Ok(Some(backend))
    }

    pub(crate) fn bound(store: &store::Store, root: &Path, target: &str) -> Result<Self, String> {
        let config = cloud::load_config(root);
        if config.target() == target {
            let backend = Self::nas(config)?;
            backend.remember(store)?;
            return Ok(backend);
        }
        if let Some(settings) =
            workflow_db::setting(store, &format!("nas:{target}")).map_err(display)?
        {
            let config: cloud::CloudConfig = serde_json::from_str(&settings).map_err(display)?;
            if config.target() == target {
                return Self::nas(config);
            }
        }
        if let Ok(client) = Qiniu::new(store) {
            if client.target() == target {
                return Ok(Self::Qiniu(client));
            }
        }
        Err("找不到此订单原来的共享存储配置。".into())
    }

    fn nas(config: cloud::CloudConfig) -> Result<Self, String> {
        let client = config.client()?;
        Ok(Self::Nas(config, client))
    }

    fn remember(&self, store: &store::Store) -> Result<(), String> {
        if let Self::Nas(config, _) = self {
            let json = serde_json::to_string(config).map_err(display)?;
            let key = format!("nas:{}", config.target());
            if workflow_db::setting(store, &key)
                .map_err(display)?
                .as_deref()
                != Some(&json)
            {
                workflow_db::put_setting(store, &key, &json).map_err(display)?;
            }
        }
        Ok(())
    }

    pub(crate) fn target(&self) -> String {
        match self {
            Self::Nas(config, _) => config.target(),
            Self::Qiniu(client) => client.target(),
        }
    }

    pub(crate) fn key_for_order(&self, order_number: &str) -> Result<String, String> {
        match self {
            Self::Nas(_, _) => {
                order_manifest_key(order_number)?;
                Ok(order_number.trim().to_owned())
            }
            Self::Qiniu(_) => Ok(order_hash(order_number)),
        }
    }

    pub(crate) fn requires_remote_revision(&self) -> bool {
        matches!(self, Self::Qiniu(_))
    }

    pub(crate) fn reconnect_smb_after(&self, error: &str) -> Result<Option<Self>, String> {
        match self {
            Self::Nas(config, _)
                if config.provider == cloud::Provider::Smb
                    && (error.contains("无法连接服务器或传输中断")
                        || error.contains("操作超时")) =>
            {
                Self::nas(config.clone()).map(Some)
            }
            _ => Ok(None),
        }
    }

    pub(crate) async fn test(&self) -> Result<(), String> {
        let config = match self {
            Self::Nas(config, _) => config,
            Self::Qiniu(client) => return client.test().await,
        };
        if config.provider == cloud::Provider::Smb {
            // Some servers pass one race and then give an ambiguous result on the
            // next. Require consistent no-overwrite behavior before first publish.
            for _ in 0..3 {
                Self::probe(config).await?;
            }
            return Ok(());
        }
        // Some MinIO responses end early when parallel, conditional PUTs race.
        // Repeat with a fresh key before classifying the storage as incompatible.
        for _ in 0..4 {
            let result = Self::probe(config).await;
            if !matches!(&result, Err(error) if error.starts_with("云服务连接失败")) {
                return result;
            }
        }
        Self::probe(config).await
    }

    async fn probe(config: &cloud::CloudConfig) -> Result<(), String> {
        let first = config.client()?;
        let second = config.client()?;
        let key = object_key(format!("probes/{}", store::random_hex_pub(16)));
        let (a, b) = tokio::join!(
            first.create_object(&key, b"first".to_vec()),
            second.create_object(&key, b"second".to_vec()),
        );
        let result = async {
            let expected: &[u8] = match (a, b) {
                (Ok(true), Ok(false)) => b"first",
                (Ok(false), Ok(true)) => b"second",
                (Err(error), _) | (_, Err(error)) => return Err(error),
                _ => return Err("共享存储无法安全拒绝重复写入。".into()),
            };
            if first.get_object(&key).await?.as_deref() != Some(expected) {
                return Err("共享存储提交后的内容校验失败。".into());
            }
            Ok(())
        }
        .await;
        let _ = first.delete_object(&key).await;
        result
    }

    pub(crate) async fn put_blob(&self, key: &str, bytes: Vec<u8>) -> Result<(), String> {
        match self {
            Self::Nas(_, client) => {
                let key = object_key(format!("blobs/{key}"));
                if client.get_object(&key).await?.as_deref() == Some(&bytes) {
                    return Ok(());
                }
                client.put_object(&key, bytes.clone()).await?;
                if client.get_object(&key).await?.as_deref() != Some(&bytes) {
                    return Err("共享存储上的文件与本机原件不一致。".into());
                }
                Ok(())
            }
            Self::Qiniu(client) => client.put_blob(key, bytes).await,
        }
    }

    pub(crate) async fn get_blob(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        match self {
            Self::Nas(_, client) => client.get_object(&object_key(format!("blobs/{key}"))).await,
            Self::Qiniu(client) => client.get_blob(key).await,
        }
    }

    pub(crate) async fn list_orders(&self) -> Result<Vec<String>, String> {
        match self {
            Self::Nas(_, client) => client.list_prefixes(&object_key("orders/")).await,
            Self::Qiniu(client) => client.list_orders().await,
        }
    }

    pub(crate) async fn latest(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        match self {
            Self::Nas(_, client) => client.get_object(&order_manifest_key(key)?).await,
            Self::Qiniu(client) => client.latest(key).await,
        }
    }

    pub(crate) async fn commit(
        &self,
        key: &str,
        expected_operation: Option<&str>,
        operation: &str,
        manifest: Vec<u8>,
    ) -> Result<bool, String> {
        match self {
            Self::Nas(_, client) => {
                let path = order_manifest_key(key)?;
                if let Some(previous) = client.get_object(&path).await? {
                    // A retry of the same operation is idempotent.  A fresh local
                    // publish must not silently replace an existing shared order.
                    if previous == manifest {
                        return Ok(true);
                    }
                    let previous_operation = serde_json::from_slice::<serde_json::Value>(&previous)
                        .ok()
                        .and_then(|value| value.get("operationId").and_then(serde_json::Value::as_str).map(str::to_owned));
                    if previous_operation.as_deref() != expected_operation && previous_operation.as_deref() != Some(operation) {
                        return Ok(false);
                    }
                }
                client.put_object(&path, manifest.clone()).await?;
                Ok(client.get_object(&path).await?.as_deref() == Some(manifest.as_slice()))
            }
            Self::Qiniu(client) => {
                let remote_revision = client
                    .latest(key)
                    .await?
                    .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                    .and_then(|value| value.get("revision").and_then(serde_json::Value::as_u64))
                    .unwrap_or(0);
                client.commit(key, remote_revision, operation, manifest).await
            }
        }
    }

    #[cfg(test)]
    pub(crate) async fn clean_fixture(&self, order: &str, blobs: &[String]) -> Result<(), String> {
        let Self::Nas(_, client) = self else {
            return Err("fixture requires NAS".into());
        };
        client.delete_object(&order_manifest_key(order)?).await?;
        for blob in blobs {
            client.delete_object(&object_key(format!("blobs/{blob}"))).await?;
        }
        Ok(())
    }
}

fn display(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_key_uses_order_number_without_revisions() {
        assert_eq!(order_manifest_key("A01").unwrap(), "orders/A01/manifest.json");
        assert!(order_manifest_key("../escape").is_err());
    }

    #[tokio::test]
    #[ignore = "requires a configured NAS, writes only a disposable probe"]
    async fn configured_nas_accepts_exactly_one_concurrent_writer() {
        let root = std::env::var_os("VAGAGA_TEST_NAS_CONFIG_DIR")
            .map(std::path::PathBuf::from)
            .expect("set VAGAGA_TEST_NAS_CONFIG_DIR");
        let backend = Backend::nas(cloud::load_config(&root)).unwrap();
        backend.test().await.unwrap();
    }
}
