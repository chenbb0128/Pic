use crate::{
    qiniu_settings,
    qiniu_transport::{checked_url, Client},
    store::Store,
};
use qiniu_etag::{EtagV1, FixedOutput, Update};
use reqwest::{
    multipart::{Form, Part},
    Method,
};
use serde::{de::DeserializeOwned, Deserialize};
use sha2::{Digest, Sha256};

pub(crate) struct Qiniu {
    api: Client,
    target: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ticket {
    completed: bool,
    key: String,
    token: String,
    upload_url: String,
}

#[derive(Deserialize)]
struct Signed {
    url: String,
    sha256: String,
    bytes: usize,
}

const API: &str = "workflow-v2";
const NETWORK: &str = "连接七牛工作流失败";
const MANIFEST_LIMIT: usize = 4 << 20;

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

impl Qiniu {
    pub(crate) fn new(store: &Store) -> Result<Self, String> {
        let (settings, secret) = qiniu_settings::load(store)?;
        Ok(Self {
            api: qiniu_settings::client(&settings, &secret)?,
            target: Self::configured_target(&settings).ok_or("请先接入七牛工作空间")?,
        })
    }

    pub(crate) fn configured_target(settings: &qiniu_settings::Settings) -> Option<String> {
        let workspace = settings.workspace_id.as_deref()?;
        Some(format!(
            "qiniu:{}#{workspace}",
            settings.api_url.trim_end_matches('/')
        ))
    }

    pub(crate) fn target(&self) -> String {
        self.target.clone()
    }

    fn request(&self, method: Method, path: &[&str]) -> Result<reqwest::RequestBuilder, String> {
        self.api.api(method, path).map_err(|e| e.to_string())
    }

    async fn json<T: DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T, String> {
        self.api
            .api_json(request, NETWORK)
            .await
            .map_err(|e| e.to_string())
    }

    pub(crate) async fn test(&self) -> Result<(), String> {
        let _: Vec<String> = self
            .json(self.request(Method::GET, &[API, "orders"])?)
            .await?;
        Ok(())
    }

    pub(crate) async fn put_blob(&self, key: &str, bytes: Vec<u8>) -> Result<(), String> {
        if bytes.is_empty() || digest(&bytes) != key {
            return Err("文件内容与 SHA-256 不匹配".into());
        }
        let mut etag = EtagV1::new();
        Update::update(&mut etag, &bytes);
        let metadata = serde_json::json!({"bytes":bytes.len(),"etag":String::from_utf8_lossy(&etag.finalize_fixed())});
        let ticket: Ticket = self
            .json(
                self.request(Method::POST, &[API, "blobs", key])?
                    .json(&metadata),
            )
            .await?;
        if ticket.completed {
            return Ok(());
        }
        let endpoint =
            checked_url(&ticket.upload_url, "七牛上传地址无效").map_err(|e| e.to_string())?;
        let file = Part::bytes(bytes)
            .file_name(key.to_string())
            .mime_str("application/octet-stream")
            .map_err(|_| "文件类型无效")?;
        let form = Form::new()
            .text("token", ticket.token)
            .text("key", ticket.key)
            .part("file", file);
        let response = self
            .api
            .http
            .post(endpoint)
            .multipart(form)
            .send()
            .await
            .map_err(|_| "七牛文件上传中断，请重试")?;
        // Concurrent writers and retries can both observe an already uploaded object (614).
        if !response.status().is_success() && response.status().as_u16() != 614 {
            return Err(format!(
                "七牛文件上传失败（HTTP {}）",
                response.status().as_u16()
            ));
        }
        let verified: bool = self
            .json(
                self.request(Method::POST, &[API, "blobs", key, "verify"])?
                    .json(&metadata),
            )
            .await?;
        if !verified {
            return Err("七牛文件校验失败".into());
        }
        Ok(())
    }

    async fn read(&self, collection: &str, id: &str) -> Result<Option<Vec<u8>>, String> {
        let req = self.request(Method::GET, &[API, collection, id])?;
        let signed: Signed = match self.api.api_json(req, NETWORK).await {
            Ok(value) => value,
            Err(e) if e.status() == Some(404) => return Ok(None),
            Err(e) => return Err(e.to_string()),
        };
        if (collection == "blobs" && signed.sha256 != id)
            || (collection != "blobs" && signed.bytes > MANIFEST_LIMIT)
        {
            return Err("七牛目录中的文件描述无效".into());
        }
        let url = checked_url(&signed.url, "七牛下载地址无效").map_err(|e| e.to_string())?;
        let mut response = self
            .api
            .http
            .get(url)
            .send()
            .await
            .map_err(|_| "七牛文件下载中断")?;
        if !response.status().is_success() {
            return Err(format!(
                "七牛文件下载失败（HTTP {}）",
                response.status().as_u16()
            ));
        }
        let mut data = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "七牛文件下载中断")? {
            if chunk.len() > signed.bytes.saturating_sub(data.len()) {
                return Err("七牛下载文件大小不匹配".into());
            }
            data.extend_from_slice(&chunk);
        }
        if data.len() != signed.bytes || digest(&data) != signed.sha256 {
            return Err("七牛下载文件完整性校验失败".into());
        }
        Ok(Some(data))
    }

