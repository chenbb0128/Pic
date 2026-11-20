// WebDAV and SMB storage for order objects.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use futures_util::{future, TryStreamExt};
use http::{header, Method, Request, Response, StatusCode};
use opendal::{
    Buffer, ErrorKind, HttpBody, HttpTransport, HttpTransporter, OperationContext, Operator,
};
use reqwest::{Client as HttpClient, Url};
use serde::{Deserialize, Serialize};
use smb::{
    Client as SmbSession, ClientConfig, CreateDisposition, CreateOptions, Directory,
    Error as SmbError, FileAccessMask, FileAttributeTagInformation, FileAttributes, FileCreateArgs,
    FileDirectoryInformation, FileDispositionInformation, FileRenameInformation, Resource,
    ResourceHandle, Status, UncPath,
};
use tokio::sync::OnceCell;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HTTP_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct WebDavConfig {
    pub endpoint: String,
    pub root: String,
    pub username: String,
    pub password: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct SmbConfig {
    pub host: String,
    pub share: String,
    pub root: String,
    pub username: String,
    pub password: String,
}

fn valid_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.trim() == segment
        && !segment.ends_with('.')
        && !segment.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|', '%'])
        && !segment.chars().any(char::is_control)
}

fn valid_path(path: &str, allow_empty: bool) -> bool {
    (allow_empty && path.is_empty()) || path.split('/').all(valid_segment)
}

fn checked_path(path: &str, allow_empty: bool) -> Result<&str, String> {
    if valid_path(path, allow_empty) {
        Ok(path)
    } else {
        Err("存储目录或对象名称无效。".into())
    }
}

fn checked_prefix(prefix: &str) -> Result<&str, String> {
    checked_path(
        prefix.strip_suffix('/').unwrap_or(prefix),
        prefix.is_empty(),
    )
}

fn with_parent(parent: &str, child: &str) -> String {
    match (parent, child) {
        ("", _) => child.to_owned(),
        (_, "") => parent.to_owned(),
        _ => format!("{parent}/{child}"),
    }
}

fn temporary_key(parent: &str) -> String {
    with_parent(
        parent,
        &format!(".vagaga-{:032x}.tmp", rand::random::<u128>()),
    )
}

pub(crate) struct WebDavClient {
    endpoint: Url,
    http: HttpClient,
    operator: Operator,
}

impl WebDavClient {
    pub(crate) fn new(config: &WebDavConfig) -> Result<Self, String> {
        let mut endpoint = Url::parse(config.endpoint.trim())
            .map_err(|_| "请填写有效的 WebDAV 地址。".to_string())?;
        if !matches!(endpoint.scheme(), "http" | "https")
            || endpoint.host_str().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            return Err("WebDAV 地址需使用 HTTP 或 HTTPS，账号和密码请填在单独的字段中。".into());
        }
        let root = checked_path(config.root.trim().trim_matches('/'), true)?;
        endpoint.set_path(endpoint.path().trim_end_matches('/').to_owned().as_str());
        push_url_path(&mut endpoint, root);

