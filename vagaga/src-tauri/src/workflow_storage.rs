use std::path::Path;

use crate::{cloud, qiniu_settings, store, workflow_db, workflow_qiniu::Qiniu};

#[cfg(not(test))]
const ROOT: &str = "vagaga/v2";
#[cfg(test)]
const ROOT: &str = "vagaga/v2-tests";

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
        let key = format!("{ROOT}/probes/{}", store::random_hex_pub(16));
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
                let key = format!("{ROOT}/blobs/{key}");
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
            Self::Nas(_, client) => client.get_object(&format!("{ROOT}/blobs/{key}")).await,
            Self::Qiniu(client) => client.get_blob(key).await,
        }
    }

    pub(crate) async fn list_orders(&self) -> Result<Vec<String>, String> {
        match self {
            Self::Nas(_, client) => client.list_prefixes(&format!("{ROOT}/orders/")).await,
            Self::Qiniu(client) => client.list_orders().await,
        }
    }

    pub(crate) async fn latest(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        match self {
            Self::Nas(_, client) => {
                let prefix = format!("{ROOT}/orders/{key}/revisions/");
                let mut revisions = client.list_prefixes(&prefix).await?;
                revisions.sort_unstable();
                for revision in revisions
                    .into_iter()
                    .rev()
                    .filter(|part| part.len() == 20 && part.bytes().all(|c| c.is_ascii_digit()))
                {
                    if let Some(manifest) = client
                        .get_object(&format!("{prefix}{revision}/manifest.json"))
                        .await?
                    {
                        return Ok(Some(manifest));
                    }
                }
                Ok(None)
            }
            Self::Qiniu(client) => client.latest(key).await,
        }
    }

    pub(crate) async fn commit(
        &self,
        key: &str,
        expected: u64,
        operation: &str,
        manifest: Vec<u8>,
    ) -> Result<bool, String> {
        match self {
            Self::Nas(_, client) => {
                let revision = expected.checked_add(1).ok_or("订单版本溢出")?;
                let base = format!("{ROOT}/orders/{key}/revisions");
                let path = format!("{base}/{revision:020}/manifest.json");
                if let Some(previous) = client.get_object(&path).await? {
                    return Ok(previous == manifest);
                }
                if expected > 0
                    && client
                        .get_object(&format!("{base}/{expected:020}/manifest.json"))
                        .await?
                        .is_none()
                {
                    return Ok(false);
                }
                // On a lost reply the record may already exist. Its exact bytes identify our operation.
                let created = client.create_object(&path, manifest.clone()).await;
                if matches!(created, Ok(true)) {
                    return Ok(true);
                }
                if let Some(previous) = client.get_object(&path).await? {
                    return Ok(previous == manifest);
                }
                created
            }
            Self::Qiniu(client) => client.commit(key, expected, operation, manifest).await,
        }
    }

    pub(crate) async fn backup(&self, id: &str, manifest: Vec<u8>) -> Result<(), String> {
        match self {
            Self::Nas(_, client) => {
                let key = format!("{ROOT}/backups/{id}/manifest.json");
                if let Some(previous) = client.get_object(&key).await? {
                    return if previous == manifest {
                        Ok(())
                    } else {
                        Err("备份编号重复。".into())
                    };
                }
                client.put_object(&key, manifest).await
            }
            Self::Qiniu(client) => client.backup(id, manifest).await,
        }
    }

    pub(crate) async fn list_backups(&self) -> Result<Vec<String>, String> {
        match self {
            Self::Nas(_, client) => client.list_prefixes(&format!("{ROOT}/backups/")).await,
            Self::Qiniu(client) => client.list_backups().await,
        }
    }

    pub(crate) async fn get_backup(&self, id: &str) -> Result<Option<Vec<u8>>, String> {
        match self {
            Self::Nas(_, client) => {
                client
                    .get_object(&format!("{ROOT}/backups/{id}/manifest.json"))
                    .await
            }
            Self::Qiniu(client) => client.get_backup(id).await,
        }
    }

    #[cfg(test)]
    pub(crate) async fn clean_fixture(
        &self,
        order: &str,
        backup: &str,
        blobs: &[String],
    ) -> Result<(), String> {
        let Self::Nas(_, client) = self else {
            return Err("fixture requires NAS".into());
        };
        for revision in 1..=2 {
            client
                .delete_object(&format!(
                    "{ROOT}/orders/{order}/revisions/{revision:020}/manifest.json"
                ))
                .await?;
        }
        client
            .delete_object(&format!("{ROOT}/backups/{backup}/manifest.json"))
            .await?;
        for blob in blobs {
            client
                .delete_object(&format!("{ROOT}/blobs/{blob}"))
                .await?;
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
