//! MinIO、WebDAV 和 SMB 共用的订单素材同步。
//!
//! 对象布局（bucket 内）：
//!   orders/<订单号>/<图片ID>.<ext>   图片字节
//!   orders/<订单号>/manifest.json    订单清单（提交点：图片先传、清单后传）
//! 按存储目标比较 manifest 指纹；同一图片 ID 可重复导入。
//!
//! S3 签名：手写 SigV4（service=s3，path-style），兼容 MinIO 自定义端点。

use std::io::Write;
use std::path::{Path, PathBuf};

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

use crate::network_drivers::{SmbClient, SmbConfig, WebDavClient, WebDavConfig};
use crate::store::{valid_layout_number, CloudImageMeta, FileSyncImport, PendingFileUpload, Store};

/* ---------- 配置（数据根/cloud.json） ---------- */

#[derive(Clone, Copy, Default, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    #[default]
    Minio,
    Webdav,
    Smb,
}

impl Provider {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Minio => "MinIO",
            Self::Webdav => "WebDAV",
            Self::Smb => "SMB",
        }
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CloudConfig {
    pub provider: Provider,
    pub enabled: bool,
    pub endpoint: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
    pub region: String,
    /// 轮询间隔秒（最小 10）
    pub poll_seconds: u64,
    pub(crate) webdav: WebDavConfig,
    pub(crate) smb: SmbConfig,
}

impl Default for CloudConfig {
    fn default() -> Self {
        Self {
            provider: Provider::Minio,
            enabled: false,
            endpoint: String::new(),
            bucket: String::new(),
            access_key: String::new(),
            secret_key: String::new(),
            region: "us-east-1".into(),
            poll_seconds: 30,
            webdav: WebDavConfig::default(),
            smb: SmbConfig::default(),
        }
    }
}

impl CloudConfig {
    pub(crate) fn target(&self) -> String {
        let location = match self.provider {
            Provider::Minio => serde_json::json!(["minio", self.endpoint.trim_end_matches('/'), self.bucket]),
            Provider::Webdav => serde_json::json!(["webdav", self.webdav.endpoint.trim_end_matches('/'), self.webdav.root.trim_matches('/')]),
            Provider::Smb => serde_json::json!(["smb", self.smb.host.to_ascii_lowercase(), self.smb.share.to_ascii_lowercase(), self.smb.root.replace('\\', "/").trim_matches('/').to_ascii_lowercase()]),
        };
        hex(&Sha256::digest(location.to_string()))
    }

    pub(crate) fn client(&self) -> Result<FileStorage, String> {
        match self.provider {
            Provider::Minio => {
                let endpoint = reqwest::Url::parse(&self.endpoint).ok();
                if !endpoint.is_some_and(|url| {
                    matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
                        && url.username().is_empty() && url.password().is_none()
                        && url.query().is_none() && url.fragment().is_none()
                }) || !safe_component(&self.bucket) || self.access_key.is_empty() || self.secret_key.is_empty() {
                    return Err("请填写完整的 MinIO 端点、Bucket 与访问密钥。".into());
                }
                Ok(FileStorage::Minio(S3Client::new(self)))
            }
            Provider::Webdav => WebDavClient::new(&self.webdav).map(FileStorage::Webdav),
            Provider::Smb => SmbClient::new(&self.smb).map(FileStorage::Smb),
        }
    }

    pub(crate) async fn test(&self) -> Result<String, String> {
        self.client()?.test().await
    }
}

pub fn config_path(data_root: &Path) -> PathBuf {
    data_root.join("cloud.json")
}

pub fn load_config(data_root: &Path) -> CloudConfig {
    match std::fs::read_to_string(config_path(data_root)) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => CloudConfig::default(),
    }
}

fn save_config(data_root: &Path, config: &CloudConfig) -> Result<(), String> {
    if config.enabled {
        config.client()?;
    }
    let mut file = tempfile::NamedTempFile::new_in(data_root).map_err(display_error)?;
    serde_json::to_writer_pretty(&mut file, config).map_err(display_error)?;
    file.flush().map_err(display_error)?;
    file.as_file().sync_all().map_err(display_error)?;
    file.persist(config_path(data_root)).map_err(display_error)?;
    Ok(())
}