        let mut headers = header::HeaderMap::new();
        if !config.username.is_empty() {
            let credentials = base64::engine::general_purpose::STANDARD
                .encode(format!("{}:{}", config.username, config.password));
            let mut authorization = header::HeaderValue::from_str(&format!("Basic {credentials}"))
                .map_err(|_| "WebDAV 账号或密码格式错误。".to_string())?;
            authorization.set_sensitive(true);
            headers.insert(header::AUTHORIZATION, authorization);
        }
        let http = HttpClient::builder()
            .default_headers(headers)
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(HTTP_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "无法初始化 WebDAV 连接。".to_string())?;
        let builder = opendal::services::Webdav::default()
            .endpoint(endpoint.as_str().trim_end_matches('/'))
            .disable_create_dir(true);
        let operator = Operator::new(builder)
            .map_err(|_| "WebDAV 地址或目录格式无效。".to_string())?
            .with_context(
                OperationContext::new()
                    .with_http_transport(HttpTransporter::new(WebDavHttp(http.clone()))),
            );
        Ok(Self {
            endpoint,
            http,
            operator,
        })
    }

    pub(crate) async fn put_object(&self, key: &str, bytes: Vec<u8>) -> Result<(), String> {
        let key = checked_path(key, false)?;
        self.directory_entries("")
            .await?
            .ok_or_else(webdav_root_missing)?;
        let parent = key.rsplit_once('/').map_or("", |(parent, _)| parent);
        if !parent.is_empty() {
            self.operator
                .create_dir(&format!("{parent}/"))
                .await
                .map_err(|error| webdav_error("创建目录", &error))?;
        }

        let temporary = temporary_key(parent);
        let result = async {
            self.operator
                .write(&temporary, bytes)
                .await
                .map_err(|error| webdav_error("写入临时文件", &error))?;
            self.operator
                .rename(&temporary, key)
                .await
                .map_err(|error| webdav_error("替换文件", &error))
        }
        .await;
        if result.is_err() {
            let _ = self.operator.delete(&temporary).await;
        }
        result
    }

    pub(crate) async fn get_object(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        let key = checked_path(key, false)?;
        match self.operator.read(key).await {
            Ok(bytes) => Ok(Some(bytes.to_vec())),
            Err(error) if error.kind() == ErrorKind::NotFound => {
                self.directory_entries("")
                    .await?
                    .ok_or_else(webdav_root_missing)?;
                Ok(None)
            }
            Err(error) => Err(webdav_error("读取文件", &error)),
        }
    }

    pub(crate) async fn list_prefixes(&self, prefix: &str) -> Result<Vec<String>, String> {
        let directory = checked_prefix(prefix)?;
        if let Some(entries) = self.directory_entries(directory).await? {
            return Ok(entries);
        }
        self.directory_entries("")
            .await?
            .ok_or_else(webdav_root_missing)?;
        Ok(Vec::new())
    }

    pub(crate) async fn test(&self) -> Result<String, String> {
        self.directory_entries("")
            .await?
            .ok_or_else(webdav_root_missing)?;
        Ok("WebDAV 连接成功，配置目录可读取。".into())
    }

    async fn directory_entries(&self, path: &str) -> Result<Option<Vec<String>>, String> {
        // OpenDAL's WebDAV lister assumes path-form hrefs. RFC 4918 also permits absolute URLs.
        let mut url = self.endpoint.clone();
        push_url_path(&mut url, path);
        url.path_segments_mut().expect("HTTP endpoint").push("");
        let response = self
            .http
            .request(
                Method::from_bytes(b"PROPFIND").expect("valid method"),
                url.clone(),
            )
            .header("Depth", "1")
            .header(header::CONTENT_TYPE, "application/xml")
            .body(r#"<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>"#)
            .send()
            .await
            .map_err(|error| webdav_error("列出目录", &webdav_request_error(error)))?;
        match response.status() {
            StatusCode::NOT_FOUND => return Ok(None),
            StatusCode::MULTI_STATUS => {}
            status => return Err(webdav_error("列出目录", &webdav_status_error(status))),
        }
        let body = response
            .bytes()
            .await
            .map_err(|error| webdav_error("列出目录", &webdav_request_error(error)))?;
        let listing: DavListing = quick_xml::de::from_reader(body.as_ref())
            .map_err(|_| "WebDAV 返回了无法读取的目录清单。".to_string())?;
        let base = urlencoding::decode(url.path())
            .map_err(|_| "WebDAV 目录的 URL 编码无效。".to_string())?;
        let mut names = Vec::new();
        let mut found_directory = false;
        for entry in listing.response {
            let Ok(resource) = url.join(&entry.href) else {
                continue;
            };
            if resource.origin() != url.origin()
                || resource.query().is_some()
                || resource.fragment().is_some()
            {
                continue;
            }
            let Ok(path) = urlencoding::decode(resource.path()) else {
                continue;
            };
            let is_directory = entry.propstat.iter().any(DavPropstat::is_collection);
            if path.trim_end_matches('/') == base.trim_end_matches('/') {
                if let Some(status @ (StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)) =
                    entry.status.as_deref().and_then(dav_status).or_else(|| {
                        entry
                            .propstat
                            .iter()
                            .filter_map(|item| dav_status(&item.status))
                            .find(|status| {
                                matches!(*status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)
                            })
                    })
                {
                    return Err(webdav_error("列出目录", &webdav_status_error(status)));
                }
                found_directory |= is_directory;
            } else if is_directory {
                if let Some(name) = path
                    .strip_prefix(base.as_ref())
                    .map(|name| name.trim_end_matches('/'))
                {
                    if valid_segment(name) {
                        names.push(name.to_owned());
                    }
                }
            }
        }
        if !found_directory {
            return Err("WebDAV 配置的路径不存在、无法列出，或不是文件夹。".into());
        }
        names.sort_unstable();
        names.dedup();
        Ok(Some(names))
    }
}

