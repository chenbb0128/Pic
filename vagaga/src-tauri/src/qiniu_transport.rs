use std::{
    fmt,
    io::{self, SeekFrom},
    path::{Path, PathBuf},
    time::Duration,
};

use base64::{
    engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD},
    Engine,
};
use qiniu_etag::{EtagV1, FixedOutput, Update};
use reqwest::{
    header::{
        HeaderValue, ACCEPT_ENCODING, AUTHORIZATION, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE,
        RANGE,
    },
    multipart::{Form, Part},
    redirect::Policy,
    Body, Method, RequestBuilder, Response, StatusCode, Url,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{
    fs::{self, File, OpenOptions},
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
};
use tokio_util::io::ReaderStream;

// Matching Qiniu ETag V1 requires every v2 part except the last to be 4 MiB.
const PART_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PARTS: u64 = 10_000;
const CHECKPOINT_LIMIT: u64 = 2 * 1024 * 1024;
const SDK_TIMEOUT: Duration = Duration::from_secs(30);
const IO_BUFFER: usize = 128 * 1024;

#[derive(Debug)]
pub struct Error {
    operation: &'static str,
    status: Option<u16>,
    retryable: bool,
    upload_missing: bool,
}

impl Error {
    fn invalid(operation: &'static str) -> Self {
        Self {
            operation,
            status: None,
            retryable: false,
            upload_missing: false,
        }
    }

    fn network(operation: &'static str, error: reqwest::Error) -> Self {
        Self {
            retryable: error.is_connect()
                || error.is_timeout()
                || error.is_body()
                || error.is_request(),
            ..Self::invalid(operation)
        }
    }

    fn io(operation: &'static str, error: io::Error) -> Self {
        Self {
            retryable: error.kind() != io::ErrorKind::NotFound,
            ..Self::invalid(operation)
        }
    }

    fn http(operation: &'static str, status: StatusCode, upload_missing: bool) -> Self {
        let status = status.as_u16();
        Self {
            operation,
            status: Some(status),
            retryable: upload_missing || matches!(status, 408 | 425 | 429 | 500..=599),
            upload_missing,
        }
    }

    pub fn retryable(&self) -> bool {
        self.retryable
    }

    pub fn status(&self) -> Option<u16> {
        self.status
    }

    pub fn is_conflict(&self) -> bool {
        self.status == Some(409) && !self.upload_missing
    }
}

// Reqwest errors can contain signed URLs. Keep only operation names and status codes.
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.status {
            Some(status) => write!(f, "{}（HTTP {}）", self.operation, status),
            None => f.write_str(self.operation),
        }
    }
}

