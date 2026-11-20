//! MinIO/S3 多机协同：客服机（千帆捕获）⇄ 制作机（订单制作中心）。
//!
//! 对象布局（bucket 内）：
//!   orders/<订单号>/<图片ID>.<ext>   图片字节
//!   orders/<订单号>/manifest.json    订单清单（提交点：图片先传、清单后传）
//! 同步语义：manifest sha256 指纹比对（orders.cloud_hash）；图片 ID 双机一致，
//! 幂等导入；北京端每次入库/改模板后重传 manifest，家里端轮询拉取。
//!
//! S3 签名：手写 SigV4（service=s3，path-style），兼容 MinIO 自定义端点。

use std::path::{Path, PathBuf};

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

use crate::store::{Store, CloudImageMeta};

/* ---------- 配置（数据根/cloud.json） ---------- */

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CloudConfig {
    pub enabled: bool,
    pub endpoint: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
    pub region: String,
    /// 轮询间隔秒（最小 10）
    pub poll_seconds: u64,
}

impl Default for CloudConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            endpoint: String::new(),
            bucket: String::new(),
            access_key: String::new(),
            secret_key: String::new(),
            region: "us-east-1".into(),
            poll_seconds: 30,
        }
    }
}

impl CloudConfig {
    pub fn valid(&self) -> bool {
        !self.endpoint.is_empty() && !self.bucket.is_empty() && !self.access_key.is_empty()
            && !self.secret_key.is_empty()
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

pub fn save_config(data_root: &Path, config: &CloudConfig) -> Result<(), String> {
    let text = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    std::fs::write(config_path(data_root), text).map_err(|error| error.to_string())
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

        let canonical_headers = format!(
            "host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n",
            host = endpoint_host,
        );
        let signed_headers = "host;x-amz-content-sha256;x-amz-date";
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
        request.send().await.map_err(|error| format!("云服务连接失败：{error}"))
    }

    pub async fn put_object(&self, key: &str, bytes: Vec<u8>) -> Result<(), String> {
        let payload_hash = hex(Sha256::digest(&bytes).as_slice());
        let response = self.request(reqwest::Method::PUT, key, &[], &payload_hash, Some(bytes)).await?;
        if !response.status().is_success() {
            return Err(format!("上传失败（HTTP {}）：{}", response.status(), response.text().await.unwrap_or_default()));
        }
        Ok(())
    }

    pub async fn get_object(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        let response = self.request(reqwest::Method::GET, key, &[], EMPTY_SHA256, None).await?;
        match response.status().as_u16() {
            200 => Ok(Some(response.bytes().await.map_err(|error| format!("下载失败：{error}"))?.to_vec())),
            404 => Ok(None),
            code => Err(format!("下载失败（HTTP {code}）")),
        }
    }

    /// ListObjectsV2 取一层子前缀（delimiter=/）。返回去掉 `prefix` 的子前缀名。
    pub async fn list_prefixes(&self, prefix: &str) -> Result<Vec<String>, String> {
        let response = self
            .request(
                reqwest::Method::GET,
                "",
                &[("delimiter", "/"), ("list-type", "2"), ("max-keys", "1000"), ("prefix", prefix)],
                EMPTY_SHA256,
                None,
            )
            .await?;
        if !response.status().is_success() {
            return Err(format!(
                "列举失败（HTTP {}）：{}",
                response.status(),
                response.text().await.unwrap_or_default()
            ));
        }
        let text = response.text().await.map_err(|error| format!("列举响应读取失败：{error}"))?;
        Ok(extract_xml_values(&text, "Prefix")
            .into_iter()
            .map(|p| p.trim_start_matches(prefix).trim_end_matches('/').to_string())
            .filter(|p| !p.is_empty())
            .collect())
    }

    pub async fn test(&self) -> Result<String, String> {
        self.list_prefixes("").await?;
        Ok(format!("连接正常（bucket={}）", self.bucket))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::qiniu_transport::tests::{local_server, receive, reply};

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

/// 极简 XML 值提取（ListObjectsV2 的 Prefix/Key 均为简单文本）。
fn extract_xml_values(xml: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut values = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        if let Some(end) = after.find(&close) {
            values.push(after[..end].to_string());
            rest = &after[end + close.len()..];
        } else {
            break;
        }
    }
    values
}

/* ---------- 同步编排 ---------- */

fn manifest_key(order_number: &str) -> String {
    format!("orders/{}/manifest.json", order_number)
}

fn image_key(order_number: &str, file_name: &str) -> String {
    format!("orders/{}/{}", order_number, file_name)
}

pub struct CloudNotice {
    pub order_number: String,
    pub new_images: usize,
}

/// 推送单订单：只上传指定图片 + 总是重传 manifest（提交点）。
/// image_ids=None 表示全量回填。
pub async fn push_order(
    store: &Store,
    s3: &S3Client,
    order_number: &str,
    image_ids: Option<&[String]>,
) -> Result<(), String> {
    let images = store
        .cloud_order_images(order_number)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "订单不存在".to_string())?;
    // 图片字节（仅指定 ID 或全量；路径为归档全路径）
    for (meta, file_path) in &images {
        let needed = match image_ids {
            Some(ids) => ids.iter().any(|id| *id == meta.id),
            None => true,
        };
        if !needed || meta.file_name.is_empty() {
            continue;
        }
        let bytes = std::fs::read(file_path)
            .map_err(|error| format!("读取素材文件失败：{error}"))?;
        s3.put_object(&image_key(order_number, &meta.file_name), bytes).await?;
    }
    let manifest = build_manifest(store, order_number, images).map_err(|error| error)?;
    let manifest_bytes = serde_json::to_vec(&manifest).map_err(|error| error.to_string())?;
    s3.put_object(&manifest_key(order_number), manifest_bytes).await
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
    Ok(Manifest {
        order_number: order_number.to_string(),
        updated_at,
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
pub async fn backfill_push(store: &Store, s3: &S3Client) -> Result<usize, String> {
    let orders = store
        .list_orders()
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|o| o.order_number)
        .collect::<Vec<_>>();
    let mut pushed = 0usize;
    for order_number in orders {
        if s3.get_object(&manifest_key(&order_number)).await?.is_some() {
            continue;
        }
        push_order(store, s3, &order_number, None).await?;
        pushed += 1;
    }
    Ok(pushed)
}

/// 拉取：列云端订单前缀 → manifest 指纹比对 → 下载缺失图片 → 幂等导入。
pub async fn pull_all(store: &Store, s3: &S3Client) -> Result<Vec<CloudNotice>, String> {
    let order_numbers = s3.list_prefixes("orders/").await?;
    let local_hashes = store
        .cloud_hashes()
        .map_err(|error| error.to_string())?
        .into_iter()
        .collect::<std::collections::HashMap<_, _>>();

    let mut notices = Vec::new();
    for order_number in order_numbers {
        let manifest_bytes = match s3.get_object(&manifest_key(&order_number)).await? {
            Some(bytes) => bytes,
            None => continue,
        };
        let hash = hex(Sha256::digest(&manifest_bytes).as_slice());
        if local_hashes.get(&order_number).and_then(|h| h.as_deref()) == Some(hash.as_str()) {
            continue;
        }
        let manifest: Manifest = match serde_json::from_slice(&manifest_bytes) {
            Ok(manifest) => manifest,
            Err(error) => {
                eprintln!("[cloud] manifest 解析失败 {order_number}: {error}");
                continue;
            }
        };
        let directory = store.cloud_import_directory(&order_number);
        let _ = std::fs::create_dir_all(&directory);
        let mut staged: Vec<(CloudImageMeta, PathBuf)> = Vec::new();
        for image in &manifest.images {
            let path = directory.join(&image.file_name);
            if !path.exists() {
                let bytes = s3
                    .get_object(&image_key(&order_number, &image.file_name))
                    .await?
                    .ok_or_else(|| format!("云端图片缺失：{}/{}", order_number, image.file_name))?;
                std::fs::write(&path, &bytes).map_err(|error| format!("写入素材失败：{error}"))?;
            }
            staged.push((
                CloudImageMeta {
                    id: image.id.clone(),
                    file_name: image.file_name.clone(),
                    original_name: image.original_name.clone(),
                    byte_length: image.byte_length,
                    width: image.width,
                    height: image.height,
                    source: image.source.clone(),
                    templates: image
                        .templates
                        .iter()
                        .map(|t| crate::store::TemplateQty {
                            template_id: t.template_id.clone(),
                            quantity: t.quantity,
                        })
                        .collect(),
                },
                path,
            ));
        }
        let new_images = store
            .import_cloud_order(&order_number, &staged, &hash, &manifest.updated_at)
            .map_err(|error| error.to_string())?;
        notices.push(CloudNotice { order_number, new_images });
    }
    Ok(notices)
}
