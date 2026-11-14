//! `apilot api` 命令组：接口读取三命令（list / search / get）＋执行命令 run。
//!
//! 读链：工作空间解析（复用 services 层口径）→ `services::tree::get_tree`
//! （唯一 DB 读链）→ `traversal_rows`（树遍历序行视图的单一事实源）→
//! CLI 层只做过滤与契约映射。同步移除即物理删除定义行，读命令天然只
//! 呈现存接口。
//! run＝执行域：直接走编排层（GUI 与 CLI 双入口同源），覆写永不写回用户数据。

use clap::Args;
use clap::Subcommand;
use serde::Serialize;

use super::output::Output;
use crate::app_context::AppContext;
use crate::constants::CLI_BODY_FILE_MAX_BYTES;
use crate::domain::endpoint::{Definition, Endpoint, is_manual_identity};
use crate::domain::redact;
use crate::domain::run_record::RunState;
use crate::domain::service::Service;
use crate::domain::user_data_codec::{BodyEnvelopeKind, KvRow, parse_body_envelope};
use crate::error::AppError;
use crate::error::codes;
use crate::infrastructure::{category_repo, endpoint_repo, service_repo, user_data_repo};
use crate::services::http::request::SendOverrides;
use crate::services::send::{self, RunResult, SendCtx, SendEntry, SendRequest};
use crate::services::tree::{self, EndpointRow};

#[derive(Debug, Args)]
pub(crate) struct ApiCommand {
    #[command(subcommand)]
    pub(super) command: ApiSub,
}

#[derive(Debug, Subcommand)]
pub(super) enum ApiSub {
    /// 列出当前工作空间全部接口（树遍历序）
    List,
    /// 按关键词搜索接口（标题/路径/分类名/方法四字段子串，不区分大小写）
    Search {
        /// 搜索关键词（前后空白截除）
        keyword: String,
    },
    /// 读取单个接口完整定义（稳定键原样，含空格需 shell 引号）
    Get {
        /// 接口 id＝稳定键（`方法 + 空格 + 路由模板`）或 UUID
        #[arg(value_name = "ID")]
        id: String,
        /// 同稳定键跨服务撞车时按服务名消歧（精确匹配）
        #[arg(long)]
        service: Option<String>,
    },
    /// 执行接口（覆写参数试跑；exit 0 含 4xx/5xx，成败判定交消费者）
    Run(RunArgs),
}

/// `api run` 参数。
#[derive(Debug, Args)]
pub(super) struct RunArgs {
    /// 接口 id＝稳定键（含空格需 shell 引号）或 UUID
    #[arg(value_name = "ID")]
    pub id: String,
    /// 同稳定键跨服务撞车时按服务名消歧（精确匹配）
    #[arg(long)]
    pub service: Option<String>,
    /// 路径参数覆写（替换 `{k}` 占位；可多次）
    #[arg(long = "param", value_name = "K=V")]
    pub params: Vec<String>,
    /// 查询参数覆写（同名替换用户数据；可多次）
    #[arg(long = "query", value_name = "K=V")]
    pub queries: Vec<String>,
    /// 请求头覆写（同名替换用户数据；可多次）
    #[arg(long = "header", value_name = "K=V")]
    pub headers: Vec<String>,
    /// 请求体整体替换（JSON 文本；不与用户数据合并）
    #[arg(long)]
    pub body: Option<String>,
    /// 请求体整体替换（UTF-8 文本文件全文，语义等同 --body；与 --body 互斥）
    #[arg(long, value_name = "PATH")]
    pub body_file: Option<String>,
    /// 表单文本行覆写（同名替换用户数据 form 信封行；可多次；仅接口保存
    /// body 为 form 家族信封时可用）
    #[arg(long = "form", value_name = "K=V")]
    pub forms: Vec<String>,
    /// 表单文件行覆写（值＝文件完整路径，文件名＝basename、mime 按扩展名
    /// 推断；可多次；仅 form-data 信封可用）
    #[arg(long = "form-file", value_name = "K=PATH")]
    pub form_files: Vec<String>,
}

/// 树遍历序的接口行（list / search 共用视图；JSON 形态即契约）。
/// `pinned` 仅作字段输出（数据序不提升——提升是 GUI 树的呈现语义）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiListItem {
    pub id: String,
    pub name: String,
    pub method: String,
    pub path: String,
    pub service: String,
    pub category: Option<String>,
    pub pinned: bool,
}

/// `apilot api list`：目标工作空间全量接口（缺省＝当前工作空间）。
pub(crate) async fn list(ctx: &AppContext, out: &Output, ws: Option<&str>) -> Result<(), AppError> {
    let items: Vec<ApiListItem> = collect_rows(ctx, ws).await?.iter().map(list_item).collect();
    render_items(out, items);
    Ok(())
}

/// `apilot api search`：四字段口径过滤后的接口集；零命中＝成功空集（exit 0）。
/// 空/纯空白关键词＝`INVALID_ARGUMENT`（exit 2，脚本缺陷 fail-fast；
/// GUI「空查询＝非过滤」是交互语义，不适用于终端）。
pub(crate) async fn search(
    ctx: &AppContext,
    out: &Output,
    ws: Option<&str>,
    keyword: &str,
) -> Result<(), AppError> {
    let query = keyword.trim();
    if query.is_empty() {
        return Err(AppError::new(
            codes::INVALID_ARGUMENT,
            "search keyword is empty or whitespace",
        ));
    }
    let hits: Vec<ApiListItem> = collect_rows(ctx, ws)
        .await?
        .iter()
        .filter(|row| matches_query(row, query))
        .map(list_item)
        .collect();
    render_items(out, hits);
    Ok(())
}

/// 树行视图取数：工作空间解析 → `get_tree`（唯一读链）→ 树遍历序行视图。
async fn collect_rows(ctx: &AppContext, ws: Option<&str>) -> Result<Vec<EndpointRow>, AppError> {
    let workspace = super::resolve_workspace(ctx, ws).await?;
    let tree = tree::get_tree(&ctx.db.pool, &workspace.id).await?;
    Ok(tree::traversal_rows(&tree))
}

/// 行视图 → CLI list/search 行（JSON 契约形态）。
fn list_item(row: &EndpointRow) -> ApiListItem {
    ApiListItem {
        id: row.key.clone(),
        name: row.title.clone(),
        method: row.method.clone(),
        path: row.path_template.clone(),
        service: row.service_name.clone(),
        category: row.category_name.clone(),
        pinned: row.pinned,
    }
}

/// `apilot api get`：单接口完整定义（用户数据结构化＋headers 脱敏）。
pub(crate) async fn get(
    ctx: &AppContext,
    out: &Output,
    ws: Option<&str>,
    id: &str,
    service: Option<&str>,
) -> Result<(), AppError> {
    let (service, endpoint) = find_endpoint(ctx, ws, id, service).await?;
    render_get(ctx, out, &service, &endpoint).await
}

/// 渲染 list / search 共用视图：JSON＝行数组；Human＝四列表格
/// （Human 列集允许少于 JSON 字段集——`pinned` 不进表格，两视图各取所需）。
fn render_items(out: &Output, items: Vec<ApiListItem>) {
    let rows: Vec<Vec<String>> = items
        .iter()
        .map(|item| {
            vec![
                item.id.clone(),
                item.method.clone(),
                item.path.clone(),
                item.service.clone(),
            ]
        })
        .collect();
    out.success_table(&items, &["ID", "METHOD", "PATH", "SERVICE"], &rows);
}

