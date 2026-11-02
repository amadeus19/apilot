//! 发送编排层：GUI Command 与 CLI 的双入口同源链路。
//!
//! 链：取接口定义＋用户数据＋工作空间 → 请求合成（覆写叠加）→ 认证注入 →
//! TaskRegistry 登记（任务键与记录标识解耦）→ 引擎纯执行 → Run Record 终态
//! 单次写入 → registry 清理 → 返回 RunResult DTO。
//!
//! 资源所有权：任务归 TaskRegistry（`http:tab:<tabId>`＝GUI、`http:run:<runId>`＝CLI）；
//! 连续发送＝先取消旧键再 spawn（最新意图优先，`TASK_KEY_EXISTS` 不暴露给发送路径）；
//! 响应临时文件归发起方（Tab / CLI 进程），文件名＝任务键净化形态（同名覆盖即替换删旧）。

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use sqlx::SqlitePool;
use tokio_util::sync::CancellationToken;

use crate::constants::SNAPSHOT_EXCERPT_BYTES;
use crate::domain::endpoint::Definition;
use crate::domain::run_id::new_run_id;
use crate::domain::run_record::{RunSource, RunState};
use crate::domain::variable::EffectiveVariable;
use crate::domain::variable_resolver::ResolutionHit;
use crate::error::AppError;
use crate::error::codes;
use crate::infrastructure::run_repo;
use crate::services::http::HttpService;
use crate::services::http::engine;
use crate::services::http::request::{RequestModel, SendOverrides};
use crate::services::http::response::{BodyHandle, BodySink, ResponseHandle, preview_excerpt};
use crate::services::settings::SettingsCache;
use crate::services::workspace;
use crate::tasks::TaskRegistry;

/// 发送装配缝（预取三步＋SynthesisInput 十字段装配单点）：普通发送、
/// SSE 流与工作流引擎请求节点共用的唯一装配现场，对 crate 内开放。
pub(crate) mod assembly;

/// 发送装配编排（合成 → 认证 → 脱敏装配的纯函数子模块），对 crate 内开放。
pub(crate) mod compose;

use assembly::AssembledSend;
use compose::ComposedSend;

/// 等待旧任务退出清键的上限（发送路径自身恒响应取消，超时属异常防御）
const ABSORB_WAIT_MS: u64 = 2000;
/// 清键轮询粒度
const ABSORB_POLL_MS: u64 = 20;

/// GUI 任务键（取消按钮与关 Tab 都知道 tabId，规避 invoke 返回前不知 run_id 的时序问题）
pub fn tab_task_key(tab_id: &str) -> String {
    format!("http:tab:{tab_id}")
}

/// CLI 任务键
pub fn run_task_key(run_id: &str) -> String {
    format!("http:run:{run_id}")
}

/// 编排装配（GUI AppState / CLI AppContext 投影到同一结构＝双入口同源）。
pub struct SendCtx<'a> {
    pub pool: &'a SqlitePool,
    pub cache: &'a SettingsCache,
    pub http: &'a HttpService,
    pub registry: &'a TaskRegistry,
    pub data_dir: &'a Path,
}

/// 发送入口形态。
pub enum SendEntry {
    /// GUI：Tab 作用域（任务键＝tab 键；响应走文件分级落盘）
    Gui { tab_id: String },
    /// CLI（任务键＝run 键；响应只读 Preview 不落盘）
    Cli,
}

/// 发送请求（接口身份＋入口＋覆写）。
pub struct SendRequest {
    pub service_id: String,
    pub endpoint_key: String,
    pub entry: SendEntry,
    pub overrides: SendOverrides,
    /// 接口级 BaseUrl 覆写（GUI Tab 会话态随 invoke 携带、不落库；CLI 恒 None）
    pub base_url_override: Option<String>,
}

/// 发送前变量解析预览（Variable Preview 素材；不新增 IPC——随既有发送 IPC
/// 的装配响应附带，预览 UI 消费）。`url`＝认证注入后的合成 URL（未经重定向，
/// 与镜像的最终 URL 相区分）；Secret 行的 resolved 值由前端按 secret 标记掩码。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPreview {
    /// 解析后合成 URL
    pub url: String,
    /// 本次发送全部模板命中记录（含未命中：URL 各段 / params·headers 值列 /
    /// body / 认证值 / BaseUrl 覆写值）
    pub hits: Vec<ResolutionHit>,
    /// 本次消费的 Secret 变量值清单（与镜像 redactions 同一来源）：预览
    /// URL 的掩码输入用它，不再由前端从 hits 推导（同一概念一种来源）
    pub secret_values: Vec<String>,
}

/// 执行结果 DTO（GUI 响应面板与 CLI 输出共用；快照明文、展示脱敏由消费层决定）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub run_id: String,
    pub state: RunState,
    pub status_code: Option<u16>,
    pub duration_ms: Option<u64>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    /// 实际发送镜像（最终 URL / headers 全量 / body excerpt）
    pub request: RequestSnapshot,
    /// 响应快照（cancelled＝None）
    pub response: Option<ResponseSnapshot>,
    /// 大响应锚 id（文件档时的 range-read 凭据；内存档＝None）
    pub response_id: Option<String>,
    /// 变量解析预览（随装配响应附带；合成失败＝空 url 空记录）
    pub resolved: ResolvedPreview,
}

/// 请求快照（run_records.request_json 同构；body excerpt ≤64KB＋truncated）。
/// `redactions`＝认证派生的脱敏提示（敏感头名 / query 键），展示与 CLI 输出
/// 消费端据此默认脱敏（`--show-secrets` 放行）；快照本体存明文。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSnapshot {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<BodyExcerpt>,
    #[serde(default)]
    pub redactions: crate::services::http::auth::RedactionHints,
}

/// 响应快照（run_records.response_json 同构）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseSnapshot {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub content_type: Option<String>,
    pub body: BodyExcerpt,
}

/// body 快照口径：excerpt ≤64KB（utf8 lossy）＋truncated＋总量。
/// `rawBase64` 为原始字节的 base64：仅内存档响应 DTO 出现（≤2MB 有界，
/// 供编码重解码等原始字节消费方；文件档全量原始字节经 http.read_range
/// 分页获取），落库快照、请求镜像与文件档恒 None 不序列化。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyExcerpt {
    pub excerpt: String,
    pub truncated: bool,
    pub total_size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_base64: Option<String>,
}

/// 覆写链（纯函数）：接口 `timeout_seconds`（NULL 继承全局 / 0 不限制 / >0 秒）
/// ＞ 全局档（null＝不限制）。落点＝per-request timeout。
pub fn resolve_effective_timeout(global: Option<u64>, endpoint: Option<i64>) -> Option<Duration> {
    match endpoint {
        // 0＝显式不限制（压过全局任何档）
        Some(0) => None,
        // 秒数覆写（写路径已限值域，负值防御性视作继承）
        Some(secs) if secs > 0 => Some(Duration::from_secs(secs as u64)),
        // NULL／非法负值＝继承全局（全局 None 亦不限制）
        _ => global.map(Duration::from_secs),
    }
}

/// 发送前装配（普通发送链入口）：解析当前空间后以服务内键直查形态走
/// 装配缝单点（assembly 模块；不落库的失败：查不到即拒绝）。
pub(crate) async fn assemble(
    ctx: &SendCtx<'_>,
    service_id: &str,
    endpoint_key: &str,
) -> Result<AssembledSend, AppError> {
    let workspace_id = workspace::resolve_current_id(ctx.pool, ctx.cache)
        .await?
        .ok_or_else(|| AppError::new(codes::WORKSPACE_NOT_FOUND, "no workspace exists"))?;
    assembly::assemble(
        ctx.pool,
        assembly::AssembleRequest {
            workspace_id: &workspace_id,
            endpoint: assembly::EndpointRef::InService {
                service_id,
                key: endpoint_key,
            },
            execution: None,
        },
    )
    .await
}

/// 执行接口（双入口同源）。查找失败（工作空间 / 接口不存在）不产生记录；
/// 合成失败与传输失败（含超时）落 failed 行；用户取消落 cancelled 行。
/// 无事件出口变体：GUI 升级判定仍生效（事件流响应转流式收体）但跳过
/// 事件推送（单测面）；CLI 面不升级（preview_only）。
pub async fn execute_endpoint(ctx: &SendCtx<'_>, req: SendRequest) -> Result<RunResult, AppError> {
    execute_endpoint_inner(ctx, req, None).await
}

/// 执行接口（GUI 入口变体）：携带 AppHandle——普通发送命中事件流响应时
/// 经 SSE 升级链路实时推送事件（`sse-upgrade://<tabId>` 告知＋`sse://<id>`
/// 增量），响应面板发送中即得流式视图。
pub async fn execute_endpoint_gui(
    ctx: &SendCtx<'_>,
    req: SendRequest,
    app: tauri::AppHandle,
) -> Result<RunResult, AppError> {
    execute_endpoint_inner(ctx, req, Some(sse_event_sink(app))).await
}

async fn execute_endpoint_inner(
    ctx: &SendCtx<'_>,
    req: SendRequest,
    sink: Option<SseEventSink>,
) -> Result<RunResult, AppError> {
    // —— 发送前装配（不落库的失败：查不到即拒绝）——
    let assembled = assemble(ctx, &req.service_id, &req.endpoint_key).await?;

    // —— 任务键与运行身份（解耦：键供取消，run_id 供落库）——
    let run_id = new_run_id();
    let (task_key, sink_root, preview_only, tab_id) = match &req.entry {
        SendEntry::Gui { tab_id } => (
            tab_task_key(tab_id),
            Some(ctx.data_dir.join("tmp").join("response")),
            false,
            Some(tab_id.clone()),
        ),
        SendEntry::Cli => (run_task_key(&run_id), None, true, None),
    };
    // 快照捕获（spawn 前）：Client 与全局超时档取自当前快照，任务内不再触碰 ctx
    let client = ctx.http.client();
    let timeout_global = ctx.http.settings().timeout_seconds;

    // 连续发送：先取消旧键再 spawn（最新意图优先）
    absorb_existing(ctx.registry, &task_key).await;

    // —— 执行（registry 登记；完成通道回传）——
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<RunResult, AppError>>();
    let spawned = SpawnedSend {
        pool: ctx.pool.clone(),
        run_id: run_id.clone(),
        workspace_id: assembled.workspace_id,
        service_id: req.service_id.clone(),
        endpoint_key: req.endpoint_key.clone(),
        source: match &req.entry {
            SendEntry::Gui { .. } => RunSource::Gui,
            SendEntry::Cli => RunSource::Cli,
        },
        task_key: task_key.clone(),
        tab_id,
        sink,
        definition: assembled.definition,
        base_url: assembled.base_url,
        base_url_override: req.base_url_override,
        variables: assembled.variables,
        request_auth: assembled.request_auth,
        workspace_auth: assembled.workspace_auth,
        user_body: assembled.user_body,
        user_params: assembled.user_params,
        user_headers: assembled.user_headers,
        path_override: assembled.path_override,
        method_override: assembled.method_override,
        overrides: req.overrides,
        client,
        timeout_global,
        timeout_endpoint: assembled.timeout_endpoint,
        sink_root,
        preview_only,
    };
    ctx.registry.spawn(&task_key, move |token| {
        let spawned = spawned;
        async move {
            let outcome = run_once(spawned, token).await;
            let _ = tx.send(outcome);
        }
    })?;
    let outcome = rx
        .await
        .map_err(|_| AppError::new(codes::INTERNAL, "send task dropped before completion"))?;

    // 完成后清理登记（仅清理已结束条目；仍在运行的键留给下一次同键发送吸收）
    if !ctx.registry.is_running(&task_key) {
        ctx.registry.remove(&task_key);
    }
    outcome
}