impl std::error::Error for Error {}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub device_id: String,
    pub workspace_id: String,
    pub role: String,
    pub max_file_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub template_id: String,
    pub quantity: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadRequest {
    pub request_id: String,
    pub asset_id: String,
    pub kind: String,
    pub order_number: String,
    pub file_name: String,
    pub mime: String,
    pub byte_length: u64,
    pub width: u32,
    pub height: u32,
    pub sha256: String,
    pub etag: String,
    pub templates: Vec<Template>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_image_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderSummary {
    pub order_number: String,
    pub version: u64,
    pub deleted: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OrderPage {
    pub orders: Vec<OrderSummary>,
    pub next: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteOrder {
    pub order_number: String,
    pub version: u64,
    pub deleted: bool,
    pub metadata: Option<String>,
    pub assets: Vec<RemoteAsset>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAsset {
    pub id: String,
    pub kind: String,
    pub file_name: String,
    pub mime: String,
    pub byte_length: u64,
    pub width: u32,
    pub height: u32,
    pub sha256: String,
    pub etag: String,
    pub templates: Vec<Template>,
    pub source_image_id: Option<String>,
    pub created_at: String,
    pub deleted: bool,
}

#[derive(Debug)]
pub struct FileHash {
    pub byte_length: u64,
    pub sha256: String,
    pub etag: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadSession {
    id: String,
    #[serde(default)]
    key: String,
    #[serde(default)]
    upload_url: String,
    #[serde(default)]
    token: String,
    #[serde(default)]
    completed: bool,
    version: Option<u64>,
}

#[derive(Deserialize)]
struct Version {
    version: u64,
}

#[derive(Deserialize)]
struct DownloadUrl {
    url: String,
}

#[derive(Deserialize)]
struct ApiError {
    code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Mutation<'a> {
    expected_version: u64,
    request_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    templates: Option<&'a [Template]>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MultipartStart {
    upload_id: String,
    expire_at: i64,
}

#[derive(Deserialize)]
struct UploadedPart {
    etag: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedPart {
    part_number: u64,
    etag: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MultipartFinish<'a> {
    parts: &'a [SavedPart],
    fname: &'a str,
    mime_type: &'a str,
}

#[derive(Deserialize, Serialize)]
struct Checkpoint {
    identity: String,
    upload_id: String,
    expire_at: i64,
    parts: Vec<SavedPart>,
}

#[derive(Deserialize)]
struct UploadPolicy {
    scope: String,
}

#[derive(Clone)]
pub struct Client {
    pub(crate) http: reqwest::Client,
    api_url: Url,
    bearer: HeaderValue,
}

impl Client {
    pub fn new(base_url: &str, token: &str) -> Result<Self, Error> {
        let mut api_url = checked_url(base_url, "同步服务地址无效")?;
        if api_url.query().is_some() || token.is_empty() || token.chars().any(char::is_whitespace) {
            return Err(Error::invalid("同步服务地址或设备令牌无效"));
        }
        if !api_url
            .path()
            .trim_end_matches('/')
            .ends_with("/api/v1/paidan")
        {
            api_url = path(&api_url, &["api", "v1", "paidan"])?;
        }
        let mut bearer = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| Error::invalid("设备令牌无效"))?;
        bearer.set_sensitive(true);
        let http = reqwest::Client::builder()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(60))
            .build()
            .map_err(|_| Error::invalid("无法初始化同步网络客户端"))?;
        Ok(Self {
            http,
            api_url,
            bearer,
        })
    }

    pub(crate) fn api(&self, method: Method, endpoint: &[&str]) -> Result<RequestBuilder, Error> {
        Ok(self
            .http
            .request(method, path(&self.api_url, endpoint)?)
            .header(AUTHORIZATION, self.bearer.clone())
            .timeout(SDK_TIMEOUT))
    }

    pub(crate) async fn api_json<T: DeserializeOwned>(
        &self,
        request: RequestBuilder,
        operation: &'static str,
    ) -> Result<T, Error> {
        let response = request
            .send()
            .await
            .map_err(|error| Error::network(operation, error))?;
        let status = response.status();
        if status.is_success() {
            return decode(response, operation).await;
        }
        // The API distinguishes an object that has yet to arrive from a mismatching object.
        let missing = if status == StatusCode::CONFLICT {
            match response.json::<ApiError>().await {
                Ok(error) => error.code == "upload_missing",
                Err(error) if error.is_timeout() || error.is_body() => {
                    return Err(Error::network(operation, error));
                }
                Err(_) => false,
            }
        } else {
            false
        };
        Err(Error::http(operation, status, missing))
    }

    pub async fn device(&self) -> Result<Device, Error> {
        self.api_json(self.api(Method::GET, &["device"])?, "读取同步设备信息失败")
            .await
    }

    pub async fn orders(&self, after: Option<&str>) -> Result<OrderPage, Error> {
        let request = self
            .api(Method::GET, &["orders"])?
            .query(&[("after", after.unwrap_or_default()), ("limit", "100")]);
        self.api_json(request, "读取云端订单列表失败").await
    }

    pub async fn order(&self, number: &str) -> Result<RemoteOrder, Error> {
        self.api_json(
            self.api(Method::GET, &["orders", number])?,
            "读取云端订单失败",
        )
        .await
    }

    pub async fn patch_templates(
        &self,
        number: &str,
        asset_id: &str,
        expected_version: u64,
        request_id: &str,
        templates: &[Template],
    ) -> Result<u64, Error> {
        self.mutate(
            self.api(
                Method::PATCH,
                &["orders", number, "images", asset_id, "templates"],
            )?,
            Mutation {
                expected_version,
                request_id,
                templates: Some(templates),
            },
        )
        .await
    }

    pub async fn delete_image(
        &self,
        number: &str,
        asset_id: &str,
        expected_version: u64,
        request_id: &str,
    ) -> Result<u64, Error> {
        self.mutate(
            self.api(Method::DELETE, &["orders", number, "images", asset_id])?,
            Mutation {
                expected_version,
                request_id,
                templates: None,
            },
        )
        .await
    }

    pub async fn delete_order(
        &self,
        number: &str,
        expected_version: u64,
        request_id: &str,
    ) -> Result<u64, Error> {
        self.mutate(
            self.api(Method::DELETE, &["orders", number])?,
            Mutation {
                expected_version,
                request_id,
                templates: None,
            },
        )
        .await
    }

    async fn mutate(&self, request: RequestBuilder, mutation: Mutation<'_>) -> Result<u64, Error> {
        let result: Version = self
            .api_json(request.json(&mutation), "修改云端订单失败")
            .await?;
        Ok(result.version)
    }

    async fn begin_upload(&self, input: &UploadRequest) -> Result<UploadSession, Error> {
        let request = self.api(Method::POST, &["upload-sessions"])?.json(input);
        self.api_json(request, "获取上传凭证失败").await
    }

    async fn complete_upload(&self, id: &str) -> Result<u64, Error> {
        let request = self.api(Method::POST, &["upload-sessions", id, "complete"])?;
        let result: Version = self.api_json(request, "确认云端文件失败").await?;
        Ok(result.version)
    }

    pub async fn upload(
        &self,
        input: &UploadRequest,
        source: &Path,
        checkpoint_path: &Path,
    ) -> Result<u64, Error> {
        let mut session = self.begin_upload(input).await?;
        if let Some(version) = self.resume_upload(&session).await? {
            let _ = remove_if_present(checkpoint_path).await;
            return Ok(version);
        }

        let mut file = File::open(source)
            .await
            .map_err(|error| Error::io("打开待上传文件失败", error))?;
        let hash = hash_open_file(&mut file).await?;
        if hash.byte_length != input.byte_length
            || hash.sha256 != input.sha256
            || hash.etag != input.etag
        {
            return Err(Error::invalid("待上传文件已更改"));
        }

        let mut refreshed = false;
        let mut restarted = false;
        loop {
            let endpoint = checked_url(&session.upload_url, "七牛上传地址无效")?;
            let sent = if input.byte_length <= PART_BYTES {
                self.form_upload(endpoint, &session, input, &mut file).await
            } else {
                self.multipart_upload(endpoint, &session, input, &mut file, checkpoint_path)
                    .await
            };
            match sent {
                Ok(()) => break,
                Err(error) if matches!(error.status(), Some(401 | 403)) && !refreshed => {
                    refreshed = true;
                    session = self.begin_upload(input).await?;
                    if let Some(version) = self.resume_upload(&session).await? {
                        let _ = remove_if_present(checkpoint_path).await;
                        return Ok(version);
                    }
                }
                Err(mut error) if matches!(error.status(), Some(612 | 614)) => {
                    if let Some(version) = self.resume_upload(&session).await? {
                        let _ = remove_if_present(checkpoint_path).await;
                        return Ok(version);
                    }
                    if error.status() != Some(612) || restarted || input.byte_length <= PART_BYTES {
                        error.retryable = true;
                        return Err(error);
                    }
                    // Qiniu discards an expired or already completed multipart upload ID.
                    restarted = true;
                    remove_if_present(checkpoint_path).await?;
                }
                Err(error) => return Err(error),
            }
        }
        let version = self
            .complete_upload(&session.id)
            .await
            .map_err(|mut error| {
                error.retryable |= error.status() == Some(404);
                error
            })?;
        let _ = remove_if_present(checkpoint_path).await;
        Ok(version)
    }

    async fn resume_upload(&self, session: &UploadSession) -> Result<Option<u64>, Error> {
        if session.completed {
            if let Some(version) = session.version.filter(|version| *version > 0) {
                return Ok(Some(version));
            }
        }
        match self.complete_upload(&session.id).await {
            Ok(version) => Ok(Some(version)),
            Err(error) if error.upload_missing || error.status() == Some(404) => Ok(None),
            Err(error) => Err(error),
        }
    }

    async fn form_upload(
        &self,
        endpoint: Url,
        session: &UploadSession,
        input: &UploadRequest,
        file: &mut File,
    ) -> Result<(), Error> {
        // https://developer.qiniu.com/kodo/1272/form-upload
        let body = file_body(file, 0, input.byte_length).await?;
        let part = Part::stream_with_length(body, input.byte_length)
            .file_name(input.file_name.clone())
            .mime_str(&input.mime)
            .map_err(|_| Error::invalid("待上传文件的 MIME 类型无效"))?;
        let form = Form::new()
            .text("token", session.token.clone())
            .text("key", session.key.clone())
            .part("file", part);
        send(self.http.post(endpoint).multipart(form), "七牛表单上传失败").await?;
        Ok(())
    }

    async fn multipart_upload(
        &self,
        endpoint: Url,
        session: &UploadSession,
        input: &UploadRequest,
        file: &mut File,
        checkpoint_path: &Path,
    ) -> Result<(), Error> {
        // https://developer.qiniu.com/kodo/6365/initialize-multipartupload
        // https://developer.qiniu.com/kodo/6366/upload-part
        // https://developer.qiniu.com/kodo/6368/complete-multipart-upload
        let part_count = input.byte_length.div_ceil(PART_BYTES);
        if part_count > MAX_PARTS {
            return Err(Error::invalid("待上传文件超过七牛分片数量上限"));
        }
        let bucket = upload_bucket(session)?;
        let key = URL_SAFE.encode(&session.key);
        let endpoint = path(&endpoint, &["buckets", &bucket, "objects", &key, "uploads"])?;
        // Only the digest of the destination is persisted. A renewed token uses the same upload ID.
        let identity = format!(
            "{:x}",
            Sha256::digest(format!(
                "v1\n{}\n{}\n{}",
                session.id, endpoint, input.sha256
            ))
        );
        let auth = upload_auth(&session.token)?;
        let mut checkpoint = match load_checkpoint(checkpoint_path, &identity, part_count).await? {
            Some(checkpoint) => checkpoint,
            None => {
                let response = send(
                    self.http
                        .post(endpoint.clone())
                        .header(AUTHORIZATION, auth.clone()),
                    "初始化七牛分片上传失败",
                )
                .await?;
                let started: MultipartStart =
                    decode(response, "七牛分片上传初始化响应无效").await?;
                let checkpoint = Checkpoint {
                    identity,
                    upload_id: started.upload_id,
                    expire_at: started.expire_at,
                    parts: Vec::new(),
                };
                save_checkpoint(checkpoint_path, &checkpoint).await?;
                checkpoint
            }
        };
        let upload_url = path(&endpoint, &[&checkpoint.upload_id])?;
        for number in checkpoint.parts.len() as u64 + 1..=part_count {
            let offset = (number - 1) * PART_BYTES;
            let length = (input.byte_length - offset).min(PART_BYTES);
            let body = file_body(file, offset, length).await?;
            let response = send(
                self.http
                    .put(path(&upload_url, &[&number.to_string()])?)
                    .header(AUTHORIZATION, auth.clone())
                    .header(CONTENT_TYPE, "application/octet-stream")
                    .header(CONTENT_LENGTH, length)
                    .body(body),
                "七牛上传分片失败",
            )
            .await?;
            let uploaded: UploadedPart = decode(response, "七牛上传分片响应无效").await?;
            if uploaded.etag.is_empty() || uploaded.etag.len() > 128 {
                return Err(Error::invalid("七牛上传分片未返回有效的 ETag"));
            }
            checkpoint.parts.push(SavedPart {
                part_number: number,
                etag: uploaded.etag,
            });
            save_checkpoint(checkpoint_path, &checkpoint).await?;
        }
        send(
            self.http
                .post(upload_url)
                .header(AUTHORIZATION, auth)
                .json(&MultipartFinish {
                    parts: &checkpoint.parts,
                    fname: &input.file_name,
                    mime_type: &input.mime,
                }),
            "七牛合并上传分片失败",
        )
        .await?;
        Ok(())
    }

    pub async fn download(&self, asset: &RemoteAsset, destination: &Path) -> Result<(), Error> {
        if verify_file(destination, asset).await? {
            return Ok(());
        }
        create_parent(destination).await?;
        let partial = append_suffix(destination, ".part");
        let mut offset = file_length(&partial).await?.unwrap_or(0);
        if offset >= asset.byte_length {
            if verify_file(&partial, asset).await? {
                return publish_file(&partial, destination).await;
            }
            remove_if_present(&partial).await?;
            offset = 0;
        }
        let request = self.api(Method::POST, &["assets", &asset.id, "download-url"])?;
        let signed: DownloadUrl = self.api_json(request, "获取云端文件下载地址失败").await?;
        let url = checked_url(&signed.url, "七牛下载地址无效")?;
        loop {
            let mut request = self
                .http
                .get(url.clone())
                .header(ACCEPT_ENCODING, "identity");
            if offset > 0 {
                request = request.header(RANGE, format!("bytes={offset}-"));
            }
            let response = request
                .send()
                .await
                .map_err(|error| Error::network("七牛下载失败", error))?;
            let status = response.status();
            let mut response = match status {
                StatusCode::OK => {
                    offset = 0;
                    response
                }
                StatusCode::PARTIAL_CONTENT
                    if matches_range(&response, offset, asset.byte_length) =>
                {
                    response
                }
                StatusCode::PARTIAL_CONTENT | StatusCode::RANGE_NOT_SATISFIABLE if offset > 0 => {
                    remove_if_present(&partial).await?;
                    offset = 0;
                    continue;
                }
                _ => {
                    let mut error = Error::http("七牛下载返回异常状态", status, false);
                    // Retry with a freshly signed URL if the issued one has expired.
                    error.retryable |= matches!(status.as_u16(), 401 | 403);
                    return Err(error);
                }
            };
            let mut written = offset;
            let mut file = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(offset == 0)
                .open(&partial)
                .await
                .map_err(|error| Error::io("打开下载临时文件失败", error))?;
            file.seek(SeekFrom::Start(offset))
                .await
                .map_err(|error| Error::io("定位下载临时文件失败", error))?;
            loop {
                let chunk = match response.chunk().await {
                    Ok(Some(chunk)) => chunk,
                    Ok(None) => break,
                    Err(error) => {
                        file.flush()
                            .await
                            .map_err(|error| Error::io("保存下载临时文件失败", error))?;
                        return Err(Error::network("读取七牛下载内容失败", error));
                    }
                };
                written += chunk.len() as u64;
                if written > asset.byte_length {
                    drop(file);
                    remove_if_present(&partial).await?;
                    return Err(Error::invalid("下载文件超过预期大小"));
                }
                file.write_all(&chunk)
                    .await
                    .map_err(|error| Error::io("写入下载临时文件失败", error))?;
            }
            file.sync_all()
                .await
                .map_err(|error| Error::io("保存下载临时文件失败", error))?;
            drop(file);
            if written != asset.byte_length {
                return Err(Error {
                    retryable: true,
                    ..Error::invalid("下载未完成，可继续下载")
                });
            }
            if verify_file(&partial, asset).await? {
                return publish_file(&partial, destination).await;
            }
            remove_if_present(&partial).await?;
            if offset == 0 {
                return Err(Error::invalid("下载文件校验失败"));
            }
            // If a leftover prefix did not match, try the entire signed object once.
            offset = 0;
        }
    }
}

pub(crate) fn checked_url(raw: &str, operation: &'static str) -> Result<Url, Error> {
    let url = Url::parse(raw).map_err(|_| Error::invalid(operation))?;
    let loopback = match url.host_str() {
        Some("localhost" | "[::1]") => true,
        Some(host) => host
            .parse::<std::net::Ipv4Addr>()
            .is_ok_and(|ip| ip.is_loopback()),
        None => false,
    };
    if (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::invalid(operation));
    }
    Ok(url)
}

fn path(url: &Url, segments: &[&str]) -> Result<Url, Error> {
    if segments
        .iter()
        .any(|segment| matches!(*segment, "" | "." | ".."))
    {
        return Err(Error::invalid("同步接口路径无效"));
    }
    let mut url = url.clone();
    url.path_segments_mut()
        .map_err(|_| Error::invalid("同步接口地址无效"))?
        .pop_if_empty()
        .extend(segments);
    Ok(url)
}

async fn decode<T: DeserializeOwned>(
    response: Response,
    operation: &'static str,
) -> Result<T, Error> {
    response
        .json()
        .await
        .map_err(|error| Error::network(operation, error))
}

async fn send(request: RequestBuilder, operation: &'static str) -> Result<Response, Error> {
    let response = request
        .send()
        .await
        .map_err(|error| Error::network(operation, error))?;
    if !response.status().is_success() {
        return Err(Error::http(operation, response.status(), false));
    }
    Ok(response)
}

fn upload_auth(token: &str) -> Result<HeaderValue, Error> {
    let mut auth = HeaderValue::from_str(&format!("UpToken {token}"))
        .map_err(|_| Error::invalid("七牛上传凭证无效"))?;
    auth.set_sensitive(true);
    Ok(auth)
}

fn upload_bucket(session: &UploadSession) -> Result<String, Error> {
    let invalid = || Error::invalid("七牛上传凭证的存储范围无效");
    // The Qiniu token is access_key:signature:base64_url(JSON policy).
    let (_, encoded) = session.token.rsplit_once(':').ok_or_else(invalid)?;
    let decoded = URL_SAFE
        .decode(encoded)
        .or_else(|_| URL_SAFE_NO_PAD.decode(encoded))
        .map_err(|_| invalid())?;
    let policy: UploadPolicy = serde_json::from_slice(&decoded).map_err(|_| invalid())?;
    let (bucket, key) = policy.scope.split_once(':').ok_or_else(invalid)?;
    if bucket.is_empty() || key != session.key {
        return Err(invalid());
    }
    Ok(bucket.to_owned())
}

async fn file_body(file: &mut File, offset: u64, length: u64) -> Result<Body, Error> {
    file.seek(SeekFrom::Start(offset))
        .await
        .map_err(|error| Error::io("定位待上传文件失败", error))?;
    let stream = file
        .try_clone()
        .await
        .map_err(|error| Error::io("打开上传文件流失败", error))?;
    Ok(Body::wrap_stream(ReaderStream::with_capacity(
        stream.take(length),
        IO_BUFFER,
    )))
}

pub async fn hash_file(path: &Path) -> Result<FileHash, Error> {
    let mut file = File::open(path)
        .await
        .map_err(|error| Error::io("打开校验文件失败", error))?;
    hash_open_file(&mut file).await
}

async fn hash_open_file(file: &mut File) -> Result<FileHash, Error> {
    let mut sha = Sha256::new();
    let mut etag = EtagV1::new();
    let mut buffer = vec![0; IO_BUFFER];
    let mut byte_length = 0;
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|error| Error::io("读取校验文件失败", error))?;
        if read == 0 {
            break;
        }
        byte_length += read as u64;
        Digest::update(&mut sha, &buffer[..read]);
        Update::update(&mut etag, &buffer[..read]);
    }
    // The SDK produces a base64url digest.
    let etag = String::from_utf8_lossy(&etag.finalize_fixed()).into_owned();
    Ok(FileHash {
        byte_length,
        sha256: format!("{:x}", sha.finalize()),
        etag,
    })
}

async fn load_checkpoint(
    path: &Path,
    identity: &str,
    part_count: u64,
) -> Result<Option<Checkpoint>, Error> {
    let Some(length) = file_length(path).await? else {
        return Ok(None);
    };
    if length > CHECKPOINT_LIMIT {
        return Ok(None);
    }
    let data = fs::read(path)
        .await
        .map_err(|error| Error::io("读取上传进度失败", error))?;
    let checkpoint = serde_json::from_slice::<Checkpoint>(&data)
        .ok()
        .filter(|checkpoint| {
            checkpoint.identity == identity
                && !matches!(checkpoint.upload_id.as_str(), "" | "." | "..")
                && checkpoint.expire_at > chrono::Utc::now().timestamp()
                && checkpoint.parts.len() as u64 <= part_count
                && checkpoint.parts.iter().enumerate().all(|(index, part)| {
                    part.part_number == index as u64 + 1
                        && !part.etag.is_empty()
                        && part.etag.len() <= 128
                })
        });
    Ok(checkpoint)
}

async fn save_checkpoint(path: &Path, checkpoint: &Checkpoint) -> Result<(), Error> {
    create_parent(path).await?;
    let temporary = append_suffix(path, ".new");
    let data = serde_json::to_vec(checkpoint).map_err(|_| Error::invalid("无法编码上传进度"))?;
    let mut file = File::create(&temporary)
        .await
        .map_err(|error| Error::io("创建上传进度失败", error))?;
    file.write_all(&data)
        .await
        .map_err(|error| Error::io("写入上传进度失败", error))?;
    file.sync_all()
        .await
        .map_err(|error| Error::io("保存上传进度失败", error))?;
    drop(file);
    fs::rename(temporary, path)
        .await
        .map_err(|error| Error::io("替换上传进度失败", error))
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

async fn create_parent(path: &Path) -> Result<(), Error> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .await
            .map_err(|error| Error::io("创建同步文件夹失败", error))?;
    }
    Ok(())
}

