//! 引擎：`execute(model, token) -> HttpResult`——纯执行，不碰 DB。
//!
//! 错误分野（编排层据此落 Run Record 终态）：
//! - 用户取消（token 触发）→ `CANCELLED`；
//! - 超时（reqwest per-request timeout 终止）→ `TIMEOUT`（归 failed，非用户取消）；
//! - multipart 文件 part 打开失败（不存在 / 不可读）→ `IO_OPEN_PATH_FAILED`
//!   （发送前构建阶段即失败，不落响应数据）；
//! - 其余传输层失败（连接拒绝 / DNS / TLS / 构建 / 读体）→ `HTTP_REQUEST_FAILED`。

use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::error::codes;

use super::request::{BodyKind, MultipartField, RequestModel, serialize_urlencoded};
use super::response::{BodySink, ResponseHandle, read_body};

/// 引擎结果：响应句柄＋实际发送镜像（总耗时由编排层计时落库，引擎不重复计时）。
#[derive(Debug, Clone)]
pub struct HttpResult {
    pub response: ResponseHandle,
    pub sent: SentRequestMirror,
}

/// 响应头快照（发送落定、读体前）：SSE 升级判定面——GUI 普通发送在响应头
/// 到达时判定事件流响应，命中则转入流式收体（send.rs 升级链路），否则走
/// 普通收体（分级落盘）。`response` 随体消费（读取所有权移交收体方）。
pub struct ResponseHead {
    pub response: reqwest::Response,
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub content_type: Option<String>,
    /// 重定向后最终 URL（镜像与快照的 url 源）
    pub final_url: String,
}

/// 事件流响应判定：Content-Type 为 `text/event-stream`（容忍参数后缀
/// `;charset=...` 与大小写差异）——普通发送升级与 SSE 链路的共同单点。
pub fn is_event_stream(content_type: &Option<String>) -> bool {
    content_type.as_deref().is_some_and(|ct| {
        let ct = ct.trim().to_ascii_lowercase();
        ct == "text/event-stream" || ct.starts_with("text/event-stream;")
    })
}

/// 实际发送镜像：最终 URL（重定向后）＋模型头（含认证注入）＋发送体素材。
/// 供 Run Record 留痕（快照存明文、展示脱敏）与 GUI「已发送请求」回显。
#[derive(Debug, Clone)]
pub struct SentRequestMirror {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    /// 发送体素材（None＝无体；excerpt 口径见 response 模块）
    pub body_bytes: Option<Vec<u8>>,
}

/// 实际发送镜像组装（普通收体与 SSE 升级收体共用）。
pub fn sent_mirror(model: &RequestModel, final_url: String) -> SentRequestMirror {
    SentRequestMirror {
        method: model.method.as_str().to_string(),
        url: final_url,
        headers: model
            .headers
            .iter()
            .filter(|r| r.enabled)
            .map(|r| (r.key.clone(), r.value.clone()))
            .collect(),
        body_bytes: body_bytes_of(model),
    }
}

/// 构建＋发送＋读响应头（取消点在等响应头阶段；传输错误映射单点）。
/// 调用方在此分岔：事件流响应转流式收体（`is_event_stream` 判定），否则
/// `read_response_body` 普通收体。构建含文件 part 的异步文件打开（失败＝
/// 文件不存在 / 不可读的稳定错误码，路径不入 message）。
pub async fn send_request(
    client: reqwest::Client,
    timeout: Option<Duration>,
    model: &RequestModel,
    token: &CancellationToken,
) -> Result<ResponseHead, AppError> {
    let builder = build_request(&client, timeout, model).await?;
    let response = tokio::select! {
        res = builder.send() => res.map_err(map_transport_error)?,
        _ = token.cancelled() => return Err(AppError::new(
            codes::CANCELLED,
            "request cancelled by user",
        )),
    };
    let final_url = response.url().to_string();
    let status = response.status().as_u16();
    let headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    Ok(ResponseHead {
        response,
        status,
        headers,
        content_type,
        final_url,
    })
}