/// spawn 任务的 owned 输入（不借用 ctx：Client 与设置已在发送前快照捕获）。
pub(crate) struct SpawnedSend {
    pool: SqlitePool,
    run_id: String,
    workspace_id: String,
    service_id: String,
    endpoint_key: String,
    source: RunSource,
    task_key: String,
    /// GUI Tab 身份（升级告知事件 `sse-upgrade://<tabId>` 的作用域；CLI＝None）
    tab_id: Option<String>,
    /// GUI 事件出口（SSE 升级链路的实时推送面；单测 / CLI＝None）
    sink: Option<SseEventSink>,
    definition: Definition,
    base_url: Option<String>,
    /// 接口级 BaseUrl 覆写（GUI Tab 会话态；CLI＝None）
    base_url_override: Option<String>,
    /// 生效变量集（合成与认证值解析的 Resolver 输入）
    variables: Vec<EffectiveVariable>,
    request_auth: Option<String>,
    workspace_auth: Option<String>,
    user_body: Option<String>,
    user_params: String,
    user_headers: String,
    /// 路径 / 方法覆写（None＝跟随接口定义）
    path_override: Option<String>,
    method_override: Option<String>,
    overrides: SendOverrides,
    client: reqwest::Client,
    timeout_global: Option<u64>,
    timeout_endpoint: Option<i64>,
    sink_root: Option<PathBuf>,
    preview_only: bool,
}

/// 执行→落库→DTO（spawn 任务体内；合成失败与传输失败都产出终态行）。
async fn run_once(input: SpawnedSend, token: CancellationToken) -> Result<RunResult, AppError> {
    let started = Instant::now();
    // 发送装配（合成 → 认证值解析 → 认证注入 → 脱敏提示；compose_send
    // 单点，与 SSE 流同链）→ 引擎执行。Ok＝传输
    // 成功（引擎结果＋请求镜像）；Err＝(error_code, error_message)；合成
    // 与认证配置失败均归构建失败（failed 终态）。合成与认证已定形的镜像
    // （composed）：传输失败也按它落库——最终 URL 与 headers 不随失败
    // 丢失，否则留痕只剩方法与错误文案，无从辨识是哪次请求
    let mut composed: Option<RequestSnapshot> = None;
    // 变量解析预览（合成与认证注入成功路径填充；URL＝认证注入后的合成 URL）
    let mut resolved_preview = ResolvedPreview {
        url: String::new(),
        hits: Vec::new(),
        secret_values: Vec::new(),
    };
    let outcome: Result<(engine::HttpResult, RequestSnapshot), (Option<String>, Option<String>)> =
        match input.compose_send() {
            Err(e) => Err((Some(e.code.clone()), Some(e.message.clone()))),
            Ok(ComposedSend {
                model,
                redactions,
                hits,
            }) => {
                resolved_preview = ResolvedPreview {
                    url: model.url.clone(),
                    hits,
                    secret_values: redactions.secret_values.clone(),
                };
                // Ok 路径以引擎镜像为准（重定向后最终 URL）；此处的
                // 模型镜像（合成 URL）只在失败路径兜底使用
                composed = Some(request_snapshot(
                    &engine::sent_mirror(&model, model.url.clone()),
                    &redactions,
                ));
                let sink = match (&input.sink_root, input.preview_only) {
                    (Some(root), false) => BodySink::File {
                        root,
                        file_key: &input.task_key,
                    },
                    _ => BodySink::PreviewOnly,
                };
                let timeout =
                    resolve_effective_timeout(input.timeout_global, input.timeout_endpoint);
                // 发送＋读头，响应头处分岔：GUI 面命中事件流响应即升级
                // 为流式收体（实时事件推送）；其余走普通收体（分级落盘）
                // （Client 内部为 Arc，clone 廉价——input 后续落库仍要用）

                match engine::send_request(input.client.clone(), timeout, &model, &token).await {
                    Ok(head) => {
                        let upgraded =
                            !input.preview_only && engine::is_event_stream(&head.content_type);
                        let body = if upgraded {
                            upgraded_sse_body(&input, head, &model, &token).await
                        } else {
                            engine::read_response_body(head, &model, &sink).await
                        };
                        match body {
                            Ok(result) => {
                                Ok((result.clone(), request_snapshot(&result.sent, &redactions)))
                            }
                            Err(e) => Err((Some(e.code.clone()), Some(e.message.clone()))),
                        }
                    }
                    Err(e) => Err((Some(e.code.clone()), Some(e.message.clone()))),
                }
            }
        };
    let duration_ms = Some(started.elapsed().as_millis() as u64);

    let (state, http_result, snapshot, error_code, error_message) = match outcome {
        Ok((result, snapshot)) => (RunState::Passed, Some(result), Some(snapshot), None, None),
        Err((code, message)) => {
            let cancelled = code.as_deref() == Some(codes::CANCELLED);
            let state = if cancelled {
                RunState::Cancelled
            } else {
                RunState::Failed
            };
            (state, None, None, code, message)
        }
    };

    // 快照与镜像（cancelled 不留响应快照；镜像兜底序＝引擎镜像 → 失败路径
    // 的合成镜像（composed）→ 定义骨架（仅合成 / 认证失败——最终 URL 无从
    // 得知）。两口径分治：落库快照恒按 Preview 契约（≤64KB＋truncated，行级
    // 有界）；DTO 内存档整包交付（UI 免二次取数）。
    let (status_code, dto_response, record_response, response_id) = match &http_result {
        Some(result) => {
            let dto = response_snapshot(&result.response);
            let record = record_response_snapshot(&result.response);
            let response_id = matches!(result.response.body, BodyHandle::File { .. })
                .then(|| input.task_key.clone());
            (
                Some(result.response.status),
                Some(dto),
                Some(record),
                response_id,
            )
        }
        None => (None, None, None, None),
    };
    let mirror = snapshot.or(composed).unwrap_or_else(|| RequestSnapshot {
        method: input.definition.method.as_str().to_string(),
        url: String::new(),
        headers: Vec::new(),
        body: None,
        redactions: Default::default(),
    });

    // 终态单次写入（快照存明文；展示与输出脱敏由消费层执行）
    let request_json = serde_json::to_string(&mirror)
        .map_err(|e| AppError::new(codes::INTERNAL, format!("serialize request snapshot: {e}")))?;
    let response_json = match &record_response {
        Some(s) => Some(serde_json::to_string(s).map_err(|e| {
            AppError::new(codes::INTERNAL, format!("serialize response snapshot: {e}"))
        })?),
        None => None,
    };
    let mut conn = input.pool.acquire().await?;
    run_repo::insert_final(
        &mut conn,
        &run_repo::RunRecordInsert {
            id: input.run_id.clone(),
            workspace_id: input.workspace_id,
            service_id: input.service_id,
            endpoint_key: input.endpoint_key,
            method: mirror.method.clone(),
            url: mirror.url.clone(),
            status_code: status_code.map(i64::from),
            duration_ms: duration_ms.map(|d| d as i64),
            state,
            error_code: error_code.clone(),
            error_message: error_message.clone(),
            request_json,
            response_json,
            source: input.source,
        },
    )
    .await?;

    Ok(RunResult {
        run_id: input.run_id,
        state,
        status_code,
        duration_ms,
        error_code,
        error_message,
        request: mirror,
        response: dto_response,
        response_id,
        resolved: resolved_preview,
    })
}

/// 请求镜像 → 快照（body excerpt ≤64KB＋truncated；携带认证脱敏提示）。
fn request_snapshot(
    sent: &engine::SentRequestMirror,
    redactions: &crate::services::http::auth::RedactionHints,
) -> RequestSnapshot {
    let body = sent.body_bytes.as_ref().map(|bytes| {
        let take = bytes.len().min(SNAPSHOT_EXCERPT_BYTES);
        BodyExcerpt {
            excerpt: String::from_utf8_lossy(&bytes[..take]).into_owned(),
            truncated: bytes.len() > take,
            total_size: bytes.len() as u64,
            // 请求镜像不走原始字节档（响应原始字节语义归 response_snapshot）
            raw_base64: None,
        }
    });
    RequestSnapshot {
        method: sent.method.clone(),
        url: sent.url.clone(),
        headers: sent.headers.clone(),
        body,
        redactions: redactions.clone(),
    }
}

/// 响应句柄 → 快照。内存档（≤2MB）整包随 DTO 交付（UI 免二次取数），并附
/// 原始字节 base64（有界，供编码重解码等消费方）；文件档 / 丢弃档走 Preview
/// 契约（≤64KB 前缀；全量查看经 range-read 取原始字节）。
fn response_snapshot(handle: &ResponseHandle) -> ResponseSnapshot {
    let body = match &handle.body {
        BodyHandle::Memory { bytes } => BodyExcerpt {
            excerpt: String::from_utf8_lossy(bytes).into_owned(),
            truncated: false,
            total_size: bytes.len() as u64,
            raw_base64: Some(BASE64_STANDARD.encode(bytes)),
        },
        _ => {
            let excerpt = preview_excerpt(&handle.preview);
            BodyExcerpt {
                excerpt: excerpt.text,
                truncated: excerpt.truncated,
                total_size: excerpt.total_size,
                raw_base64: None,
            }
        }
    };
    ResponseSnapshot {
        status: handle.status,
        headers: handle.headers.clone(),
        content_type: handle.content_type.clone(),
        body,
    }
}

/// 落库响应快照（恒 Preview 契约：≤64KB＋truncated；run_records 行级有界，
/// 不携带原始字节）。
fn record_response_snapshot(handle: &ResponseHandle) -> ResponseSnapshot {
    let excerpt = preview_excerpt(&handle.preview);
    ResponseSnapshot {
        status: handle.status,
        headers: handle.headers.clone(),
        content_type: handle.content_type.clone(),
        body: BodyExcerpt {
            excerpt: excerpt.text,
            truncated: excerpt.truncated,
            total_size: excerpt.total_size,
            raw_base64: None,
        },
    }
}

/// 连续发送吸收：取消旧键 → 有界等待退出 → 清键；超时强清（防御不响应取消的任务）。
async fn absorb_existing(registry: &TaskRegistry, key: &str) {
    if !registry.is_running(key) {
        registry.remove(key);
        return;
    }
    registry.cancel(key);
    let deadline = Instant::now() + Duration::from_millis(ABSORB_WAIT_MS);
    while registry.is_running(key) {
        if Instant::now() >= deadline {
            tracing::warn!(
                task = key,
                "old send task did not exit after cancel; forcing"
            );
            break;
        }
        tokio::time::sleep(Duration::from_millis(ABSORB_POLL_MS)).await;
    }
    registry.remove(key);
}