fn push_url_path(url: &mut Url, path: &str) {
    let mut segments = url.path_segments_mut().expect("HTTP endpoint");
    segments.pop_if_empty();
    if !path.is_empty() {
        segments.extend(path.split('/'));
    }
}

#[derive(Deserialize)]
struct DavListing {
    #[serde(default)]
    response: Vec<DavEntry>,
}

#[derive(Deserialize)]
struct DavEntry {
    href: String,
    status: Option<String>,
    #[serde(default)]
    propstat: Vec<DavPropstat>,
}

#[derive(Deserialize)]
struct DavPropstat {
    status: String,
    prop: DavProperties,
}

impl DavPropstat {
    fn is_collection(&self) -> bool {
        dav_status(&self.status) == Some(StatusCode::OK)
            && self
                .prop
                .resourcetype
                .as_ref()
                .is_some_and(|kind| kind.collection.is_some())
    }
}

#[derive(Deserialize)]
struct DavProperties {
    resourcetype: Option<DavResourceType>,
}

#[derive(Deserialize)]
struct DavResourceType {
    collection: Option<()>,
}

fn dav_status(line: &str) -> Option<StatusCode> {
    StatusCode::from_bytes(line.split_whitespace().nth(1)?.as_bytes()).ok()
}

struct WebDavHttp(HttpClient);

impl HttpTransport for WebDavHttp {
    async fn fetch(&self, request: Request<Buffer>) -> opendal::Result<Response<HttpBody>> {
        let (parts, body) = request.into_parts();
        let response = self
            .0
            .request(parts.method, parts.uri.to_string())
            .headers(parts.headers)
            .body(body.to_bytes())
            .send()
            .await
            .map_err(webdav_request_error)?;
        let status = response.status();
        // OpenDAL handles 404 for reads and directory creation. Map remote failures before
        // returning the body so errors cannot echo server-controlled credentials or URLs.
        if !status.is_success()
            && status != StatusCode::NOT_FOUND
            && !(status == StatusCode::METHOD_NOT_ALLOWED
                && parts.extensions.get::<opendal::raw::Operation>()
                    == Some(&opendal::raw::Operation::CreateDir))
        {
            return Err(webdav_status_error(status));
        }
        let headers = response.headers().clone();
        let length = response.content_length();
        let mut result = Response::new(HttpBody::new(
            response
                .bytes_stream()
                .try_filter(|bytes| future::ready(!bytes.is_empty()))
                .map_ok(Buffer::from)
                .map_err(webdav_request_error),
            length,
        ));
        *result.status_mut() = status;
        *result.headers_mut() = headers;
        Ok(result)
    }
}

fn webdav_request_error(error: reqwest::Error) -> opendal::Error {
    let reason = if error.is_timeout() {
        "连接或传输超时"
    } else {
        "无法连接服务器或读取响应"
    };
    opendal::Error::new(ErrorKind::Unexpected, reason)
}

fn webdav_status_error(status: StatusCode) -> opendal::Error {
    let kind = match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => ErrorKind::PermissionDenied,
        StatusCode::NOT_FOUND => ErrorKind::NotFound,
        StatusCode::METHOD_NOT_ALLOWED | StatusCode::NOT_IMPLEMENTED => ErrorKind::Unsupported,
        _ => ErrorKind::Unexpected,
    };
    opendal::Error::new(kind, format!("HTTP {}", status.as_u16()))
}

fn webdav_error(action: &str, error: &opendal::Error) -> String {
    let reason = match error.kind() {
        ErrorKind::PermissionDenied => "账号、密码错误或目录权限不足",
        ErrorKind::NotFound => "文件或目录不存在",
        ErrorKind::Unsupported => "服务器不支持此 WebDAV 操作",
        _ => {
            let message = error.message();
            if matches!(message, "连接或传输超时" | "无法连接服务器或读取响应")
                || (message.starts_with("HTTP ")
                    && message.len() == 8
                    && message[5..].bytes().all(|b| b.is_ascii_digit()))
            {
                message
            } else {
                "请检查服务器地址和 WebDAV 服务设置"
            }
        }
    };
    format!("WebDAV {action}失败，{reason}。")
}