/* ---------- manifest.json ---------- */

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestImage {
    pub id: String,
    pub file_name: String,
    pub original_name: String,
    pub byte_length: i64,
    pub width: i64,
    pub height: i64,
    pub source: String,
    pub templates: Vec<ManifestTemplate>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestTemplate {
    pub template_id: String,
    pub quantity: i64,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub order_number: String,
    pub updated_at: String,
    pub images: Vec<ManifestImage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout_number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout_number_captured_at: Option<String>,
}

/* ---------- S3 客户端（SigV4，path-style） ---------- */

pub struct S3Client {
    http: reqwest::Client,
    endpoint: String,
    bucket: String,
    access_key: String,
    secret_key: String,
    region: String,
}

const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// AWS URI 编码：保留 A-Za-z0-9-._~；keep_slash 用于规范化 URI 路径。
fn aws_uri_encode(value: &str, keep_slash: bool) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            b'/' if keep_slash => out.push('/'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("hmac key");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl S3Client {
    pub fn new(config: &CloudConfig) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .expect("云同步 HTTP 客户端构建失败"),
            endpoint: config.endpoint.trim_end_matches('/').to_string(),
            bucket: config.bucket.clone(),
            access_key: config.access_key.clone(),
            secret_key: config.secret_key.clone(),
            region: if config.region.is_empty() { "us-east-1".into() } else { config.region.clone() },
        }
    }

    fn base_url(&self) -> String {
        format!("{}/{}", self.endpoint, self.bucket)
    }

    /// SigV4 签名后发送。query 按 (key, value) 传，由本函数排序编码。
    async fn request(
        &self,
        method: reqwest::Method,
        key: &str,
        query: &[(&str, &str)],
        payload_hash: &str,
        body: Option<Vec<u8>>,
        create_only: bool,
    ) -> Result<reqwest::Response, String> {
        let now_utc = chrono::Utc::now();
        let amz_date = now_utc.format("%Y%m%dT%H%M%SZ").to_string();
        let date_stamp = now_utc.format("%Y%m%d").to_string();

        let url = if key.is_empty() {
            format!("{}/", self.base_url())
        } else {
            format!("{}/{}", self.base_url(), aws_uri_encode(key, true))
        };
        let mut url = reqwest::Url::parse(&url)
            .map_err(|error| format!("MinIO 端点无效：{error}"))?;

        // 规范化查询串：键排序 + AWS 编码
        let mut pairs: Vec<_> = query
            .iter()
            .map(|(key, value)| (aws_uri_encode(key, false), aws_uri_encode(value, false)))
            .collect();
        pairs.sort();
        let canonical_query = pairs
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join("&");
        if !canonical_query.is_empty() {
            url.set_query(Some(&canonical_query));
        }

        let host = url.host_str().ok_or("MinIO 端点缺少主机名")?;
        let endpoint_host = match url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_owned(),
        };

        let condition_header = if create_only { "if-none-match:*\n" } else { "" };
        let condition_name = if create_only { "if-none-match;" } else { "" };
        let canonical_headers = format!(
            "host:{endpoint_host}\n{condition_header}x-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n",
        );
        let signed_headers = format!("host;{condition_name}x-amz-content-sha256;x-amz-date");
        let canonical_request = format!(
            "{}\n{}\n{}\n{}\n{}\n{}",
            method.as_str(),
            url.path(),
            canonical_query,
            canonical_headers,
            signed_headers,
            payload_hash
        );

        let scope = format!("{}/{}/s3/aws4_request", date_stamp, self.region);
        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n{}\n{}\n{}",
            amz_date,
            scope,
            hex(Sha256::digest(canonical_request.as_bytes()).as_slice())
        );

        let signing_key = hmac_sha256(
            &hmac_sha256(
                &hmac_sha256(
                    &hmac_sha256(format!("AWS4{}", self.secret_key).as_bytes(), date_stamp.as_bytes()),
                    self.region.as_bytes(),
                ),
                b"s3",
            ),
            b"aws4_request",
        );
        let signature = hex(hmac_sha256(&signing_key, string_to_sign.as_bytes()).as_slice());
        let authorization = format!(
            "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
            self.access_key, scope, signed_headers, signature
        );

        let mut request = self
            .http
            .request(method, url)
            .header("host", &endpoint_host)
            .header("x-amz-content-sha256", payload_hash)
            .header("x-amz-date", &amz_date)
            .header("Authorization", authorization);
        if let Some(bytes) = body {
            request = request.body(bytes);
        }
        if create_only {
            request = request.header(reqwest::header::IF_NONE_MATCH, "*");
        }
        request.send().await.map_err(|error| format!("云服务连接失败：{error}"))
    }

    pub async fn put_object(&self, key: &str, bytes: Vec<u8>) -> Result<(), String> {
        let payload_hash = hex(Sha256::digest(&bytes).as_slice());
        let response = self.request(reqwest::Method::PUT, key, &[], &payload_hash, Some(bytes), false).await?;
        if !response.status().is_success() {
            return Err(format!("上传失败（HTTP {}）：{}", response.status(), response.text().await.unwrap_or_default()));
        }
        Ok(())
    }

    async fn create_object(&self, key: &str, bytes: Vec<u8>) -> Result<bool, String> {
        let payload_hash = hex(&Sha256::digest(&bytes));
        let response = self.request(reqwest::Method::PUT, key, &[], &payload_hash, Some(bytes), true).await?;
        match response.status() {
            status if status.is_success() => Ok(true),
            reqwest::StatusCode::PRECONDITION_FAILED => Ok(false),
            // A conditional-write conflict can also race with a deletion.
            status => Err(format!("创建文件失败（HTTP {status}）：{}", response.text().await.unwrap_or_default())),
        }
    }

    async fn delete_object(&self, key: &str) -> Result<(), String> {
        let response = self.request(reqwest::Method::DELETE, key, &[], EMPTY_SHA256, None, false).await?;
        match response.status() {
            status if status.is_success() => Ok(()),
            reqwest::StatusCode::NOT_FOUND => Ok(()),
            status => Err(format!("删除文件失败（HTTP {status}）")),
        }
    }

    pub async fn get_object(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        let response = self.request(reqwest::Method::GET, key, &[], EMPTY_SHA256, None, false).await?;
        match response.status().as_u16() {
            200 => Ok(Some(response.bytes().await.map_err(|error| format!("下载失败：{error}"))?.to_vec())),
            404 => Ok(None),
            code => Err(format!("下载失败（HTTP {code}）")),
        }
    }

    /// ListObjectsV2 取一层子前缀（delimiter=/）。返回去掉 `prefix` 的子前缀名。
    pub async fn list_prefixes(&self, prefix: &str) -> Result<Vec<String>, String> {
        let mut prefixes = Vec::new();
        let mut seen_tokens = std::collections::HashSet::<String>::new();
        let mut token = None::<String>;
        loop {
            let mut query = vec![("delimiter", "/"), ("list-type", "2"), ("max-keys", "1000"), ("prefix", prefix)];
            if let Some(token) = token.as_deref() {
                query.push(("continuation-token", token));
            }
            let page = self.list_page(&query).await?;
            prefixes.extend(page.common_prefixes.into_iter().filter_map(|entry| {
                let name = entry.prefix.strip_prefix(prefix)?.trim_end_matches('/');
                (!name.is_empty()).then(|| name.to_owned())
            }));
            if !page.is_truncated {
                return Ok(prefixes);
            }
            token = page.next_continuation_token
                .filter(|next| !next.is_empty() && seen_tokens.insert(next.clone()));
            if token.is_none() {
                return Err("MinIO 返回了无效的目录分页标记。".into());
            }
        }
    }

    pub async fn test(&self) -> Result<String, String> {
        self.list_page(&[("list-type", "2"), ("max-keys", "1")]).await?;
        Ok(format!("连接正常（bucket={}）", self.bucket))
    }

    async fn list_page(&self, query: &[(&str, &str)]) -> Result<S3PrefixPage, String> {
        let response = self.request(reqwest::Method::GET, "", query, EMPTY_SHA256, None, false).await?;
        if !response.status().is_success() {
            return Err(format!("列举失败（HTTP {}）：{}", response.status(), response.text().await.unwrap_or_default()));
        }
        let text = response.text().await.map_err(|error| format!("列举响应读取失败：{error}"))?;
        quick_xml::de::from_str(&text).map_err(|error| format!("MinIO 目录列表无效：{error}"))
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "PascalCase")]
struct S3PrefixPage {
    #[serde(default)]
    is_truncated: bool,
    next_continuation_token: Option<String>,
    #[serde(default)]
    common_prefixes: Vec<S3CommonPrefix>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "PascalCase")]