// —— SSE / 事件流链路 ——
//
// 与普通发送的差异：响应不进分级落盘体系——后端内存有界环形缓冲（尾部
// `SSE_RING_BUFFER_BYTES`）＋实时推送（`SSE_EMIT_INTERVAL_MS` 聚合降频）；
// 前端直接渲染增量文本。流正常结束＝passed；用户取消＝cancelled（取消标记
// 是流式展示标记，run_records 落库状态两者独立语义同形）。

/// 后端事件聚合推送间隔（50ms 降频：高吞吐流不逐 chunk 打事件）
const SSE_EMIT_INTERVAL_MS: u64 = 50;

/// SSE 启动结果。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SseStartDto {
    pub stream_id: String,
}

/// SSE 首事件（seq=0）携带的响应元信息。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SseMeta {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub content_type: Option<String>,
}

/// SSE 错误体（终态事件携带）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SseErrorBody {
    pub code: String,
    pub message: String,
}

/// SSE 升级告知事件 payload（事件名＝`sse-upgrade://<tabId>`）：普通发送
/// 命中事件流响应时即时推送——http.send 的 invoke 在流终态才返回，前端在
/// 返回前无从得知流 id（run_id），经此 tab 作用域事件提前拿到流身份与
/// 响应元信息，发送中立起流式视图（「流式」入口即时显形的触发点）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SseUpgradeDto {
    pub stream_id: String,
    pub meta: SseMeta,
}

/// 事件出口（GUI 升级链路的实时推送面）：`sse-upgrade://<tabId>` 告知与
/// `sse://<id>` 增量经此闭包推送。以闭包注入而非在 services 层结构体持有
/// AppHandle——运行时句柄作为字段类型会向 lib 测试链接面牵入宿主窗口栈
/// （实测导致测试进程启动失败），tauri 依赖收敛在 commands 层闭包内。
pub type SseEventSink = std::sync::Arc<dyn Fn(&str, &serde_json::Value) + Send + Sync>;

/// commands 层事件出口装配（AppHandle → JSON 事件闭包）。
pub fn sse_event_sink(app: tauri::AppHandle) -> SseEventSink {
    std::sync::Arc::new(move |name, payload| {
        use tauri::Emitter;
        let _ = app.emit(name, payload.clone());
    })
}

/// 经事件出口推送（payload 先序列化为 JSON 值：出口闭包统一消费 JSON）。
fn emit_value(sink: &SseEventSink, name: &str, payload: &impl serde::Serialize) {
    if let Ok(value) = serde_json::to_value(payload) {
        sink(name, &value);
    }
}

/// SSE 事件 payload（事件名＝`sse://<stream_id>`；序列号单调递增）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SseEvent {
    pub seq: u64,
    /// 增量文本（utf8 lossy；各事件累计＝已接收全文）
    pub text: String,
    /// 终态：流正常结束
    pub done: bool,
    /// 终态：用户取消（已收部分保留）
    pub cancelled: bool,
    /// 终态：传输失败（连接层错误）
    pub error: Option<SseErrorBody>,
    /// 仅 seq=0 携带
    pub meta: Option<SseMeta>,
}

/// 启动 SSE 流（command 立即返回流 id；事件经 Tauri 事件推送，停止＝http.cancel）。
/// 任务键＝Tab 键（与普通发送同键互斥，最新意图优先）。接口级 BaseUrl 覆写
/// 与普通发送同口径参与合成（值列解析后优先于工作空间生效值）。
pub async fn start_sse(
    app: tauri::AppHandle,
    ctx: &SendCtx<'_>,
    tab_id: &str,
    service_id: &str,
    endpoint_key: &str,
    base_url_override: Option<String>,
) -> Result<SseStartDto, AppError> {
    let assembled = assemble(ctx, service_id, endpoint_key).await?;
    let run_id = new_run_id();
    let task_key = tab_task_key(tab_id);
    let timeout_global = ctx.http.settings().timeout_seconds;
    let spawned = SpawnedSend {
        pool: ctx.pool.clone(),
        run_id: run_id.clone(),
        workspace_id: assembled.workspace_id,
        service_id: service_id.to_string(),
        endpoint_key: endpoint_key.to_string(),
        source: RunSource::Gui,
        task_key,
        tab_id: Some(tab_id.to_string()),
        sink: None,
        definition: assembled.definition,
        base_url: assembled.base_url,
        base_url_override,
        variables: assembled.variables,
        request_auth: assembled.request_auth,
        workspace_auth: assembled.workspace_auth,
        user_body: assembled.user_body,
        user_params: assembled.user_params,
        user_headers: assembled.user_headers,
        path_override: assembled.path_override,
        method_override: assembled.method_override,
        overrides: SendOverrides::default(),
        client: ctx.http.client(),
        timeout_global,
        timeout_endpoint: assembled.timeout_endpoint,
        sink_root: None,
        preview_only: true,
    };
    // 连续发送：先取消旧键再 spawn（普通发送与 SSE 同 Tab 键互斥）
    absorb_existing(ctx.registry, &spawned.task_key).await;
    let event_name = format!("sse://{run_id}");
    let stream_id = run_id.clone();
    ctx.registry
        .spawn(&spawned.task_key.clone(), move |token| {
            let app = app;
            let event_name = event_name;
            async move {
                // 任务键清理由下一次同键发送的吸收路径兜底（流任务不持有 registry）
                run_sse_stream(app, event_name, spawned, token).await;
            }
        })?;
    Ok(SseStartDto { stream_id })
}

/// SSE 流任务体：合成 → 认证 → 流式读取（pump_sse_stream 核心）→ 终态事件＋落库。
async fn run_sse_stream(
    app: tauri::AppHandle,
    event_name: String,
    input: SpawnedSend,
    token: CancellationToken,
) {
    let started = Instant::now();
    // app（函数参数）在此包成事件出口：后续 seq=0 / 终态与 pump 增量共用
    // 同一出口（结构体持有运行时句柄会牵入宿主窗口栈，见 SseEventSink 注释）
    let sink = sse_event_sink(app);
    let emit = |payload: SseEvent| {
        emit_value(&sink, &event_name, &payload);
    };

    // 发送装配（合成＋认证值解析＋认证注入；compose_send 单点，与普通
    // 发送同链；失败＝构建失败终态）
    let model = match input.compose_send() {
        Ok(composed) => {
            // hits 有意不消费：SSE 流式链路的消费面是流视图（增量文本与
            // 终态事件），无 Variable Preview 通道——普通链路的预览经
            // RunResult.resolved 随终态返回，而 sse.start 的 command 早已
            // 返回，补预览只能扩 sse:// 事件契约（meta 或新事件变体）；
            // 在无消费方的前提下不动事件面，compose 已保留 hits，后续有
            // 消费面时在此接入即可
            Some((composed.model, composed.redactions))
        }
        Err(e) => {
            let event = SseErrorBody {
                code: e.code.clone(),
                message: e.message.clone(),
            };
            finish_sse(
                &input,
                RunState::Failed,
                None,
                elapsed_ms(started),
                Some((e.code, e.message)),
                SseMirror::Skeleton,
                None,
            )
            .await;
            emit(terminal_event(0, String::new(), false, Some(event)));
            return;
        }
    };
    let Some((model, redactions)) = model else {
        return;
    };

    // 发送（token select：取消＝cancelled 终态）；构建面收敛于引擎（与普通
    // 发送同源），multipart 文件 part 的异步文件打开也在此失败（文件不存在 /
    // 不可读＝构建失败终态，不进入流阶段）
    let timeout = resolve_effective_timeout(input.timeout_global, input.timeout_endpoint);
    let builder = match engine::build_request(&input.client, timeout, &model).await {
        Ok(builder) => builder,
        Err(e) => {
            let event = SseErrorBody {
                code: e.code.clone(),
                message: e.message.clone(),
            };
            finish_sse(
                &input,
                RunState::Failed,
                None,
                elapsed_ms(started),
                Some((e.code, e.message)),
                SseMirror::Skeleton,
                None,
            )
            .await;
            emit(terminal_event(0, String::new(), false, Some(event)));
            return;
        }
    };

    let response = tokio::select! {
        res = builder.send() => match res {
            Ok(r) => r,
            Err(e) => {
                // 传输错误分类（超时 / 连接 / DNS 细分）收敛于引擎单点
                let err = engine::map_transport_error(e);
                let event = SseErrorBody { code: err.code.clone(), message: err.message.clone() };
                finish_sse(
                    &input,
                    RunState::Failed,
                    None,
                    elapsed_ms(started),
                    Some((err.code, err.message)),
                    SseMirror::Skeleton,
                    None,
                )
                .await;
                emit(terminal_event(0, String::new(), false, Some(event)));
                return;
            }
        },
        _ = token.cancelled() => {
            finish_sse(
                &input,
                RunState::Cancelled,
                None,
                elapsed_ms(started),
                None,
                SseMirror::Skeleton,
                None,
            )
            .await;
            emit(terminal_event(0, String::new(), true, None));
            return;
        }
    };

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

    // 首事件：元信息
    emit(SseEvent {
        seq: 0,
        text: String::new(),
        done: false,
        cancelled: false,
        error: None,
        meta: Some(SseMeta {
            status,
            headers: headers.clone(),
            content_type: content_type.clone(),
        }),
    });

    // 流式读取（环形缓冲＋聚合推送；sse.start 与普通发送升级共用核心）
    let pumped = pump_sse_stream(Some(&sink), &event_name, response, &token).await;

    let duration_ms = Some(started.elapsed().as_millis() as u64);
    let (state, error) = match &pumped.terminal {
        None => (RunState::Passed, None),
        Some((true, _)) => (RunState::Cancelled, None),
        Some((false, err)) => (
            RunState::Failed,
            err.as_ref().map(|e| (e.code.clone(), e.message.clone())),
        ),
    };

    // 落库：body 摘要＝环形缓冲尾部 ≤64KB（流式记录只保留尾部，truncated 标注）
    let take = pumped
        .ring
        .len()
        .min(crate::constants::SNAPSHOT_EXCERPT_BYTES);
    let excerpt = String::from_utf8_lossy(&pumped.ring[pumped.ring.len() - take..]).into_owned();
    let response_json = serde_json::json!({
        "status": status,
        "headers": headers,
        "contentType": content_type,
        "body": {
            "excerpt": excerpt,
            "truncated": pumped.total > take as u64,
            "totalSize": pumped.total,
        },
    })
    .to_string();
    finish_sse(
        &input,
        state,
        Some(status),
        duration_ms,
        error,
        SseMirror::Model(&model, &redactions),
        Some(response_json),
    )
    .await;

    // 终态事件（携带末次聚合余量）
    let (cancelled, error) = match pumped.terminal {
        None => (false, None),
        Some((c, e)) => (c, e),
    };
    emit(terminal_event(pumped.seq, pumped.pending, cancelled, error));
}

