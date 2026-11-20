//! AI 抠图客户端：直连 PicWish 分割服务，sha256 内容寻址本地缓存。
//!
//! 语义对齐 server/internal/modules/library/cutout.go：
//! 同图（字节级）命中缓存直接复用、不再计费；≤25MB 输入；PNG 落盘
//! `数据根/cutout/<sha256前16字节hex>.png`。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use sha2::{Digest, Sha256};

/* ---------- 配置（数据根/cutout.json） ---------- */

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CutoutConfig {
    /// PicWish X-API-KEY；留空则回退环境变量 PIC_PICWISH_API_KEY，再回退内置默认
    pub api_key: String,
    /// 分割类型：person（人物）/ product（商品）
    pub kind: String,
    /// 请求超时秒（下限 30）
    pub timeout_secs: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn fixture(fail: bool) -> (CutoutClient, PathBuf, tokio::task::JoinHandle<()>) {
        let root = std::env::temp_dir().join(format!(
            "paidan-cutout-{}",
            crate::store::random_hex_pub(12)
        ));
        let cache_dir = root.join("cutout");
        std::fs::create_dir_all(&cache_dir).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let result_url = format!("{base_url}/result.png");
        let task = tokio::spawn(async move {
            for _ in 0..if fail { 1 } else { 2 } {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 4096];
                loop {
                    let n = socket.read(&mut buffer).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..n]);
                    if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                let (key, value) = line.split_once(':')?;
                                key.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                let (status, body) = if fail {
                    ("429 Too Many Requests", b"rate limited".to_vec())
                } else if request.starts_with(b"POST ") {
                    (
                        "200 OK",
                        serde_json::json!({"status":200,"data":{"state":1,"image":result_url}})
                            .to_string()
                            .into_bytes(),
                    )
                } else {
                    ("200 OK", b"fake-png-result".to_vec())
                };
                let header = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                socket.write_all(header.as_bytes()).await.unwrap();
                socket.write_all(&body).await.unwrap();
            }
        });
        let client = CutoutClient {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(3))
                .build()
                .unwrap(),
            api_key: "test-key-never-log".into(),
            kind: "person".into(),
            base_url,
            cache_dir,
        };
        (client, root, task)
    }

    #[tokio::test]
    async fn logs_request_stages_and_reuses_cached_result() {
        let (client, root, server) = fixture(false).await;
        let first = client.cutout(b"original-photo".to_vec()).await.unwrap();
        assert!(!first.cached);
        assert_eq!(B64.decode(first.png_b64).unwrap(), b"fake-png-result");
        server.await.unwrap();
        // The server has stopped: a second successful request must use the cache.
        let second = client.cutout(b"original-photo".to_vec()).await.unwrap();
        assert!(second.cached);
        let log = std::fs::read_to_string(root.join("cutout.log"))
            .expect("cutout diagnostics must be persisted");
        for stage in [
            "request_start",
            "upstream_response",
            "task_response",
            "download_response",
            "complete",
            "cache_hit",
        ] {
            assert!(log.contains(stage), "missing stage {stage}: {log}");
        }
        assert!(log.contains("elapsed_ms="));
        assert!(!log.contains("test-key-never-log"));
        assert!(!log.contains("original-photo"));
    }

    #[tokio::test]
    async fn logs_http_failures_without_caching_them() {
        let (client, root, server) = fixture(true).await;
        let error = client
            .cutout(b"different-photo".to_vec())
            .await
            .err()
            .unwrap();
        assert!(error.contains("频繁"));
        server.await.unwrap();
        let log = std::fs::read_to_string(root.join("cutout.log"))
            .expect("failed requests must also be logged");
        assert!(log.contains("http=429"));
        assert!(log.contains("failed"));
        assert_eq!(std::fs::read_dir(root.join("cutout")).unwrap().count(), 0);
    }
}

impl Default for CutoutConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            kind: "person".into(),
            timeout_secs: 90,
        }
    }
}

pub fn config_path(data_root: &Path) -> PathBuf {
    data_root.join("cutout.json")
}

pub fn load_config(data_root: &Path) -> CutoutConfig {
    match std::fs::read_to_string(config_path(data_root)) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| CutoutConfig {
            api_key: String::new(),
            kind: "person".into(),
            timeout_secs: 90,
        }),
        Err(_) => CutoutConfig {
            api_key: String::new(),
            kind: "person".into(),
            timeout_secs: 90,
        },
    }
}