fn webdav_root_missing() -> String {
    "WebDAV 配置的目录不存在。".into()
}

pub(crate) struct SmbClient {
    share: UncPath,
    root: String,
    username: String,
    password: String,
    session: OnceCell<SmbSession>,
}

impl SmbClient {
    pub(crate) fn new(config: &SmbConfig) -> Result<Self, String> {
        let host = config.host.trim();
        let share = config.share.trim();
        if host.is_empty()
            || !host
                .chars()
                .all(|ch| ch.is_alphanumeric() || ".-_:[]%".contains(ch))
        {
            return Err("请填写 SMB 服务器的主机名或 IP 地址。".into());
        }
        if !valid_segment(share)
            || share.eq_ignore_ascii_case("IPC$")
            || config.username.trim().is_empty()
        {
            return Err("请填写 SMB 共享名称和用户名。".into());
        }
        let share = UncPath::new(host)
            .and_then(|path| path.with_share(share))
            .map_err(|_| "SMB 服务器地址或共享名称无效。".to_string())?;
        let root = config.root.trim().replace('\\', "/");
        let root = checked_path(root.trim_matches('/'), true)?.to_owned();
        Ok(Self {
            share,
            root,
            username: config.username.trim().to_string(),
            password: config.password.clone(),
            session: OnceCell::new(),
        })
    }

    async fn session(&self) -> Result<&SmbSession, String> {
        self.session
            .get_or_try_init(|| async {
                // Keep paths on the configured share and avoid following DFS referrals.
                let session = SmbSession::new(ClientConfig {
                    dfs: false,
                    ..Default::default()
                });
                match tokio::time::timeout(
                    CONNECT_TIMEOUT,
                    session.share_connect(&self.share, &self.username, self.password.clone()),
                )
                .await
                {
                    Ok(Ok(())) => Ok(session),
                    result => {
                        let _ = session.close().await;
                        match result {
                            Ok(Err(error)) => Err(smb_error("连接", &error)),
                            _ => Err("SMB 连接超时，请检查服务器地址和网络。".into()),
                        }
                    }
                }
            })
            .await
    }

    pub(crate) async fn put_object(&self, key: &str, bytes: Vec<u8>) -> Result<(), String> {
        let key = checked_path(key, false)?;
        let parent = key.rsplit_once('/').map_or("", |(parent, _)| parent);
        let session = self.session().await?;
        let parent_handle = self
            .directory(session, parent, true, false)
            .await?
            .ok_or_else(|| "SMB 无法打开存储目录。".to_string())?;
        let temp_path = self
            .share
            .clone()
            .with_path(&with_parent(&self.root, &temporary_key(parent)));
        let resource = session
            .create_file(
                &temp_path,
                &FileCreateArgs {
                    disposition: CreateDisposition::Create,
                    attributes: FileAttributes::new(),
                    options: CreateOptions::new().with_non_directory_file(true),
                    desired_access: FileAccessMask::new()
                        .with_file_write_data(true)
                        .with_delete(true),
                },
            )
            .await
            .map_err(|error| smb_error("创建临时文件", &error))?;
        let Resource::File(file) = resource else {
            return Err("SMB 无法打开临时文件。".into());
        };

        let result = async {
            let mut offset = 0;
            while offset < bytes.len() {
                let end = (offset + SMB_BLOCK_SIZE).min(bytes.len());
                let written = file
                    .write_block(&bytes[offset..end], offset as u64, None)
                    .await
                    .map_err(|error| smb_error("写入临时文件", &SmbError::IoError(error)))?;
                if written == 0 || written > end - offset {
                    return Err("SMB 写入临时文件不完整。".to_string());
                }
                offset += written;
            }
            file.flush()
                .await
                .map_err(|error| smb_error("完成临时文件写入", &SmbError::IoError(error)))?;
            file.set_info(FileRenameInformation {
                replace_if_exists: true.into(),
                root_directory: 0,
                file_name: with_parent(&self.root, key).replace('/', "\\").into(),
            })
            .await
            .map_err(|error| smb_error("替换文件", &error))
        }
        .await;
        let close_result = file
            .close()
            .await
            .map_err(|error| smb_error("关闭文件", &error));
        if result.is_err() {
            // A lost rename reply may mean the move succeeded. Clean up by the
            // temporary path, since the original handle may now be the final file.
            remove_smb_temporary_file(session, &temp_path).await;
        }
        let _ = parent_handle.close().await;
        result.and(close_result)
    }