/// SSE 流式读取核心（sse.start 与普通发送的事件流升级共用）：环形缓冲
/// （尾部 `SSE_RING_BUFFER_BYTES` 有界）＋聚合推送（`SSE_EMIT_INTERVAL_MS`
/// 降频）＋取消响应。增量事件（seq 从 1 起；seq=0 元事件由调用方先行发出）
/// 经 `sse://<stream_id>` 推送，终态事件素材随返回值交调用方（落库顺序由
/// 其编排）。`sink=None` 跳过推送（单测面：只验证收体口径）。
struct PumpedStream {
    /// 尾部环形缓冲（≤SSE_RING_BUFFER_BYTES）
    ring: Vec<u8>,
    /// 累计已收字节（不受缓冲裁剪影响）
    total: u64,
    /// 终态事件序列号（下一 seq）＋未推送余量
    seq: u64,
    pending: String,
    /// None＝正常结束；(cancelled, error)＝取消 / 传输失败
    terminal: Option<(bool, Option<SseErrorBody>)>,
}

async fn pump_sse_stream(
    sink: Option<&SseEventSink>,
    event_name: &str,
    response: reqwest::Response,
    token: &CancellationToken,
) -> PumpedStream {
    use futures_util::StreamExt;

    let emit = |payload: SseEvent| {
        if let Some(sink) = sink {
            emit_value(sink, event_name, &payload);
        }
    };

    let mut stream = response.bytes_stream();
    let mut ring: std::collections::VecDeque<u8> = std::collections::VecDeque::new();
    let mut pending = String::new();
    let mut total: u64 = 0;
    let mut seq: u64 = 1;
    let mut last_emit = Instant::now();
    let mut terminal: Option<(bool, Option<SseErrorBody>)> = None;

    loop {
        tokio::select! {
            chunk = stream.next() => match chunk {
                Some(Ok(bytes)) => {
                    total += bytes.len() as u64;
                    ring.extend(bytes.iter().copied());
                    // 环形缓冲只留尾部（一切缓冲有界）
                    while ring.len() > crate::constants::SSE_RING_BUFFER_BYTES {
                        ring.pop_front();
                    }
                    pending.push_str(&String::from_utf8_lossy(&bytes));
                    if last_emit.elapsed() >= Duration::from_millis(SSE_EMIT_INTERVAL_MS) {
                        emit(SseEvent {
                            seq,
                            text: std::mem::take(&mut pending),
                            done: false,
                            cancelled: false,
                            error: None,
                            meta: None,
                        });
                        seq += 1;
                        last_emit = Instant::now();
                    }
                }
                Some(Err(e)) => {
                    // 传输错误分类（超时 / 连接 / DNS 细分）收敛于引擎单点
                    let err = engine::map_transport_error(e);
                    terminal = Some((false, Some(SseErrorBody { code: err.code, message: err.message })));
                    break;
                }
                None => break,
            },
            _ = token.cancelled() => {
                terminal = Some((true, None));
                break;
            }
        }
    }

    PumpedStream {
        ring: ring.into_iter().collect(),
        total,
        seq,
        pending,
        terminal,
    }
}

/// SSE 升级收体（GUI 普通发送命中事件流响应）：tab 作用域告知事件 →
/// seq=0 元事件 → 流式读取（pump）→ 终态事件（invoke 返回前送达——前端在
/// http.send 落定前收到流终态，流式视图增量收尾不丢）。产物口径：环形尾部
/// 进 Preview 契约（`BodyHandle::Discarded`＋尾部 preview——不落盘、无
/// range-read 凭据）；取消 / 传输错误映射 Err（与普通链路终态分野一致：
/// 升级只改变接收期间的实时性，不改变终态契约）。
async fn upgraded_sse_body(
    input: &SpawnedSend,
    head: engine::ResponseHead,
    model: &crate::services::http::request::RequestModel,
    token: &CancellationToken,
) -> Result<engine::HttpResult, AppError> {
    let final_url = head.final_url.clone();
    let status = head.status;
    let headers = head.headers.clone();
    let content_type = head.content_type.clone();
    let event_name = format!("sse://{}", input.run_id);

    // 告知事件（tab 作用域）＋seq=0 元事件（SseEvent 契约起点；meta 与告知
    // 事件重复携带无害，保证独立消费 sse:// 的链路也能拿到元信息）
    if let (Some(sink), Some(tab_id)) = (&input.sink, input.tab_id.as_deref()) {
        let meta = SseMeta {
            status,
            headers: headers.clone(),
            content_type: content_type.clone(),
        };
        emit_value(
            sink,
            &format!("sse-upgrade://{tab_id}"),
            &SseUpgradeDto {
                stream_id: input.run_id.clone(),
                meta: meta.clone(),
            },
        );
        emit_value(
            sink,
            &event_name,
            &SseEvent {
                seq: 0,
                text: String::new(),
                done: false,
                cancelled: false,
                error: None,
                meta: Some(meta),
            },
        );
    }

    let pumped = pump_sse_stream(input.sink.as_ref(), &event_name, head.response, token).await;

    // 终态事件先行（顺序见函数注释）
    if let Some(sink) = &input.sink {
        let (cancelled, error) = match &pumped.terminal {
            None => (false, None),
            Some((c, e)) => (*c, e.clone()),
        };
        emit_value(
            sink,
            &event_name,
            &terminal_event(pumped.seq, pumped.pending.clone(), cancelled, error),
        );
    }

    match pumped.terminal {
        None => {
            // 尾部 ≤64KB 进 Preview 契约（SSE 语义＝只保留尾部；preview.bytes
            // 此处承载环形尾部而非普通链路的前缀）
            let take = pumped
                .ring
                .len()
                .min(crate::constants::SNAPSHOT_EXCERPT_BYTES);
            let tail = pumped.ring[pumped.ring.len() - take..].to_vec();
            Ok(engine::HttpResult {
                response: ResponseHandle {
                    status,
                    headers,
                    content_type,
                    body: BodyHandle::Discarded {
                        total_size: pumped.total,
                    },
                    preview: crate::services::http::response::BodyPreview {
                        bytes: tail,
                        total_size: pumped.total,
                        truncated: pumped.total > take as u64,
                    },
                },
                sent: engine::sent_mirror(model, final_url),
            })
        }
        Some((true, _)) => Err(AppError::new(codes::CANCELLED, "request cancelled by user")),
        Some((false, err)) => {
            // err 缺席＝流失败但未携带错误体：编造空 message 会让前端展示
            // 空文案，兜底为固定描述
            let err = err.unwrap_or_else(|| SseErrorBody {
                code: codes::HTTP_REQUEST_FAILED.to_string(),
                message: "event stream failed without error details".to_string(),
            });
            Err(AppError::new(err.code, err.message))
        }
    }
}

fn terminal_event(
    seq: u64,
    text: String,
    cancelled: bool,
    error: Option<SseErrorBody>,
) -> SseEvent {
    SseEvent {
        seq,
        text,
        done: error.is_none() && !cancelled,
        cancelled,
        error,
        meta: None,
    }
}

/// SSE 终态镜像来源：无合成产物（合成 / 认证失败、发送前取消）退化为定义
/// 骨架；已合成的终态按最终模型镜像（与普通发送快照同口径）。
enum SseMirror<'a> {
    /// 无合成产物：镜像退化为定义骨架（url 空、头空）
    Skeleton,
    /// 已合成：按最终模型与脱敏提示镜像
    Model(
        &'a RequestModel,
        &'a crate::services::http::auth::RedactionHints,
    ),
}

/// 已耗毫秒（SSE 终态落库的时长口径）。
fn elapsed_ms(started: Instant) -> Option<u64> {
    Some(started.elapsed().as_millis() as u64)
}

/// SSE 终态行写入（与普通发送同一 repo 路径；镜像按来源构造，快照存明文）。
/// 写库失败仅留痕不外抛：SSE 任务体无错误回传通道，终态事件已先行推送。
async fn finish_sse(
    input: &SpawnedSend,
    state: RunState,
    status: Option<u16>,
    duration_ms: Option<u64>,
    error: Option<(String, String)>,
    mirror: SseMirror<'_>,
    response_json: Option<String>,
) {
    let mirror = match mirror {
        SseMirror::Skeleton => RequestSnapshot {
            method: input.definition.method.as_str().to_string(),
            url: String::new(),
            headers: Vec::new(),
            body: None,
            redactions: Default::default(),
        },
        SseMirror::Model(model, redactions) => RequestSnapshot {
            method: model.method.as_str().to_string(),
            url: model.url.clone(),
            headers: model
                .headers
                .iter()
                .filter(|r| r.enabled)
                .map(|r| (r.key.clone(), r.value.clone()))
                .collect(),
            body: None,
            redactions: redactions.clone(),
        },
    };
    let request_json = serde_json::to_string(&mirror).unwrap_or_else(|_| "{}".into());
    let Ok(mut conn) = input.pool.acquire().await else {
        tracing::warn!("sse run record write failed: pool acquire");
        return;
    };
    let result = run_repo::insert_final(
        &mut conn,
        &run_repo::RunRecordInsert {
            id: input.run_id.clone(),
            workspace_id: input.workspace_id.clone(),
            service_id: input.service_id.clone(),
            endpoint_key: input.endpoint_key.clone(),
            method: mirror.method.clone(),
            url: mirror.url.clone(),
            status_code: status.map(i64::from),
            duration_ms: duration_ms.map(|d| d as i64),
            state,
            error_code: error.as_ref().map(|(c, _)| c.clone()),
            error_message: error.map(|(_, m)| m),
            request_json,
            response_json,
            source: input.source,
        },
    )
    .await;
    if let Err(err) = result {
        tracing::warn!(code = %err.code, "sse run record write failed");
    }
}

#[cfg(test)]
mod tests {
    // 测试夹具以 Default + 单点字段覆盖表达用例焦点；改结构体字面量会把
    // 每个用例淹没在无关字段里（可读性优先的定向豁免）
    #![allow(clippy::field_reassign_with_default)]
    use super::*;
    use crate::db;
    use crate::domain::user_data::UserDataInput;
    use crate::domain::user_data_codec::KvRow;
    use crate::infrastructure::user_data_repo;
    use sqlx::SqlitePool;

    async fn memory_pool() -> SqlitePool {
        let pool = db::connect_in_memory().await;
        db::run_migrations(&pool).await.unwrap();
        pool
    }

    struct Fixture {
        pool: SqlitePool,
        cache: SettingsCache,
        http: HttpService,
        registry: TaskRegistry,
        data_dir: PathBuf,
        target: demo_server::DemoServer,
    }

