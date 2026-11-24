use std::path::Path;

use crate::{cloud, qiniu_settings, store, workflow_db, workflow_qiniu::Qiniu};

const STORAGE_SETTING: &str = "shared-storage";

pub(crate) enum StorageSelection {
    Nas,
    Qiniu,
}

impl StorageSelection {
    pub(crate) fn save(self, store: &store::Store) -> Result<(), String> {
        let value = match self {
            Self::Nas => "nas",
            Self::Qiniu => "qiniu",
        };
        workflow_db::put_setting(store, STORAGE_SETTING, value).map_err(display)
    }
}

pub(crate) enum Configuration {
    Nas(cloud::CloudConfig),
    Qiniu(qiniu_settings::Settings),
}

impl Configuration {
    pub(crate) fn load(store: &store::Store, root: &Path) -> Result<Option<Self>, String> {
        match workflow_db::setting(store, STORAGE_SETTING).map_err(display)?.as_deref() {
            Some("qiniu") => qiniu_settings::load(store).map(|(settings, _)| Some(Self::Qiniu(settings))),
            Some("nas") => Ok(Some(Self::Nas(cloud::load_config(root)))),
            None => {
                // Preserve the previous choice and reuse complete profiles saved before this setting.
                let (qiniu, _) = qiniu_settings::load(store)?;
                if qiniu.enabled || (qiniu.has_token && !cloud::config_path(root).is_file()) {
                    return Ok(Some(Self::Qiniu(qiniu)));
                }
                let nas = cloud::load_config(root);
                if nas.enabled || nas.client().is_ok() {
                    return Ok(Some(Self::Nas(nas)));
                }
                Ok(qiniu.has_token.then_some(Self::Qiniu(qiniu)))
            }
            Some(_) => Err("共享存储选择无效，请在设置中重新保存配置。".into()),
        }
    }

    pub(crate) fn provider(&self) -> &'static str {
        match self {
            Self::Nas(config) => match config.provider {
                cloud::Provider::Minio => "minio",
                cloud::Provider::Webdav => "webdav",
                cloud::Provider::Smb => "smb",
            },
            Self::Qiniu(_) => "qiniu",
        }
    }

    pub(crate) fn target(&self) -> Option<String> {
        match self {
            Self::Nas(config) => Some(config.target()),
            Self::Qiniu(settings) => Qiniu::configured_target(settings),
        }
    }
}

