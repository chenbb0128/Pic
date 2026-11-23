use crate::{
    qiniu_settings,
    qiniu_transport::{checked_url, Client},
    store::Store,
};
use reqwest::{
    multipart::{Form, Part},
    Method, RequestBuilder,
};
use serde::Deserialize;

pub(crate) struct Qiniu {
    api: Client,
    target: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ticket {
    key: String,
    token: String,
    upload_url: String,
}

#[derive(Deserialize)]
struct ImageLocation {
    url: String,
    bytes: usize,
}

const API: &str = "shared-materials";
const NETWORK: &str = "连接七牛素材接口失败";

pub(crate) fn image_mime(extension: &str) -> Option<&'static str> {
    Some(match extension {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "tif" => "image/tiff",
        "ico" => "image/vnd.microsoft.icon",
        "avif" => "image/avif",
        _ => return None,
    })
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

    pub(crate) async fn check_connection(&self) -> Result<(), String> {
        // The gateway stats the object in Kodo before returning a missing-object response.
        let reference = format!("{}.png", crate::store::random_hex_pub(16));
        self.location("original", &reference).await.map(|_| ())
    }

    fn image_request(
        &self,
        method: Method,
        kind: &str,
        reference: &str,
    ) -> Result<RequestBuilder, String> {
        let request = match reference.split_once('/') {
            Some((order, name)) => self.api.api(method, &[API, order, kind, name]),
            None => self.api.api(method, &[API, kind, reference]),
        };
        request.map_err(|e| e.to_string())
    }

    pub(crate) async fn put_image(
        &self,
        kind: &str,
        reference: &str,
        bytes: Vec<u8>,
    ) -> Result<(), String> {
        let size = bytes.len();
        let name = reference
            .split_once('/')
            .map_or(reference, |(_, name)| name);
        let mime = name
            .rsplit_once('.')
            .and_then(|(_, ext)| image_mime(ext))
            .ok_or("七牛素材文件类型无效。")?;
        let request = self.image_request(Method::POST, kind, reference)?;
        let ticket: Ticket = self
            .api
            .api_json(request.json(&serde_json::json!({"bytes": size})), NETWORK)
            .await
            .map_err(|e| e.to_string())?;
        let endpoint =
            checked_url(&ticket.upload_url, "七牛上传地址无效").map_err(|e| e.to_string())?;
        let file = Part::bytes(bytes)
            .file_name(name.to_owned())
            .mime_str(mime)
            .map_err(|e| e.to_string())?;
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
        if !response.status().is_success() && response.status().as_u16() != 614 {
            return Err(format!("七牛文件上传失败（HTTP {}）", response.status()));
        }
        if self.location(kind, reference).await?.map(|file| file.bytes) != Some(size) {
            return Err("七牛素材上传后大小不一致。".into());
        }
        Ok(())
    }

    async fn location(&self, kind: &str, reference: &str) -> Result<Option<ImageLocation>, String> {
        let request = self.image_request(Method::GET, kind, reference)?;
        match self.api.api_json(request, NETWORK).await {
            Ok(value) => Ok(Some(value)),
            Err(e) if e.status() == Some(404) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub(crate) async fn get_image(
        &self,
        kind: &str,
        name: &str,
    ) -> Result<Option<Vec<u8>>, String> {
        let Some(file) = self.location(kind, name).await? else {
            return Ok(None);
        };
        let url = checked_url(&file.url, "七牛下载地址无效").map_err(|e| e.to_string())?;
        let mut response = self
            .api
            .http
            .get(url)
            .send()
            .await
            .map_err(|_| "七牛文件下载中断")?;
        if !response.status().is_success() {
            return Err(format!("七牛文件下载失败（HTTP {}）", response.status()));
        }
        if file.bytes == 0 || file.bytes > crate::workflow::MAX_ASSET_BYTES as usize {
            return Err("七牛素材文件大小超限。".into());
        }
        let mut data = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "七牛文件下载中断")? {
            if chunk.len() > file.bytes.saturating_sub(data.len()) {
                return Err("七牛下载文件大小不匹配。".into());
            }
            data.extend_from_slice(&chunk);
        }
        if data.len() != file.bytes {
            return Err("七牛下载文件大小不匹配。".into());
        }
        Ok(Some(data))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::qiniu_transport::tests::{local_server, receive, reply};

    #[tokio::test]
    async fn shared_material_uses_an_image_ticket_and_rejects_short_downloads() {
        let (listener, origin) = local_server();
        let endpoint = origin.clone();
        let name = "12345678901234567890123456789012.png";
        let reference = format!("001234/{name}");
        let server = std::thread::spawn(move || {
            let path = format!("/api/v1/paidan/shared-materials/001234/original/{name}");
            let (socket, request) = receive(&listener, &format!("POST {path}"));
            assert_eq!(request.headers["authorization"], "Bearer fixture-token");
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&request.body).unwrap(),
                serde_json::json!({"bytes": 4}),
            );
            let ticket = serde_json::json!({
                "key": name, "uploadUrl": format!("{endpoint}/upload"), "token": "upload-token",
            });
            reply(socket, 200, &[], ticket.to_string().as_bytes());
            let (socket, upload) = receive(&listener, "POST /upload");
            assert!(!upload.headers.contains_key("authorization"));
            assert!(upload.body.windows(9).any(|part| part == b"image/png"));
            reply(socket, 614, &[], b"{}");
            for _ in 0..2 {
                let (socket, _) = receive(&listener, &format!("GET {path}"));
                let location = serde_json::json!({"bytes": 4, "url": format!("{endpoint}/image")});
                reply(socket, 200, &[], location.to_string().as_bytes());
            }
            let (socket, download) = receive(&listener, "GET /image");
            assert!(!download.headers.contains_key("authorization"));
            reply(socket, 200, &[], b"bad");
            let legacy = format!("GET /api/v1/paidan/shared-materials/original/{name}");
            let (socket, _) = receive(&listener, &legacy);
            reply(socket, 404, &[], b"{}");
        });
        let client = Qiniu {
            api: Client::new(&origin, "fixture-token").unwrap(),
            target: String::new(),
        };
        client
            .put_image("original", &reference, b"data".to_vec())
            .await
            .unwrap();
        assert!(client
            .get_image("original", &reference)
            .await
            .unwrap_err()
            .contains("大小"));
        assert!(client.get_image("original", name).await.unwrap().is_none());
        server.join().unwrap();
    }
}