struct S3CommonPrefix {
    prefix: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::qiniu_transport::tests::{local_server, receive, reply};

    #[test]
    fn old_minio_configuration_and_manifest_still_load() {
        let config: CloudConfig = serde_json::from_str(
            r#"{"enabled":true,"endpoint":"http://host:9000","bucket":"vagaga","accessKey":"test","secretKey":"test"}"#,
        ).unwrap();
        assert!(config.provider == Provider::Minio && config.enabled);
        let old: Manifest = serde_json::from_str(
            r#"{"orderNumber":"123","updatedAt":"2026-11-20T00:00:00Z","images":[]}"#,
        ).unwrap();
        assert!(old.layout_number.is_none());
        assert!(!safe_component("../photo.png"));
        assert!(!safe_component(r"C:\photo.png"));
        assert!(!safe_component("NUL.png"));
        assert!(safe_component("image-01.png"));
    }

    #[tokio::test]
    #[ignore = "requires disposable WebDAV or SMB service and VAGAGA_STORAGE_TEST_CONFIG"]
    async fn network_storage_round_trip() {
        let config: CloudConfig = serde_json::from_str(
            &std::env::var("VAGAGA_STORAGE_TEST_CONFIG").expect("missing test fixture config"),
        ).unwrap();
        assert!(config.enabled && config.provider != Provider::Minio);
        config.test().await.unwrap();
        let writer = config.client().unwrap();
        let contender = config.client().unwrap();
        let probe = format!("vagaga/v2/probes/test-{:032x}.json", rand::random::<u128>());
        let (first, second) = tokio::join!(
            writer.create_object(&probe, b"first".to_vec()),
            contender.create_object(&probe, b"second".to_vec()),
        );
        let first = first.unwrap();
        let second = second.unwrap();
        assert_ne!(first, second);
        let expected: &[u8] = if first { b"first" } else { b"second" };
        assert_eq!(writer.get_object(&probe).await.unwrap().as_deref(), Some(expected));
        writer.delete_object(&probe).await.unwrap();
        assert!(contender.get_object(&probe).await.unwrap().is_none());
        let mut denied = config.clone();
        match denied.provider {
            Provider::Webdav => denied.webdav.password.push_str("-denied"),
            Provider::Smb => denied.smb.password.push_str("-denied"),
            Provider::Minio => unreachable!(),
        }
        assert!(denied.test().await.is_err());
        assert_eq!(denied.target(), config.target());

        let sender_root = tempfile::tempdir().unwrap();
        let receiver_root = tempfile::tempdir().unwrap();
        let sync = Sync::new();
        let sender = Store::open(sender_root.path()).unwrap();
        let receiver = Store::open(receiver_root.path()).unwrap();
        let discriminator = rand::random::<u64>();
        let new_order = format!("test-new-{discriminator}");
        let old_order = format!("test-old-{discriminator}");
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(2, 2).write_to(&mut png, image::ImageFormat::Png).unwrap();
        let png = png.into_inner();
        let image = sender.ingest_image(&new_order, &png, "image/png", &[], "test").unwrap();
        let historic_image = sender.ingest_image(&old_order, &png, "image/png", &[], "test").unwrap();
        sender.set_order_metadata(&new_order, r#"{"layoutNumber":"yy-00123","layoutNumberCapturedAt":"2026-11-20T00:00:00Z"}"#).unwrap();

        sync.save(sender_root.path(), &denied).await.unwrap();
        sync.enqueue(&sender, sender_root.path(), &new_order, &image.image_id, true).unwrap();
        assert!(sync.cycle(&sender, sender_root.path()).await.is_err());
        assert_eq!(sender.pending_file_uploads(&config.target()).unwrap().len(), 1);
        sync.save(sender_root.path(), &config).await.unwrap();
        sync.save(receiver_root.path(), &config).await.unwrap();
        sync.update_templates(&sender, sender_root.path(), &historic_image.image_id, &[("fixture".into(), 2)]).unwrap();
        assert_eq!(sync.backfill(&sender, sender_root.path(), true).await.unwrap(), 0);
        sync.cycle(&sender, sender_root.path()).await.unwrap();
        assert!(sender.pending_file_uploads(&config.target()).unwrap().is_empty());
        let notices = sync.cycle(&receiver, receiver_root.path()).await.unwrap();
        assert!(notices.iter().any(|notice| notice.order_number == new_order && notice.new_images == 1));
        assert_eq!(receiver.read_image_bytes(&image.image_id).unwrap(), png);
        let metadata = receiver.order_metadata_by_number(&new_order).unwrap().unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&metadata).unwrap()["layoutNumber"], "yy-00123");
        assert!(receiver.list_orders().unwrap().iter().all(|row| row.order_number != old_order));
        assert!(sync.cycle(&receiver, receiver_root.path()).await.unwrap().is_empty());
        assert_eq!(sync.backfill(&sender, sender_root.path(), false).await.unwrap(), 1);
        let notices = sync.cycle(&receiver, receiver_root.path()).await.unwrap();
        assert!(notices.iter().any(|notice| notice.order_number == old_order && notice.new_images == 1));