fn connection_error(service: &str, error: &str) -> String {
    format!("请确保共享存储（{service}）可连接并可用。{error}")
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
        Ok(Configuration::load(store, root)?.and_then(|configuration| configuration.target()))
    }

    pub(crate) fn current(store: &store::Store, root: &Path) -> Result<Option<Self>, String> {
        match Configuration::load(store, root)? {
            Some(Configuration::Qiniu(_)) => Qiniu::new(store)
                .map(Self::Qiniu)
                .map(Some)
                .map_err(|error| connection_error("七牛 Kodo", &error)),
            Some(Configuration::Nas(config)) => {
                let backend = Self::nas(config)?;
                backend.remember(store)?;
                Ok(Some(backend))
            }
            None => Ok(None),
        }
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
        let client = config.client().map_err(|error| connection_error(config.provider.label(), &error))?;
        Ok(Self::Nas(config, client))
    }

    pub(crate) async fn check_connection(&self) -> Result<(), String> {
        let service = match self {
            Self::Nas(config, _) => config.provider.label(),
            Self::Qiniu(_) => "七牛 Kodo",
        };
        let probe = async {
            match self {
                Self::Nas(_, client) => client.test().await.map(|_| ()),
                Self::Qiniu(client) => client.check_connection().await,
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(15), probe)
            .await
            .map_err(|_| connection_error(service, "连接检测超时。"))?
            .map_err(|error| connection_error(service, &error))
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

    pub(crate) async fn put_template_image(
        &self,
        id: &str,
        name: &str,
        bytes: Vec<u8>,
    ) -> Result<(), String> {
        let key = template_image_key(id, name)?;
        match self {
            Self::Nas(_, client) => client.put_object(&key, bytes).await,
            Self::Qiniu(client) => client.put_template_image(id, name, bytes).await,
        }
    }

    pub(crate) async fn get_template_image(
        &self,
        id: &str,
        name: &str,
    ) -> Result<Option<Vec<u8>>, String> {
        let key = template_image_key(id, name)?;
        match self {
            Self::Nas(_, client) => client.get_object(&key).await,
            Self::Qiniu(client) => client.get_template_image(id, name).await,
        }
    }
}

fn template_image_key(id: &str, name: &str) -> Result<String, String> {
    if id.len() != 32
        || !id.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !matches!(name, "background.png" | "preview.webp")
    {
        return Err("模板图片路径无效。".into());
    }
    Ok(format!("templates/{id}/{name}"))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::qiniu_transport::tests::{local_server, receive, reply};

    fn minio_config(endpoint: String) -> cloud::CloudConfig {
        cloud::CloudConfig {
            endpoint,
            bucket: "fixture".into(),
            access_key: "fixture".into(),
            secret_key: "fixture".into(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn saved_selection_overrides_legacy_switches() {
        let dir = tempfile::tempdir().unwrap();
        let store = store::Store::open(dir.path()).unwrap();
        let config = minio_config("http://127.0.0.1:9000".into());
        cloud::Sync::new().save(dir.path(), &config).await.unwrap();
        let load = || Configuration::load(&store, dir.path()).unwrap().unwrap();
        assert_eq!(load().provider(), "minio");

        let qiniu = qiniu_settings::Settings {
            enabled: true,
            workspace_id: Some("fixture".into()),
            ..Default::default()
        };
        store.write_qiniu_settings(&serde_json::to_string(&qiniu).unwrap(), &[]).unwrap();
        assert_eq!(load().provider(), "qiniu");
        StorageSelection::Nas.save(&store).unwrap();
        assert_eq!(load().provider(), "minio");
        StorageSelection::Qiniu.save(&store).unwrap();
        assert_eq!(load().provider(), "qiniu");
    }

    #[tokio::test]
    async fn minio_probe_reports_permission_errors_without_writing_an_object() {
        let (listener, endpoint) = local_server();
        let server = std::thread::spawn(move || {
            let (socket, _) = receive(&listener, "GET /fixture/?list-type=2&max-keys=1");
            reply(socket, 403, &[], b"<Error><Code>AccessDenied</Code></Error>");
        });
        let backend = Backend::nas(minio_config(endpoint)).unwrap();
        let error = backend.check_connection().await.unwrap_err();
        assert!(error.contains("共享存储（MinIO）可连接并可用"), "{error}");
        assert!(error.contains("403"), "{error}");
        server.join().unwrap();
    }

    #[tokio::test]
    async fn template_images_use_the_templates_directory() {
        let (listener, endpoint) = local_server();
        let id = "aabbccddeeff00112233aabbccddeeff";
        let server = std::thread::spawn(move || {
            let path = format!("/fixture/templates/{id}/background.png");
            let (socket, request) = receive(&listener, &format!("PUT {path}"));
            assert_eq!(request.body, b"image");
            reply(socket, 200, &[], b"");
            let (socket, _) = receive(&listener, &format!("GET {path}"));
            reply(socket, 200, &[], b"image");
        });

        let backend = Backend::nas(minio_config(endpoint)).unwrap();
        assert!(backend
            .get_template_image("../orders", "background.png")
            .await
            .is_err());
        assert!(backend
            .get_template_image(id, "manifest.json")
            .await
            .is_err());
        backend
            .put_template_image(id, "background.png", b"image".to_vec())
            .await
            .unwrap();
        assert_eq!(
            backend
                .get_template_image(id, "background.png")
                .await
                .unwrap(),
            Some(b"image".to_vec()),
        );
        server.join().unwrap();
    }
}