    pub(crate) async fn get_object(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        let key = checked_path(key, false)?;
        let parent = key.rsplit_once('/').map_or("", |(parent, _)| parent);
        let session = self.session().await?;
        let Some(parent_handle) = self.directory(session, parent, false, false).await? else {
            return Ok(None);
        };
        let path = self.share.clone().with_path(&with_parent(&self.root, key));
        let result = self.read_file(session, &path).await;
        let _ = parent_handle.close().await;
        result
    }

    async fn read_file(
        &self,
        session: &SmbSession,
        path: &UncPath,
    ) -> Result<Option<Vec<u8>>, String> {
        let resource = match session
            .create_file(
                path,
                &FileCreateArgs {
                    options: CreateOptions::new()
                        .with_non_directory_file(true)
                        .with_open_reparse_point(true),
                    ..FileCreateArgs::make_open_existing(
                        FileAccessMask::new()
                            .with_file_read_data(true)
                            .with_file_read_attributes(true),
                    )
                },
            )
            .await
        {
            Ok(resource) => resource,
            Err(error) if smb_missing(&error) => return Ok(None),
            Err(error) => return Err(smb_error("打开文件", &error)),
        };
        let Resource::File(file) = resource else {
            return Err("SMB 路径未指向普通文件。".into());
        };
        let result = async {
            self.check_handle(&file).await?;
            let mut data = Vec::new();
            let mut block = vec![0; SMB_BLOCK_SIZE];
            loop {
                let count = file
                    .read_block(&mut block, data.len() as u64, None, false)
                    .await
                    .map_err(|error| smb_error("读取文件", &SmbError::IoError(error)))?;
                if count == 0 {
                    return Ok(Some(data));
                }
                data.extend_from_slice(&block[..count]);
            }
        }
        .await;
        let _ = file.close().await;
        result
    }

    pub(crate) async fn list_prefixes(&self, prefix: &str) -> Result<Vec<String>, String> {
        let path = checked_prefix(prefix)?;
        let session = self.session().await?;
        let Some(directory) = self.directory(session, path, false, true).await? else {
            return Ok(Vec::new());
        };
        let directory = Arc::new(directory);
        let result = async {
            let mut entries = Directory::query::<FileDirectoryInformation>(&directory, "*")
                .await
                .map_err(|error| smb_error("列出目录", &error))?;
            let mut names = Vec::new();
            while let Some(entry) = tokio::time::timeout(CONNECT_TIMEOUT * 2, entries.try_next())
                .await
                .map_err(|_| "SMB 列出目录超时。".to_string())?
                .map_err(|error| smb_error("列出目录", &error))?
            {
                if entry.file_attributes.directory() && !entry.file_attributes.reparse_point() {
                    let name = entry.file_name.to_string();
                    if valid_segment(&name) {
                        names.push(name);
                    }
                }
            }
            names.sort_unstable();
            names.dedup();
            Ok(names)
        }
        .await;
        let _ = directory.close().await;
        result
    }

    pub(crate) async fn test(&self) -> Result<String, String> {
        self.list_prefixes("").await?;
        Ok("SMB 连接成功，配置目录可读取。".into())
    }

    async fn directory(
        &self,
        session: &SmbSession,
        relative: &str,
        create: bool,
        list: bool,
    ) -> Result<Option<Directory>, String> {
        let complete = with_parent(&self.root, relative);
        if complete.is_empty() {
            let directory = self
                .open_directory(session, "", CreateDisposition::Open, list)
                .await
                .map_err(|error| smb_error("打开共享目录", &error))?;
            return Ok(Some(directory));
        }

        let mut path = String::new();
        let mut components = complete.split('/').peekable();
        while let Some(component) = components.next() {
            path = with_parent(&path, component);
            let final_component = components.peek().is_none();
            let in_root = self.root == path
                || self
                    .root
                    .strip_prefix(&path)
                    .is_some_and(|suffix| suffix.starts_with('/'));
            let directory = match self
                .open_directory(
                    session,
                    &path,
                    CreateDisposition::Open,
                    list && final_component,
                )
                .await
            {
                Ok(directory) => directory,
                Err(error) if smb_missing(&error) && in_root => {
                    return Err("SMB 配置的目录不存在。".into());
                }
                Err(error) if smb_missing(&error) && create => self
                    .open_directory(session, &path, CreateDisposition::OpenIf, false)
                    .await
                    .map_err(|error| smb_error("创建目录", &error))?,
                Err(error) if smb_missing(&error) => return Ok(None),
                Err(error) => return Err(smb_error("打开目录", &error)),
            };
            if let Err(error) = self.check_handle(&directory).await {
                let _ = directory.close().await;
                return Err(error);
            }
            if final_component {
                return Ok(Some(directory));
            }
            let _ = directory.close().await;
        }
        unreachable!("nonempty SMB directory")
    }