        sender.set_order_metadata(&new_order, r#"{"layoutNumber":"x-00064","layoutNumberCapturedAt":"2026-11-21T00:00:00Z"}"#).unwrap();
        sync.enqueue(&sender, sender_root.path(), &new_order, &image.image_id, false).unwrap();
        sync.cycle(&sender, sender_root.path()).await.unwrap();
        let notices = sync.cycle(&receiver, receiver_root.path()).await.unwrap();
        assert!(notices.iter().any(|notice| notice.order_number == new_order && notice.new_images == 0));
        let metadata = receiver.order_metadata_by_number(&new_order).unwrap().unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&metadata).unwrap()["layoutNumber"], "x-00064");
    }

    #[tokio::test]
    async fn minio_create_signs_the_precondition_and_distinguishes_conflicts() {
        let (listener, endpoint) = local_server();
        let server = std::thread::spawn(move || {
            for status in [200, 412, 409] {
                let (socket, request) = receive(&listener, "PUT /vagaga/workflow/event.json");
                assert_eq!(request.headers["if-none-match"], "*");
                let host = &request.headers["host"];
                let date = &request.headers["x-amz-date"];
                let payload_hash = hex(&Sha256::digest(&request.body));
                let signed = "host;if-none-match;x-amz-content-sha256;x-amz-date";
                let canonical = format!(
                    "PUT\n/vagaga/workflow/event.json\n\nhost:{host}\nif-none-match:*\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{date}\n\n{signed}\n{payload_hash}"
                );
                let day = &date[..8];
                let scope = format!("{day}/us-east-1/s3/aws4_request");
                let to_sign = format!(
                    "AWS4-HMAC-SHA256\n{date}\n{scope}\n{}",
                    hex(&Sha256::digest(canonical)),
                );
                let mut key = b"AWS4fixture-secret".to_vec();
                for part in [day, "us-east-1", "s3", "aws4_request"] {
                    key = hmac_sha256(&key, part.as_bytes());
                }
                let signature = hex(&hmac_sha256(&key, to_sign.as_bytes()));
                assert_eq!(
                    request.headers["authorization"],
                    format!("AWS4-HMAC-SHA256 Credential=fixture/{scope}, SignedHeaders={signed}, Signature={signature}")
                );
                reply(socket, status, &[], b"");
            }
        });
        let client = S3Client::new(&CloudConfig {
            endpoint,
            bucket: "vagaga".into(),
            access_key: "fixture".into(),
            secret_key: "fixture-secret".into(),
            ..CloudConfig::default()
        });
        let key = "workflow/event.json";
        assert!(client.create_object(key, b"first".to_vec()).await.unwrap());
        assert!(!client.create_object(key, b"second".to_vec()).await.unwrap());
        assert!(client.create_object(key, b"third".to_vec()).await.is_err());
        server.join().unwrap();
    }

    #[tokio::test]
    async fn minio_lists_all_workflow_prefix_pages() {
        let (listener, endpoint) = local_server();
        let server = std::thread::spawn(move || {
            let query = "delimiter=%2F&list-type=2&max-keys=1000&prefix=vagaga%2Fv2%2Fbackups%2F";
            let (socket, _) = receive(&listener, &format!("GET /vagaga/?{query}"));
            reply(socket, 200, &[], b"<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>test&amp;next</NextContinuationToken><CommonPrefixes><Prefix>vagaga/v2/backups/a/</Prefix></CommonPrefixes></ListBucketResult>");
            let (socket, _) = receive(&listener, &format!("GET /vagaga/?continuation-token=test%26next&{query}"));
            reply(socket, 200, &[], b"<ListBucketResult><IsTruncated>false</IsTruncated><CommonPrefixes><Prefix>vagaga/v2/backups/b/</Prefix></CommonPrefixes></ListBucketResult>");
        });
        let client = S3Client::new(&CloudConfig {
            endpoint,
            bucket: "vagaga".into(),
            access_key: "fixture".into(),
            secret_key: "fixture-secret".into(),
            ..CloudConfig::default()
        });
        assert_eq!(client.list_prefixes("vagaga/v2/backups/").await.unwrap(), ["a", "b"]);
        server.join().unwrap();
    }

    #[tokio::test]
    async fn list_objects_sends_and_signs_the_bucket_path_and_query() {
        let (listener, endpoint) = local_server();
        let server = std::thread::spawn(move || {
            let query = "delimiter=%2F&list-type=2&max-keys=1000&prefix=orders%2F";
            let (socket, request) = receive(&listener, &format!("GET /vagaga/?{query}"));
            let host = &request.headers["host"];
            let date = &request.headers["x-amz-date"];
            let day = &date[..8];
            let signed_headers = "host;x-amz-content-sha256;x-amz-date";
            let canonical = format!(
                "GET\n/vagaga/\n{query}\nhost:{host}\nx-amz-content-sha256:{EMPTY_SHA256}\nx-amz-date:{date}\n\n{signed_headers}\n{EMPTY_SHA256}"
            );
            let scope = format!("{day}/us-east-1/s3/aws4_request");
            let to_sign = format!(
                "AWS4-HMAC-SHA256\n{date}\n{scope}\n{}",
                hex(&Sha256::digest(canonical)),
            );
            let mut key = b"AWS4fixture-secret".to_vec();
            for part in [day, "us-east-1", "s3", "aws4_request"] {
                key = hmac_sha256(&key, part.as_bytes());
            }
            let signature = hex(&hmac_sha256(&key, to_sign.as_bytes()));
            assert_eq!(
                request.headers["authorization"],
                format!("AWS4-HMAC-SHA256 Credential=fixture/{scope}, SignedHeaders={signed_headers}, Signature={signature}")
            );
            reply(socket, 200, &[], b"<ListBucketResult><CommonPrefixes><Prefix>orders/123/</Prefix></CommonPrefixes></ListBucketResult>");
        });
        let client = S3Client::new(&CloudConfig {
            endpoint,
            bucket: "vagaga".into(),
            access_key: "fixture".into(),
            secret_key: "fixture-secret".into(),
            ..CloudConfig::default()
        });
        let result = client.list_prefixes("orders/").await;
        server.join().unwrap();
        assert_eq!(result.unwrap(), ["123"]);
    }
}