    pub(crate) async fn get_blob(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        self.read("blobs", key).await
    }
    pub(crate) async fn latest(&self, order_key: &str) -> Result<Option<Vec<u8>>, String> {
        self.read("orders", order_key).await
    }
    pub(crate) async fn get_backup(&self, id: &str) -> Result<Option<Vec<u8>>, String> {
        self.read("backups", id).await
    }

    async fn list(&self, collection: &str) -> Result<Vec<String>, String> {
        let mut ids = Vec::<String>::new();
        loop {
            let after = ids.last().map(String::as_str).unwrap_or_default();
            let page: Vec<String> = self
                .json(
                    self.request(Method::GET, &[API, collection])?
                        .query(&[("after", after)]),
                )
                .await?;
            if page.first().is_some_and(|first| first.as_str() <= after)
                || page.windows(2).any(|pair| pair[0] >= pair[1])
            {
                return Err("七牛目录分页顺序无效".into());
            }
            let done = page.len() < 100;
            ids.extend(page);
            if done {
                return Ok(ids);
            }
        }
    }

    pub(crate) async fn list_orders(&self) -> Result<Vec<String>, String> {
        self.list("orders").await
    }
    pub(crate) async fn list_backups(&self) -> Result<Vec<String>, String> {
        self.list("backups").await
    }

    async fn publish(
        &self,
        collection: &str,
        id: &str,
        expected: u64,
        manifest: Vec<u8>,
    ) -> Result<bool, String> {
        if manifest.len() > MANIFEST_LIMIT {
            return Err("清单超过七牛目录允许的 4 MiB".into());
        }
        self.put_blob(&digest(&manifest), manifest.clone()).await?;
        self.json(
            self.request(Method::PUT, &[API, collection, id])?
                .query(&[("expected", expected)])
                .header("Content-Type", "application/json")
                .body(manifest),
        )
        .await
    }

    pub(crate) async fn commit(
        &self,
        order_key: &str,
        expected: u64,
        operation: &str,
        manifest: Vec<u8>,
    ) -> Result<bool, String> {
        let parsed: serde_json::Value =
            serde_json::from_slice(&manifest).map_err(|_| "七牛订单清单无效")?;
        if parsed["operationId"].as_str() != Some(operation) {
            return Err("七牛清单操作编号不一致".into());
        }
        self.publish("orders", order_key, expected, manifest).await
    }

    pub(crate) async fn backup(&self, id: &str, manifest: Vec<u8>) -> Result<(), String> {
        if self.publish("backups", id, 0, manifest).await? {
            Ok(())
        } else {
            Err("七牛备份编号已存在".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::qiniu_transport::tests::{local_server, receive, reply};
    use std::thread;

    #[tokio::test]
    async fn verified_duplicate_upload_and_corrupt_download() {
        let (listener, origin) = local_server();
        let bytes = b"etag";
        let key = digest(bytes);
        let remote = key.clone();
        let endpoint = origin.clone();
        let handle = thread::spawn(move || {
            let prefix = format!("/api/v1/paidan/workflow-v2/blobs/{remote}");
            let (socket, stage) = receive(&listener, &format!("POST {prefix}"));
            assert_eq!(stage.headers["authorization"], "Bearer api-token");
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&stage.body).unwrap(),
                serde_json::json!({"bytes":4,"etag":"FpLiADEaVoALPkdb8tJEJyRTXoe_"})
            );
            reply(socket,200,&[],serde_json::json!({"completed":false,"key":"stage","uploadUrl":format!("{endpoint}/upload"),"token":"object-token"}).to_string().as_bytes());
            let (socket, upload) = receive(&listener, "POST /upload");
            assert!(!upload.headers.contains_key("authorization"));
            reply(socket, 614, &[], b"{}");
            let (socket, verify) = receive(&listener, &format!("POST {prefix}/verify"));
            assert_eq!(verify.body, stage.body);
            reply(socket, 200, &[], b"true");
            let (socket, _) = receive(&listener, &format!("GET {prefix}"));
            reply(
                socket,
                200,
                &[],
                serde_json::json!({"sha256":remote,"bytes":4,"url":format!("{endpoint}/object")})
                    .to_string()
                    .as_bytes(),
            );
            let (socket, download) = receive(&listener, "GET /object");
            assert!(!download.headers.contains_key("authorization"));
            reply(socket, 200, &[], b"oops");
        });
        let store = Qiniu {
            api: Client::new(&origin, "api-token").unwrap(),
            target: String::new(),
        };
        store.put_blob(&key, bytes.to_vec()).await.unwrap();
        assert!(store.get_blob(&key).await.unwrap_err().contains("校验失败"));
        handle.join().unwrap();
    }
}