    async fn open_directory(
        &self,
        session: &SmbSession,
        path: &str,
        disposition: CreateDisposition,
        list: bool,
    ) -> Result<Directory, SmbError> {
        let resource = session
            .create_file(
                &self.share.clone().with_path(path),
                &FileCreateArgs {
                    disposition,
                    attributes: FileAttributes::new().with_directory(true),
                    options: CreateOptions::new()
                        .with_directory_file(true)
                        .with_open_reparse_point(true),
                    // The read-data access bit means list-directory for directories.
                    desired_access: FileAccessMask::new()
                        .with_file_read_attributes(true)
                        .with_file_read_data(list),
                },
            )
            .await?;
        match resource {
            Resource::Directory(directory) => Ok(directory),
            _ => Err(SmbError::UnexpectedMessageStatus(
                Status::U32_FILE_IS_A_DIRECTORY,
            )),
        }
    }

    async fn check_handle(&self, handle: &ResourceHandle) -> Result<(), String> {
        let attributes = handle
            .query_info::<FileAttributeTagInformation>()
            .await
            .map_err(|error| smb_error("检查路径", &error))?;
        if attributes.file_attributes.reparse_point() {
            return Err("SMB 存储路径中包含符号链接或目录联接。".into());
        }
        Ok(())
    }
}

impl Drop for SmbClient {
    fn drop(&mut self) {
        if let (Some(session), Ok(runtime)) =
            (self.session.take(), tokio::runtime::Handle::try_current())
        {
            runtime.spawn(async move {
                let _ = session.close().await;
            });
        }
    }
}

const SMB_BLOCK_SIZE: usize = 64 * 1024;
const STATUS_NO_SUCH_FILE: u32 = 0xC000000F;

async fn remove_smb_temporary_file(session: &SmbSession, path: &UncPath) {
    let request = FileCreateArgs {
        options: CreateOptions::new()
            .with_non_directory_file(true)
            .with_open_reparse_point(true),
        ..FileCreateArgs::make_open_existing(FileAccessMask::new().with_delete(true))
    };
    if let Ok(Resource::File(file)) = session.create_file(path, &request).await {
        let _ = file.set_info(FileDispositionInformation::default()).await;
        let _ = file.close().await;
    }
}

fn smb_status(error: &SmbError) -> Option<u32> {
    match error {
        SmbError::UnexpectedMessageStatus(status) | SmbError::ReceivedErrorMessage(status, _) => {
            Some(*status)
        }
        _ => None,
    }
}

fn smb_missing(error: &SmbError) -> bool {
    matches!(
        smb_status(error),
        Some(
            Status::U32_OBJECT_NAME_NOT_FOUND
                | Status::U32_OBJECT_PATH_NOT_FOUND
                | STATUS_NO_SUCH_FILE
        )
    )
}