/// 四字段匹配（标题＋路径模板＋分类名＋方法），不区分大小写子串；
/// 散层接口无分类名（该字段不参与）。query 由调用方 trim 后传入
/// （命令层已判空）。与左栏树搜索（selector.ts::matchesEndpoint）的口径
/// 一致性由共享契约夹具 `src/test/fixtures/search-contract.json` 双端
/// 钉住——谓词本身两份实现（前端即时过滤须本地），口径漂移靠双端
/// 测试同时抓住。
fn matches_query(row: &EndpointRow, query: &str) -> bool {
    let query = query.to_lowercase();
    row.method.to_lowercase().contains(&query)
        || row.path_template.to_lowercase().contains(&query)
        || row.title.to_lowercase().contains(&query)
        || row
            .category_name
            .as_deref()
            .is_some_and(|c| c.to_lowercase().contains(&query))
}

/// 按身份解析接口（跨服务全工作空间查找）＋`--service` 消歧。
/// 撞车未消歧＝`ENDPOINT_AMBIGUOUS`（details 列候选）；未命中＝
/// `ENDPOINT_NOT_FOUND`；`--service` 零命中＝`SERVICE_NOT_FOUND`、
/// 同名多命中复用歧义语义（details 区分）。
async fn find_endpoint(
    ctx: &AppContext,
    ws: Option<&str>,
    id: &str,
    service: Option<&str>,
) -> Result<(Service, Endpoint), AppError> {
    let workspace = super::resolve_workspace(ctx, ws).await?;
    find_endpoint_in_workspace(ctx, &workspace.id, id, service).await
}

/// 已解析工作空间内的接口定位（get 与 run 共用）。run 的发送链需要与
/// 接口定位同一空间身份贯穿装配（base_url / 变量 / 两级认证），故先解析
/// 一次空间再进定位，不在此处二次解析。
async fn find_endpoint_in_workspace(
    ctx: &AppContext,
    workspace_id: &str,
    id: &str,
    service: Option<&str>,
) -> Result<(Service, Endpoint), AppError> {
    let pool = &ctx.db.pool;
    let services = service_repo::list_by_workspace(pool, workspace_id).await?;

    let candidates: Vec<&Service> = match service {
        Some(name) => {
            let matched: Vec<&Service> = services.iter().filter(|s| s.name == name).collect();
            match matched.as_slice() {
                [] => {
                    return Err(AppError::new(
                        codes::SERVICE_NOT_FOUND,
                        format!("service not found: {name}"),
                    ));
                }
                [only] => vec![only],
                many => {
                    let names: Vec<String> = many
                        .iter()
                        .map(|s| format!("{} (id={})", s.name, s.id))
                        .collect();
                    return Err(AppError::new(
                        codes::ENDPOINT_AMBIGUOUS,
                        format!("service name is ambiguous: {name}"),
                    )
                    .with_details(serde_json::json!({ "candidates": names })));
                }
            }
        }
        None => services.iter().collect(),
    };

    let mut hits: Vec<(&Service, Endpoint)> = Vec::new();
    for candidate in candidates {
        if let Some(endpoint) = endpoint_repo::get(pool, &candidate.id, id).await? {
            hits.push((candidate, endpoint));
        }
    }
    match hits.len() {
        0 => Err(AppError::new(
            codes::ENDPOINT_NOT_FOUND,
            format!("endpoint not found: {id}"),
        )),
        1 => {
            let (service, endpoint) = hits.pop().expect("len checked");
            Ok((service.clone(), endpoint))
        }
        _ => {
            let mut candidates = Vec::new();
            for (service, endpoint) in &hits {
                let category = match &endpoint.category_id {
                    Some(id) => category_repo::get(pool, id).await?.map(|c| c.name),
                    None => None,
                };
                candidates.push(serde_json::json!({
                    "service": service.name,
                    "category": category,
                    "name": endpoint.title,
                }));
            }
            Err(AppError::new(
                codes::ENDPOINT_AMBIGUOUS,
                format!("endpoint id is ambiguous across services: {id}"),
            )
            .with_details(serde_json::json!({ "candidates": candidates })))
        }
    }
}

/// `api get` 的 data 值：params / headers 为结构化 JSON（parse 失败原样
/// 字符串回退）；headers 经敏感名单脱敏（`--show-secrets` 放行）；body 原样。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiDetail {
    pub id: String,
    pub name: String,
    pub method: String,
    pub path: String,
    pub service: String,
    pub category: Option<String>,
    pub manual: bool,
    pub params: serde_json::Value,
    pub headers: serde_json::Value,
    pub body: Option<String>,
}

/// 渲染单接口详情：JSON＝完整契约；Human＝键值行。
async fn render_get(
    ctx: &AppContext,
    out: &Output,
    service: &Service,
    endpoint: &Endpoint,
) -> Result<(), AppError> {
    let definition: Definition = serde_json::from_str(&endpoint.definition)
        .map_err(|err| AppError::internal(format!("endpoint definition is corrupt: {err}")))?;
    let category = match &endpoint.category_id {
        Some(id) => category_repo::get(&ctx.db.pool, id).await?.map(|c| c.name),
        None => None,
    };
    let user_data = user_data_repo::get(&ctx.db.pool, &service.id, &endpoint.key).await?;
    let params_raw = user_data
        .as_ref()
        .map(|u| u.params.clone())
        .unwrap_or_else(|| "[]".to_owned());
    let headers_raw = user_data
        .as_ref()
        .map(|u| u.headers.clone())
        .unwrap_or_else(|| "[]".to_owned());
    let body = user_data.and_then(|u| u.body);

    let params = structured_or_raw(&params_raw);
    let headers = render_headers(&headers_raw, out.show_secrets());
    let detail = ApiDetail {
        id: endpoint.key.clone(),
        name: endpoint.title.clone(),
        method: definition.method.as_str().to_owned(),
        path: definition.path_template.clone(),
        service: service.name.clone(),
        category,
        manual: is_manual_identity(&endpoint.key),
        params,
        headers,
        body: body.clone(),
    };
    let entries = [
        ("id", detail.id.clone()),
        ("name", detail.name.clone()),
        ("method", detail.method.clone()),
        ("path", detail.path.clone()),
        ("service", detail.service.clone()),
        (
            "category",
            detail.category.clone().unwrap_or_else(|| "null".into()),
        ),
        ("manual", detail.manual.to_string()),
        (
            "params",
            serde_json::to_string(&detail.params).expect("value serialization cannot fail"),
        ),
        (
            "headers",
            serde_json::to_string(&detail.headers).expect("value serialization cannot fail"),
        ),
        ("body", body.unwrap_or_else(|| "null".into())),
    ];
    out.success_kv(&detail, &entries);
    Ok(())
}

/// DB 字符串 → 结构化 JSON 数组；parse 失败原样字符串回退（含非数组形态）。
fn structured_or_raw(raw: &str) -> serde_json::Value {
    serde_json::from_str::<Vec<serde_json::Value>>(raw)
        .map(serde_json::Value::Array)
        .unwrap_or_else(|_| serde_json::Value::String(raw.to_owned()))
}

/// headers 结构化脱敏：项 `name` 命中敏感名单 → `value` 掩码；
/// `--show-secrets` 放行。parse 失败（无结构可供匹配）原样回退。
fn render_headers(raw: &str, show_secrets: bool) -> serde_json::Value {
    let value = structured_or_raw(raw);
    if show_secrets || !value.is_array() {
        return value;
    }
    let items = value.as_array().expect("array checked").clone();
    serde_json::Value::Array(
        items
            .into_iter()
            .map(|mut item| {
                let sensitive = item
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(redact::is_sensitive_header);
                if sensitive && let Some(obj) = item.as_object_mut() {
                    obj.insert(
                        "value".to_owned(),
                        serde_json::Value::String(redact::MASK.to_owned()),
                    );
                }
                item
            })
            .collect(),
    )
}