/// 普通收体：读响应体（分级落盘体系）＋组装引擎结果。
pub async fn read_response_body(
    head: ResponseHead,
    model: &RequestModel,
    sink: &BodySink<'_>,
) -> Result<HttpResult, AppError> {
    let (body, preview) = read_body(head.response, sink).await?;
    Ok(HttpResult {
        response: ResponseHandle {
            status: head.status,
            headers: head.headers,
            content_type: head.content_type,
            body,
            preview,
        },
        sent: sent_mirror(model, head.final_url),
    })
}

/// 从合成产物构建 reqwest 请求（方法 / per-request 超时 / 头 / 体的单点收敛）：
/// 普通发送与 SSE 流共用的构建面——普通发送＝构建＋执行＋收体；SSE＝构建＋流式收体。
/// multipart 文件 part 的打开是异步 IO（流式承载、不整包驻内存），故构建面
/// 为 async；文件不存在 / 不可读返回 `IO_OPEN_PATH_FAILED`。
pub async fn build_request(
    client: &reqwest::Client,
    timeout: Option<Duration>,
    model: &RequestModel,
) -> Result<reqwest::RequestBuilder, AppError> {
    let mut builder = client.request(
        reqwest::Method::from_bytes(model.method.as_str().as_bytes())
            .expect("七选方法恒可转 reqwest::Method"),
        &model.url,
    );
    if let Some(timeout) = timeout {
        builder = builder.timeout(timeout);
    }
    for row in model
        .headers
        .iter()
        .filter(|r| r.enabled && !r.key.is_empty())
    {
        builder = builder.header(&row.key, &row.value);
    }
    attach_body(builder, model).await
}

async fn attach_body(
    builder: reqwest::RequestBuilder,
    model: &RequestModel,
) -> Result<reqwest::RequestBuilder, AppError> {
    match &model.body {
        BodyKind::None => Ok(builder),
        BodyKind::Json(value) => Ok(builder.json(value)),
        BodyKind::FormUrlEncoded(rows) => {
            // 发送体与镜像共用 serialize_urlencoded 单源（镜像＝真实发送字节）；
            // 默认 Content-Type 仅在用户未显式设置时插入（显式头恒优先）
            let encoded = serialize_urlencoded(rows);
            let has_explicit_content_type = model.headers.iter().any(|r| {
                r.enabled && !r.key.is_empty() && r.key.eq_ignore_ascii_case("content-type")
            });
            let builder = if has_explicit_content_type {
                builder
            } else {
                builder.header(
                    reqwest::header::CONTENT_TYPE,
                    "application/x-www-form-urlencoded",
                )
            };
            Ok(builder.body(encoded.into_bytes()))
        }
        BodyKind::Multipart(fields) => {
            let mut form = reqwest::multipart::Form::new();
            for field in fields {
                match field {
                    MultipartField::Text { name, value } => {
                        form = form.text(name.clone(), value.clone());
                    }
                    MultipartField::File { name, path } => {
                        form = form.part(name.clone(), file_part(name, path).await?);
                    }
                }
            }
            Ok(builder.multipart(form))
        }
        BodyKind::Raw {
            bytes,
            content_type,
        } => {
            if content_type.is_empty() {
                Ok(builder.body(bytes.clone()))
            } else {
                Ok(builder
                    .header(reqwest::header::CONTENT_TYPE, content_type)
                    .body(bytes.clone()))
            }
        }
    }
}

/// 发送文件名＝路径 basename（Windows 反斜杠与 POSIX 正斜杠分隔都容忍）。
fn file_base_name(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

/// 按扩展名推断 mime 的常见映射集（小写比较）；未知 / 无扩展名回落
/// `application/octet-stream`。返回值恒为合法 MIME 串（静态常量）。
fn guess_mime(path: &str) -> &'static str {
    let Some((_, ext)) = path.rsplit_once('.') else {
        return "application/octet-stream";
    };
    match ext.to_ascii_lowercase().as_str() {
        "txt" | "text" | "log" | "csv" => "text/plain",
        "htm" | "html" => "text/html",
        "xml" => "application/xml",
        "json" | "geojson" => "application/json",
        "yaml" | "yml" => "application/yaml",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "md" => "text/markdown",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "tar" => "application/x-tar",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}

/// 文件 part：tokio 文件句柄经 ReaderStream 流式承载（按需分块读取，不整包
/// 驻内存），文件名＝路径 basename、mime 按扩展名推断。打开失败（不存在 /
/// 不可读）映射 `IO_OPEN_PATH_FAILED`——message 只含字段名与 IO 分类，路径
/// 不入 message（镜像与日志面同向静默）。
async fn file_part(field: &str, path: &str) -> Result<reqwest::multipart::Part, AppError> {
    let file = tokio::fs::File::open(std::path::Path::new(path))
        .await
        .map_err(|e| {
            AppError::new(
                codes::IO_OPEN_PATH_FAILED,
                format!("multipart file field \"{field}\" cannot be opened: {e}"),
            )
        })?;
    let body = reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(file));
    Ok(reqwest::multipart::Part::stream(body)
        .file_name(file_base_name(path).to_string())
        // mime 值出自静态映射常量，恒可被 reqwest 解析
        .mime_str(guess_mime(path))
        .expect("推断表恒为合法 MIME 串"))
}