    impl Fixture {
        async fn new() -> Self {
            let pool = memory_pool().await;
            let cache = SettingsCache::default();
            let target = demo_server::spawn_ephemeral().await.unwrap();
            let base = target.base_url();
            crate::infrastructure::workspace_repo::test_support::seed_workspace(
                &pool, "w1", "空间",
            )
            .await;
            crate::infrastructure::workspace_repo::update(&pool, "w1", "空间", Some(base.as_str()))
                .await
                .unwrap();
            crate::infrastructure::service_repo::test_support::seed_service(
                &pool, "s1", "w1", "服务",
            )
            .await;
            // 稳定键形态的接口（GET /healthz）：定义与身份一致，便于按 key 直查
            seed_definition(
                &pool,
                "s1",
                "GET /healthz",
                crate::domain::endpoint::HttpMethod::GET,
                "/healthz",
                "健康检查",
            )
            .await;
            let data_dir =
                std::env::temp_dir().join(format!("apilot-send-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&data_dir).unwrap();
            Self {
                pool,
                cache,
                http: HttpService::new(),
                registry: TaskRegistry::new(),
                data_dir,
                target,
            }
        }

        fn ctx(&self) -> SendCtx<'_> {
            SendCtx {
                pool: &self.pool,
                cache: &self.cache,
                http: &self.http,
                registry: &self.registry,
                data_dir: &self.data_dir,
            }
        }

        async fn seed_endpoint_of(
            &self,
            key: &str,
            method: crate::domain::endpoint::HttpMethod,
            path: &str,
            title: &str,
        ) {
            seed_definition(&self.pool, "s1", key, method, path, title).await;
        }
    }

    /// 稳定键接口种子：key＝`方法 + 空格 + 路径模板`，定义与身份一致。
    async fn seed_definition(
        pool: &SqlitePool,
        service_id: &str,
        key: &str,
        method: crate::domain::endpoint::HttpMethod,
        path: &str,
        title: &str,
    ) {
        crate::infrastructure::endpoint_repo::test_support::seed_endpoint_with_definition(
            pool,
            service_id,
            key,
            Definition::new(method, path).unwrap(),
            title,
        )
        .await;
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.target.shutdown();
            std::fs::remove_dir_all(&self.data_dir).ok();
        }
    }

    #[tokio::test]
    async fn passed_record_written_with_full_fields() {
        let fx = Fixture::new().await;
        let result = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /healthz".into(),
                entry: SendEntry::Gui {
                    tab_id: "tab-1".into(),
                },
                overrides: SendOverrides::default(),
                base_url_override: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(result.state, RunState::Passed);
        assert_eq!(result.status_code, Some(200));
        assert!(result.run_id.starts_with("run_"));

        let row = run_repo::get(&fx.pool, &result.run_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.state, "passed");
        assert_eq!(row.status_code, Some(200));
        assert_eq!(row.source, "gui");
        assert!(row.response_json.is_some());
        let request: serde_json::Value = serde_json::from_str(&row.request_json).unwrap();
        assert_eq!(request["url"], format!("{}/healthz", fx.target.base_url()));

        // 任务登记已清（完成后 remove 纪律）
        assert!(!fx.registry.is_running("http:tab:tab-1"));
    }