// —— api run（执行域：GUI 与 CLI 双入口同源）——

/// `apilot api run`：覆写执行接口。exit 0 含 4xx/5xx（请求到达且响应已回，
/// 成败判定交消费者）；传输失败（含超时）exit 4；用户取消 exit 130。
pub(crate) async fn run(
    ctx: &AppContext,
    out: &Output,
    ws: Option<&str>,
    args: RunArgs,
) -> Result<(), AppError> {
    // --body 与 --body-file 互斥：同给＝覆写来源意图不明，参数校验先行
    // fail-fast（exit 2，不碰数据目录与文件系统）
    if args.body.is_some() && args.body_file.is_some() {
        return Err(AppError::new(
            codes::INVALID_ARGUMENT,
            "--body and --body-file are mutually exclusive; pass at most one",
        ));
    }
    // body 族与 form 族互斥：整体替换与行级覆写意图冲突，同一 fail-fast 位置
    let has_body_flag = args.body.is_some() || args.body_file.is_some();
    let has_form_flag = !args.forms.is_empty() || !args.form_files.is_empty();
    if has_body_flag && has_form_flag {
        return Err(AppError::new(
            codes::INVALID_ARGUMENT,
            "--body/--body-file and --form/--form-file are mutually exclusive; \
             pass at most one family",
        ));
    }
    // --body-file 语义等同 --body 文本：读文件全文后并入同一覆写通道
    // （trim 后空白＝忽略、变量替换、纯文本发送语义全部同源）
    let body_override = match &args.body_file {
        Some(path) => Some(read_body_file(path)?),
        None => args.body,
    };

    // 工作空间只解析一次：接口定位与发送装配链共用同一空间身份——
    // `--workspace` 指定空间时 base_url、变量与两级认证全部取该空间；
    // 缺省时即当前空间（与只解析当前空间的既有行为一致）
    let workspace = super::resolve_workspace(ctx, ws).await?;
    let (_service, endpoint) =
        find_endpoint_in_workspace(ctx, &workspace.id, &args.id, args.service.as_deref()).await?;

    // form 族信封前提：接口保存 body 须为 form 家族信封（读发送装配同一
    // user_data 行；覆写永不写回）。前提破裂＝INVALID_ARGUMENT 明示报错，
    // 不隐式切换信封
    if has_form_flag {
        let saved_body = user_data_repo::get(&ctx.db.pool, &endpoint.service_id, &endpoint.key)
            .await?
            .and_then(|data| data.body);
        check_form_envelope(saved_body.as_deref(), !args.form_files.is_empty())?;
    }

    // 覆写解析：K=V 形态错误 fail-fast（exit 2）；同名替换与后值胜由编排层合成
    let mut param_rows = parse_kv_args("param", &args.params)?;
    param_rows.extend(parse_kv_args("query", &args.queries)?);
    let overrides = SendOverrides {
        param_rows,
        headers: parse_kv_args("header", &args.headers)?,
        body: body_override,
        form_rows: parse_form_rows(&args.forms, &args.form_files)?,
    };

    // Ctrl+C 侧车：信号到 → cancel_all（CLI 进程同时至多一个执行；发送链自身
    // 响应取消并落 cancelled 行，主流程随后以 CANCELLED 包络退出 130）
    let tasks = ctx.tasks.clone();
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            tasks.cancel_all();
        }
    });

    let send_ctx = SendCtx {
        pool: &ctx.db.pool,
        cache: &ctx.db.cache,
        http: &ctx.http,
        registry: &ctx.tasks,
        data_dir: &ctx.data_dir,
        // 发送链作用域＝已解析空间：接口定位在哪，装配（base_url / 变量 /
        // 两级认证）就在哪，不再回落当前空间
        workspace_id: Some(workspace.id.as_str()),
    };
    let result = send::execute_endpoint(
        &send_ctx,
        SendRequest {
            service_id: endpoint.service_id.clone(),
            endpoint_key: endpoint.key.clone(),
            entry: SendEntry::Cli,
            overrides,
            // 接口级覆写是 GUI Tab 会话态：CLI 恒跟随工作空间生效值
            base_url_override: None,
        },
    )
    .await?;

    match result.state {
        RunState::Passed => {
            render_run_success(out, &result);
            Ok(())
        }
        RunState::Failed | RunState::Cancelled => Err(AppError::new(
            result
                .error_code
                .unwrap_or_else(|| codes::INTERNAL.to_string()),
            result
                .error_message
                .as_deref()
                .unwrap_or("execution failed"),
        )),
    }
}

/// 成功渲染：JSON＝顶层契约（含 success:true，不套 data 包络）；
/// Human＝摘要行＋Body 预览（≤2KB）。extracted / assertions 恒在（schema 稳定）。
/// 请求镜像（URL / headers）的 Secret 变量消费值全文替换掩码（`--show-secrets`
/// 放行）；响应内容是服务端数据，不做该替换。
fn render_run_success(out: &Output, result: &RunResult) {
    let show = out.show_secrets();
    let hints = &result.request.redactions;
    let url = redact_url(
        &mask_secret_values(&result.request.url, &hints.secret_values, show),
        &hints.query_keys,
        show,
    );
    let payload = serde_json::json!({
        "success": true,
        "runId": result.run_id,
        "request": {
            "method": result.request.method,
            "url": url,
            "headers": redact_header_pairs(
                &result.request.headers,
                &hints.header_names,
                &hints.secret_values,
                show,
            ),
        },
        "response": result.response.as_ref().map(|r| serde_json::json!({
            "status": r.status,
            "durationMs": result.duration_ms,
            "headers": redact_header_pairs(&r.headers, &hints.header_names, &[], show),
            "body": {
                "excerpt": r.body.excerpt,
                "truncated": r.body.truncated,
                "totalSize": r.body.total_size,
                "contentType": r.content_type,
            },
        })),
        "extracted": {},
        "assertions": [],
    });
    let mut lines = vec![format!(
        "HTTP {} {}ms",
        result
            .status_code
            .map(|c| c.to_string())
            .unwrap_or_else(|| "-".into()),
        result.duration_ms.unwrap_or(0),
    )];
    lines.push(redact_url(
        &mask_secret_values(&result.request.url, &hints.secret_values, show),
        &hints.query_keys,
        show,
    ));
    if let Some(response) = &result.response {
        const PREVIEW_LIMIT: usize = 2048;
        let preview: String = response.body.excerpt.chars().take(PREVIEW_LIMIT).collect();
        if !preview.is_empty() {
            lines.push(String::new());
            lines.push(preview);
            if response.body.excerpt.chars().count() > PREVIEW_LIMIT {
                lines.push("…".to_string());
            }
        }
    }
    out.success_with_human(&payload, &lines);
}

/// K=V 覆写参数解析（--param / --query / --header / --form 共用）。
fn parse_kv_args(flag: &str, args: &[String]) -> Result<Vec<KvRow>, AppError> {
    args.iter()
        .map(|raw| {
            let (key, value) = raw.split_once('=').ok_or_else(|| {
                AppError::new(
                    codes::INVALID_ARGUMENT,
                    format!("--{flag} expects K=V form, got: {raw}"),
                )
            })?;
            Ok(KvRow::new(key, value))
        })
        .collect()
}

/// form 族覆写行解析：--form K=V 产文本行、--form-file K=<路径> 产文件行
/// （行 type=="file" 与信封行的存储形态一致，value 即文件完整路径；文件
/// 名＝basename、mime 按扩展名推断由引擎既有能力处理）。两旗标各自可重复、
/// 同名后值胜；跨旗标同名时文件行后并入＝文件行胜（两旗标独立收集保不住
/// 命令行交错序，定为文件意图更强——同给同名本就是参数缺陷，一致即可）。
fn parse_form_rows(forms: &[String], form_files: &[String]) -> Result<Vec<KvRow>, AppError> {
    let mut rows = parse_kv_args("form", forms)?;
    for mut row in parse_kv_args("form-file", form_files)? {
        row.type_ = Some("file".to_owned());
        rows.push(row);
    }
    Ok(rows)
}