pub fn save_config(data_root: &Path, config: &CutoutConfig) -> Result<(), String> {
    let text = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    std::fs::write(config_path(data_root), text).map_err(|error| error.to_string())
}

const MAX_IMAGE_BYTES: usize = 25 << 20; // 25MB，与 Go server maxImageBytes 一致
const MAX_RESULT_BYTES: u64 = 50 << 20; // 50MB，与 picWishDownload 上限一致
const CLIENT_TIMEOUT_SECS: u64 = 90;
/// 环境变量优先；缺省回退到与 server 相同的测试密钥。
const DEFAULT_API_KEY: &str = "wxfcm9m0237phwxwo";
const DEFAULT_BASE_URL: &str = "https://techsz.aoscdn.com";

pub struct CutoutResult {
    pub png_b64: String,
    pub cached: bool,
}

pub struct CutoutClient {
    http: reqwest::Client,
    api_key: String,
    kind: String,
    base_url: String,
    cache_dir: PathBuf,
}

struct CutoutTrace {
    path: PathBuf,
    id: String,
    started: Instant,
}

impl CutoutTrace {
    fn new(cache_dir: &Path) -> Self {
        Self {
            path: cache_dir.parent().unwrap_or(cache_dir).join("cutout.log"),
            id: format!(
                "{}-{:08x}",
                chrono::Utc::now().timestamp_millis(),
                rand::random::<u32>()
            ),
            started: Instant::now(),
        }
    }

    fn record(&self, stage: &str, detail: &str) {
        let line = format!(
            "{} request={} elapsed_ms={} stage={} {}",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
            self.id,
            self.started.elapsed().as_millis(),
            stage,
            detail.replace(['\r', '\n'], " "),
        );
        match std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
        {
            Ok(mut file) => {
                if let Err(error) = writeln!(file, "{line}") {
                    eprintln!("[cutout] 日志写入失败: {error}");
                }
            }
            Err(error) => eprintln!("[cutout] 日志打开失败: {error}"),
        }
    }
}

impl CutoutClient {
    pub fn new(config: &CutoutConfig, cache_dir: PathBuf) -> Self {
        // 密钥优先级：设置文件非空 → 环境变量 → 内置默认
        let api_key = if !config.api_key.is_empty() {
            config.api_key.clone()
        } else {
            std::env::var("PIC_PICWISH_API_KEY").unwrap_or_else(|_| DEFAULT_API_KEY.to_string())
        };
        let kind = if config.kind.is_empty() {
            "person".into()
        } else {
            config.kind.clone()
        };
        let timeout_secs = if config.timeout_secs >= 30 {
            config.timeout_secs
        } else {
            90
        };
        let base_url =
            std::env::var("PIC_PICWISH_API_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.to_string());
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(timeout_secs))
            .build()
            .expect("抠图 HTTP 客户端构建失败");
        let _ = std::fs::create_dir_all(&cache_dir);
        Self {
            http,
            api_key,
            kind,
            base_url,
            cache_dir,
        }
    }

    /// 主入口：字节 → 缓存查询 → 未命中调 PicWish → 写缓存 → 返回 PNG base64。
    pub async fn cutout(&self, bytes: Vec<u8>) -> Result<CutoutResult, String> {
        let trace = CutoutTrace::new(&self.cache_dir);
        trace.record(
            "request_start",
            &format!("input_bytes={} kind={}", bytes.len(), self.kind),
        );
        let result = self.cutout_traced(bytes, &trace).await;
        match &result {
            Ok(value) => trace.record("complete", &format!("cached={}", value.cached)),
            Err(error) => {
                let detail = if self.api_key.is_empty() {
                    error.clone()
                } else {
                    error.replace(&self.api_key, "[redacted]")
                };
                trace.record("failed", &detail);
            }
        }
        result
    }

    async fn cutout_traced(
        &self,
        bytes: Vec<u8>,
        trace: &CutoutTrace,
    ) -> Result<CutoutResult, String> {
        if bytes.is_empty() {
            return Err("图片数据为空。".into());
        }
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(format!(
                "图片超过 {}MB 上限，请先缩小后重试。",
                MAX_IMAGE_BYTES >> 20
            ));
        }

        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let digest = hasher.finalize();
        let cache_id: String = digest[..16].iter().map(|b| format!("{b:02x}")).collect();
        let cache_path = self.cache_dir.join(format!("{cache_id}.png"));