/// multipart 镜像前缀：明示镜像性质（文本与文件字段名的可读枚举、非 wire
/// 字节，文件内容字节不入镜像），消费方一眼可辨留痕与真实报文的差别。
const MULTIPART_MIRROR_PREFIX: &str =
    "multipart 字段镜像（非 wire 字节；文件字段以 name=文件名 记录、文件字节不入镜像）：";

/// multipart 字段镜像（人读留痕）：文本字段 `k=v`、文件字段 `name=文件名`
/// 以 `&` 连接，前缀明示镜像与真实 multipart wire 字节（boundary 分隔多段）
/// 的差别，不伪造边界、不携带文件内容。
fn multipart_mirror(fields: &[MultipartField]) -> String {
    let mut out = String::from(MULTIPART_MIRROR_PREFIX);
    out.push_str(
        &fields
            .iter()
            .map(|f| match f {
                MultipartField::Text { name, value } => format!("{name}={value}"),
                MultipartField::File { name, path } => {
                    format!("{name}={}", file_base_name(path))
                }
            })
            .collect::<Vec<_>>()
            .join("&"),
    );
    out
}

fn body_bytes_of(model: &RequestModel) -> Option<Vec<u8>> {
    match &model.body {
        BodyKind::None => None,
        BodyKind::Raw { bytes, .. } => Some(bytes.clone()),
        BodyKind::Json(value) => Some(value.to_string().into_bytes()),
        // 与发送侧同一序列化函数：镜像＝真实发送字节（同一过滤与编码口径）
        BodyKind::FormUrlEncoded(rows) => Some(serialize_urlencoded(rows).into_bytes()),
        // 文本与文件字段名的可读留痕，非 wire 字节（语义见 multipart_mirror）
        BodyKind::Multipart(fields) => Some(multipart_mirror(fields).into_bytes()),
    }
}