/// form 族旗标的信封前提校验：接口保存 body 为 form-data 信封→文本行与
/// 文件行皆可；urlencoded 信封→仅文本行（无文件语义）；其余信封 kind、
/// legacy 非信封纯文本与无保存 body→拒绝。错误信息指明接口 body 的实际
/// 类型（用户排错的唯一线索；明示报错，不隐式切换信封）。
fn check_form_envelope(saved_body: Option<&str>, has_file_rows: bool) -> Result<(), AppError> {
    let mismatch = |actual: &str| {
        AppError::new(
            codes::INVALID_ARGUMENT,
            format!(
                "--form/--form-file require the endpoint body saved as a form envelope \
                 (form-data or urlencoded), but this endpoint body is {actual}"
            ),
        )
    };
    let Some(text) = saved_body.map(str::trim).filter(|body| !body.is_empty()) else {
        return Err(mismatch("empty (no saved body)"));
    };
    match parse_body_envelope(text).map(|envelope| envelope.kind) {
        Some(BodyEnvelopeKind::FormData) => Ok(()),
        Some(BodyEnvelopeKind::FormUrlEncoded) if has_file_rows => Err(AppError::new(
            codes::INVALID_ARGUMENT,
            "--form-file is not supported for urlencoded bodies (no file semantics); \
             use --form for text rows",
        )),
        Some(BodyEnvelopeKind::FormUrlEncoded) => Ok(()),
        Some(BodyEnvelopeKind::Json) => Err(mismatch("json")),
        Some(BodyEnvelopeKind::Xml) => Err(mismatch("xml")),
        Some(BodyEnvelopeKind::Text) => Err(mismatch("text")),
        Some(BodyEnvelopeKind::None) => Err(mismatch("none")),
        None => Err(mismatch("plain text (not a form envelope)")),
    }
}

/// `--body-file` 读文件全文为请求体文本：UTF-8、不限后缀（内容语义与后缀
/// 无关——.md 后缀的 JSON 照常发送）、剥 UTF-8 BOM（PowerShell 5.1 的 UTF8
/// 写出默认带 BOM，残留会破坏 JSON 嗅探判 text/plain 并随体发出干扰服务端
/// 解析——本旗标的主场景正是 PowerShell）。大小有上限（一切缓冲有界）：
/// 读前按 metadata 预检拒绝异常大文件（防整读进内存），读后复核防预检后
/// 文件增长。失败错误信息恒含路径（调用方定位问题的唯一线索）。
fn read_body_file(path: &str) -> Result<String, AppError> {
    let invalid = |message: String| {
        AppError::new(
            codes::INVALID_ARGUMENT,
            format!("--body-file {message}: {path}"),
        )
    };
    let metadata = std::fs::metadata(path).map_err(|e| invalid(format!("cannot read ({e})")))?;
    if !metadata.is_file() {
        return Err(invalid("is not a regular file".into()));
    }
    if metadata.len() > CLI_BODY_FILE_MAX_BYTES as u64 {
        return Err(invalid(format!(
            "exceeds {} bytes (file is {} bytes)",
            CLI_BODY_FILE_MAX_BYTES,
            metadata.len()
        )));
    }
    let content =
        std::fs::read_to_string(path).map_err(|e| invalid(format!("cannot read ({e})")))?;
    if content.len() > CLI_BODY_FILE_MAX_BYTES {
        return Err(invalid("exceeds size limit".into()));
    }
    // BOM 不是请求体内容的一部分（trim 不覆盖 U+FEFF——它不是空白字符）
    Ok(content.strip_prefix('\u{feff}').unwrap_or(&content).to_owned())
}

/// 头对脱敏（标准名单 ∪ 认证派生名单；`--show-secrets` 放行）。非名单头
/// 再过一遍 Secret 值全文替换（变量解析消费的 Secret 值可能注入任意头）。
pub(crate) fn redact_header_pairs(
    pairs: &[(String, String)],
    extra_sensitive: &[String],
    secret_values: &[String],
    show: bool,
) -> serde_json::Value {
    pairs
        .iter()
        .map(|(name, value)| {
            let masked = !show
                && (redact::is_sensitive_header(name)
                    || extra_sensitive.iter().any(|e| e.eq_ignore_ascii_case(name)));
            let shown = if masked {
                redact::MASK.to_string()
            } else {
                mask_secret_values(value, secret_values, show)
            };
            serde_json::json!({
                "name": name,
                "value": shown,
            })
        })
        .collect::<Vec<_>>()
        .into()
}

/// Secret 变量消费值的全文替换（请求镜像掩码口径：解析处产出的本次消费
/// 清单 → 消费层全文替换）。`--show-secrets` 放行链路不变；替换核在
/// redact 单点（写时掩码面共用）。
pub(crate) fn mask_secret_values(text: &str, values: &[String], show: bool) -> String {
    if show {
        return text.to_string();
    }
    redact::mask_secret_values_in(text, values)
}