/* ---------- 同步编排 ---------- */

pub(crate) enum FileStorage {
    Minio(S3Client),
    Webdav(WebDavClient),
    Smb(SmbClient),
}

impl FileStorage {
    pub(crate) async fn test(&self) -> Result<String, String> {
        match self {
            Self::Minio(client) => client.test().await,
            Self::Webdav(client) => client.test().await,
            Self::Smb(client) => client.test().await,
        }
    }

    pub(crate) async fn put_object(&self, key: &str, bytes: Vec<u8>) -> Result<(), String> {
        match self {
            Self::Minio(client) => client.put_object(key, bytes).await,
            Self::Webdav(client) => client.put_object(key, bytes).await,
            Self::Smb(client) => client.put_object(key, bytes).await,
        }
    }

    pub(crate) async fn create_object(&self, key: &str, bytes: Vec<u8>) -> Result<bool, String> {
        match self {
            Self::Minio(client) => client.create_object(key, bytes).await,
            Self::Webdav(client) => client.create_object(key, bytes).await,
            Self::Smb(client) => client.create_object(key, bytes).await,
        }
    }

    pub(crate) async fn delete_object(&self, key: &str) -> Result<(), String> {
        match self {
            Self::Minio(client) => client.delete_object(key).await,
            Self::Webdav(client) => client.delete_object(key).await,
            Self::Smb(client) => client.delete_object(key).await,
        }
    }

    pub(crate) async fn get_object(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        match self {
            Self::Minio(client) => client.get_object(key).await,
            Self::Webdav(client) => client.get_object(key).await,
            Self::Smb(client) => client.get_object(key).await,
        }
    }