    #[tokio::test]
    async fn not_found_endpoint_rejected_without_record() {
        let fx = Fixture::new().await;
        let err = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /missing".into(),
                entry: SendEntry::Cli,
                overrides: SendOverrides::default(),
                base_url_override: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, codes::ENDPOINT_NOT_FOUND);
        assert_eq!(run_repo::count(&fx.pool).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn error_endpoint_still_passed_and_404_recorded() {
        let fx = Fixture::new().await;
        fx.seed_endpoint_of(
            "GET /api/error/{status}",
            crate::domain::endpoint::HttpMethod::GET,
            "/api/error/{status}",
            "错误样本",
        )
        .await;
        let mut overrides = SendOverrides::default();
        overrides.param_rows = vec![KvRow::new("status", "404")];
        let result = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /api/error/{status}".into(),
                entry: SendEntry::Cli,
                overrides,
                base_url_override: None,
            },
        )
        .await
        .unwrap();
        // 4xx/5xx＝传输成功（passed）；成败判定交消费者
        assert_eq!(result.state, RunState::Passed);
        assert_eq!(result.status_code, Some(404));
        let row = run_repo::get(&fx.pool, &result.run_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.source, "cli");
    }

    #[tokio::test]
    async fn missing_user_data_defaults_empty_kv() {
        let fx = Fixture::new().await;
        // 未编辑过草稿（无 user_data 行）也能发送：params/headers 默认空
        let result = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /healthz".into(),
                entry: SendEntry::Cli,
                overrides: SendOverrides::default(),
                base_url_override: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(result.status_code, Some(200));
    }

    #[tokio::test]
    async fn synthesis_failure_records_failed_row() {
        let fx = Fixture::new().await;
        // 非法 params JSON（原文保真模式的用户数据）→ 构建失败＝failed 终态
        user_data_repo::upsert(
            &fx.pool,
            "s1",
            "GET /healthz",
            &UserDataInput {
                body: None,
                params: "{\"bad\": 1}".into(),
                headers: "[]".into(),
                timeout_seconds: None,
                auth: None,
                path_override: None,
                method_override: None,
            },
        )
        .await
        .unwrap();
        let result = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /healthz".into(),
                entry: SendEntry::Gui {
                    tab_id: "tab-2".into(),
                },
                overrides: SendOverrides::default(),
                base_url_override: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(result.state, RunState::Failed);
        assert_eq!(
            result.error_code.as_deref(),
            Some(codes::HTTP_SYNTHESIS_INVALID)
        );
        assert!(result.response.is_none());
        let row = run_repo::get(&fx.pool, &result.run_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.state, "failed");
        assert!(row.response_json.is_none());
        assert_eq!(row.status_code, None);
        // 合成失败＝定义骨架镜像：URL 无从得知，落空串（与传输失败的有 URL 镜像相对）
        assert_eq!(row.url, "");
    }

    #[tokio::test]
    async fn user_data_invariant_unchanged_by_send() {
        let fx = Fixture::new().await;
        user_data_repo::upsert(
            &fx.pool,
            "s1",
            "GET /healthz",
            &UserDataInput {
                body: None,
                params: r#"[{"name":"verbose","value":"true"}]"#.into(),
                headers: r#"[{"name":"X-Custom","value":"1"}]"#.into(),
                timeout_seconds: None,
                auth: None,
                path_override: None,
                method_override: None,
            },
        )
        .await
        .unwrap();
        let before = user_data_repo::get(&fx.pool, "s1", "GET /healthz")
            .await
            .unwrap();
        execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /healthz".into(),
                entry: SendEntry::Gui {
                    tab_id: "tab-3".into(),
                },
                overrides: SendOverrides::default(),
                base_url_override: None,
            },
        )
        .await
        .unwrap();
        let after = user_data_repo::get(&fx.pool, "s1", "GET /healthz")
            .await
            .unwrap();
        // 领域核心承诺：发送与覆写零触碰用户数据（显式草稿 upsert 除外）——
        // 逐字段对账（实体未派生 PartialEq）
        let (before, after) = (before.unwrap(), after.unwrap());
        assert_eq!(before.body, after.body);
        assert_eq!(before.params, after.params);
        assert_eq!(before.headers, after.headers);
    }

    #[tokio::test]
    async fn token_cancel_records_cancelled_row() {
        let fx = Fixture::new().await;
        fx.seed_endpoint_of(
            "GET /api/slow",
            crate::domain::endpoint::HttpMethod::GET,
            "/api/slow",
            "慢响应",
        )
        .await;
        // 发送后取消该 Tab 键（等价取消按钮 / 关 Tab 链路的 registry.cancel）
        let result = {
            let ctx = SendCtx {
                pool: &fx.pool,
                cache: &fx.cache,
                http: &fx.http,
                registry: &fx.registry,
                data_dir: &fx.data_dir,
            };
            let send = execute_endpoint(
                &ctx,
                SendRequest {
                    service_id: "s1".into(),
                    endpoint_key: "GET /api/slow".into(),
                    entry: SendEntry::Gui {
                        tab_id: "tab-slow".into(),
                    },
                    overrides: SendOverrides::default(),
                    base_url_override: None,
                },
            );
            tokio::pin!(send);
            tokio::select! {
                r = &mut send => r.unwrap(),
                _ = tokio::time::sleep(Duration::from_millis(200)) => {
                    fx.registry.cancel("http:tab:tab-slow");
                    send.await.unwrap()
                }
            }
        };
        assert_eq!(result.state, RunState::Cancelled);
        assert!(result.response.is_none());
        let row = run_repo::get(&fx.pool, &result.run_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.state, "cancelled");
        assert!(row.response_json.is_none());
        assert_eq!(row.status_code, None);
    }

    /// 关 Tab 生命周期（http.tab_closed 内核对靶机）：Tab 先完成一笔大响应
    /// （文件档临时文件落地），再发慢请求并关 Tab——断言任务登记键清除、
    /// cancelled 终态行经取消链路自然落库（不另起写库）、临时文件已删
    /// （「关 Tab 即删」）。
    #[tokio::test]
    async fn tab_close_cancels_send_records_cancelled_and_removes_tmp_file() {
        let fx = Fixture::new().await;
        fx.seed_endpoint_of(
            "GET /api/download/binary",
            crate::domain::endpoint::HttpMethod::GET,
            "/api/download/binary",
            "大响应",
        )
        .await;
        fx.seed_endpoint_of(
            "GET /api/slow",
            crate::domain::endpoint::HttpMethod::GET,
            "/api/slow",
            "慢响应",
        )
        .await;

        // 第一笔：4MB 大响应 → 该 Tab 键名下落临时文件（关 Tab 要删的对象）
        let mut big_overrides = SendOverrides::default();
        big_overrides.param_rows = vec![KvRow::new("size_mb", "4")];
        let big = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /api/download/binary".into(),
                entry: SendEntry::Gui {
                    tab_id: "tab-close".into(),
                },
                overrides: big_overrides,
                base_url_override: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(big.response_id.as_deref(), Some("http:tab:tab-close"));
        let body_file = fx.data_dir.join("tmp").join("response").join(
            crate::services::http::response::sanitize_file_key("http:tab:tab-close") + ".body",
        );
        assert!(body_file.exists(), "关 Tab 前临时文件应在");

        // 第二笔：慢请求在途时关 Tab（取消点在等响应头阶段）
        let ctx = fx.ctx();
        let send = execute_endpoint(
            &ctx,
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /api/slow".into(),
                entry: SendEntry::Gui {
                    tab_id: "tab-close".into(),
                },
                overrides: SendOverrides::default(),
                base_url_override: None,
            },
        );
        tokio::pin!(send);
        let result = tokio::select! {
            r = &mut send => r.unwrap(),
            _ = tokio::time::sleep(Duration::from_millis(200)) => {
                crate::commands::http::close_tab_cleanup(&fx.registry, &fx.data_dir, "tab-close");
                send.await.unwrap()
            }
        };
        assert_eq!(result.state, RunState::Cancelled);
        assert!(result.response.is_none());
        let row = run_repo::get(&fx.pool, &result.run_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.state, "cancelled", "取消终态行经现有取消链路落库");
        assert!(row.response_json.is_none());
        // 任务登记键清除（发送链路完成路径 remove 纪律）
        assert!(!fx.registry.is_running("http:tab:tab-close"));
        // 临时文件已删（关 Tab 即删）
        assert!(!body_file.exists(), "关 Tab 后临时文件应删除");
    }

    #[tokio::test]
    async fn consecutive_same_key_sends_absorb_each_other() {
        let fx = Fixture::new().await;
        // 同键顺序两笔：第一笔完成后第二笔仍可发（吸收路径清键，无 TASK_KEY_EXISTS 残留）
        for i in 0..2 {
            let result = execute_endpoint(
                &fx.ctx(),
                SendRequest {
                    service_id: "s1".into(),
                    endpoint_key: "GET /healthz".into(),
                    entry: SendEntry::Gui {
                        tab_id: "tab-seq".into(),
                    },
                    overrides: SendOverrides::default(),
                    base_url_override: None,
                },
            )
            .await
            .unwrap();
            assert_eq!(result.status_code, Some(200), "第 {i} 笔应成功");
        }
    }

    #[tokio::test]
    async fn absorb_cancels_running_task_and_frees_key() {
        let registry = TaskRegistry::new();
        // 模拟不响应外力、只响应 token 的在途发送
        registry
            .spawn("http:tab:x", |token| async move {
                let _ = token.cancelled().await;
                tokio::time::sleep(Duration::from_millis(30)).await;
            })
            .unwrap();
        assert!(registry.is_running("http:tab:x"));
        absorb_existing(&registry, "http:tab:x").await;
        assert!(!registry.is_running("http:tab:x"));
        // 清键后同键可再登记（连续发送的最新意图胜出）
        registry.spawn("http:tab:x", |_token| async {}).unwrap();
    }

    #[test]
    fn timeout_override_chain() {
        use std::time::Duration;
        // NULL 继承全局（全局 None 亦不限制）
        assert_eq!(resolve_effective_timeout(None, None), None);
        assert_eq!(
            resolve_effective_timeout(Some(30), None),
            Some(Duration::from_secs(30))
        );
        // 0＝显式不限制（压过全局任何档）
        assert_eq!(resolve_effective_timeout(Some(30), Some(0)), None);
        // >0＝秒数覆写全局
        assert_eq!(
            resolve_effective_timeout(Some(30), Some(120)),
            Some(Duration::from_secs(120))
        );
        assert_eq!(
            resolve_effective_timeout(None, Some(5)),
            Some(Duration::from_secs(5))
        );
        // 负值防御性视作继承（写路径已限值域）
        assert_eq!(
            resolve_effective_timeout(Some(10), Some(-1)),
            Some(Duration::from_secs(10))
        );
    }

    #[tokio::test]
    async fn endpoint_timeout_overrides_global_on_send() {
        let fx = Fixture::new().await;
        fx.seed_endpoint_of(
            "GET /api/slow",
            crate::domain::endpoint::HttpMethod::GET,
            "/api/slow",
            "慢响应",
        )
        .await;
        // 全局 1s＋接口 0（不限制）：慢响应 3s 不超时＝接口覆写生效
        fx.http
            .rebuild(crate::services::http::HttpSettings {
                timeout_seconds: Some(1),
                ..Default::default()
            })
            .unwrap();
        user_data_repo::upsert(
            &fx.pool,
            "s1",
            "GET /api/slow",
            &UserDataInput {
                body: None,
                params: r#"[{"name":"ms","value":"3000"}]"#.into(),
                headers: "[]".into(),
                timeout_seconds: Some(0),
                auth: None,
                path_override: None,
                method_override: None,
            },
        )
        .await
        .unwrap();
        let result = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /api/slow".into(),
                entry: SendEntry::Gui {
                    tab_id: "tab-to".into(),
                },
                overrides: SendOverrides::default(),
                base_url_override: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(result.state, RunState::Passed, "接口不限制应压过全局 1s 档");
    }

    #[tokio::test]
    async fn timeout_records_failed_with_timeout_code() {
        let fx = Fixture::new().await;
        fx.seed_endpoint_of(
            "GET /api/slow",
            crate::domain::endpoint::HttpMethod::GET,
            "/api/slow",
            "慢响应",
        )
        .await;
        // 全局超时档 1s：慢响应 5s 必超时（TIMEOUT 归 failed，不占 token 通道）
        fx.http
            .rebuild(crate::services::http::HttpSettings {
                timeout_seconds: Some(1),
                ..Default::default()
            })
            .unwrap();
        let result = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /api/slow".into(),
                entry: SendEntry::Cli,
                overrides: SendOverrides::default(),
                base_url_override: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(result.state, RunState::Failed);
        assert_eq!(result.error_code.as_deref(), Some(codes::TIMEOUT));
        // 传输失败也留全量镜像：行内 url＝合成 URL（非空骨架），快照带最终
        // URL 与 headers——列表与详情能辨识是哪次请求
        let row = run_repo::get(&fx.pool, &result.run_id)
            .await
            .unwrap()
            .unwrap();
        assert!(
            row.url.ends_with("/api/slow"),
            "失败行应带合成 URL: {}",
            row.url
        );
        assert!(
            row.url.starts_with("http://"),
            "失败行应带完整 URL: {}",
            row.url
        );
        let request: serde_json::Value = serde_json::from_str(&row.request_json).unwrap();
        assert_eq!(request["url"], row.url);
        // 裸 GET 可无头（空数组合法）；headers 形态必须在场
        assert!(request["headers"].is_array());
    }

    #[tokio::test]
    async fn gui_large_response_lands_in_file_tier_with_response_id() {
        let fx = Fixture::new().await;
        fx.seed_endpoint_of(
            "GET /api/download/binary",
            crate::domain::endpoint::HttpMethod::GET,
            "/api/download/binary",
            "大响应",
        )
        .await;
        let mut overrides = SendOverrides::default();
        overrides.param_rows = vec![KvRow::new("size_mb", "4")]; // 4MB > 2MB 内存线
        let result = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /api/download/binary".into(),
                entry: SendEntry::Gui {
                    tab_id: "tab-big".into(),
                },
                overrides,
                base_url_override: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(result.status_code, Some(200));
        assert_eq!(
            result.response.as_ref().unwrap().body.total_size,
            4 * 1024 * 1024
        );
        // 文件档不携带原始字节 base64（全量原始字节经 http.read_range 分页获取）
        assert!(result.response.as_ref().unwrap().body.raw_base64.is_none());
        // 文件档：响应 id 给出（range-read 凭据）；临时文件落在数据目录 tmp/response
        assert_eq!(result.response_id.as_deref(), Some("http:tab:tab-big"));
        let body_file =
            fx.data_dir.join("tmp").join("response").join(
                crate::services::http::response::sanitize_file_key("http:tab:tab-big") + ".body",
            );
        assert!(body_file.exists(), "临时响应文件应存在: {body_file:?}");
        assert_eq!(
            std::fs::metadata(&body_file).unwrap().len(),
            4 * 1024 * 1024
        );
    }

    /// 内存档（≤2MB）：整包随 DTO 交付（excerpt 即全文）、无 range-read
    /// 凭据、不落临时文件——与文件档（上测）构成双档阈值断言。
    /// 用文本流端点：体量可精确换算（每行 59 字节），二进制流经 lossy
    /// UTF-8 转换后字节数不可精确断言。
    #[tokio::test]
    async fn small_response_stays_in_memory_tier() {
        let fx = Fixture::new().await;
        fx.seed_endpoint_of(
            "GET /api/download/text",
            crate::domain::endpoint::HttpMethod::GET,
            "/api/download/text",
            "小响应",
        )
        .await;
        const LINES: u64 = 16_384;
        const LINE_BYTES: usize = 58; // "line NNNNNN: <44 字符句子>\n"
        let mut overrides = SendOverrides::default();
        overrides.param_rows = vec![KvRow::new("lines", LINES.to_string())];
        let result = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /api/download/text".into(),
                entry: SendEntry::Gui {
                    tab_id: "tab-small".into(),
                },
                overrides,
                base_url_override: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(result.status_code, Some(200));
        let expected = LINES as usize * LINE_BYTES;
        let response = result.response.as_ref().expect("内存档应有响应快照");
        assert_eq!(response.body.total_size, expected as u64);
        assert_eq!(
            response.body.excerpt.len(),
            expected,
            "内存档 excerpt＝全文"
        );
        assert!(!response.body.truncated);
        // 内存档 DTO 附原始字节 base64（有界）：解码后与 excerpt 的字节一致
        let raw_base64 = response
            .body
            .raw_base64
            .as_ref()
            .expect("内存档应携带原始字节 base64");
        let decoded = BASE64_STANDARD.decode(raw_base64).unwrap();
        assert_eq!(decoded.len(), expected);
        assert_eq!(String::from_utf8_lossy(&decoded), response.body.excerpt);
        assert_eq!(result.response_id, None, "内存档无 range-read 凭据");
        let tmp_root = fx.data_dir.join("tmp").join("response");
        assert!(
            !tmp_root.exists() || std::fs::read_dir(&tmp_root).unwrap().next().is_none(),
            "内存档不落临时文件"
        );
    }

    /// 超限档（>50MB 上限线）：chunked 流无 Content-Length 可预判，实现
    /// 收满上限线即停、truncated 置位、文件档保留（range-read 仍可用）；
    /// 有 CL 预判的超限才走不落盘的 PreviewOnly（引擎侧由声明长度分流）。
    /// 三档阈值断言的收口档；文本端点保证 excerpt 字节可断言（ASCII）。
    #[tokio::test]
    async fn oversize_chunked_response_stops_at_limit_with_file() {
        let fx = Fixture::new().await;
        fx.seed_endpoint_of(
            "GET /api/download/text",
            crate::domain::endpoint::HttpMethod::GET,
            "/api/download/text",
            "超大响应",
        )
        .await;
        // 100 万行 × 58 字节 ≈ 55MB：超过 50MB 上限线
        let mut overrides = SendOverrides::default();
        overrides.param_rows = vec![KvRow::new("lines", "1000000")];
        let result = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /api/download/text".into(),
                entry: SendEntry::Gui {
                    tab_id: "tab-huge".into(),
                },
                overrides,
                base_url_override: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(result.status_code, Some(200));
        let response = result.response.as_ref().expect("超限响应应有快照");
        assert!(
            response.body.total_size > crate::constants::HTTP_MAX_RESPONSE_BYTES,
            "实收越过上限线才停"
        );
        assert!(!response.body.excerpt.is_empty(), "Preview 已捕获");
        assert!(response.body.truncated);
        let response_id = result
            .response_id
            .as_ref()
            .expect("chunked 超限保留文件档凭据");
        let body_file = fx
            .data_dir
            .join("tmp")
            .join("response")
            .join(crate::services::http::response::sanitize_file_key(response_id) + ".body");
        assert!(body_file.exists(), "截断文件应存在: {body_file:?}");
    }

    /// 请求镜像 body 截断语义：超过 64KB 的镜像在快照面仅保留 64KB excerpt，
    /// truncated 与 total_size 保真（截断口径不随镜像形态变化）。
    #[test]
    fn request_snapshot_truncates_body_excerpt_at_64k() {
        let mirror = engine::SentRequestMirror {
            method: "POST".to_string(),
            url: "http://x.test/api/form".to_string(),
            headers: vec![],
            body_bytes: Some(vec![b'a'; SNAPSHOT_EXCERPT_BYTES + 1]),
        };
        let snapshot = request_snapshot(
            &mirror,
            &crate::services::http::auth::RedactionHints::default(),
        );
        let body = snapshot.body.expect("有体镜像");
        assert_eq!(body.excerpt.len(), SNAPSHOT_EXCERPT_BYTES, "64KB excerpt");
        assert!(body.truncated, "超限镜像应标 truncated");
        assert_eq!(
            body.total_size,
            (SNAPSHOT_EXCERPT_BYTES + 1) as u64,
            "total_size 记录原尺寸"
        );
        assert!(body.raw_base64.is_none(), "请求镜像不走原始字节档");
    }

    #[tokio::test]
    async fn cli_preview_only_never_lands_files() {
        let fx = Fixture::new().await;
        fx.seed_endpoint_of(
            "GET /api/download/binary",
            crate::domain::endpoint::HttpMethod::GET,
            "/api/download/binary",
            "大响应",
        )
        .await;
        let mut overrides = SendOverrides::default();
        overrides.param_rows = vec![KvRow::new("size_mb", "3")];
        let result = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /api/download/binary".into(),
                entry: SendEntry::Cli,
                overrides,
                base_url_override: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(result.status_code, Some(200));
        // CLI 面：无响应 id、无临时文件（PreviewOnly）
        assert_eq!(result.response_id, None);
        let tmp_root = fx.data_dir.join("tmp").join("response");
        assert!(!tmp_root.exists() || std::fs::read_dir(&tmp_root).unwrap().next().is_none());
    }

    /// 认证全链：登录取 token → 请求级 Bearer 调受保护接口 200；
    /// 无认证 401；伪 token 401；认证头进 sent mirror 且快照带脱敏提示。
    #[tokio::test]
    async fn auth_bearer_roundtrip_against_target() {
        let fx = Fixture::new().await;
        fx.seed_endpoint_of(
            "POST /auth/login",
            crate::domain::endpoint::HttpMethod::POST,
            "/auth/login",
            "登录",
        )
        .await;
        fx.seed_endpoint_of(
            "GET /auth/me",
            crate::domain::endpoint::HttpMethod::GET,
            "/auth/me",
            "受保护",
        )
        .await;

        // 登录取 token（响应体双形态之一）
        let login = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "POST /auth/login".into(),
                entry: SendEntry::Gui {
                    tab_id: "tab-login".into(),
                },
                overrides: SendOverrides {
                    body: Some(r#"{"username":"admin","password":"123456"}"#.into()),
                    ..Default::default()
                },
                base_url_override: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(login.status_code, Some(200));
        let token = login
            .response
            .as_ref()
            .and_then(|r| serde_json::from_str::<serde_json::Value>(&r.body.excerpt).ok())
            .and_then(|v| v["token"].as_str().map(str::to_string))
            .expect("登录响应应含 token");

        // 无认证调受保护接口：401（passed 态——传输成功）
        let no_auth = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /auth/me".into(),
                entry: SendEntry::Gui {
                    tab_id: "tab-me".into(),
                },
                overrides: SendOverrides::default(),
                base_url_override: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(no_auth.status_code, Some(401));

        // 请求级 Bearer：200，claims 回显
        user_data_repo::upsert(
            &fx.pool,
            "s1",
            "GET /auth/me",
            &UserDataInput {
                body: None,
                params: "[]".into(),
                headers: "[]".into(),
                timeout_seconds: None,
                auth: Some(format!(r#"{{"type":"bearer","token":"{token}"}}"#)),
                path_override: None,
                method_override: None,
            },
        )
        .await
        .unwrap();
        let authorized = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /auth/me".into(),
                entry: SendEntry::Gui {
                    tab_id: "tab-me".into(),
                },
                overrides: SendOverrides::default(),
                base_url_override: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(authorized.status_code, Some(200));
        assert!(
            authorized
                .response
                .as_ref()
                .unwrap()
                .body
                .excerpt
                .contains("admin")
        );

        // 认证头进 sent mirror（明文快照）；脱敏提示含 Authorization
        assert!(
            authorized
                .request
                .headers
                .iter()
                .any(|(k, v)| k == "Authorization" && v.starts_with("Bearer "))
        );
        assert!(
            authorized
                .request
                .redactions
                .header_names
                .contains(&"Authorization".to_string())
        );

        // 伪 token：401 样本
        user_data_repo::upsert(
            &fx.pool,
            "s1",
            "GET /auth/me",
            &UserDataInput {
                body: None,
                params: "[]".into(),
                headers: "[]".into(),
                timeout_seconds: None,
                auth: Some(r#"{"type":"bearer","token":"not-a-jwt"}"#.into()),
                path_override: None,
                method_override: None,
            },
        )
        .await
        .unwrap();
        let fake = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /auth/me".into(),
                entry: SendEntry::Gui {
                    tab_id: "tab-me".into(),
                },
                overrides: SendOverrides::default(),
                base_url_override: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(fake.status_code, Some(401));
    }

    /// GUI 普通发送命中事件流响应：升级为流式收体——RunResult 的 body 走
    /// 尾部 Preview 契约（小流＝全文、不落盘无 range-read 凭据、无原始字节
    /// base64）、contentType 保真；RunRecord 照常落库。事件推送面（事件出口）
    /// 经 GUI 实机验收覆盖，单测走无事件出口变体验证收体口径。
    #[tokio::test]
    async fn gui_sse_response_upgrades_to_stream_body_tier() {
        let fx = Fixture::new().await;
        fx.seed_endpoint_of(
            "GET /api/sse",
            crate::domain::endpoint::HttpMethod::GET,
            "/api/sse",
            "事件流",
        )
        .await;
        let mut overrides = SendOverrides::default();
        overrides.param_rows = vec![KvRow::new("events", "3"), KvRow::new("interval_ms", "10")];
        let result = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /api/sse".into(),
                entry: SendEntry::Gui {
                    tab_id: "tab-sse".into(),
                },
                overrides,
                base_url_override: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(result.state, RunState::Passed);
        assert_eq!(result.status_code, Some(200));
        let response = result.response.as_ref().expect("升级收体应有响应快照");
        assert!(
            response
                .content_type
                .as_deref()
                .unwrap_or_default()
                .starts_with("text/event-stream"),
            "ct={}",
            response.content_type.clone().unwrap_or_default()
        );
        assert_eq!(
            result.response_id, None,
            "事件流不落盘（无 range-read 凭据）"
        );
        assert!(
            response.body.raw_base64.is_none(),
            "不携带原始字节（尾部 Preview 契约）"
        );
        assert!(!response.body.truncated, "3 条事件 < 64KB：全文保留");
        assert_eq!(
            response.body.excerpt.matches("event: message").count(),
            3,
            "全文进 excerpt"
        );
        let row = run_repo::get(&fx.pool, &result.run_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.state, "passed");
        assert_eq!(row.status_code, Some(200));
    }

    /// GUI 大事件流：excerpt 只保留尾部 ≤64KB（seq 首条丢弃、末条保留）、
    /// truncated 置位、totalSize 保真（实收全量计数）。
    #[tokio::test]
    async fn gui_large_sse_stream_keeps_tail_excerpt() {
        let fx = Fixture::new().await;
        fx.seed_endpoint_of(
            "GET /api/sse",
            crate::domain::endpoint::HttpMethod::GET,
            "/api/sse",
            "事件流",
        )
        .await;
        let mut overrides = SendOverrides::default();
        // 1000 条 × ~72B ≈ 72KB > 64KB excerpt 线（每条字节数恒定，确定性越线）
        overrides.param_rows = vec![KvRow::new("events", "1000"), KvRow::new("interval_ms", "1")];
        let result = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /api/sse".into(),
                entry: SendEntry::Gui {
                    tab_id: "tab-sse-big".into(),
                },
                overrides,
                base_url_override: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(result.state, RunState::Passed);
        let response = result.response.as_ref().expect("升级收体应有响应快照");
        assert!(
            response.body.total_size > crate::constants::SNAPSHOT_EXCERPT_BYTES as u64,
            "实收应越过 64KB 线: {}",
            response.body.total_size
        );
        assert!(response.body.truncated, "越线流应标 truncated");
        assert!(
            response.body.excerpt.contains(r#""seq":1000"#),
            "尾部保留（末条在）"
        );
        assert!(
            !response.body.excerpt.contains(r#""seq":1,"total""#),
            "头部丢弃（首条不在 64KB 尾窗内）"
        );
    }

    /// 升级期间取消（取消按钮 / 关 Tab 同链路）：与普通发送取消同终态——
    /// cancelled 行落库、无响应快照（已收内容只在流式视图期间展示）。
    #[tokio::test]
    async fn gui_sse_upgrade_cancel_records_cancelled_without_response() {
        let fx = Fixture::new().await;
        fx.seed_endpoint_of(
            "GET /api/sse",
            crate::domain::endpoint::HttpMethod::GET,
            "/api/sse",
            "事件流",
        )
        .await;
        let mut overrides = SendOverrides::default();
        // 200 条 × 50ms ≈ 10s：200ms 时必在流式接收中
        overrides.param_rows = vec![KvRow::new("events", "200"), KvRow::new("interval_ms", "50")];
        let ctx = fx.ctx();
        let send = execute_endpoint(
            &ctx,
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /api/sse".into(),
                entry: SendEntry::Gui {
                    tab_id: "tab-sse-cancel".into(),
                },
                overrides,
                base_url_override: None,
            },
        );
        tokio::pin!(send);
        let result = tokio::select! {
            r = &mut send => r.unwrap(),
            _ = tokio::time::sleep(Duration::from_millis(200)) => {
                fx.registry.cancel("http:tab:tab-sse-cancel");
                send.await.unwrap()
            }
        };
        assert_eq!(result.state, RunState::Cancelled);
        assert!(result.response.is_none());
        let row = run_repo::get(&fx.pool, &result.run_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.state, "cancelled");
        assert!(row.response_json.is_none());
    }

    /// CLI 面不升级：事件流响应仍走普通收体（PreviewOnly 前缀口径）——
    /// CLI 无事件消费方，升级无意义且会改变 CLI 输出契约。
    #[tokio::test]
    async fn cli_sse_response_stays_normal_body_tier() {
        let fx = Fixture::new().await;
        fx.seed_endpoint_of(
            "GET /api/sse",
            crate::domain::endpoint::HttpMethod::GET,
            "/api/sse",
            "事件流",
        )
        .await;
        let mut overrides = SendOverrides::default();
        overrides.param_rows = vec![KvRow::new("events", "1000"), KvRow::new("interval_ms", "1")];
        let result = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /api/sse".into(),
                entry: SendEntry::Cli,
                overrides,
                base_url_override: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(result.state, RunState::Passed);
        let response = result.response.as_ref().expect("普通收体应有响应快照");
        assert!(
            response.body.total_size > crate::constants::SNAPSHOT_EXCERPT_BYTES as u64,
            "实收应越过 64KB 线"
        );
        assert!(
            response.body.excerpt.contains(r#""seq":1,"total""#),
            "前缀保留（首条在）"
        );
        assert!(
            !response.body.excerpt.contains(r#""seq":1000"#),
            "普通收体是前缀口径（末条不在前 64KB）"
        );
    }

    /// SSE 流读取侧（对靶机）：事件序列与服务端关闭语义——流式编排
    /// （run_sse_stream 的落库路径）与普通发送共用装配与终态写库，事件推送
    /// 面经 GUI 实机验收覆盖（事件循环属 Tauri 宿主能力，单测不可达）。
    #[tokio::test]
    async fn sse_target_stream_events_then_server_closes() {
        let fx = Fixture::new().await;
        let client = reqwest::Client::new();
        let resp = client
            .get(format!(
                "{}/api/sse?events=3&interval_ms=20",
                fx.target.base_url()
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        assert!(
            content_type.starts_with("text/event-stream"),
            "ct={content_type}"
        );
        let body = resp.text().await.unwrap();
        assert_eq!(
            body.matches("event: message").count(),
            3,
            "3 条事件后服务端关闭"
        );
        // 靶机断开检测观测面：流结束后活跃计数归零
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            fx.target.sse_active_connections(),
            0,
            "流结束（Drop guard）应递减活跃计数"
        );
    }

    /// SSE 中途取消观测面：客户端断开后靶机 Drop guard 感知（断开检测素材）。
    #[tokio::test]
    async fn sse_target_detects_client_disconnect() {
        let fx = Fixture::new().await;
        let client = reqwest::Client::new();
        let resp = client
            .get(format!(
                "{}/api/sse?events=50&interval_ms=50",
                fx.target.base_url()
            ))
            .send()
            .await
            .unwrap();
        // 读首块后立即断开（drop 响应体＝客户端断开）
        use futures_util::StreamExt;
        let mut stream = resp.bytes_stream();
        let _ = stream.next().await;
        // stream 持有响应体所有权，drop 即断开连接
        drop(stream);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            fx.target.sse_active_connections(),
            0,
            "客户端断开后 Drop guard 应及时感知（短间隔 yield）"
        );
    }

    /// 工作空间级认证（继承链根）：请求级未配置时生效。
    #[tokio::test]
    async fn workspace_level_auth_applies_via_inheritance() {
        let fx = Fixture::new().await;
        fx.seed_endpoint_of(
            "GET /auth/me",
            crate::domain::endpoint::HttpMethod::GET,
            "/auth/me",
            "受保护",
        )
        .await;
        // 先登录取 token，写进工作空间级认证
        fx.seed_endpoint_of(
            "POST /auth/login",
            crate::domain::endpoint::HttpMethod::POST,
            "/auth/login",
            "登录",
        )
        .await;
        let login = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "POST /auth/login".into(),
                entry: SendEntry::Cli,
                overrides: SendOverrides {
                    body: Some(r#"{"username":"admin","password":"123456"}"#.into()),
                    ..Default::default()
                },
                base_url_override: None,
            },
        )
        .await
        .unwrap();
        let token = login
            .response
            .as_ref()
            .and_then(|r| serde_json::from_str::<serde_json::Value>(&r.body.excerpt).ok())
            .and_then(|v| v["token"].as_str().map(str::to_string))
            .unwrap();
        crate::infrastructure::workspace_repo::update_auth(
            &fx.pool,
            "w1",
            Some(&format!(r#"{{"type":"bearer","token":"{token}"}}"#)),
        )
        .await
        .unwrap();

        // 请求级未配置 → 继承工作空间级 → 200
        let result = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /auth/me".into(),
                entry: SendEntry::Gui {
                    tab_id: "tab-ws".into(),
                },
                overrides: SendOverrides::default(),
                base_url_override: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(result.status_code, Some(200));

        // 请求级显式「不使用」阻断继承 → 401
        user_data_repo::upsert(
            &fx.pool,
            "s1",
            "GET /auth/me",
            &UserDataInput {
                body: None,
                params: "[]".into(),
                headers: "[]".into(),
                timeout_seconds: None,
                auth: Some(r#"{"type":"none"}"#.into()),
                path_override: None,
                method_override: None,
            },
        )
        .await
        .unwrap();
        let blocked = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /auth/me".into(),
                entry: SendEntry::Gui {
                    tab_id: "tab-ws".into(),
                },
                overrides: SendOverrides::default(),
                base_url_override: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(blocked.status_code, Some(401));
    }

    // —— 变量解析发送链（GUI / CLI / 预览同一 Resolver 与输入源）——

    /// 变量种子：激活分类挂两个变量（其一 Secret），激活指针指向它
    async fn seed_active_variables(fx: &Fixture) {
        use crate::infrastructure::variable_repo::test_support as var_support;
        var_support::seed_category(&fx.pool, "vc1", "w1", "开发").await;
        var_support::seed_variable(&fx.pool, "vc1", "env", "smoke", false).await;
        var_support::seed_variable(&fx.pool, "vc1", "apiKey", "sk-live-123", true).await;
        crate::services::variable::set_active_category(&fx.pool, "w1", Some("vc1"))
            .await
            .unwrap();
    }

    /// 全链：变量命中参与 URL（query 值）与请求头值列；Secret 消费值清单进
    /// redactions；Run Record 快照仍存明文；resolved 预览携带命中记录
    #[tokio::test]
    async fn variables_resolve_in_send_chain_with_secret_redactions() {
        let fx = Fixture::new().await;
        seed_active_variables(&fx).await;
        user_data_repo::upsert(
            &fx.pool,
            "s1",
            "GET /healthz",
            &UserDataInput {
                body: None,
                params: r#"[{"name":"env","value":"{{env}}"},{"name":"secret","value":"{{apiKey}}"},{"name":"miss","value":"{{miss}}"}]"#.into(),
                headers: r#"[{"name":"X-Key","value":"{{apiKey}}"}]"#.into(),
                timeout_seconds: None,
                auth: None,
                path_override: None,
                method_override: None,
            },
        )
        .await
        .unwrap();
        let result = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /healthz".into(),
                entry: SendEntry::Gui {
                    tab_id: "tab-var".into(),
                },
                overrides: SendOverrides::default(),
                base_url_override: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(result.state, RunState::Passed);
        // 镜像 URL：值列命中替换＋未命中原样保留（`{{` `}}` 经 percent 编码）
        assert_eq!(
            result.request.url,
            format!(
                "{}/healthz?env=smoke&secret=sk-live-123&miss=%7B%7Bmiss%7D%7D",
                fx.target.base_url()
            ),
        );
        assert!(
            result
                .request
                .headers
                .iter()
                .any(|(k, v)| k == "X-Key" && v == "sk-live-123")
        );
        // Secret 消费清单并入 redactions（去重：query 与头各消费一次）
        assert_eq!(
            result.request.redactions.secret_values,
            vec!["sk-live-123".to_owned()]
        );
        // resolved 预览：合成 URL（＝镜像 URL，本测无重定向）＋命中记录
        assert_eq!(result.resolved.url, result.request.url);
        let keys: Vec<(&str, bool, bool)> = result
            .resolved
            .hits
            .iter()
            .map(|h| (h.key.as_str(), h.hit, h.secret))
            .collect();
        assert_eq!(
            keys,
            vec![
                ("env", true, false),
                ("apiKey", true, true),
                ("miss", false, false),
                // params 值列之外，headers 值列的 {{apiKey}} 同样产生命中记录
                ("apiKey", true, true),
            ],
            "命中 / 未命中 / Secret 标记齐全（各位置消费逐条记录）"
        );
        // Run Record 快照仍存明文（掩码归消费层，落库不动）
        let row = run_repo::get(&fx.pool, &result.run_id)
            .await
            .unwrap()
            .unwrap();
        let snapshot: serde_json::Value = serde_json::from_str(&row.request_json).unwrap();
        assert_eq!(snapshot["redactions"]["secretValues"][0], "sk-live-123");
        assert!(snapshot["url"].as_str().unwrap().contains("sk-live-123"));
    }

    /// 认证值解析：Bearer token 引用 Secret 变量——注入的 Authorization 头是
    /// 明文值（发送要真的带），其值进 Secret 消费清单（CLI 输出 / GUI 展示掩码）
    #[tokio::test]
    async fn auth_token_variable_resolves_and_redacts() {
        let fx = Fixture::new().await;
        seed_active_variables(&fx).await;
        user_data_repo::upsert(
            &fx.pool,
            "s1",
            "GET /healthz",
            &UserDataInput {
                body: None,
                params: "[]".into(),
                headers: "[]".into(),
                timeout_seconds: None,
                auth: Some(r#"{"type":"bearer","token":"{{apiKey}}"}"#.into()),
                path_override: None,
                method_override: None,
            },
        )
        .await
        .unwrap();
        let result = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /healthz".into(),
                entry: SendEntry::Cli,
                overrides: SendOverrides::default(),
                base_url_override: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(result.state, RunState::Passed);
        // 注入头＝解析后的明文值（真实发送消费它）
        assert!(
            result
                .request
                .headers
                .iter()
                .any(|(k, v)| k == "Authorization" && v == "Bearer sk-live-123")
        );
        // 认证值命中并入预览与 Secret 清单
        assert_eq!(
            result.request.redactions.secret_values,
            vec!["sk-live-123".to_owned()]
        );
        assert_eq!(result.resolved.hits.len(), 1);
        assert!(result.resolved.hits[0].secret);
    }

    /// 接口级 BaseUrl 覆写：GUI invoke 携带覆写值（值列口径解析）优先于
    /// 工作空间生效值；CLI 恒 None（跟随工作空间）
    #[tokio::test]
    async fn base_url_override_takes_precedence_in_send() {
        let fx = Fixture::new().await;
        seed_active_variables(&fx).await;
        // 工作空间生效值指向不可达地址：若覆写未生效，发送必然连接失败
        crate::infrastructure::workspace_repo::update(
            &fx.pool,
            "w1",
            "空间",
            Some("http://127.0.0.1:1"),
        )
        .await
        .unwrap();
        let result = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /healthz".into(),
                entry: SendEntry::Gui {
                    tab_id: "tab-ovr".into(),
                },
                overrides: SendOverrides::default(),
                base_url_override: Some(fx.target.base_url()),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            result.state,
            RunState::Passed,
            "覆写值参与拼接（绕过不可达的生效值）"
        );
        // 覆写是字面 URL：无模板，预览无覆写命中记录
        assert!(result.resolved.hits.is_empty());

        // CLI（None）走工作空间生效值：连接失败落 failed（同一 Resolver 的
        // 无覆写形态）
        let cli = execute_endpoint(
            &fx.ctx(),
            SendRequest {
                service_id: "s1".into(),
                endpoint_key: "GET /healthz".into(),
                entry: SendEntry::Cli,
                overrides: SendOverrides::default(),
                base_url_override: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(cli.state, RunState::Failed);
    }
}