        if let Ok(existing) = std::fs::read(&cache_path) {
            if !existing.is_empty() {
                trace.record("cache_hit", &format!("output_bytes={}", existing.len()));
                return Ok(CutoutResult {
                    png_b64: B64.encode(&existing),
                    cached: true,
                });
            }
        }

        trace.record("cache_miss", "");
        let png = self.request_picwish(bytes, trace).await?;
        // 原子写缓存：临时文件 + rename，避免并发写半截文件。
        let tmp = cache_path.with_extension("tmp");
        std::fs::write(&tmp, &png).map_err(|error| format!("缓存写入失败：{error}"))?;
        std::fs::rename(&tmp, &cache_path).map_err(|error| format!("缓存提交失败：{error}"))?;
        Ok(CutoutResult {
            png_b64: B64.encode(&png),
            cached: false,
        })
    }

    async fn request_picwish(
        &self,
        bytes: Vec<u8>,
        trace: &CutoutTrace,
    ) -> Result<Vec<u8>, String> {
        let url = format!(
            "{}/api/tasks/visual/segmentation",
            self.base_url.trim_end_matches('/')
        );
        let kind = self.kind.clone();
        let form = reqwest::multipart::Form::new()
            .part(
                "image_file",
                reqwest::multipart::Part::bytes(bytes).file_name("photo.png"),
            )
            .text("sync", "1")
            .text("type", kind)
            .text("return_type", "1")
            .text("output_type", "2")
            .text("crop", "1")
            .text("format", "png");
        let upstream_started = Instant::now();
        trace.record("upstream_start", "upload_and_processing");
        let response = self
            .http
            .post(&url)
            .header("X-API-KEY", &self.api_key)
            .multipart(form)
            .send()
            .await
            .map_err(|error| format!("AI 抠图处理请求失败：{}", error.without_url()))?;
        trace.record(
            "upstream_response",
            &format!(
                "http={} stage_ms={}",
                response.status().as_u16(),
                upstream_started.elapsed().as_millis()
            ),
        );

        if !response.status().is_success() {
            return Err(match response.status().as_u16() {
                401 | 403 => "AI 抠图服务密钥无效，请在设置中检查配置。".to_string(),
                429 => "AI 抠图请求过于频繁或今日次数已用完，请稍后再试。".to_string(),
                code => format!("AI 抠图服务返回错误（HTTP {code}），请稍后重试。"),
            });
        }

        let payload: serde_json::Value = response
            .json()
            .await
            .map_err(|error| format!("AI 抠图返回解析失败：{error}"))?;
        let status = payload.get("status").and_then(|v| v.as_i64()).unwrap_or(0);
        let state = payload
            .pointer("/data/state")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        trace.record(
            "task_response",
            &format!("api_status={status} state={state}"),
        );
        if !(200..300).contains(&status) {
            return Err(payload
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("AI 抠图返回异常，请稍后重试。")
                .to_string());
        }
        let image = payload
            .pointer("/data/image")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "AI 抠图未返回结果图片，请稍后重试。".to_string())?;
        if state != 1 {
            return Err(format!("AI 抠图任务未完成（state={state}），请稍后重试。"));
        }

        let download_started = Instant::now();
        trace.record("download_start", "");
        let png = self
            .http
            .get(image)
            .send()
            .await
            .map_err(|error| format!("AI 抠图结果下载失败：{}", error.without_url()))?;
        trace.record(
            "download_response",
            &format!("http={}", png.status().as_u16()),
        );
        if !png.status().is_success() {
            return Err("AI 抠图结果下载失败，请稍后重试。".into());
        }
        let body = png
            .bytes()
            .await
            .map_err(|error| format!("AI 抠图结果读取失败：{error}"))?;
        if body.len() as u64 > MAX_RESULT_BYTES {
            return Err("AI 抠图结果超出大小上限。".into());
        }
        trace.record(
            "download_complete",
            &format!(
                "output_bytes={} stage_ms={}",
                body.len(),
                download_started.elapsed().as_millis()
            ),
        );
        Ok(body.to_vec())
    }
}
