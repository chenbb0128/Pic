use std::path::Path;

use crate::{cloud, qiniu_settings, store, workflow_db, workflow_qiniu::Qiniu};

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

    pub(crate) fn uses_order_directory(&self) -> bool {
        match self {
            Self::Nas(config, _) => config.provider == cloud::Provider::Minio,
            Self::Qiniu(_) => true,
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

    pub(crate) async fn put_image(
        &self,
        kind: &str,
        name: &str,
        bytes: Vec<u8>,
    ) -> Result<(), String> {
        match self {
            Self::Nas(_, client) => {
                let key = image_key(kind, name);
                client.put_object(&key, bytes).await
            }
            Self::Qiniu(client) => client.put_image(kind, name, bytes).await,
        }
    }

    pub(crate) async fn get_image(
        &self,
        kind: &str,
        name: &str,
    ) -> Result<Option<Vec<u8>>, String> {
        match self {
            Self::Nas(_, client) => client.get_object(&image_key(kind, name)).await,
            Self::Qiniu(client) => client.get_image(kind, name).await,
        }
    }
}

fn image_key(kind: &str, reference: &str) -> String {
    match reference.split_once('/') {
        Some((order, name)) => format!("materials/{order}/{kind}/{name}"),
        None => format!("materials/{kind}/{reference}"),
    }
}

fn display(error: impl std::fmt::Display) -> String {
    error.to_string()
}