    /// Lists immediate child directory names relative to `prefix`.
    pub(crate) async fn list_prefixes(&self, prefix: &str) -> Result<Vec<String>, String> {
        match self {
            Self::Minio(client) => client.list_prefixes(prefix).await,
            Self::Webdav(client) => client.list_prefixes(prefix).await,
            Self::Smb(client) => client.list_prefixes(prefix).await,
        }
    }
}

pub(crate) struct Sync {
    operations: tokio::sync::Mutex<()>,
    pub wake: tokio::sync::Notify,
}

impl Sync {
    pub(crate) fn new() -> Self {
        Self { operations: tokio::sync::Mutex::new(()), wake: tokio::sync::Notify::new() }
    }

    pub(crate) async fn save(&self, root: &Path, config: &CloudConfig) -> Result<(), String> {
        let _operation = self.operations.lock().await;
        save_config(root, config)?;
        self.wake.notify_one();
        Ok(())
    }

    pub(crate) fn enqueue(
        &self,
        store: &Store,
        root: &Path,
        order_number: &str,
        image_id: &str,
        newly_captured: bool,
    ) -> Result<(), String> {
        let config = load_config(root);
        if config.enabled {
            let may_add = newly_captured || config.provider == Provider::Minio;
            store.enqueue_file_upload(&config.target(), order_number, image_id, may_add).map_err(display_error)?;
            self.wake.notify_one();
        }
        Ok(())
    }

    pub(crate) fn update_templates(
        &self, store: &Store, root: &Path, image_id: &str, templates: &[(String, i64)],
    ) -> Result<String, String> {
        let config = load_config(root);
        let upload = config.enabled.then(|| (config.target(), config.provider == Provider::Minio));
        let order = store.set_image_templates_and_queue(
            image_id, templates, upload.as_ref().map(|(target, may_add)| (target.as_str(), *may_add)),
        ).map_err(display_error)?;
        if upload.is_some() {
            self.wake.notify_one();
        }
        Ok(order)
    }

    pub(crate) async fn cycle(&self, store: &Store, root: &Path) -> Result<Vec<CloudNotice>, String> {
        let _operation = self.operations.lock().await;
        let config = load_config(root);
        if !config.enabled {
            return Ok(Vec::new());
        }
        let client = config.client()?;
        let target = config.target();
        let mut failure = None;
        let mut orders = std::collections::BTreeMap::<String, Vec<PendingFileUpload>>::new();
        for item in store.pending_file_uploads(&target).map_err(display_error)? {
            orders.entry(item.order_number.clone()).or_default().push(item);
        }
        for (order_number, items) in orders {
            let result = push_order(store, &client, &order_number, Some(&items)).await;
            if let Err(error) = result {
                let message = format!("订单 {order_number} 待重试：{error}");
                eprintln!("[cloud] {message}");
                failure.get_or_insert(message);
                continue;
            }
            for item in items {
                store.complete_file_upload(&target, &item).map_err(display_error)?;
            }
        }
        let notices = pull_all(store, &client, &target).await?;
        if notices.is_empty() {
            if let Some(error) = failure {
                return Err(error);
            }
        }
        Ok(notices)
    }

    pub(crate) async fn backfill(
        &self,
        store: &Store,
        root: &Path,
        startup: bool,
    ) -> Result<usize, String> {
        let _operation = self.operations.lock().await;
        let config = load_config(root);
        if startup && (!config.enabled || config.provider != Provider::Minio) {
            return Ok(0);
        }
        if !config.enabled {
            return Err("请先启用对象存储。".into());
        }
        let client = config.client()?;
        client.list_prefixes("").await?;
        backfill_push(store, &client).await
    }
}

fn display_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn safe_component(value: &str) -> bool {
    use std::path::Component;
    let mut components = Path::new(value).components();
    matches!(components.next(), Some(Component::Normal(part)) if part == value)
        && components.next().is_none()
        && !value.ends_with(['.', ' '])
        && !value.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|'])
        && !value.chars().any(char::is_control)
        && !matches!(value.split('.').next().unwrap_or("").to_ascii_uppercase().as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "COM3" | "COM4" | "COM5"
            | "COM6" | "COM7" | "COM8" | "COM9" | "LPT1" | "LPT2" | "LPT3" | "LPT4"
            | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9")
}

fn manifest_key(order_number: &str) -> String {
    format!("orders/{}/manifest.json", order_number)
}

fn image_key(order_number: &str, file_name: &str) -> String {
    format!("orders/{}/{}", order_number, file_name)
}

fn validate_manifest(manifest: &Manifest, order_number: &str) -> Result<(), String> {
    if manifest.order_number != order_number {
        return Err("订单清单与目录中的订单号不一致".into());
    }
    let mut names = std::collections::HashSet::new();
    let mut ids = std::collections::HashSet::new();
    for image in &manifest.images {
        if !safe_component(&image.file_name) || image.file_name.eq_ignore_ascii_case("manifest.json")
            || image.id.is_empty() || image.byte_length <= 0
            || !names.insert(image.file_name.to_ascii_lowercase()) || !ids.insert(&image.id)
        {
            return Err("清单含有无效或重复的素材".into());
        }
    }
    Ok(())
}

fn parse_timestamp(value: &str) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    chrono::DateTime::parse_from_rfc3339(value).ok()
}