/// reqwest 错误 → 稳定码（TIMEOUT / HTTP_REQUEST_FAILED，details 携带传输层分类）。
/// 传输错误分类知识（超时 / 连接 / DNS / TLS 细分）单点收敛：普通发送与 SSE 流共用。
pub fn map_transport_error(e: reqwest::Error) -> AppError {
    if e.is_timeout() {
        AppError::new(codes::TIMEOUT, format!("request timed out: {e}"))
    } else {
        let kind = if e.is_connect() {
            "connect"
        } else if e.is_builder() {
            "builder"
        } else if e.is_decode() {
            "decode"
        } else if e.is_redirect() {
            "redirect"
        } else if e.is_body() {
            "body"
        } else if e.is_request() {
            "request"
        } else {
            "transport"
        };
        AppError::new(
            codes::HTTP_REQUEST_FAILED,
            format!("http request failed: {e}"),
        )
        .with_details(serde_json::json!({ "kind": kind }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::endpoint::Definition;
    use crate::domain::user_data_codec::KvRow;
    use crate::services::http::HttpService;
    use crate::services::http::request::{
        MultipartField, SendOverrides, SynthesisInput, synthesize,
    };
    use crate::services::http::response::BodySink;
    use tokio_util::sync::CancellationToken;

    /// 同进程内嵌靶机（dev-dependency，端口 0 免就绪探测）。
    async fn server() -> demo_server::DemoServer {
        demo_server::spawn_ephemeral()
            .await
            .expect("demo-server 自旋")
    }

    /// 端到端直通组合（测试面）：发送＋读头＋普通收体。生产链路在
    /// `send_request` 后按 `is_event_stream` 分岔（send.rs），此处直连验证
    /// 两段的组合行为与既有断言。
    async fn execute(
        client: reqwest::Client,
        timeout: Option<Duration>,
        model: &RequestModel,
        sink: &BodySink<'_>,
        token: &CancellationToken,
    ) -> Result<HttpResult, AppError> {
        let head = send_request(client, timeout, model, token).await?;
        read_response_body(head, model, sink).await
    }

    /// 测试临时目录（不碰生产数据目录）。
    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("apilot-engine-test-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn model_of(
        base: &str,
        method: crate::domain::endpoint::HttpMethod,
        path: &str,
        params_json: &str,
        headers_json: &str,
        body: Option<&str>,
    ) -> crate::services::http::request::RequestModel {
        let definition = Definition::new(method, path).unwrap();
        synthesize(&SynthesisInput {
            definition: &definition,
            base_url: Some(base),
            user_body: body,
            user_params: params_json,
            user_headers: headers_json,
            path_override: None,
            method_override: None,
            overrides: &SendOverrides::default(),
            base_url_override: None,
            variables: &[],
        })
        .unwrap()
        .model
    }

    #[tokio::test]
    async fn four_method_shapes_roundtrip_against_target() {
        let target = server().await;
        let base = target.base_url();
        let http = HttpService::new();
        let token = CancellationToken::new();
        let tmp = tmp_dir("four");

        // GET + query 形态
        let model = model_of(
            &base,
            crate::domain::endpoint::HttpMethod::GET,
            "/api/users",
            r#"[{"name":"keyword","value":"alice"}]"#,
            "[]",
            None,
        );
        let result = execute(
            http.client(),
            None,
            &model,
            &BodySink::File {
                root: &tmp,
                file_key: "http:tab:t1",
            },
            &token,
        )
        .await
        .unwrap();
        assert_eq!(result.response.status, 200);
        let body = match &result.response.body {
            super::super::response::BodyHandle::Memory { bytes } => bytes.clone(),
            other => panic!("小响应应入内存档: {other:?}"),
        };
        let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["total"], 1, "keyword 过滤应生效");
        assert!(
            result.sent.url.contains("/api/users?keyword=alice"),
            "url={}",
            result.sent.url
        );
        assert_eq!(result.sent.method, "GET");

        // POST + JSON body（无显式头时嗅探 application/json）
        let model = model_of(
            &base,
            crate::domain::endpoint::HttpMethod::POST,
            "/api/users",
            "[]",
            "[]",
            Some(r#"{"name":"Dave","email":"dave@example.com"}"#),
        );
        let result = execute(
            http.client(),
            None,
            &model,
            &BodySink::File {
                root: &tmp,
                file_key: "http:tab:t2",
            },
            &token,
        )
        .await
        .unwrap();
        assert_eq!(result.response.status, 201);

        // PUT + 三形态（body+path+header；X-Request-Id 必带）
        let model = model_of(
            &base,
            crate::domain::endpoint::HttpMethod::PUT,
            "/api/users/1",
            r#"[{"name":"id","value":"1"}]"#,
            r#"[{"name":"X-Request-Id","value":"req-1"}]"#,
            Some(r#"{"name":"A1","email":"a1@example.com"}"#),
        );
        let result = execute(
            http.client(),
            None,
            &model,
            &BodySink::File {
                root: &tmp,
                file_key: "http:tab:t3",
            },
            &token,
        )
        .await
        .unwrap();
        assert_eq!(result.response.status, 200);
        assert!(result.sent.headers.iter().any(|(k, _)| k == "X-Request-Id"));

        // DELETE + 204
        let model = model_of(
            &base,
            crate::domain::endpoint::HttpMethod::DELETE,
            "/api/users/2",
            "[]",
            "[]",
            None,
        );
        let result = execute(
            http.client(),
            None,
            &model,
            &BodySink::File {
                root: &tmp,
                file_key: "http:tab:t4",
            },
            &token,
        )
        .await
        .unwrap();
        assert_eq!(result.response.status, 204);

        target.shutdown();
    }

    /// multipart 文本字段上传（引擎通路直测）：手工构造模型钉住引擎
    /// multipart 文本 part 能力真实可用（合成面从信封 rows 映射，见
    /// request.rs 专项用例）。
    #[tokio::test]
    async fn multipart_upload_roundtrip_against_target() {
        let target = server().await;
        let base = target.base_url();
        let http = HttpService::new();
        let token = CancellationToken::new();
        let definition =
            Definition::new(crate::domain::endpoint::HttpMethod::POST, "/api/upload").unwrap();
        let model = synthesize(&SynthesisInput {
            definition: &definition,
            base_url: Some(&base),
            user_body: None,
            user_params: "[]",
            user_headers: "[]",
            path_override: None,
            method_override: None,
            overrides: &SendOverrides::default(),
            base_url_override: None,
            variables: &[],
        })
        .unwrap()
        .model;
        let model = RequestModel {
            body: BodyKind::Multipart(vec![super::super::request::MultipartField::Text {
                name: "payload".into(),
                value: "hello-upload".into(),
            }]),
            ..model
        };
        let result = execute(
            http.client(),
            None,
            &model,
            &BodySink::File {
                root: &tmp_dir("multipart"),
                file_key: "http:tab:mp",
            },
            &token,
        )
        .await
        .unwrap();
        assert_eq!(result.response.status, 200);
        let body = match &result.response.body {
            super::super::response::BodyHandle::Memory { bytes } => bytes.clone(),
            other => panic!("小响应应入内存档: {other:?}"),
        };
        let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["fields"][0]["name"], "payload");
        assert_eq!(parsed["fields"][0]["size"], 12, "回显字段尺寸");
        target.shutdown();
    }

    /// multipart 文件 part 上传（引擎通路直测，临时文件夹具）：文件字段以
    /// 真实文件字节发出，靶机回显 filename＝路径 basename、content_type＝
    /// 扩展名推断 mime、size＝文件字节数；文本字段与文件字段混合同体。
    #[tokio::test]
    async fn multipart_file_upload_roundtrip_against_target() {
        let target = server().await;
        let base = target.base_url();
        let http = HttpService::new();
        let token = CancellationToken::new();
        let dir = tmp_dir("multipart-file");
        let file_path = dir.join("avatar.png");
        let payload: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3];
        std::fs::write(&file_path, payload).unwrap();
        let definition =
            Definition::new(crate::domain::endpoint::HttpMethod::POST, "/api/upload").unwrap();
        let model = synthesize(&SynthesisInput {
            definition: &definition,
            base_url: Some(&base),
            user_body: None,
            user_params: "[]",
            user_headers: "[]",
            path_override: None,
            method_override: None,
            overrides: &SendOverrides::default(),
            base_url_override: None,
            variables: &[],
        })
        .unwrap()
        .model;
        let model = RequestModel {
            body: BodyKind::Multipart(vec![
                MultipartField::Text {
                    name: "note".into(),
                    value: "hi".into(),
                },
                MultipartField::File {
                    name: "attach".into(),
                    // 路径按平台原生形态直传（basename 双分隔容忍由单点直测覆盖）
                    path: file_path.to_string_lossy().into_owned(),
                },
            ]),
            ..model
        };
        let result = execute(
            http.client(),
            None,
            &model,
            &BodySink::File {
                root: &tmp_dir("multipart-file-resp"),
                file_key: "http:tab:mpf",
            },
            &token,
        )
        .await
        .unwrap();
        assert_eq!(result.response.status, 200);
        let body = match &result.response.body {
            super::super::response::BodyHandle::Memory { bytes } => bytes.clone(),
            other => panic!("小响应应入内存档: {other:?}"),
        };
        let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["fields"][0]["name"], "note");
        assert_eq!(parsed["fields"][0]["size"], 2, "文本字段尺寸");
        assert_eq!(parsed["fields"][1]["name"], "attach");
        assert_eq!(
            parsed["fields"][1]["filename"], "avatar.png",
            "文件名＝basename"
        );
        assert_eq!(
            parsed["fields"][1]["content_type"], "image/png",
            "mime 按扩展名推断"
        );
        assert_eq!(
            parsed["fields"][1]["size"],
            payload.len() as u64,
            "文件字节完整到达靶机"
        );
        target.shutdown();
    }

    /// 文件不存在 / 不可读的稳定错误码：构建阶段（发送前）即失败，
    /// `IO_OPEN_PATH_FAILED`；message 含字段名、不含路径（镜像与日志同向静默）。
    #[tokio::test]
    async fn multipart_file_part_missing_file_maps_to_io_error() {
        let http = HttpService::new();
        let definition =
            Definition::new(crate::domain::endpoint::HttpMethod::POST, "/api/upload").unwrap();
        let model = synthesize(&SynthesisInput {
            definition: &definition,
            base_url: Some("http://127.0.0.1:1"),
            user_body: None,
            user_params: "[]",
            user_headers: "[]",
            path_override: None,
            method_override: None,
            overrides: &SendOverrides::default(),
            base_url_override: None,
            variables: &[],
        })
        .unwrap()
        .model;
        let model = RequestModel {
            body: BodyKind::Multipart(vec![MultipartField::File {
                name: "attach".into(),
                path: std::env::temp_dir()
                    .join("apilot-definitely-missing-file.png")
                    .to_string_lossy()
                    .into_owned(),
            }]),
            ..model
        };
        let client = http.client();
        let err = build_request(&client, None, &model).await.unwrap_err();
        assert_eq!(err.code, codes::IO_OPEN_PATH_FAILED);
        assert!(
            err.message.contains("attach"),
            "定位到字段名: {}",
            err.message
        );
        assert!(
            !err.message.contains("apilot-definitely-missing-file"),
            "路径不入 message: {}",
            err.message
        );
    }

    /// mime 按扩展名推断（小写比较）与 basename 双分隔容忍的单点直测。
    #[test]
    fn mime_guess_and_basename_cover_common_shapes() {
        assert_eq!(guess_mime("a.png"), "image/png");
        assert_eq!(
            guess_mime("a.JSON"),
            "application/json",
            "扩展名大小写不敏感"
        );
        assert_eq!(guess_mime("dir/a.jpeg"), "image/jpeg");
        assert_eq!(guess_mime("C:\\tmp\\包.csv"), "text/plain");
        // 未知 / 无扩展名回落 octet-stream
        assert_eq!(guess_mime("a.unknownext"), "application/octet-stream");
        assert_eq!(guess_mime("noext"), "application/octet-stream");
        assert_eq!(guess_mime("dir.noext/file"), "application/octet-stream");

        assert_eq!(file_base_name("avatar.png"), "avatar.png");
        assert_eq!(file_base_name("C:\\tmp\\上传\\avatar.png"), "avatar.png");
        assert_eq!(file_base_name("/tmp/a.png"), "a.png");
        assert_eq!(file_base_name(""), "", "空路径 basename 为空");
    }

    #[tokio::test]
    async fn timeout_maps_to_timeout_code() {
        let target = server().await;
        let base = target.base_url();
        let http = HttpService::new();
        let token = CancellationToken::new();
        let model = model_of(
            &base,
            crate::domain::endpoint::HttpMethod::GET,
            "/api/slow",
            r#"[{"name":"ms","value":"3000"}]"#,
            "[]",
            None,
        );
        let err = execute(
            http.client(),
            Some(Duration::from_millis(200)),
            &model,
            &BodySink::File {
                root: &tmp_dir("timeout"),
                file_key: "http:tab:t5",
            },
            &token,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, codes::TIMEOUT);
        target.shutdown();
    }

    #[tokio::test]
    async fn cancel_maps_to_cancelled_code() {
        let target = server().await;
        let base = target.base_url();
        let http = HttpService::new();
        let token = CancellationToken::new();
        let model = model_of(
            &base,
            crate::domain::endpoint::HttpMethod::GET,
            "/api/slow",
            r#"[{"name":"ms","value":"5000"}]"#,
            "[]",
            None,
        );
        // 200ms 后取消（在 5s 慢响应完成前）
        let cancel_token = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            cancel_token.cancel();
        });
        let err = execute(
            http.client(),
            None,
            &model,
            &BodySink::File {
                root: &tmp_dir("cancel"),
                file_key: "http:tab:t6",
            },
            &token,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, codes::CANCELLED);
        target.shutdown();
    }

    #[tokio::test]
    async fn transport_failure_maps_to_request_failed() {
        // 127.0.0.1:1 无服务监听（特权端口，本机常驻服务不占用）：
        // 连接必被拒绝；并发测试占用临时端口的竞态由重试环吸收
        let http = HttpService::new();
        let token = CancellationToken::new();
        let model = model_of(
            "http://127.0.0.1:1",
            crate::domain::endpoint::HttpMethod::GET,
            "/healthz",
            "[]",
            "[]",
            None,
        );
        let tmp = tmp_dir("transport");
        let mut last: Option<AppError> = None;
        for _ in 0..3 {
            let result = execute(
                http.client(),
                None,
                &model,
                &BodySink::File {
                    root: &tmp,
                    file_key: "http:tab:t7",
                },
                &token,
            )
            .await;
            match result {
                Err(e) => {
                    assert_eq!(e.code, codes::HTTP_REQUEST_FAILED, "传输失败码: {}", e.code);
                    assert_eq!(e.details.as_ref().unwrap()["kind"], "connect");
                    return;
                }
                Ok(result) => {
                    // 罕见：该端口被本机服务占用——换一个高位关闭端口重试
                    last = Some(AppError::new(
                        codes::INTERNAL,
                        format!(
                            "unexpected success on port 1: status {}",
                            result.response.status
                        ),
                    ));
                }
            }
        }
        panic!("连接拒绝未被触发: {:?}", last);
    }

    #[tokio::test]
    async fn error_endpoint_status_passthrough() {
        let target = server().await;
        let base = target.base_url();
        let http = HttpService::new();
        let token = CancellationToken::new();
        // 4xx/5xx 是成功传输（引擎不视为错误——成败判定交消费者）
        let model = model_of(
            &base,
            crate::domain::endpoint::HttpMethod::GET,
            "/api/error/503",
            "[]",
            "[]",
            None,
        );
        let result = execute(
            http.client(),
            None,
            &model,
            &BodySink::File {
                root: &tmp_dir("status"),
                file_key: "http:tab:t8",
            },
            &token,
        )
        .await
        .unwrap();
        assert_eq!(result.response.status, 503);
        assert!(matches!(
            result.response.body,
            super::super::response::BodyHandle::Memory { .. }
        ));
        target.shutdown();
    }

    /// urlencoded 表体模型（复用合成产物填充非 body 字段）。
    fn urlencoded_model(rows: Vec<KvRow>) -> RequestModel {
        let definition =
            Definition::new(crate::domain::endpoint::HttpMethod::POST, "/api/form").unwrap();
        let model = synthesize(&SynthesisInput {
            definition: &definition,
            base_url: Some("http://127.0.0.1:1"),
            user_body: None,
            user_params: "[]",
            user_headers: "[]",
            path_override: None,
            method_override: None,
            overrides: &SendOverrides::default(),
            base_url_override: None,
            variables: &[],
        })
        .unwrap()
        .model;
        RequestModel {
            body: BodyKind::FormUrlEncoded(rows),
            ..model
        }
    }

    /// urlencoded 镜像与发送序列同源：build 产物的真实发送字节与镜像逐字节
    /// 一致（保留字符直通、中文 UTF-8 百分号、空格 `%20`、`&` / `=` 结构字符
    /// 编码不破坏形态）；空 key 行与禁用行不参与——发送与镜像同一过滤口径。
    #[tokio::test]
    async fn urlencoded_mirror_matches_sent_request_body() {
        let http = HttpService::new();
        let model = urlencoded_model(vec![
            KvRow::new("q", "a b&c=1"),
            KvRow::new("中文", "值 with space"),
            KvRow::new("kept", "a-b.c~d"),
            KvRow::new("", "skipped-empty-key"),
            KvRow {
                enabled: false,
                ..KvRow::new("disabled", "x")
            },
        ]);
        let client = http.client();
        let request = build_request(&client, None, &model)
            .await
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(
            request
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some("application/x-www-form-urlencoded"),
            "未显式设置时补默认 Content-Type"
        );
        let sent_bytes = match request.body() {
            Some(body) => body
                .as_bytes()
                .expect("urlencoded 发送体为内存字节")
                .to_vec(),
            None => panic!("urlencoded 发送应有体"),
        };
        let mirror = body_bytes_of(&model).expect("urlencoded 镜像应有体");
        assert_eq!(sent_bytes, mirror, "镜像与发送序列同源");
        assert_eq!(
            String::from_utf8(mirror).unwrap(),
            "q=a%20b%26c%3D1&%E4%B8%AD%E6%96%87=%E5%80%BC%20with%20space&kept=a-b.c~d",
        );
    }

    /// 用户显式 Content-Type 恒优先：默认 urlencoded 头不再叠加，发送体仍与
    /// 镜像同源。
    #[tokio::test]
    async fn urlencoded_default_content_type_yields_to_explicit_header() {
        let http = HttpService::new();
        let definition =
            Definition::new(crate::domain::endpoint::HttpMethod::POST, "/api/form").unwrap();
        let model = synthesize(&SynthesisInput {
            definition: &definition,
            base_url: Some("http://127.0.0.1:1"),
            user_body: None,
            user_params: "[]",
            user_headers: r#"[{"name":"Content-Type","value":"text/csv"}]"#,
            path_override: None,
            method_override: None,
            overrides: &SendOverrides::default(),
            base_url_override: None,
            variables: &[],
        })
        .unwrap()
        .model;
        let model = RequestModel {
            body: BodyKind::FormUrlEncoded(vec![KvRow::new("k", "v")]),
            ..model
        };
        let client = http.client();
        let request = build_request(&client, None, &model)
            .await
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(
            request
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some("text/csv"),
            "显式头恒优先"
        );
        let sent_bytes = request
            .body()
            .and_then(|b| b.as_bytes())
            .expect("urlencoded 有体");
        assert_eq!(
            sent_bytes,
            body_bytes_of(&model).expect("镜像有体").as_slice(),
            "镜像与发送序列同源"
        );
    }

    /// multipart 镜像＝字段名可读留痕：前缀明示「非 wire 字节；文件字段以
    /// name=文件名 记录、文件字节不入镜像」，文本字段 k=v 原样可读、文件字段
    /// 只入文件名（路径与字节都不入），不伪造 boundary。
    #[test]
    fn multipart_mirror_lists_field_names_with_file_basenames() {
        let model = RequestModel {
            method: crate::domain::endpoint::HttpMethod::POST,
            url: "http://127.0.0.1:1/api/upload".into(),
            headers: vec![],
            body: BodyKind::Multipart(vec![
                MultipartField::Text {
                    name: "payload".into(),
                    value: "hello-upload".into(),
                },
                MultipartField::Text {
                    name: "note".into(),
                    value: "a=b&c".into(),
                },
                MultipartField::File {
                    name: "attach".into(),
                    path: "C:\\用户数据\\avatar.png".into(),
                },
            ]),
        };
        let mirror =
            String::from_utf8(body_bytes_of(&model).expect("multipart 镜像应有体")).unwrap();
        assert!(
            mirror.starts_with("multipart 字段镜像（非 wire 字节；文件字段以 name=文件名 记录、文件字节不入镜像）："),
            "镜像须明示字段名枚举语义: {mirror}"
        );
        assert!(
            mirror.contains("payload=hello-upload"),
            "文本字段枚举可读: {mirror}"
        );
        assert!(mirror.contains("note=a=b&c"), "文本字段原样可读: {mirror}");
        assert!(
            mirror.contains("attach=avatar.png"),
            "文件字段以 name=文件名 入枚举: {mirror}"
        );
        assert!(
            !mirror.contains("用户数据"),
            "文件字段路径不入镜像: {mirror}"
        );
    }

    /// 事件流判定：精确类型与带参数后缀命中（大小写不敏感）；其他类型与
    /// 缺失不命中——普通发送升级分岔的裁决面。
    #[test]
    fn is_event_stream_matches_type_with_parameters_and_case() {
        assert!(is_event_stream(&Some("text/event-stream".into())));
        assert!(is_event_stream(&Some(
            "text/event-stream; charset=utf-8".into()
        )));
        assert!(is_event_stream(&Some("Text/Event-Stream".into())));
        assert!(is_event_stream(&Some("  text/event-stream ".into())));
        assert!(!is_event_stream(&Some("application/json".into())));
        assert!(!is_event_stream(&Some("text/event-streamx".into())));
        assert!(!is_event_stream(&None));
    }
}