fn smb_error(action: &str, error: &SmbError) -> String {
    let status = smb_status(error);
    let reason = match (status, error) {
        (Some(Status::U32_BAD_NETWORK_NAME), _) => "指定的共享不存在",
        (
            Some(
                Status::U32_ACCESS_DENIED
                | Status::U32_LOGON_FAILURE
                | Status::U32_USER_ACCOUNT_LOCKED_OUT,
            ),
            _,
        )
        | (_, SmbError::MissingPermissions(_) | SmbError::SspiError(_)) => {
            "账号、密码错误或目录权限不足"
        }
        (Some(Status::U32_STOPPED_ON_SYMLINK), _) => "存储路径中包含符号链接",
        (Some(Status::U32_SHARING_VIOLATION), _) => "文件被其他程序占用",
        (Some(Status::U32_NOT_SUPPORTED), _) => "服务器不支持此 SMB 操作",
        (_, SmbError::IoError(error))
            if error.kind() == std::io::ErrorKind::PermissionDenied
                || error.to_string().contains("(0xc0000022)") =>
        {
            "目录权限不足"
        }
        _ if smb_missing(error) => "文件或目录不存在",
        (_, SmbError::OperationTimeout(_, _)) => "操作超时，请检查网络",
        (_, SmbError::TransportError(_) | SmbError::ConnectionStopped | SmbError::IoError(_)) => {
            "无法连接服务器或传输中断"
        }
        (_, SmbError::NegotiationError(_)) => "请检查服务器是否启用了 SMB2 或 SMB3",
        _ => "请检查服务器地址、目录和 SMB 服务设置",
    };
    format!("SMB {action}失败，{reason}。")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;
    use tokio::task::JoinHandle;

    async fn webdav_fixture(
        status: StatusCode,
        body: impl FnOnce(&str) -> String,
    ) -> (WebDavClient, JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let body = body(&endpoint);
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(&mut socket);
            let mut request = String::new();
            reader.read_line(&mut request).await.unwrap();
            let mut body_len = 0;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).await.unwrap() == 0 || line == "\r\n" {
                    break;
                }
                if let Some((name, value)) = line.split_once(':') {
                    if name.eq_ignore_ascii_case("Content-Length") {
                        body_len = value.trim().parse().unwrap();
                    }
                }
            }
            reader.read_exact(&mut vec![0; body_len]).await.unwrap();
            socket.write_all(format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            ).as_bytes()).await.unwrap();
            request
        });
        let client = WebDavClient::new(&WebDavConfig {
            endpoint: format!("{endpoint}/dav"),
            root: "资料".into(),
            ..Default::default()
        })
        .unwrap();
        (client, server)
    }

    #[tokio::test]
    async fn webdav_lists_only_direct_collections_with_either_href_form() {
        let (client, request) = webdav_fixture(StatusCode::MULTI_STATUS, |endpoint| {
            let mut xml = String::from(r#"<D:multistatus xmlns:D="DAV:">"#);
            for href in [
                "/dav/%E8%B5%84%E6%96%99/orders/".to_owned(),
                format!("{endpoint}/dav/%E8%B5%84%E6%96%99/orders/one/"),
                "/dav/%E8%B5%84%E6%96%99/orders/%E8%AE%A2%E5%8D%95/".to_owned(),
                "/dav/%E8%B5%84%E6%96%99/orders/one/nested/".to_owned(),
                "https://another.example/dav/%E8%B5%84%E6%96%99/orders/outside/".to_owned(),
            ] {
                xml.push_str(&format!(
                    "<D:response><D:href>{href}</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>"
                ));
            }
            xml.push_str("</D:multistatus>");
            xml
        }).await;
        assert_eq!(
            client.list_prefixes("orders/").await.unwrap(),
            ["one", "订单"]
        );
        assert_eq!(
            request.await.unwrap(),
            "PROPFIND /dav/%E8%B5%84%E6%96%99/orders/ HTTP/1.1\r\n"
        );
    }

    #[tokio::test]
    async fn webdav_connection_test_reports_authentication_failure_safely() {
        let (client, request) = webdav_fixture(StatusCode::UNAUTHORIZED, |_| {
            "server response must not be surfaced".into()
        })
        .await;
        let error = client.test().await.unwrap_err();
        assert!(
            error.contains("权限") && !error.contains("server response"),
            "{error}"
        );
        assert_eq!(
            request.await.unwrap(),
            "PROPFIND /dav/%E8%B5%84%E6%96%99/ HTTP/1.1\r\n"
        );
    }

    #[test]
    fn object_paths_stay_relative_to_the_configured_directory() {
        for unsafe_path in [
            "",
            "/",
            "/outside",
            "orders//file",
            "orders/../file",
            "orders/./file",
            "orders/.. /file",
            "orders\\outside",
            "orders/file:stream",
            "orders/file.",
            "orders/%2e%2e/file",
            "orders/file\n",
        ] {
            assert!(!valid_path(unsafe_path, false), "{unsafe_path:?}");
        }
        assert!(valid_path("orders/中文订单/manifest.json", false));
        assert!(valid_path("", true));
    }
}