fn merge_remote_manifest(new: &mut Manifest, remote: Manifest) {
    let remote_number = remote.layout_number.as_deref().filter(|value| valid_layout_number(value));
    let new_time = new.layout_number_captured_at.as_deref().and_then(parse_timestamp);
    let remote_time = remote.layout_number_captured_at.as_deref().and_then(parse_timestamp);
    if let Some(number) = remote_number {
        if new.layout_number.is_none() || new_time <= remote_time {
            new.layout_number = Some(number.to_owned());
            new.layout_number_captured_at = remote.layout_number_captured_at;
        }
    }
    if parse_timestamp(&new.updated_at) < parse_timestamp(&remote.updated_at) {
        new.updated_at = remote.updated_at;
    }
    let updated: std::collections::HashSet<_> = new.images.iter().map(|image| image.id.clone()).collect();
    new.images.extend(remote.images.into_iter().filter(|image| !updated.contains(&image.id)));
    new.images.sort_by(|left, right| left.id.cmp(&right.id));
}

pub struct CloudNotice {
    pub order_number: String,
    pub new_images: usize,
}

/// 重试时重新读取订单，素材齐全后再发布清单。
async fn push_order(
    store: &Store,
    client: &FileStorage,
    order_number: &str,
    pending: Option<&[PendingFileUpload]>,
) -> Result<bool, String> {
    if !safe_component(order_number) {
        return Err("订单号不能用作存储目录名".into());
    }
    let Some(mut images) = store.cloud_order_images(order_number).map_err(display_error)? else {
        return Ok(false);
    };
    let remote = client.get_object(&manifest_key(order_number)).await?;
    if pending.is_none() && remote.is_some() {
        return Ok(false);
    }
    let remote: Option<Manifest> = remote.as_deref().map(serde_json::from_slice).transpose().map_err(display_error)?;
    if let Some(remote) = &remote {
        validate_manifest(remote, order_number)?;
    }
    if let Some(pending) = pending {
        images.retain(|(image, _)| pending.iter().any(|item| {
            item.image_id == image.id && (item.may_add || remote.as_ref()
                .is_some_and(|manifest| manifest.images.iter().any(|row| row.id == image.id)))
        }));
    }
    if images.is_empty() {
        return Ok(false);
    }
    if remote.as_ref().is_some_and(|published| {
        images.iter().any(|(image, _)| published.images.iter().any(|old| {
            old.id != image.id && old.file_name.eq_ignore_ascii_case(&image.file_name)
        }))
    }) {
        return Err("本地素材与远端清单存在同名文件".into());
    }
    let files: Vec<_> = images.iter().map(|(image, path)| {
        (image.file_name.clone(), image.byte_length, path.clone())
    }).collect();
    let mut manifest = build_manifest(store, order_number, images)?;
    validate_manifest(&manifest, order_number)?;
    for (file_name, length, file_path) in files {
        let bytes = tokio::fs::read(file_path).await
            .map_err(|error| format!("读取素材文件失败：{error}"))?;
        if i64::try_from(bytes.len()).ok() != Some(length) {
            return Err("本地素材长度与记录不一致".into());
        }
        client.put_object(&image_key(order_number, &file_name), bytes).await?;
    }
    if let Some(latest) = client.get_object(&manifest_key(order_number)).await? {
        if pending.is_none() {
            return Ok(false);
        }
        let latest = serde_json::from_slice(&latest).map_err(display_error)?;
        validate_manifest(&latest, order_number)?;
        merge_remote_manifest(&mut manifest, latest);
        validate_manifest(&manifest, order_number)?;
    }
    let manifest_bytes = serde_json::to_vec(&manifest).map_err(display_error)?;
    client.put_object(&manifest_key(order_number), manifest_bytes).await?;
    Ok(true)
}

fn build_manifest(
    store: &Store,
    order_number: &str,
    images: Vec<(CloudImageMeta, PathBuf)>,
) -> Result<Manifest, String> {
    let updated_at = store
        .order_updated_at_by_number(order_number)
        .map_err(|error| error.to_string())?
        .unwrap_or_else(|| chrono::Local::now().to_rfc3339());
    let metadata = store.order_metadata_by_number(order_number).map_err(display_error)?
        .and_then(|metadata| serde_json::from_str::<serde_json::Value>(&metadata).ok());
    let layout_number = metadata.as_ref().and_then(|data| data["layoutNumber"].as_str())
        .filter(|value| valid_layout_number(value)).map(str::to_owned);
    let layout_number_captured_at = layout_number.as_ref().and_then(|_| {
        metadata.as_ref()?.get("layoutNumberCapturedAt")?.as_str().map(str::to_owned)
    });
    Ok(Manifest {
        order_number: order_number.to_string(),
        updated_at,
        layout_number,
        layout_number_captured_at,
        images: images
            .into_iter()
            .map(|(m, _)| ManifestImage {
                id: m.id,
                file_name: m.file_name,
                original_name: m.original_name,
                byte_length: m.byte_length,
                width: m.width,
                height: m.height,
                source: m.source,
                templates: m
                    .templates
                    .into_iter()
                    .map(|t| ManifestTemplate { template_id: t.template_id, quantity: t.quantity })
                    .collect(),
            })
            .collect(),
    })
}