async fn file_length(path: &Path) -> Result<Option<u64>, Error> {
    match fs::metadata(path).await {
        Ok(metadata) if metadata.is_file() => Ok(Some(metadata.len())),
        Ok(_) => Err(Error::invalid("同步文件路径指向了其他类型的文件")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(Error::io("读取同步文件信息失败", error)),
    }
}

async fn remove_if_present(path: &Path) -> Result<(), Error> {
    match fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(Error::io("删除同步临时文件失败", error)),
    }
}

async fn verify_file(path: &Path, asset: &RemoteAsset) -> Result<bool, Error> {
    if file_length(path).await? != Some(asset.byte_length) {
        return Ok(false);
    }
    let hash = hash_file(path).await?;
    Ok(hash.byte_length == asset.byte_length && hash.sha256 == asset.sha256)
}

async fn publish_file(partial: &Path, destination: &Path) -> Result<(), Error> {
    fs::rename(partial, destination)
        .await
        .map_err(|error| Error::io("保存校验后的下载文件失败", error))
}

fn matches_range(response: &Response, offset: u64, size: u64) -> bool {
    size.checked_sub(1).is_some_and(|last| {
        let expected = format!("bytes {offset}-{last}/{size}");
        response
            .headers()
            .get(CONTENT_RANGE)
            .is_some_and(|actual| actual == expected.as_str())
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::{
        collections::HashMap,
        io::{BufRead, BufReader, Read, Write},
        net::{TcpListener, TcpStream},
        thread,
    };

    #[tokio::test]
    async fn hash_file_matches_qiniu_etag_across_block_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("original");
        std::fs::write(&file, vec![b'a'; (4 << 20) + 1]).unwrap();

        let digest = hash_file(&file).await.unwrap();
        assert_eq!(digest.byte_length, 4_194_305);
        assert_eq!(
            digest.sha256,
            "acd560a1e1d523c090ab93aed616d154b7b5e8206a153cced729d83f2c7dcfc3"
        );
        assert_eq!(digest.etag, "lieGn00gWdbfwEIHaUpzu4drHeun");
    }

    #[tokio::test]
    async fn upload_resumes_saved_parts_with_a_new_token() {
        let (listener, base) = local_server();
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("original.jpg");
        let checkpoint = dir.path().join("checkpoint");
        std::fs::write(&source, vec![b'a'; PART_BYTES as usize + 1]).unwrap();
        let hash = hash_file(&source).await.unwrap();
        let input = upload_input(hash);
        let endpoint = base.clone();
        let server = thread::spawn(move || {
            let upload_path = "/upload/buckets/bucket/objects/cGljdHVyZXMvaW1hZ2U=/uploads";
            let complete = "POST /api/v1/paidan/upload-sessions/session/complete";
            let first_token = qiniu_token("first");
            let second_token = qiniu_token("second");
            let issue = |token: &str| {
                let (socket, request) = receive(&listener, "POST /api/v1/paidan/upload-sessions");
                assert_eq!(request.headers["authorization"], "Bearer api-token");
                reply(socket, 200, &[], serde_json::json!({
                    "id": "session", "key": "pictures/image", "uploadUrl": format!("{endpoint}/upload"),
                    "token": token, "completed": false,
                }).to_string().as_bytes());
            };
            let missing = |status| {
                let (socket, _) = receive(&listener, complete);
                reply(socket, status, &[], br#"{"code":"upload_missing"}"#);
            };
            issue(&first_token);
            missing(409);
            let (socket, request) = receive(&listener, &format!("POST {upload_path}"));
            assert_eq!(
                request.headers["authorization"],
                format!("UpToken {first_token}")
            );
            reply(
                socket,
                200,
                &[],
                serde_json::json!({
                    "uploadId": "parts", "expireAt": chrono::Utc::now().timestamp() + 600
                })
                .to_string()
                .as_bytes(),
            );
            let (socket, request) = receive(&listener, &format!("PUT {upload_path}/parts/1"));
            assert_eq!(request.body.len() as u64, PART_BYTES);
            assert!(request.body.iter().all(|byte| *byte == b'a'));
            reply(socket, 200, &[], br#"{"etag":"first-etag"}"#);
            let (socket, _) = receive(&listener, &format!("PUT {upload_path}/parts/2"));
            reply(socket, 503, &[], b"");
            issue(&second_token);
            missing(404);
            let (socket, request) = receive(&listener, &format!("PUT {upload_path}/parts/2"));
            assert_eq!(
                request.headers["authorization"],
                format!("UpToken {second_token}")
            );
            assert_eq!(request.body, b"a");
            reply(socket, 200, &[], br#"{"etag":"second-etag"}"#);
            let (socket, request) = receive(&listener, &format!("POST {upload_path}/parts"));
            assert_eq!(
                request.headers["authorization"],
                format!("UpToken {second_token}")
            );
            let finish: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
            assert_eq!(
                finish,
                serde_json::json!({
                    "parts": [{"partNumber": 1, "etag": "first-etag"}, {"partNumber": 2, "etag": "second-etag"}],
                    "fname": "original.jpg", "mimeType": "image/jpeg",
                })
            );
            reply(socket, 200, &[], b"{}");
            let (socket, request) = receive(&listener, complete);
            assert_eq!(request.headers["authorization"], "Bearer api-token");
            reply(socket, 200, &[], br#"{"version":7}"#);
        });
        let first = Client::new(&base, "api-token").unwrap();
        let error = first
            .upload(&input, &source, &checkpoint)
            .await
            .unwrap_err();
        assert!(error.retryable());
        assert_eq!(error.status(), Some(503));
        drop(first);
        let saved = std::fs::read_to_string(&checkpoint).unwrap();
        assert!(saved.contains("first-etag"));
        assert!(!saved.contains(&qiniu_token("first")));
        let second = Client::new(&base, "api-token").unwrap();
        assert_eq!(
            second.upload(&input, &source, &checkpoint).await.unwrap(),
            7
        );
        assert!(!checkpoint.exists());
        server.join().unwrap();
    }

    #[tokio::test]
    async fn existing_form_object_requires_api_verification() {
        let (listener, base) = local_server();
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("original.jpg");
        let checkpoint = dir.path().join("checkpoint");
        std::fs::write(&source, b"etag").unwrap();
        let input = upload_input(hash_file(&source).await.unwrap());
        let endpoint = base.clone();
        let server = thread::spawn(move || {
            let (socket, _) = receive(&listener, "POST /api/v1/paidan/upload-sessions");
            reply(socket, 200, &[], serde_json::json!({
                "id": "session", "key": "pictures/image", "uploadUrl": format!("{endpoint}/form"),
                "token": "form-token", "completed": false,
            }).to_string().as_bytes());
            let complete = "POST /api/v1/paidan/upload-sessions/session/complete";
            let (socket, _) = receive(&listener, complete);
            reply(socket, 404, &[], b"{}");
            let (socket, request) = receive(&listener, "POST /form");
            assert!(!request.headers.contains_key("authorization"));
            let form = String::from_utf8(request.body).unwrap();
            assert!(form.contains("name=\"token\"\r\n\r\nform-token"));
            assert!(form.contains("name=\"key\"\r\n\r\npictures/image"));
            assert!(form.contains("Content-Type: image/jpeg\r\n\r\netag"));
            reply(socket, 614, &[], b"{}");
            let (socket, _) = receive(&listener, complete);
            reply(socket, 409, &[], br#"{"code":"upload_mismatch"}"#);
        });
        let client = Client::new(&base, "api-token").unwrap();
        let error = client
            .upload(&input, &source, &checkpoint)
            .await
            .unwrap_err();
        assert!(error.is_conflict());
        assert!(!error.retryable());
        server.join().unwrap();
    }

    #[tokio::test]
    async fn download_replaces_a_corrupt_partial_only_after_verifying_sha256() {
        let (listener, base) = local_server();
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("photo");
        let partial = dir.path().join("photo.part");
        std::fs::write(&destination, b"old").unwrap();
        std::fs::write(&partial, b"zz").unwrap();
        let endpoint = base.clone();
        let server = thread::spawn(move || {
            let (socket, request) =
                receive(&listener, "POST /api/v1/paidan/assets/asset/download-url");
            assert_eq!(request.headers["authorization"], "Bearer api-token");
            reply(
                socket,
                200,
                &[],
                serde_json::json!({
                    "url": format!("{endpoint}/download?token=private")
                })
                .to_string()
                .as_bytes(),
            );
            let (socket, request) = receive(&listener, "GET /download?token=private");
            assert!(!request.headers.contains_key("authorization"));
            assert_eq!(request.headers["range"], "bytes=2-");
            reply(socket, 206, &[("Content-Range", "bytes 2-3/4")], b"ag");
            let (socket, request) = receive(&listener, "GET /download?token=private");
            assert!(!request.headers.contains_key("range"));
            reply(socket, 200, &[], b"etag");
        });
        let asset = RemoteAsset {
            id: "asset".into(),
            kind: "original".into(),
            file_name: "original.jpg".into(),
            mime: "image/jpeg".into(),
            byte_length: 4,
            width: 1,
            height: 1,
            sha256: "fcaec3a55087c997f24ba2a70383ed9b7607fd85f0ae2e0dccb5ec094c75f009".into(),
            etag: "FpLiADEaVoALPkdb8tJEJyRTXoe_".into(),
            templates: Vec::new(),
            source_image_id: None,
            created_at: "2026-01-01T00:00:00Z".into(),
            deleted: false,
        };
        Client::new(&base, "api-token")
            .unwrap()
            .download(&asset, &destination)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"etag");
        assert!(!partial.exists());
        server.join().unwrap();
    }

    fn upload_input(hash: FileHash) -> UploadRequest {
        UploadRequest {
            request_id: "request".into(),
            asset_id: "asset".into(),
            kind: "original".into(),
            order_number: "123".into(),
            file_name: "original.jpg".into(),
            mime: "image/jpeg".into(),
            byte_length: hash.byte_length,
            width: 1,
            height: 1,
            sha256: hash.sha256,
            etag: hash.etag,
            templates: Vec::new(),
            source_image_id: None,
            metadata: None,
        }
    }

    fn qiniu_token(signature: &str) -> String {
        let policy = URL_SAFE.encode(br#"{"scope":"bucket:pictures/image"}"#);
        format!("access:{signature}:{policy}")
    }

    pub(crate) fn local_server() -> (TcpListener, String) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        (listener, base)
    }

    pub(crate) struct LocalRequest {
        pub(crate) headers: HashMap<String, String>,
        pub(crate) body: Vec<u8>,
    }

    pub(crate) fn receive(listener: &TcpListener, expected: &str) -> (TcpStream, LocalRequest) {
        let (socket, line, request) = receive_request(listener);
        assert_eq!(line, format!("{expected} HTTP/1.1"));
        (socket, request)
    }

    pub(crate) fn receive_request(listener: &TcpListener) -> (TcpStream, String, LocalRequest) {
        let (socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut reader = BufReader::new(socket);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let request_line = line.trim_end().to_owned();
        let mut headers = HashMap::new();
        loop {
            line.clear();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
            let (name, value) = line.split_once(':').unwrap();
            headers.insert(name.to_ascii_lowercase(), value.trim().to_owned());
        }
        let length = headers
            .get("content-length")
            .map_or(0, |value| value.parse().unwrap());
        let mut body = vec![0; length];
        reader.read_exact(&mut body).unwrap();
        (reader.into_inner(), request_line, LocalRequest { headers, body })
    }

    pub(crate) fn reply(mut socket: TcpStream, status: u16, headers: &[(&str, &str)], body: &[u8]) {
        write!(
            socket,
            "HTTP/1.1 {status} Test\r\nConnection: close\r\nContent-Length: {}\r\n",
            body.len()
        )
        .unwrap();
        for (name, value) in headers {
            write!(socket, "{name}: {value}\r\n").unwrap();
        }
        socket.write_all(b"\r\n").unwrap();
        socket.write_all(body).unwrap();
    }
}