/// URL query 脱敏：命中认证派生键名的值掩码（--show-secrets 放行）。
/// 键比较不区分 ASCII 大小写（HTTP query 键本就大小写不敏感，
/// 与前端 maskUrlQuery 的 gi 正则口径一致）。
pub(crate) fn redact_url(url: &str, query_keys: &[String], show: bool) -> String {
    if show || query_keys.is_empty() {
        return url.to_string();
    }
    let Some((base, query)) = url.split_once('?') else {
        return url.to_string();
    };
    let masked: Vec<String> = query
        .split('&')
        .map(|pair| match pair.split_once('=') {
            Some((key, _)) if query_keys.iter().any(|qk| qk.eq_ignore_ascii_case(key)) => {
                format!("{key}={}", redact::MASK)
            }
            _ => pair.to_string(),
        })
        .collect();
    format!("{base}?{}", masked.join("&"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::endpoint::{HttpMethod, ManualEndpointInput};

    /// 测试专用临时目录（不引 tempfile 依赖，stdlib 组合即可）
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("apilot2-cli-api-test-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 装配注入：AppContext::new(temp)＋默认工作空间种子。
    async fn seeded_ctx(tag: &str) -> AppContext {
        let dir = temp_dir(tag);
        AppContext::new(dir).await.unwrap()
    }

    /// 插入自定义定义的接口（key 与定义可自由组合，稳定键语义）。
    async fn seed_endpoint_with(
        pool: &sqlx::SqlitePool,
        service_id: &str,
        key: &str,
        title: &str,
        method: HttpMethod,
        path: &str,
    ) -> Endpoint {
        endpoint_repo::insert_manual(
            pool,
            &ManualEndpointInput {
                service_id: service_id.to_owned(),
                key: key.to_owned(),
                title: title.to_owned(),
                category_id: None,
                definition: Definition::new(method, path).unwrap(),
            },
        )
        .await
        .unwrap()
    }

    async fn default_workspace_id(ctx: &AppContext) -> String {
        let (id,): (String,) = sqlx::query_as("SELECT id FROM workspaces LIMIT 1")
            .fetch_one(&ctx.db.pool)
            .await
            .unwrap();
        id
    }

    #[tokio::test]
    async fn list_on_empty_workspace_returns_empty() {
        let ctx = seeded_ctx("list-empty").await;
        assert!(
            collect_rows(&ctx, None).await.unwrap().is_empty(),
            "空库＝零行（exit 0 语义）"
        );
    }

    /// 全链接线：get_tree（唯一读链）→ traversal_rows → 行字段。
    /// 数据序：置顶保持原位、`pinned` 仅作字段（GUI 提升语义不进 CLI）。
    #[tokio::test]
    async fn collect_rows_wires_tree_read_chain() {
        let ctx = seeded_ctx("rows").await;
        let ws = default_workspace_id(&ctx).await;
        let pool = &ctx.db.pool;
        crate::infrastructure::service_repo::test_support::seed_service(pool, "s1", &ws, "服务")
            .await;
        crate::infrastructure::category_repo::test_support::seed_category(pool, "c1", "s1", "分类")
            .await;
        crate::infrastructure::endpoint_repo::test_support::seed_endpoint_in_category(
            pool,
            "s1",
            "e-in",
            Some("c1"),
            "分类内",
        )
        .await;
        crate::infrastructure::endpoint_repo::test_support::seed_endpoint(
            pool, "s1", "e-pin", "置顶",
        )
        .await;
        endpoint_repo::set_pinned(pool, "s1", "e-pin", true)
            .await
            .unwrap();

        let rows = collect_rows(&ctx, None).await.unwrap();
        let keys: Vec<&str> = rows.iter().map(|r| r.key.as_str()).collect();
        assert_eq!(
            keys,
            vec!["e-in", "e-pin"],
            "数据序：置顶保持原位（不提升）"
        );
        assert_eq!(rows[0].category_name.as_deref(), Some("分类"));
        assert!(rows[1].pinned, "pinned 作为字段输出");
    }

    /// 搜索口径契约夹具（`src/test/fixtures/search-contract.json`，
    /// 与前端 selector 测试共享同一份表）——任一端改口径另一端立红。
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ContractFixture {
        endpoints: Vec<ContractEndpoint>,
        cases: Vec<ContractCase>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ContractEndpoint {
        key: String,
        title: String,
        method: String,
        path_template: String,
        category_name: Option<String>,
        #[serde(default)]
        pinned: bool,
    }

    #[derive(serde::Deserialize)]
    struct ContractCase {
        keyword: String,
        expect: Vec<String>,
    }

    #[test]
    fn search_matches_tree_search_contract() {
        let fixture: ContractFixture = serde_json::from_str(include_str!(
            "../../../src/test/fixtures/search-contract.json"
        ))
        .expect("contract fixture must parse");
        let rows: Vec<EndpointRow> = fixture
            .endpoints
            .into_iter()
            .map(|e| EndpointRow {
                key: e.key,
                title: e.title,
                method: e.method,
                path_template: e.path_template,
                service_name: "服务".to_owned(),
                category_name: e.category_name,
                pinned: e.pinned,
            })
            .collect();
        for case in &fixture.cases {
            // trim 语义在命令层（与前端 filterApiTree 内部 trim 口径一致）
            let hits: Vec<&str> = rows
                .iter()
                .filter(|row| matches_query(row, case.keyword.trim()))
                .map(|row| row.key.as_str())
                .collect();
            assert_eq!(hits, case.expect, "keyword={:?}", case.keyword);
        }
    }

    /// 空/纯空白关键词＝`INVALID_ARGUMENT`（exit 2）：脚本缺陷 fail-fast，
    /// 不静默全量也不假空集。
    #[tokio::test]
    async fn search_rejects_blank_keyword() {
        let ctx = seeded_ctx("blank").await;
        for keyword in ["", "   "] {
            let err = search(&ctx, &Output::new(false, false), None, keyword)
                .await
                .unwrap_err();
            assert_eq!(err.code, codes::INVALID_ARGUMENT, "keyword={keyword:?}");
            assert_eq!(crate::cli::error::exit_code_for(&err.code), 2);
        }
    }

    #[tokio::test]
    async fn get_resolves_ambiguity_and_not_found() {
        let ctx = seeded_ctx("get-amb").await;
        let ws = default_workspace_id(&ctx).await;
        let pool = &ctx.db.pool;
        crate::infrastructure::service_repo::test_support::seed_service(pool, "s1", &ws, "服务A")
            .await;
        crate::infrastructure::service_repo::test_support::seed_service(pool, "s2", &ws, "服务B")
            .await;
        seed_endpoint_with(pool, "s1", "GET /dup", "甲", HttpMethod::GET, "/dup").await;
        seed_endpoint_with(pool, "s2", "GET /dup", "乙", HttpMethod::GET, "/dup").await;

        // 跨服务撞车未消歧 → ENDPOINT_AMBIGUOUS＋候选清单
        let err = find_endpoint(&ctx, None, "GET /dup", None)
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::ENDPOINT_AMBIGUOUS);
        let candidates = err.details.unwrap()["candidates"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0]["service"], "服务A");
        assert_eq!(candidates[0]["name"], "甲");

        // --service 精确消歧
        let (service, endpoint) = find_endpoint(&ctx, None, "GET /dup", Some("服务B"))
            .await
            .unwrap();
        assert_eq!(service.id, "s2");
        assert_eq!(endpoint.title, "乙");

        // --service 零命中 → SERVICE_NOT_FOUND
        let err = find_endpoint(&ctx, None, "GET /dup", Some("不存在"))
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::SERVICE_NOT_FOUND);

        // 未命中 → ENDPOINT_NOT_FOUND（exit 3）
        let err = find_endpoint(&ctx, None, "GET /nope", None)
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::ENDPOINT_NOT_FOUND);
        assert_eq!(crate::cli::error::exit_code_for(&err.code), 3);
    }

    #[tokio::test]
    async fn structured_output_redaction_and_dirty_fallback() {
        // 纯函数层：params/headers 结构化、脏数据回退、脱敏与放行
        let structured = structured_or_raw(r#"[{"name":"page","value":"1"}]"#);
        assert_eq!(structured[0]["value"], "1");
        let dirty = structured_or_raw("not-json");
        assert_eq!(
            dirty,
            serde_json::json!("not-json"),
            "parse 失败原样字符串回退"
        );
        let non_array = structured_or_raw("{}");
        assert_eq!(non_array, serde_json::json!("{}"), "非数组形态按回退处理");

        let headers = r#"[{"name":"Authorization","value":"Bearer tok"},{"name":"Accept","value":"application/json"}]"#;
        let redacted = render_headers(headers, false);
        assert_eq!(redacted[0]["value"], "***", "敏感名单头值掩码");
        assert_eq!(redacted[0]["name"], "Authorization");
        assert_eq!(redacted[1]["value"], "application/json", "非敏感头放行");
        let revealed = render_headers(headers, true);
        assert_eq!(revealed[0]["value"], "Bearer tok", "--show-secrets 放行");
        let dirty_headers = render_headers("not-json", false);
        assert_eq!(
            dirty_headers,
            serde_json::json!("not-json"),
            "脏 headers 回退且不误脱敏"
        );
    }

    #[tokio::test]
    async fn get_marks_manual_by_identity_shape() {
        let ctx = seeded_ctx("get-manual").await;
        let ws = default_workspace_id(&ctx).await;
        let pool = &ctx.db.pool;
        crate::infrastructure::service_repo::test_support::seed_service(pool, "s1", &ws, "服务")
            .await;
        // 稳定键（含空格）＝同步来源；UUID＝手工来源
        seed_endpoint_with(pool, "s1", "GET /sync", "同步", HttpMethod::GET, "/sync").await;
        crate::infrastructure::endpoint_repo::test_support::seed_endpoint(
            pool, "s1", "uuid-key", "手工",
        )
        .await;

        let (_, sync) = find_endpoint(&ctx, None, "GET /sync", None).await.unwrap();
        assert!(!is_manual_identity(&sync.key));
        let (_, manual) = find_endpoint(&ctx, None, "uuid-key", None).await.unwrap();
        assert!(is_manual_identity(&manual.key));
    }

    // —— api run 覆写解析与脱敏（纯函数层）——

    #[test]
    fn parse_kv_args_splits_k_v_pairs() {
        let rows = parse_kv_args(
            "query",
            &["page=2".to_owned(), "tag=beta release".to_owned()],
        )
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].key, "page");
        assert_eq!(rows[0].value, "2");
        assert_eq!(rows[1].value, "beta release", "值取首个 = 之后的整段");
        assert!(rows.iter().all(|r| r.enabled), "覆写行默认启用");
    }

    #[test]
    fn parse_kv_args_rejects_missing_equals() {
        let err = parse_kv_args("param", &["just-a-key".to_owned()]).unwrap_err();
        assert_eq!(err.code, codes::INVALID_ARGUMENT);
        assert_eq!(crate::cli::error::exit_code_for(&err.code), 2);
        assert!(err.message.contains("--param"), "报错须指认具体旗标");
    }

    /// form 族旗标解析：--form 产文本行、--form-file 产文件行（type=="file"
    /// 与信封行存储形态一致）；K=V 形态错误须指认具体旗标；跨旗标同名时
    /// 文件行后并入（文件行胜）。
    #[test]
    fn parse_form_rows_marks_file_rows_and_reports_flag() {
        let rows = parse_form_rows(
            &["a=1".to_owned(), "b=x=y z".to_owned()],
            &["f=C:\\tmp\\pic.png".to_owned()],
        )
        .unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].key, "a");
        assert_eq!(rows[0].value, "1");
        assert_eq!(rows[0].type_, None, "--form 产文本行");
        assert_eq!(rows[2].value, "C:\\tmp\\pic.png", "值取首个 = 之后的整段");
        assert_eq!(
            rows[2].type_.as_deref(),
            Some("file"),
            "--form-file 产文件行"
        );

        // K=V 形态错误：分别指认 --form / --form-file（exit 2）
        for (flag, raw) in [("form", "just-a-key"), ("form-file", "nope")] {
            let forms;
            let form_files;
            if flag == "form" {
                forms = vec![raw.to_owned()];
                form_files = vec![];
            } else {
                forms = vec![];
                form_files = vec![raw.to_owned()];
            }
            let err = parse_form_rows(&forms, &form_files).unwrap_err();
            assert_eq!(err.code, codes::INVALID_ARGUMENT, "{flag}");
            assert_eq!(crate::cli::error::exit_code_for(&err.code), 2);
            assert!(
                err.message.contains(&format!("--{flag}")),
                "报错须指认具体旗标: {}",
                err.message
            );
        }
    }

    /// form 族信封前提表驱动：form-data→文本行与文件行皆可；urlencoded→
    /// 仅文本行；json / xml / text / none 信封、legacy 纯文本与无保存 body
    /// 均拒绝且错误信息指明实际类型（INVALID_ARGUMENT，exit 2）。
    #[test]
    fn check_form_envelope_covers_body_kind_matrix() {
        let ok_data = r#"{"kind":"form-data","rows":[{"name":"f","value":"v"}]}"#;
        let ok_urlencoded = r#"{"kind":"urlencoded","rows":[{"name":"a","value":"1"}]}"#;
        // form-data：两种行皆可
        assert!(check_form_envelope(Some(ok_data), false).is_ok());
        assert!(check_form_envelope(Some(ok_data), true).is_ok());
        // urlencoded：文本行可、文件行拒（错误信息指明 urlencoded 无文件语义）
        assert!(check_form_envelope(Some(ok_urlencoded), false).is_ok());
        let err = check_form_envelope(Some(ok_urlencoded), true).unwrap_err();
        assert_eq!(err.code, codes::INVALID_ARGUMENT);
        assert_eq!(crate::cli::error::exit_code_for(&err.code), 2);
        assert!(
            err.message.contains("urlencoded") && err.message.contains("--form-file"),
            "urlencoded＋文件行报错须指明旗标与信封类型: {}",
            err.message
        );
        // 非 form 家族：错误信息指明接口 body 实际类型
        for (body, label) in [
            (r#"{"kind":"json","text":"{}"}"#, "json"),
            (r#"{"kind":"xml","text":"<a/>"}"#, "xml"),
            (r#"{"kind":"text","text":"hi"}"#, "text"),
            (r#"{"kind":"none"}"#, "none"),
            ("plain legacy body", "plain text"),
            ("   ", "empty"),
            ("", "empty"),
        ] {
            let err = check_form_envelope(Some(body), false).unwrap_err();
            assert_eq!(err.code, codes::INVALID_ARGUMENT, "{label}");
            assert_eq!(crate::cli::error::exit_code_for(&err.code), 2);
            assert!(
                err.message.contains(label),
                "错误信息须指明 body 类型 {label}: {}",
                err.message
            );
        }
        // 无保存 body（None）：同拒绝口径
        let err = check_form_envelope(None, false).unwrap_err();
        assert_eq!(err.code, codes::INVALID_ARGUMENT);
        assert!(err.message.contains("empty"));
    }

    /// --body 与 --body-file 同给＝INVALID_ARGUMENT（exit 2）：参数校验先行
    /// fail-fast，不触碰数据目录（互斥检查在任何解析之前）。
    #[tokio::test]
    async fn run_rejects_body_and_body_file_together() {
        let ctx = seeded_ctx("body-mutex").await;
        let err = run(
            &ctx,
            &Output::new(false, false),
            None,
            RunArgs {
                id: "GET /healthz".into(),
                service: None,
                params: vec![],
                queries: vec![],
                headers: vec![],
                body: Some("{}".into()),
                body_file: Some("body.json".into()),
                forms: vec![],
                form_files: vec![],
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, codes::INVALID_ARGUMENT);
        assert_eq!(crate::cli::error::exit_code_for(&err.code), 2);
        assert!(
            err.message.contains("--body") && err.message.contains("--body-file"),
            "报错须同时指认两个旗标: {}",
            err.message
        );
    }

    /// body 族与 form 族互斥＝INVALID_ARGUMENT（exit 2）：整体替换与行级
    /// 覆写意图冲突，与 --body/--body-file 互斥同一 fail-fast 位置（不碰
    /// 数据目录；四种两两组合都须指认两族旗标）。
    #[tokio::test]
    async fn run_rejects_body_family_and_form_family_together() {
        let ctx = seeded_ctx("form-mutex").await;
        for (body, body_file, forms, form_files) in [
            (Some("{}".to_owned()), None, vec!["a=1".to_owned()], vec![]),
            (
                None,
                Some("body.json".to_owned()),
                vec![],
                vec!["f=C:\\x\\p.png".to_owned()],
            ),
            (
                None,
                Some("body.json".to_owned()),
                vec!["a=1".to_owned()],
                vec![],
            ),
            (
                Some("{}".to_owned()),
                None,
                vec![],
                vec!["f=C:\\x\\p.png".to_owned()],
            ),
        ] {
            let err = run(
                &ctx,
                &Output::new(false, false),
                None,
                RunArgs {
                    id: "GET /healthz".into(),
                    service: None,
                    params: vec![],
                    queries: vec![],
                    headers: vec![],
                    body,
                    body_file,
                    forms,
                    form_files,
                },
            )
            .await
            .unwrap_err();
            assert_eq!(err.code, codes::INVALID_ARGUMENT);
            assert_eq!(crate::cli::error::exit_code_for(&err.code), 2);
            assert!(
                err.message.contains("--body") && err.message.contains("--form"),
                "报错须同时指认两族旗标: {}",
                err.message
            );
        }
    }

    /// run 链信封前提接线：校验读接口 user_data 的 body 列（GUI 写入的信封
    /// 形态）——json 信封接口＋--form→INVALID_ARGUMENT（exit 2）且错误信息
    /// 指明 json；无 user_data 行（无保存 body）同样拒绝。
    #[tokio::test]
    async fn run_rejects_form_flags_on_non_form_body_endpoint() {
        let ctx = seeded_ctx("form-json").await;
        let ws = default_workspace_id(&ctx).await;
        let pool = &ctx.db.pool;
        crate::infrastructure::service_repo::test_support::seed_service(pool, "s1", &ws, "服务")
            .await;
        seed_endpoint_with(
            pool,
            "s1",
            "POST /login",
            "登录",
            HttpMethod::POST,
            "/login",
        )
        .await;
        crate::infrastructure::user_data_repo::upsert(
            pool,
            "s1",
            "POST /login",
            &crate::domain::user_data::UserDataInput {
                body: Some(r#"{"kind":"json","text":"{}"}"#.into()),
                params: "[]".into(),
                headers: "[]".into(),
                timeout_seconds: None,
                auth: None,
                path_override: None,
                method_override: None,
            },
        )
        .await
        .unwrap();
        seed_endpoint_with(
            pool,
            "s1",
            "POST /bare",
            "裸接口",
            HttpMethod::POST,
            "/bare",
        )
        .await;

        for id in ["POST /login", "POST /bare"] {
            let err = run(
                &ctx,
                &Output::new(false, false),
                None,
                RunArgs {
                    id: id.into(),
                    service: None,
                    params: vec![],
                    queries: vec![],
                    headers: vec![],
                    body: None,
                    body_file: None,
                    forms: vec!["a=1".into()],
                    form_files: vec![],
                },
            )
            .await
            .unwrap_err();
            assert_eq!(err.code, codes::INVALID_ARGUMENT, "{id}");
            assert_eq!(crate::cli::error::exit_code_for(&err.code), 2);
        }
        // json 信封的错误信息指明类型；裸接口指明无保存 body
        // （message 断言细分在 check_form_envelope 纯函数表驱动中）
    }

    /// --body-file 读取口径：UTF-8 全文原样（含多行）、不限后缀、剥 BOM、
    /// 不存在与超大小上限均 INVALID_ARGUMENT 且错误信息含路径（一切缓冲
    /// 有界——超限文件按 metadata 预检拒绝，稀疏文件零成本构造超限长度）。
    #[test]
    fn read_body_file_reads_utf8_any_extension_and_reports_path() {
        let dir = temp_dir("body-file");
        let path = dir.join("payload.md");
        std::fs::write(&path, "{\n  \"a\": 1\n}").unwrap();
        assert_eq!(
            read_body_file(&path.to_string_lossy()).unwrap(),
            "{\n  \"a\": 1\n}",
            "内容原样读入，后缀与内部空白不影响"
        );

        // UTF-8 BOM 剥除：PowerShell 5.1 的 UTF8 写出默认带 BOM，残留会
        // 破坏 JSON 嗅探（判 text/plain）并随体发出
        let bom = dir.join("ps.json");
        std::fs::write(&bom, "\u{feff}{\"a\": 1}").unwrap();
        assert_eq!(
            read_body_file(&bom.to_string_lossy()).unwrap(),
            "{\"a\": 1}",
            "BOM 剥除后内容照常"
        );

        // 不存在：INVALID_ARGUMENT（exit 2）且错误信息含路径
        let missing = dir.join("nope.json");
        let err = read_body_file(&missing.to_string_lossy()).unwrap_err();
        assert_eq!(err.code, codes::INVALID_ARGUMENT);
        assert_eq!(crate::cli::error::exit_code_for(&err.code), 2);
        assert!(err.message.contains("nope.json"), "错误信息含路径");

        // 目录不是常规文件：拒绝且含路径
        let err = read_body_file(&dir.to_string_lossy()).unwrap_err();
        assert_eq!(err.code, codes::INVALID_ARGUMENT);
        assert!(err.message.contains("body-file"), "错误信息含路径线索");

        // 超大小上限：预检拒绝（稀疏文件逻辑长度超限，不实读）
        let big = dir.join("big.bin");
        let file = std::fs::File::create(&big).unwrap();
        file.set_len(CLI_BODY_FILE_MAX_BYTES as u64 + 1).unwrap();
        drop(file);
        let err = read_body_file(&big.to_string_lossy()).unwrap_err();
        assert_eq!(err.code, codes::INVALID_ARGUMENT);
        assert!(err.message.contains("big.bin"), "错误信息含路径");
    }

    #[test]
    fn redact_url_masks_hinted_query_keys_only() {
        let keys = vec!["api_key".to_owned()];
        let url = "http://x.test/a?api_key=secret&verbose=1";
        assert_eq!(
            redact_url(url, &keys, false),
            "http://x.test/a?api_key=***&verbose=1"
        );
        assert_eq!(redact_url(url, &keys, true), url, "--show-secrets 放行");
        assert_eq!(
            redact_url("http://x.test/a", &keys, false),
            "http://x.test/a",
            "无 query 原样"
        );
        assert_eq!(
            redact_url("http://x.test/a?verbose=1", &keys, false),
            "http://x.test/a?verbose=1",
            "未命中提示键的 query 不掩码"
        );
    }

    /// query 掩码口径契约夹具（`src/test/fixtures/redact-contract.json`，
    /// 与前端 maskUrlQuery 测试共享同一份表）——任一端改口径另一端立红。
    /// 名单演进通道：先改夹具（双端测试同红）再双端内化；单边改任一端
    /// 内化口径，该端立红（本地验证：临时改本函数键比较回精确等值，
    /// 本测试即红；只改夹具用例，双端测试同红）。
    #[test]
    fn redact_url_matches_redact_contract_query_cases() {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Fixture {
            query_cases: Vec<QueryCase>,
        }
        #[derive(serde::Deserialize)]
        struct QueryCase {
            url: String,
            keys: Vec<String>,
            masked: String,
        }
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../src/test/fixtures/redact-contract.json"
        ))
        .expect("redact contract fixture must parse");
        assert!(!fixture.query_cases.is_empty(), "夹具须含 query 用例");
        for case in &fixture.query_cases {
            assert_eq!(
                redact_url(&case.url, &case.keys, false),
                case.masked,
                "url={}",
                case.url
            );
            // --show-secrets 放行：任何用例都不掩
            assert_eq!(
                redact_url(&case.url, &case.keys, true),
                case.url,
                "url={}",
                case.url
            );
        }
    }

    #[test]
    fn redact_header_pairs_masks_standard_and_extra_names() {
        let pairs = vec![
            ("Authorization".to_owned(), "Bearer t".to_owned()),
            ("X-Trace-Id".to_owned(), "abc".to_owned()),
        ];
        let extras = vec!["X-Trace-Id".to_owned()];
        let redacted = redact_header_pairs(&pairs, &extras, &[], false);
        assert_eq!(redacted[0]["value"], "***", "标准敏感名单掩码");
        assert_eq!(
            redacted[1]["value"], "***",
            "认证派生名单（redactions 提示）掩码"
        );
        let shown = redact_header_pairs(&pairs, &extras, &[], true);
        assert_eq!(shown[0]["value"], "Bearer t", "--show-secrets 放行");
        assert_eq!(shown[1]["value"], "abc");
    }

    /// Secret 变量消费值全文替换：非名单头与 URL 任意位置的 Secret 值掩码
    /// （纯函数口径由 redact-contract 夹具双端钉住，此处只留组合行为）
    #[test]
    fn secret_values_full_text_replacement() {
        let secrets = vec!["s3cr3t".to_owned(), String::new()];
        assert_eq!(
            mask_secret_values("http://x.test/a?tok=s3cr3t&v=1", &secrets, false),
            "http://x.test/a?tok=***&v=1",
            "URL 任意位置（含非 query 键名位置）全文替换"
        );
        // 非名单头携带 Secret 值：头对渲染走同一替换
        let pairs = vec![("X-Custom".to_owned(), "Bearer s3cr3t".to_owned())];
        let redacted = redact_header_pairs(&pairs, &[], &secrets, false);
        assert_eq!(redacted[0]["value"], "Bearer ***");
    }

    /// Secret 消费值全文替换口径契约夹具（`src/test/fixtures/redact-contract.json`，
    /// 与前端 maskSecretValues 测试共享同一份表）——任一端改口径另一端
    /// 立红。演进通道：先改夹具（双端测试同红）再双端内化；单边改任一端
    /// 内化口径，该端立红（本地验证：临时去掉空值跳过守卫，本测试红而
    /// 前端测试仍绿，即暴露单边漂移；只改夹具用例，双端测试同红）。
    #[test]
    fn mask_secret_values_matches_redact_contract_secret_value_cases() {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Fixture {
            secret_value_cases: Vec<SecretValueCase>,
        }
        #[derive(serde::Deserialize)]
        struct SecretValueCase {
            text: String,
            values: Vec<String>,
            show: bool,
            masked: String,
        }
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../src/test/fixtures/redact-contract.json"
        ))
        .expect("redact contract fixture must parse");
        assert!(
            !fixture.secret_value_cases.is_empty(),
            "夹具须含 Secret 值替换用例"
        );
        for case in &fixture.secret_value_cases {
            assert_eq!(
                mask_secret_values(&case.text, &case.values, case.show),
                case.masked,
                "text={}",
                case.text
            );
        }
    }

    // —— api run 指定空间贯通（本地靶机双端口集成）——

    /// 两侧对称种子：空间各自的靶机 base_url＋服务与 GET /healthz＋用户
    /// 数据 env={{env}} 参数行＋激活变量 env/tok＋工作空间级 Bearer 认证。
    /// 同名配置取不同值——解析值即空间指纹，错取即现形。
    async fn seed_run_workspace(
        pool: &sqlx::SqlitePool,
        workspace_id: &str,
        service_id: &str,
        base_url: &str,
        category_id: &str,
        env: &str,
        token: &str,
    ) {
        sqlx::query("UPDATE workspaces SET base_url = ? WHERE id = ?")
            .bind(base_url)
            .bind(workspace_id)
            .execute(pool)
            .await
            .unwrap();
        // 认证模板引用变量键 tok（值随空间不同），注入后即空间指纹
        crate::infrastructure::workspace_repo::update_auth(
            pool,
            workspace_id,
            Some(r#"{"type":"bearer","token":"{{tok}}"}"#),
        )
        .await
        .unwrap();
        crate::infrastructure::service_repo::test_support::seed_service(
            pool,
            service_id,
            workspace_id,
            "服务",
        )
        .await;
        seed_endpoint_with(
            pool,
            service_id,
            "GET /healthz",
            "健康检查",
            HttpMethod::GET,
            "/healthz",
        )
        .await;
        use crate::infrastructure::variable_repo::test_support as var_support;
        var_support::seed_category(pool, category_id, workspace_id, "环境").await;
        var_support::seed_variable(pool, category_id, "env", env, false).await;
        var_support::seed_variable(pool, category_id, "tok", token, false).await;
        crate::services::variable::set_active_category(pool, workspace_id, Some(category_id))
            .await
            .unwrap();
        crate::infrastructure::user_data_repo::upsert(
            pool,
            service_id,
            "GET /healthz",
            &crate::domain::user_data::UserDataInput {
                body: None,
                params: r#"[{"name":"env","value":"{{env}}"}]"#.into(),
                headers: "[]".into(),
                timeout_seconds: None,
                auth: None,
                path_override: None,
                method_override: None,
            },
        )
        .await
        .unwrap();
    }

    /// 最近一笔 run record 的（URL、归属空间、请求镜像）。
    async fn last_run_record(pool: &sqlx::SqlitePool) -> (String, String, serde_json::Value) {
        let (url, workspace_id, request_json): (String, String, String) = sqlx::query_as(
            "SELECT url, workspace_id, request_json FROM run_records \
                 ORDER BY rowid DESC LIMIT 1",
        )
        .fetch_one(pool)
        .await
        .unwrap();
        (
            url,
            workspace_id,
            serde_json::from_str(&request_json).unwrap(),
        )
    }

    /// 请求镜像里的 Authorization 头值（两级认证注入结果的观测面）。
    fn authorization_of(request: &serde_json::Value) -> String {
        request["headers"]
            .as_array()
            .expect("headers 应为数组")
            .iter()
            .find(|h| h[0] == "Authorization")
            .and_then(|h| h[1].as_str())
            .expect("认证头应已注入")
            .to_owned()
    }

    /// 两空间各指向独立本地靶机端口：`--workspace` 指定空间发送时，接口
    /// 定位、base_url、变量与工作空间级认证全部取指定空间——URL 落在
    /// 指定空间端口、run record 归属该空间、认证头是该空间的值；缺省
    /// （当前空间）时落在当前空间端口（既有行为不变）。
    #[tokio::test]
    async fn run_targets_specified_workspace_through_send_chain() {
        let ctx = seeded_ctx("run-ws").await;
        let pool = &ctx.db.pool;
        // 默认工作空间＝当前空间（settings 无当前键，回落清单首位）
        let current_id = default_workspace_id(&ctx).await;
        let created = crate::services::workspace::create(pool, &ctx.db.cache, "空间甲", None, None)
            .await
            .unwrap();

        let server_a = demo_server::spawn_ephemeral().await.unwrap();
        let server_b = demo_server::spawn_ephemeral().await.unwrap();
        seed_run_workspace(
            pool,
            &created.id,
            "s-run-a",
            &server_a.base_url(),
            "vc-run-a",
            "alpha",
            "ta",
        )
        .await;
        seed_run_workspace(
            pool,
            &current_id,
            "s-run-b",
            &server_b.base_url(),
            "vc-run-b",
            "beta",
            "tb",
        )
        .await;

        // 指定空间甲：请求落在甲的靶机端口
        run(
            &ctx,
            &Output::new(false, false),
            Some("空间甲"),
            RunArgs {
                id: "GET /healthz".into(),
                service: None,
                params: vec![],
                queries: vec![],
                headers: vec![],
                body: None,
                body_file: None,
                forms: vec![],
                form_files: vec![],
            },
        )
        .await
        .unwrap();
        let (url, workspace_id, request) = last_run_record(pool).await;
        assert_eq!(workspace_id, created.id, "run record 归属指定空间");
        assert_eq!(
            url,
            format!("{}/healthz?env=alpha", server_a.base_url()),
            "base_url 与变量都取指定空间"
        );
        assert_eq!(
            authorization_of(&request),
            "Bearer ta",
            "工作空间级认证取指定空间"
        );

        // 缺省：当前空间口径不变，落在当前空间端口
        run(
            &ctx,
            &Output::new(false, false),
            None,
            RunArgs {
                id: "GET /healthz".into(),
                service: None,
                params: vec![],
                queries: vec![],
                headers: vec![],
                body: None,
                body_file: None,
                forms: vec![],
                form_files: vec![],
            },
        )
        .await
        .unwrap();
        let (url, workspace_id, request) = last_run_record(pool).await;
        assert_eq!(workspace_id, current_id, "缺省归属当前空间");
        assert_eq!(
            url,
            format!("{}/healthz?env=beta", server_b.base_url()),
            "缺省仍取当前空间"
        );
        assert_eq!(authorization_of(&request), "Bearer tb");
    }
}