/// 启动回填：云端缺失的订单整体上传；已有 manifest 的订单跳过（增量由入库钩子负责）。
async fn backfill_push(store: &Store, client: &FileStorage) -> Result<usize, String> {
    let orders = store
        .list_orders()
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|o| o.order_number)
        .collect::<Vec<_>>();
    let mut pushed = 0usize;
    let mut failures = Vec::new();
    for order_number in orders {
        if !safe_component(&order_number) {
            continue;
        }
        match push_order(store, client, &order_number, None).await {
            Ok(true) => pushed += 1,
            Ok(false) => {}
            Err(error) => {
                eprintln!("[cloud] 历史订单 {order_number} 补传失败：{error}");
                failures.push((order_number, error));
            }
        }
    }
    if let Some((order, error)) = failures.first() {
        return Err(format!("已补传 {pushed} 个订单，{} 个订单失败。订单 {order}：{error}", failures.len()));
    }
    Ok(pushed)
}

/// Read existing order manifests from the legacy NAS layout.
pub(crate) async fn import_legacy(store: &Store, config: &CloudConfig) -> Result<Vec<CloudNotice>, String> {
    let client = config.client()?;
    pull_all(store, &client, &config.target()).await
}

/// 拉取：列云端订单前缀 → manifest 指纹比对 → 下载缺失图片 → 幂等导入。
async fn pull_all(store: &Store, client: &FileStorage, target: &str) -> Result<Vec<CloudNotice>, String> {
    let order_numbers = client.list_prefixes("orders/").await?;
    let local_hashes = store.file_sync_fingerprints(target).map_err(display_error)?;
    let pending: std::collections::HashSet<_> = store.pending_file_uploads(target).map_err(display_error)?
        .into_iter().map(|item| item.order_number).collect();

    let mut notices = Vec::new();
    let mut failure = None;
    for order_number in order_numbers {
        if !safe_component(&order_number) || pending.contains(&order_number) {
            continue;
        }
        let result = pull_order(store, client, target, &order_number, local_hashes.get(&order_number)).await;
        match result {
            Ok(Some(notice)) => notices.push(notice),
            Ok(None) => {}
            Err(error) => {
                let message = format!("读取订单 {order_number} 失败：{error}");
                eprintln!("[cloud] {message}");
                failure.get_or_insert(message);
            }
        }
    }
    if notices.is_empty() {
        if let Some(error) = failure {
            return Err(error);
        }
    }
    Ok(notices)
}

async fn pull_order(
    store: &Store,
    client: &FileStorage,
    target: &str,
    order_number: &str,
    local_hash: Option<&String>,
) -> Result<Option<CloudNotice>, String> {
    let Some(manifest_bytes) = client.get_object(&manifest_key(order_number)).await? else {
        return Ok(None);
    };
    let hash = hex(&Sha256::digest(&manifest_bytes));
    if local_hash == Some(&hash) {
        return Ok(None);
    }
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes).map_err(display_error)?;
    validate_manifest(&manifest, order_number)?;
    let directory = store.cloud_import_directory(order_number);
    tokio::fs::create_dir_all(&directory).await.map_err(display_error)?;
    let mut staged = Vec::with_capacity(manifest.images.len());
    for image in manifest.images {
        let local = store.get_image(&image.id).map_err(display_error)?;
        if let Some(row) = &local {
            let owner = store.order_number_by_id(&row.order_id).map_err(display_error)?;
            if owner.as_deref() != Some(order_number) || row.byte_length != image.byte_length {
                return Err("清单与本地同 ID 素材的记录不一致".into());
            }
        }
        let path = local.map_or_else(|| directory.join(&image.file_name), |row| PathBuf::from(row.file_path));
        let existing_size = tokio::fs::metadata(&path).await.ok()
            .and_then(|meta| i64::try_from(meta.len()).ok());
        if existing_size != Some(image.byte_length) {
            let bytes = client.get_object(&image_key(order_number, &image.file_name)).await?
                .ok_or("远端素材缺失")?;
            if i64::try_from(bytes.len()).ok() != Some(image.byte_length) {
                return Err("下载的素材长度与清单不一致，稍后重试".into());
            }
            let parent = path.parent().ok_or("本地素材路径无效")?;
            tokio::fs::create_dir_all(parent).await.map_err(display_error)?;
            let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(display_error)?;
            temp.write_all(&bytes).map_err(display_error)?;
            temp.as_file().sync_all().map_err(display_error)?;
            temp.persist(&path).map_err(display_error)?;
        }
        staged.push((
            CloudImageMeta {
                id: image.id,
                file_name: image.file_name,
                original_name: image.original_name,
                byte_length: image.byte_length,
                width: image.width,
                height: image.height,
                source: image.source,
                templates: image.templates.into_iter().map(|t| crate::store::TemplateQty {
                    template_id: t.template_id, quantity: t.quantity,
                }).collect(),
            },
            path,
        ));
    }
    let state = FileSyncImport {
        target, fingerprint: &hash, layout_number: manifest.layout_number.as_deref(),
        layout_captured_at: manifest.layout_number_captured_at.as_deref(),
    };
    let new_images = store.import_file_order(order_number, &staged, &manifest.updated_at, state)
        .map_err(display_error)?;
    Ok(new_images.map(|new_images| CloudNotice { order_number: order_number.to_owned(), new_images }))
}
