//! 数据面节点执行器：请求节点（发送桥接 → 响应快照 → 输出桶注入）、
//! 参数提取节点（单来源逐规则求值 → 产物写桶 → 写回分支）与提取产物
//! 的敏感掩码口径；消费节点的可见输出层（连线作用域）。

use std::collections::BTreeMap;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::domain::json_path;
use crate::domain::redact;
use crate::domain::user_data_codec::KvRow;
use crate::domain::variable::normalize_variable_key;
use crate::domain::workflow::{
    ExtractNodeConfig, ExtractSource, RequestNodeConfig, WorkflowGraph, WorkflowNode,
};
use crate::domain::workflow_execution::{
    ExecutionVariable, NodeRequestDetail, NodeResponseDetail, REQUEST_OUTPUT_BODY_KEY,
    REQUEST_OUTPUT_STATUS_KEY, UpstreamRequestViolation, WritebackEntry, direct_upstream_ids,
    match_writeback_source, resolve_upstream_request,
};
use crate::error::AppError;
use crate::error::codes;
use crate::services::http::engine;
use crate::services::http::request::SendOverrides;
use crate::services::http::response::BodySink;
use crate::services::send::assembly::{
    self, AssembleRequest, AssemblyFace, EndpointRef, ExecutionLayer,
};
use crate::services::send::resolve_effective_timeout;
use crate::services::variable::writeback_to_category;


use super::{NodeOutcome, SharedRunContext, SpawnedWorkflow, UpstreamResponse};

/// 请求节点执行：稳定键解析（空间内跨服务）→ 装配（用户数据＋节点覆写）→
/// 变量解析（执行内变量链＋生效集逐节点现取）→ 认证注入 → 引擎发送与
/// 收体（PreviewOnly）→ 响应快照留存（提取节点的取值来源）。
/// 传输成功（含 4xx/5xx 响应）＝节点 passed——语义成败判定交断言等下游
/// 消费者，与 HTTP 域 RunState 口径一致。
pub(super) async fn execute_request_node(
    input: &SpawnedWorkflow,
    node: &WorkflowNode,
    config: &RequestNodeConfig,
    shared_ctx: &SharedRunContext,
    token: &CancellationToken,
) -> NodeOutcome {
    let Some(endpoint_key) = config.endpoint_key.as_deref() else {
        return NodeOutcome::failed(
            codes::ENDPOINT_NOT_FOUND.to_string(),
            format!("request node is not bound to an endpoint: {}", node.id),
        );
    };
    // 每请求节点的装配与生效集都现取（不缓存整轮：执行期写回改变生效集时此口径不变）
    let outcome = send_for_node(input, node, config, endpoint_key, shared_ctx, token).await;
    match outcome {
        Ok(snapshot) => {
            // 裸键条目在快照 move 前取样（status / body 取自同一份响应）
            let entries = request_output_entries(&snapshot);
            let mut ctx = shared_ctx.lock().expect("执行上下文锁");
            ctx.snapshots.insert(node.id.clone(), snapshot);
            // status / body 写本节点输出桶（裸键，无节点名前缀）——可见性
            // 由下游消费节点的入边判定（连线作用域），书写名不进解析链
            let bucket = ctx.node_outputs.entry(node.id.clone()).or_default();
            for (key, variable) in entries {
                bucket.insert(key, variable);
            }
            NodeOutcome::passed(None)
        }
        Err(err) => NodeOutcome::from_error(err),
    }
}

/// 请求节点终态后的输出桶条目（`{{status}}` / `{{body}}` 裸键的注入面）：
/// status 为响应状态码（天然非敏感），body 为响应原文（快照 Preview 前缀），
/// 内容敏感性未知按保守口径带 secret 标记——下游槽位的掩码仍走既有 Secret
/// 消费清单链，本层不做掩码变换。键不带节点名前缀：可见范围由消费节点的
/// 入边（连线作用域）判定，节点书写名只作显示、不进解析链。
fn request_output_entries(snapshot: &UpstreamResponse) -> Vec<(String, ExecutionVariable)> {
    vec![
        (
            REQUEST_OUTPUT_STATUS_KEY.to_owned(),
            ExecutionVariable {
                value: snapshot.status.to_string(),
                secret: false,
            },
        ),
        (
            REQUEST_OUTPUT_BODY_KEY.to_owned(),
            ExecutionVariable {
                value: snapshot.body_text.clone(),
                secret: true,
            },
        ),
    ]
}

/// 消费节点的可见输出层（连线作用域单点）：入边 source 节点输出桶的并集，
/// 按 graph.edges 边序合并——同名键后到覆盖先到（歧义由校验层静态拦截，
/// 引擎保持确定性）。一跳口径：只见直接上游的输出，不见隔跳产物；上游
/// 集合的收集走 domain 单点（与校验歧义判定同一口径）。
pub(super) fn visible_upstream_outputs(
    graph: &WorkflowGraph,
    node_id: &str,
    node_outputs: &BTreeMap<String, BTreeMap<String, ExecutionVariable>>,
) -> BTreeMap<String, ExecutionVariable> {
    let mut visible = BTreeMap::new();
    for upstream_id in direct_upstream_ids(graph, node_id) {
        if let Some(bucket) = node_outputs.get(upstream_id) {
            for (key, variable) in bucket {
                visible.insert(key.clone(), variable.clone());
            }
        }
    }
    visible
}

async fn send_for_node(
    input: &SpawnedWorkflow,
    node: &WorkflowNode,
    config: &RequestNodeConfig,
    endpoint_key: &str,
    shared_ctx: &SharedRunContext,
    token: &CancellationToken,
) -> Result<UpstreamResponse, AppError> {
    // 执行内变量层锁内取值（分桶 clone 后立即释放 guard，不跨 await 持锁）
    let (workflow_vars, buckets) = {
        let ctx = shared_ctx.lock().expect("执行上下文锁");
        (ctx.workflow_vars.clone(), ctx.node_outputs.clone())
    };
    // 可见层就地合成（锁外，图数据不持锁）：本节点的可见输出＝入边 source
    // 节点输出桶并集（连线作用域，一跳），再与工作流变量层走既有合成链
    let execution = ExecutionLayer {
        workflow_vars,
        node_outputs: visible_upstream_outputs(&input.graph, &node.id, &buckets),
    };
    // 预取＋变量合并走发送装配缝单点：显式执行空间、稳定键跨服务解析、
    // 执行内变量注入经装配请求表达；生效集逐节点现取（执行期写回改变
    // 生效集时此口径不变）
    let assembled = assembly::assemble(
        &input.pool,
        AssembleRequest {
            workspace_id: &input.workspace_id,
            endpoint: EndpointRef::StableKey { key: endpoint_key },
            execution: Some(execution),
        },
    )
    .await?;

    // 节点覆写 → 发送覆写链（行值空白＝不覆写该参数，行不进覆写集——预填
    // 行「留空＝跟随接口」的执行口径；query 行合并进参数行，path_params 行
    // 追加其后按名代入 `{param}` 洞，同 key 时模板参数字段后值胜；body 非空
    // 才整体替换，None／空串＝跟随接口用户数据）
    let overrides = SendOverrides {
        param_rows: config
            .query
            .iter()
            .chain(config.path_params.iter())
            .filter(|row| !row.value.trim().is_empty())
            .map(|row| KvRow::new(row.name.clone(), row.value.clone()))
            .collect(),
        headers: Vec::new(),
        body: config.body.clone().filter(|body| !body.is_empty()),
    };

    let composed = assembly::compose_request(AssemblyFace {
        definition: &assembled.definition,
        base_url: assembled.base_url.as_deref(),
        base_url_override: None,
        user_body: assembled.user_body.as_deref(),
        user_params: &assembled.user_params,
        user_headers: &assembled.user_headers,
        path_override: assembled.path_override.as_deref(),
        method_override: assembled.method_override.as_deref(),
        overrides: &overrides,
        variables: &assembled.variables,
        request_auth: assembled.request_auth.as_deref(),
        workspace_auth: assembled.workspace_auth.as_deref(),
    })?;

    // 超时档：节点覆写（毫秒）＞ 接口用户数据 ＞ 全局档。Some＝节点档压过
    // 下游所有档位（覆写不动接口本体的产品语义）；None＝继承现行为（接口
    // 用户数据档，NULL 回落全局档，均无则不限制）
    let timeout = match config.timeout_ms {
        Some(ms) => Some(Duration::from_millis(ms)),
        None => resolve_effective_timeout(input.timeout_global, assembled.timeout_endpoint),
    };
    let head = engine::send_request(input.client.clone(), timeout, &composed.model, token).await?;
    // 收体恒 PreviewOnly（工作流执行不落临时文件）；快照取 Preview 前缀
    // （≤64KB 有界）供提取节点消费，读完即转存快照、不保留整包
    let sink = BodySink::PreviewOnly;
    let result = engine::read_response_body(head, &composed.model, &sink).await?;
    let body_text = String::from_utf8_lossy(&result.response.preview.bytes).into_owned();
    Ok(UpstreamResponse {
        status: result.response.status,
        headers: result.response.headers,
        // Secret 消费清单随快照带出（提取 / 断言产物名单式投影的回显判定）
        secret_values: composed.redactions.secret_values.clone(),
        request: NodeRequestDetail {
            method: composed.model.method.as_str().to_owned(),
            // URL 写时掩码（Secret 消费值全文替换）：记录与事件是输出面，
            // 明文不进记录；掩码不可复原，`--show-secrets` 不适用于记录字段
            url: redact::mask_secret_values_in(
                &composed.model.url,
                &composed.redactions.secret_values,
            ),
        },
        response: NodeResponseDetail {
            status: result.response.status,
            body: redact::masked_body_excerpt(&body_text),
        },
        body_text,
    })
}

/// 提取来源产物摘要的敏感口径（名单式）：状态码天然非敏感；响应头按敏感
/// 头名单判定（复用 redact 名单）；JSONPath 经 [`redact::is_sensitive_value`]
/// 单点判定（尾段键名 ∨ Secret 消费值回显）——产物摘要面命中即整值掩码
/// （不回显原始内容片段，与断言面的片段替换粒度分工见该函数文档）；文本
/// 产物是整包响应体——无键名可判且为潜在敏感载体，保守掩码。
fn mask_extract_output(
    source: ExtractSource,
    path: &str,
    value: &str,
    secret_values: &[String],
) -> bool {
    match source {
        ExtractSource::StatusCode => false,
        ExtractSource::Header => redact::is_sensitive_header(path),
        ExtractSource::JsonPath => redact::is_sensitive_value(
            crate::domain::workflow_assert::path_tail_key(path),
            value,
            secret_values,
        ),
        ExtractSource::Text => true,
    }
}

/// 数据消费节点（提取 / 断言）的上游响应快照定位（共用约束单点）：
/// 上游请求节点约束走 domain 单点（与校验清单同一口径），响应快照按请求
/// 节点 id 分键取（并行分支各自的快照互不覆盖）。
/// `consumer_label` 进错误信息（"extract" / "assert"），错误码按消费方分列。
pub(super) fn upstream_request_snapshot(
    input: &SpawnedWorkflow,
    node: &WorkflowNode,
    shared_ctx: &SharedRunContext,
    consumer_label: &str,
    source_invalid_code: &str,
) -> Result<UpstreamResponse, NodeOutcome> {
    let upstream_node =
        resolve_upstream_request(&input.graph, &node.id).map_err(|violation| {
            let detail = match violation {
                UpstreamRequestViolation::NoUpstream => format!(
                    "{consumer_label} node has no upstream request node: {}",
                    node.id
                ),
                UpstreamRequestViolation::NotRequest(kind) => format!(
                    "{consumer_label} node upstream must be a request node, got {kind:?}: {}",
                    node.id
                ),
            };
            NodeOutcome::failed(source_invalid_code.to_owned(), detail)
        })?;
    // 响应快照校验：按上游请求节点 id 分键取（锁内 clone，guard 不外借）
    shared_ctx
        .lock()
        .expect("执行上下文锁")
        .snapshots
        .get(upstream_node.id.as_str())
        .cloned()
        .ok_or_else(|| {
            NodeOutcome::failed(
                source_invalid_code.to_owned(),
                format!(
                    "{consumer_label} node upstream response is unavailable: {}",
                    node.id
                ),
            )
        })
}

/// 提取产物（执行内形态）：原始值供注入与写回，掩码值供摘要。
struct ExtractProduct {
    name: String,
    value: String,
    secret: bool,
    masked: String,
}

/// 参数提取节点执行：上游必须是请求节点（引擎约束——完整校验清单归校验器），
/// 从其响应快照对多条提取规则逐条求值（节点级单来源、规则自身取值路径）。
/// 空规则集或任一规则求值失败（产物名空白 / 路径未命中 / 语法不受支持 /
/// 响应体非 JSON）＝节点 failed，错误信息定位到具体规则。成功：产物写入
/// 本节点输出桶（键＝裸产物名，无节点名前缀——可见性由下游消费节点的入边
/// 判定，对象 / 数组产物为序列化 JSON 文本，深层字段经解析链
/// `{{产物名.字段}}` 惰性取值）；写回分支开启时再按分类名快照写回本空间
/// 变量分类（命中即写、未命中按名重建后写入；upsert——无键新建、有键覆盖；
/// 执行到即写不回滚），写回值来源按名称遍历本节点产物、首条命中即用（可
/// 带深层字段路径），写回清单进执行记录（值按条目敏感标记掩码）。
pub(super) async fn execute_extract_node(
    input: &SpawnedWorkflow,
    node: &WorkflowNode,
    config: &ExtractNodeConfig,
    shared_ctx: &SharedRunContext,
) -> NodeOutcome {
    let snapshot = match upstream_request_snapshot(
        input,
        node,
        shared_ctx,
        "extract",
        codes::WORKFLOW_EXTRACT_SOURCE_INVALID,
    ) {
        Ok(snapshot) => snapshot,
        Err(outcome) => return outcome,
    };

    // 空规则集：无产物可产（执行前校验已拦截，引擎侧兜底 fail-fast）
    if config.rules.is_empty() {
        return NodeOutcome::failed(
            codes::WORKFLOW_EXTRACT_EVAL_FAILED.to_string(),
            format!("extract node has no extraction rule: {}", node.id),
        );
    }

    // 逐规则求值（同一来源、规则自身路径；首失败即节点 failed——错误定位
    // 到具体规则）
    let mut products: Vec<ExtractProduct> = Vec::with_capacity(config.rules.len());
    for rule in &config.rules {
        let name = rule.name.trim();
        if name.is_empty() {
            return NodeOutcome::failed(
                codes::WORKFLOW_EXTRACT_EVAL_FAILED.to_string(),
                format!("extract node has an empty product name: {}", node.id),
            );
        }
        let extracted = match config.source {
            ExtractSource::JsonPath => extract_json_path(&rule.path, &snapshot.body_text),
            ExtractSource::Header => {
                let header_name = rule.path.trim();
                if header_name.is_empty() {
                    Err("header name is empty".to_owned())
                } else {
                    Ok(find_header(&snapshot.headers, header_name).map(str::to_owned))
                }
            }
            ExtractSource::StatusCode => Ok(Some(snapshot.status.to_string())),
            ExtractSource::Text => Ok(Some(snapshot.body_text.clone())),
        };
        let value = match extracted {
            Ok(Some(value)) => value,
            Ok(None) => {
                return NodeOutcome::failed(
                    codes::WORKFLOW_EXTRACT_EVAL_FAILED.to_string(),
                    format!(
                        "extract path not found for product {name}: {}; response body: {}",
                        rule.path,
                        redact::masked_body_excerpt(&snapshot.body_text)
                    ),
                );
            }
            Err(reason) => {
                return NodeOutcome::failed(
                    codes::WORKFLOW_EXTRACT_EVAL_FAILED.to_string(),
                    format!(
                        "extract failed for product {name}: {reason}; path: {}; response body: {}",
                        rule.path,
                        redact::masked_body_excerpt(&snapshot.body_text)
                    ),
                );
            }
        };
        let secret =
            mask_extract_output(config.source, &rule.path, &value, &snapshot.secret_values);
        let masked = secret
            .then(|| redact::MASK.to_owned())
            .unwrap_or_else(|| value.clone());
        products.push(ExtractProduct {
            name: name.to_owned(),
            value,
            secret,
            masked,
        });
    }

    // 产物写入本节点输出桶（解析链最上层，键＝裸产物名）：可见性由下游
    // 消费节点的入边判定（连线作用域），产物自身恒下传（无去向开关，写回
    // 分支不改变注入）
    {
        let mut ctx = shared_ctx.lock().expect("执行上下文锁");
        let bucket = ctx.node_outputs.entry(node.id.clone()).or_default();
        for product in &products {
            bucket.insert(
                product.name.clone(),
                ExecutionVariable {
                    value: product.value.clone(),
                    secret: product.secret,
                },
            );
        }
    }

    // 写回分支（语义整体搬迁自存变量节点）：按分类名在本空间解析、未命中
    // 自愈重建同名分类、变量键 upsert、执行到即写不回滚
    let mut writebacks = Vec::new();
    if config.writeback.enabled {
        let Some(category_name) = config
            .writeback
            .category_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        else {
            return NodeOutcome::failed(
                codes::NAME_INVALID.to_string(),
                "extract writeback is enabled without a category name".to_owned(),
            );
        };
        let Some(key) = normalize_variable_key(&config.writeback.key)
            .ok()
            .filter(|key| !key.is_empty())
        else {
            return NodeOutcome::failed(
                codes::NAME_INVALID.to_string(),
                format!(
                    "extract writeback is enabled without a variable key: {:?}",
                    config.writeback.key
                ),
            );
        };
        let Some(value) = writeback_product_value(&products, &config.writeback.product_path) else {
            return NodeOutcome::failed(
                codes::NAME_INVALID.to_string(),
                format!(
                    "extract writeback source does not match any product name: {}",
                    config.writeback.product_path
                ),
            );
        };
        if let Err(err) = writeback_to_category(
            &input.pool,
            &input.workspace_id,
            category_name,
            &key,
            &value,
            config.writeback.secret,
        )
        .await
        {
            return NodeOutcome::from_error(err);
        }
        writebacks.push(WritebackEntry {
            key,
            category_name: category_name.to_owned(),
            secret: config.writeback.secret,
            value: if config.writeback.secret {
                redact::MASK.to_owned()
            } else {
                value
            },
        });
    }

    // 产物摘要：逐产物「产物名 = 掩码值」（敏感口径按来源判定，明文只在
    // 执行内流转），多产物以逗号连接
    let summary = products
        .iter()
        .map(|product| format!("{} = {}", product.name, product.masked))
        .collect::<Vec<_>>()
        .join(", ");
    NodeOutcome::Passed {
        output: Some(summary),
        writebacks,
        assertions: Vec::new(),
        selected_edge: None,
    }
}

/// 写回值求值：值来源（`产物名` 或 `产物名.字段路径`）的命中判定走 domain
/// 单点（与校验清单同一口径）——精确全等即整产物值；带深层字段路径时按
/// 点分段下钻（对象按键 / 数组按下标，与解析链深层引用同一求值语义）。
/// 无产物命中＝None（执行前校验已拦截，引擎侧兜底 fail-fast）。
fn writeback_product_value(products: &[ExtractProduct], product_path: &str) -> Option<String> {
    let names: Vec<&str> = products.iter().map(|product| product.name.as_str()).collect();
    let (name, field) = match_writeback_source(&names, product_path)?;
    let product = products.iter().find(|product| product.name == name)?;
    match field {
        Some(field) => crate::domain::workflow_execution::json_field_value_text(&product.value, field),
        None => Some(product.value.clone()),
    }
}

/// JSONPath 提取（响应体文本 → JSON 求值）：响应体非合法 JSON、路径语法
/// 不受支持、路径未命中分别给出可区分的错误信息。
pub(super) fn extract_json_path(path: &str, body_text: &str) -> Result<Option<String>, String> {
    let value: serde_json::Value = serde_json::from_str(body_text)
        .map_err(|_| "response body is not valid JSON".to_owned())?;
    match json_path::evaluate(path, &value) {
        Ok(Some(hit)) => Ok(Some(match hit {
            serde_json::Value::String(text) => text.clone(),
            other => other.to_string(),
        })),
        Ok(None) => Ok(None),
        Err(unsupported) => Err(format!(
            "JSONPath syntax not supported: {}",
            unsupported.fragment
        )),
    }
}

/// 响应头查找（大小写不敏感）。
fn find_header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::run_id::new_workflow_execution_id;
    use crate::domain::workflow::{
        AssertNodeConfig, AssertRule, ExtractRule, ExtractWriteback, GRAPH_SCHEMA_VERSION,
        OverrideRow, Position,
        WorkflowEdge, WorkflowGraph, WorkflowNode, WorkflowNodeConfig,
    };
    use crate::domain::workflow_execution::{STATUS_FAILED, STATUS_PASSED, STATUS_SKIPPED};
    use crate::infrastructure::variable_repo;
    use crate::services::workflow_engine::{RunContext, execute};
    use crate::test_support::{
        Fixture, chain_graph, edge, issues_of, last_record, seeded_memory_pool, node,
        node_record, node_status, plain_client, request_node,
    };
    use sqlx::SqlitePool;
    use std::sync::{Arc, Mutex};

    // —— 数据链（参数提取单来源求值 / 产物引用 / 写回分支）——

    /// 登录链图：Start → 登录请求 → 提取 token（写回分支内嵌）→ 带令牌查
    /// me → End。`extract_path` 注入提取路径（正常链与失败链复用）；
    /// `writeback_category` 为 Some 时提取节点开启写回分支。me 的授权头由
    /// 接口用户数据承担（节点头覆写已取消），`Fixture::seed_me_bearer_auth`
    /// 按需播种——不播种即无授权（供 401 反证链测试）。
    fn login_chain_graph(extract_path: &str, writeback_category: Option<&str>) -> WorkflowGraph {
        let login = WorkflowNode {
            id: "login".into(),
            name: "登录".into(),
            position: Position { x: 1.0, y: 0.0 },
            config: WorkflowNodeConfig::Request(RequestNodeConfig {
                endpoint_key: Some("POST /auth/login".into()),
                body: Some(r#"{"username":"admin","password":"123456"}"#.into()),
                ..Default::default()
            }),
        };
        let extract = WorkflowNode {
            id: "extract".into(),
            name: "提取".into(),
            position: Position { x: 2.0, y: 0.0 },
            config: WorkflowNodeConfig::Extract(ExtractNodeConfig {
                source: ExtractSource::JsonPath,
                rules: vec![ExtractRule {
                    path: extract_path.into(),
                    name: "token".into(),
                }],
                writeback: ExtractWriteback {
                    enabled: writeback_category.is_some(),
                    product_path: "token".into(),
                    key: "token".into(),
                    category_name: writeback_category.map(str::to_owned),
                    secret: true,
                },
            }),
        };
        let me = WorkflowNode {
            id: "me".into(),
            name: "查询".into(),
            position: Position { x: 3.0, y: 0.0 },
            config: WorkflowNodeConfig::Request(RequestNodeConfig {
                endpoint_key: Some("GET /auth/me".into()),
                ..Default::default()
            }),
        };
        let node = |id: &str, config| WorkflowNode {
            id: id.to_owned(),
            name: String::new(),
            position: Position { x: 0.0, y: 0.0 },
            config,
        };
        let edge = |index: usize, source: &str, target: &str| WorkflowEdge {
            id: format!("e{index}"),
            source: source.to_owned(),
            target: target.to_owned(),
            label: None,
        };
        WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                login,
                extract,
                me,
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![
                edge(0, "start", "login"),
                edge(1, "login", "extract"),
                edge(2, "extract", "me"),
                edge(3, "me", "end"),
            ],
        }
    }

    /// 链尾追加验证提取（me → verify → end）：me 响应 200 时 claims 含
    /// `sub` 提取成功（verify passed）；401 时响应体为 error 形态（无
    /// `sub`）提取失败（verify failed、工作流 failed）。请求节点传输成功
    /// 即 passed（4xx 不可见），verify 是把 me 实际收到 200 还是 401 转成
    /// 节点成败的唯一可断言形态。
    fn append_verify_extract(mut graph: WorkflowGraph) -> WorkflowGraph {
        graph.nodes.push(WorkflowNode {
            id: "verify".into(),
            name: String::new(),
            position: Position { x: 5.0, y: 0.0 },
            config: WorkflowNodeConfig::Extract(ExtractNodeConfig {
                source: ExtractSource::JsonPath,
                rules: vec![ExtractRule {
                    path: "$.sub".into(),
                    name: "sub".into(),
                }],
                writeback: ExtractWriteback::default(),
            }),
        });
        graph.edges.retain(|edge| edge.target != "end");
        graph.edges.push(WorkflowEdge {
            id: "ev1".into(),
            source: "me".into(),
            target: "verify".into(),
            label: None,
        });
        graph.edges.push(WorkflowEdge {
            id: "ev2".into(),
            source: "verify".into(),
            target: "end".into(),
            label: None,
        });
        graph
    }

    /// 全链集成（对靶机）：登录 → 提取 $.token（产物 token 注入＋写回分
    /// 支落分类）→ 后续请求 `{{token}}` 引用成功（verify 提取 $.sub 成功＝
    /// me 实际 200，非传输成功即 passed 的假阳性）。工作流 passed；产物
    /// 摘要进执行记录（敏感口径掩码）；写回落库且分类按名自愈。
    #[tokio::test]
    async fn login_extract_writeback_chain_passes_with_writeback() {
        let fx = Fixture::new().await;
        fx.seed_me_bearer_auth().await;
        let graph = append_verify_extract(login_chain_graph("$.token", Some("登录态")));
        let workflow_id = fx.seed_workflow("登录链", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED, "全链应通过: {dto:?}");
        for id in ["login", "extract", "me", "verify"] {
            assert_eq!(node_record(&dto, id).status, STATUS_PASSED, "{id} 应通过");
        }

        // 产物摘要进记录与事件：`token` 键名命中敏感名单，行级掩码占位
        // （多行摘要形态「行名 = 掩码值」）
        let extract_record = node_record(&dto, "extract");
        assert_eq!(extract_record.output.as_deref(), Some("token = ***"));
        let completed_output: Vec<String> = fx
            .events
            .lock()
            .expect("事件锁")
            .iter()
            .filter_map(|event| {
                if event["event"] == "node.completed" && event["nodeId"] == "extract" {
                    event["output"].as_str().map(str::to_owned)
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(completed_output, vec!["token = ***".to_owned()]);

        // 写回落库：分类按名自愈重建、token 明文入库（库内明文 / 展示掩码定案）
        let categories = variable_repo::list_workspace_categories(&fx.pool, "w1")
            .await
            .unwrap();
        let category = categories
            .iter()
            .find(|category| category.name == "登录态")
            .expect("写回分类应被按名重建");
        let variables = variable_repo::list_variables(&fx.pool, &category.id)
            .await
            .unwrap();
        assert_eq!(variables.len(), 1);
        assert_eq!(variables[0].key, "token");
        assert!(
            !variables[0].value.is_empty(),
            "写回值应为提取到的真实 token"
        );
        assert!(variables[0].secret, "写回敏感标记恒置敏感（默认口径）");
    }

    /// 请求明细落记录：request（方法＋最终 URL）与 response（状态码＋响应体
    /// 掩码摘要）随响应快照留存同步落记录；URL 中的 Secret 消费值写时掩码
    /// （记录与事件是输出面，明细不可复原——`--show-secrets` 只放行读时
    /// 掩码面，不适用记录字段）；非请求节点明细恒 None。
    #[tokio::test]
    async fn request_node_record_carries_masked_request_response_details() {
        let fx = Fixture::new().await;
        fx.seed_me_bearer_auth().await;
        let mut graph = login_chain_graph("$.token", None);
        // me 节点加 query 覆写 token={{token}}：URL 携带 Secret 消费值 → 掩码面
        let me = graph
            .nodes
            .iter_mut()
            .find(|node| node.id == "me")
            .expect("登录链图应有 me 节点");
        if let WorkflowNodeConfig::Request(config) = &mut me.config {
            config.query = vec![OverrideRow {
                name: "token".into(),
                value: "{{token}}".into(),
            }];
        }
        let workflow_id = fx.seed_workflow("明细链", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED, "全链应通过: {dto:?}");

        let login_record = node_record(&dto, "login");
        let request = login_record.request.as_ref().expect("请求节点应有请求明细");
        assert_eq!(request.method, "POST");
        assert!(
            request.url.ends_with("/auth/login"),
            "最终 URL 应可读: {}",
            request.url
        );
        let response = login_record
            .response
            .as_ref()
            .expect("请求节点应有响应明细");
        assert_eq!(response.status, 200);
        // 响应体掩码摘要：JSON 键名可见、字符串值（JWT）掩码
        assert!(
            response.body.contains("\"token\""),
            "键名可见: {}",
            response.body
        );
        assert!(
            !response.body.contains("eyJ"),
            "JWT 不得明文进记录: {}",
            response.body
        );

        // me 请求：URL 携带 {{token}} 解析值 → 写时掩码
        let me_request = node_record(&dto, "me")
            .request
            .clone()
            .expect("请求明细应存在");
        assert!(
            me_request.url.contains("token=***"),
            "URL Secret 消费值应掩码: {}",
            me_request.url
        );
        assert!(
            !me_request.url.contains("eyJ"),
            "URL 不得残留明文 token: {}",
            me_request.url
        );

        // 非请求节点明细恒 None
        assert!(node_record(&dto, "extract").request.is_none());
        assert!(node_record(&dto, "me").response.is_some());

        // 落库记录与内存记录同构（读后写一致）
        let stored = last_record(&fx.pool, &workflow_id).await;
        let stored_login = stored
            .nodes
            .iter()
            .find(|node| node.node_id == "login")
            .expect("落库记录应有 login");
        assert!(stored_login.request.is_some());
        assert!(stored_login.response.is_some());
    }

    /// 节点 path_params 代入与空值行跳过（对靶机）：模板参数行按名填充
    /// `{param}` 洞（靶机回填状态码可判），值空白的 query / path 行不进
    /// URL（「留空＝不覆写」的执行口径）。
    #[tokio::test]
    async fn path_params_fill_template_and_blank_rows_are_skipped() {
        let fx = Fixture::new().await;
        let graph = WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                WorkflowNode {
                    id: "call".into(),
                    name: "调用".into(),
                    position: Position { x: 1.0, y: 0.0 },
                    config: WorkflowNodeConfig::Request(RequestNodeConfig {
                        endpoint_key: Some("GET /api/error/{status}".into()),
                        query: vec![
                            OverrideRow {
                                name: "blank".into(),
                                value: String::new(),
                            },
                            OverrideRow {
                                name: "verbose".into(),
                                value: "1".into(),
                            },
                        ],
                        path_params: vec![
                            OverrideRow {
                                name: "status".into(),
                                value: "418".into(),
                            },
                            OverrideRow {
                                name: "blank".into(),
                                value: "  ".into(),
                            },
                        ],
                        ..Default::default()
                    }),
                },
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![edge(0, "start", "call"), edge(1, "call", "end")],
        };
        let workflow_id = fx.seed_workflow("路径链", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED, "全链应通过: {dto:?}");

        let request = node_record(&dto, "call")
            .request
            .clone()
            .expect("请求明细应存在");
        assert!(
            request.url.ends_with("/api/error/418?verbose=1"),
            "path_params 应代入模板洞、空白行不进 URL: {}",
            request.url
        );
        let response = node_record(&dto, "call")
            .response
            .as_ref()
            .expect("响应明细应存在");
        assert_eq!(response.status, 418, "模板参数代入后靶机按路径回状态码");
    }

    /// 写回 upsert：键已存在即覆盖（token 刷新语义）、分类被删后按名重建。
    #[tokio::test]
    async fn writeback_upserts_and_rebuilds_deleted_category() {
        let fx = Fixture::new().await;
        let graph = login_chain_graph("$.token", Some("登录态"));
        let workflow_id = fx.seed_workflow("写回链", &graph).await;

        // 预置同名分类与旧值（旧 token）：执行应覆盖旧值而非撞车报错
        let _category = variable_repo::insert_category(
            &fx.pool,
            &crate::domain::variable::NewVariableCategory {
                id: "cat-old".into(),
                workspace_id: Some("w1".into()),
                name: "登录态".into(),
            },
        )
        .await
        .unwrap();
        variable_repo::insert_variable(
            &fx.pool,
            &crate::domain::variable::NewVariable {
                category_id: "cat-old".into(),
                key: "token".into(),
                value: "stale-token".into(),
                secret: false,
            },
        )
        .await
        .unwrap();

        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED, "全链应通过: {dto:?}");
        let variables = variable_repo::list_variables(&fx.pool, "cat-old")
            .await
            .unwrap();
        assert_eq!(variables.len(), 1, "同键覆盖不新增行");
        assert_ne!(variables[0].value, "stale-token", "旧值应被新 token 覆盖");
        assert!(variables[0].secret, "覆盖写同步更新敏感标记");

        // 分类删除后重建：执行仍按名自愈写入新分类行
        variable_repo::delete_category(&fx.pool, "cat-old")
            .await
            .unwrap();
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED, "重建后全链应通过");
        let categories = variable_repo::list_workspace_categories(&fx.pool, "w1")
            .await
            .unwrap();
        let rebuilt = categories
            .iter()
            .find(|category| category.name == "登录态")
            .expect("分类应被按名重建");
        assert_ne!(rebuilt.id, "cat-old", "重建为新分类行");
        let variables = variable_repo::list_variables(&fx.pool, &rebuilt.id)
            .await
            .unwrap();
        assert_eq!(variables.len(), 1);
        assert_eq!(variables[0].key, "token");
    }

    /// 提取失败（路径不存在）：节点 failed、工作流 failed、后续 skipped；
    /// 错误信息携带期望路径与实际响应摘要。
    #[tokio::test]
    async fn extract_path_miss_fails_node_with_expected_path_and_excerpt() {
        let fx = Fixture::new().await;
        let graph = login_chain_graph("$.data.tokn", None);
        let workflow_id = fx.seed_workflow("提取失败", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_FAILED);
        assert_eq!(node_status(&dto, "login"), STATUS_PASSED);
        let record = node_record(&dto, "extract");
        assert_eq!(record.status, STATUS_FAILED);
        assert_eq!(
            record.error_code.as_deref(),
            Some(codes::WORKFLOW_EXTRACT_EVAL_FAILED)
        );
        let message = record.error_message.as_deref().expect("失败原因应可见");
        assert!(message.contains("$.data.tokn"), "期望路径应可见: {message}");
        assert!(
            message.contains("response body:"),
            "响应摘要应可见: {message}"
        );
        assert_eq!(node_status(&dto, "me"), STATUS_SKIPPED);
        assert_eq!(node_status(&dto, "end"), STATUS_SKIPPED);
    }

    /// 提取上游不是请求节点时执行前拦截（upstreamNotRequest 可定位）。
    #[tokio::test]
    async fn extract_upstream_must_be_request_node() {
        let fx = Fixture::new().await;
        // Start → 提取（上游为 Start，非请求节点）→ End
        let graph = WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                node(
                    "extract",
                    WorkflowNodeConfig::Extract(ExtractNodeConfig {
                        source: ExtractSource::JsonPath,
                        rules: vec![ExtractRule {
                            path: "$.token".into(),
                            name: "token".into(),
                        }],
                        writeback: ExtractWriteback::default(),
                    }),
                ),
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![edge(0, "start", "extract"), edge(1, "extract", "end")],
        };
        let workflow_id = fx.seed_workflow("上游非法", &graph).await;
        let err = execute(&fx.ctx(), &workflow_id).await.unwrap_err();
        assert_eq!(err.code, codes::WORKFLOW_NOT_EXECUTABLE);
        let issues = issues_of(&err);
        assert_eq!(issues[0]["code"], "upstreamNotRequest");
        assert_eq!(issues[0]["nodeId"], "extract");
    }

    /// 解析优先级：节点输出可见层压过同名生效变量集条目（对靶机——生效
    /// 集预置同名键 `token`、值不同，后续请求必须用产物值）；执行内产物
    /// 运行结束不残留（第二次执行的生效集取值不受首执行污染——写回分类
    /// 未激活时生效链不携带执行内值）。
    #[tokio::test]
    async fn node_outputs_override_effective_and_do_not_leak_across_runs() {
        let fx = Fixture::new().await;
        // 生效集预置同名键 `token`（非敏感、值恒 "stale"），激活分类路径
        let _category = variable_repo::insert_category(
            &fx.pool,
            &crate::domain::variable::NewVariableCategory {
                id: "cat-active".into(),
                workspace_id: Some("w1".into()),
                name: "激活分类".into(),
            },
        )
        .await
        .unwrap();
        variable_repo::insert_variable(
            &fx.pool,
            &crate::domain::variable::NewVariable {
                category_id: "cat-active".into(),
                key: "token".into(),
                value: "stale".into(),
                secret: false,
            },
        )
        .await
        .unwrap();
        variable_repo::set_active_category(&fx.pool, "w1", Some("cat-active"))
            .await
            .unwrap();

        // 链尾 verify 提取 $.sub：me 200（claims 回显含 sub）才成功，401
        // （error 体无 sub）则 failed、工作流 failed。若解析链落到生效集
        // 的 "stale"（伪 token），me 必 401——即 dto passed 才真正证明
        // 节点输出层的产物值覆盖了生效集同名键（请求节点传输成功即
        // passed，4xx 不可见，须由 verify 显形）。
        fx.seed_me_bearer_auth().await;
        let graph = append_verify_extract(login_chain_graph("$.token", None));
        let workflow_id = fx.seed_workflow("优先级", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED, "节点输出层应覆盖生效集同名键");
        assert_eq!(node_status(&dto, "me"), STATUS_PASSED);

        // 执行内产物不残留：写回未开启，首执行结束后生效集同名键仍是
        // 预置 "stale"（执行内值只活在 RunContext）；二次执行重建上下文，
        // 仍走「提取→产物注入→覆盖」链通过，不因残留状态绕过验证。
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED, "二次执行应重建执行内上下文");

        // 生效集未被执行污染（写回未开启，激活分类的预置值保持原样）
        let variables = variable_repo::list_variables(&fx.pool, "cat-active")
            .await
            .unwrap();
        assert_eq!(variables[0].value, "stale");
    }

    /// 反证链（verify 区分力）：me 不引用 `{{token}}` 时靶机回 401——
    /// 传输成功节点仍 passed（4xx 不判败），但 verify 提取 `$.sub` 失败、
    /// 工作流 failed。证明正向链的 passed 不可能是「verify 恒真」退化。
    #[tokio::test]
    async fn chain_without_token_reference_fails_at_verify() {
        let fx = Fixture::new().await;
        let graph = append_verify_extract(login_chain_graph("$.token", None));
        let workflow_id = fx.seed_workflow("无引用链", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(
            dto.status, STATUS_FAILED,
            "me 401 应经 verify 显形: {dto:?}"
        );
        assert_eq!(
            node_status(&dto, "me"),
            STATUS_PASSED,
            "传输成功仍 passed（4xx 不判败）"
        );
        assert_eq!(node_status(&dto, "verify"), STATUS_FAILED);
        assert_eq!(
            node_record(&dto, "verify").error_code.as_deref(),
            Some(codes::WORKFLOW_EXTRACT_EVAL_FAILED)
        );
    }

    /// 提取直调上游快照（200）：记录面响应明细在直调面不被消费，预览体随
    /// body_text 占位；secret_values 恒空（名单式敏感判定覆盖直调用例）。
    fn extract_snapshot(
        method: &str,
        url: &str,
        headers: Vec<(&str, &str)>,
        body_text: &str,
    ) -> UpstreamResponse {
        UpstreamResponse {
            status: 200,
            headers: headers
                .into_iter()
                .map(|(name, value)| (name.to_owned(), value.to_owned()))
                .collect(),
            body_text: body_text.to_owned(),
            secret_values: Vec::new(),
            request: NodeRequestDetail {
                method: method.to_owned(),
                url: url.to_owned(),
            },
            response: NodeResponseDetail {
                status: 200,
                body: body_text.to_owned(),
            },
        }
    }

    /// 提取直调链骨架：Start → login 请求 → 提取节点 → End（提取节点由
    /// 调用方给——规则集各用例不同；入边 login → extract 供快照定位）。
    fn extract_direct_graph(extract_node: WorkflowNode) -> WorkflowGraph {
        let mut graph = chain_graph(&[]);
        graph.nodes.push(request_node("login", "GET /healthz"));
        graph.nodes.push(extract_node);
        graph.edges.push(WorkflowEdge {
            id: "e0".into(),
            source: "login".into(),
            target: "extract".into(),
            label: None,
        });
        graph
    }

    /// 提取直调执行输入：SpawnedWorkflow 组装＋上游响应快照播种（按 login
    /// 节点 id 分键）。EdgesIndex 借用图，由调用方在图存活期自建。
    fn extract_direct_input(
        pool: &SqlitePool,
        graph: &WorkflowGraph,
        snapshot: UpstreamResponse,
    ) -> (SpawnedWorkflow, SharedRunContext) {
        let shared_ctx: SharedRunContext = Arc::new(Mutex::new(RunContext::new()));
        shared_ctx
            .lock()
            .expect("执行上下文锁")
            .snapshots
            .insert("login".into(), snapshot);
        let input = SpawnedWorkflow {
            pool: pool.clone(),
            execution_id: new_workflow_execution_id(),
            workflow_id: "wf-x".into(),
            workspace_id: "w1".into(),
            graph: graph.clone(),
            sink: None,
            client: plain_client(),
            timeout_global: None,
        };
        (input, shared_ctx)
    }

    /// 节点输出桶读取便捷面（按节点 id 分桶取裸键值）。
    fn bucket_value(ctx: &SharedRunContext, node_id: &str, key: &str) -> Option<String> {
        ctx.lock()
            .expect("执行上下文锁")
            .node_outputs
            .get(node_id)
            .and_then(|bucket| bucket.get(key))
            .map(|v| v.value.clone())
    }

    /// 单来源提取直调：状态码 / 响应头 / JSONPath 三种来源分别求值，产物
    /// 以裸产物名写入本节点输出桶，摘要「产物名 = 掩码值」；失败错误定位
    /// 到具体规则。
    #[tokio::test]
    async fn extract_single_source_evaluates_and_injects_products() {
        let pool = seeded_memory_pool().await;
        let extract_node = |source, path: &str, name: &str| WorkflowNode {
            id: "extract".into(),
            name: "提取".into(),
            position: Position { x: 1.0, y: 0.0 },
            config: WorkflowNodeConfig::Extract(ExtractNodeConfig {
                source,
                rules: vec![ExtractRule {
                    path: path.into(),
                    name: name.into(),
                }],
                writeback: ExtractWriteback::default(),
            }),
        };
        let graph = extract_direct_graph(extract_node(
            ExtractSource::StatusCode,
            "",
            "status",
        ));
        let (input, shared_ctx) = extract_direct_input(
            &pool,
            &graph,
            extract_snapshot(
                "POST",
                "http://x/login",
                vec![("X-Request-Id", "r-1")],
                r#"{"data":{"token":"t-1","exp":9}}"#,
            ),
        );
        let run_extract = async |input: &SpawnedWorkflow,
                                 config: &ExtractNodeConfig,
                                 shared_ctx: &SharedRunContext|
               -> NodeOutcome {
            let node = input
                .graph
                .nodes
                .iter()
                .find(|node| node.id == "extract")
                .expect("提取节点应存在");
            execute_extract_node(input, node, config, shared_ctx).await
        };

        // 状态码源：非敏感明文摘要，产物以裸键写入本节点桶
        let status_config = match &input.graph.nodes[3].config {
            WorkflowNodeConfig::Extract(config) => config.clone(),
            other => panic!("测试固定提取节点: {other:?}"),
        };
        let outcome = run_extract(&input, &status_config, &shared_ctx).await;
        match outcome {
            NodeOutcome::Passed { output, .. } => {
                assert_eq!(output.as_deref(), Some("status = 200"));
            }
            other => panic!("应通过，实际: {other:?}"),
        }
        assert_eq!(
            bucket_value(&shared_ctx, "extract", "status"),
            Some("200".to_owned())
        );

        // JSONPath 源：对象产物序列化为 JSON 文本注入
        let data_config = ExtractNodeConfig {
            source: ExtractSource::JsonPath,
            rules: vec![ExtractRule {
                path: "$.data".into(),
                name: "data".into(),
            }],
            writeback: ExtractWriteback::default(),
        };
        let outcome = run_extract(&input, &data_config, &shared_ctx).await;
        match outcome {
            NodeOutcome::Passed { output, .. } => {
                let summary = output.expect("对象产物摘要应存在");
                assert!(
                    summary.contains(r#"data = {"exp":9,"token":"t-1"}"#),
                    "对象产物序列化为 JSON 文本: {summary}"
                );
            }
            other => panic!("应通过，实际: {other:?}"),
        }
        assert_eq!(
            bucket_value(&shared_ctx, "extract", "data"),
            Some(r#"{"exp":9,"token":"t-1"}"#.to_owned())
        );

        // 响应头源：头名不在敏感名单，明文注入
        let header_config = ExtractNodeConfig {
            source: ExtractSource::Header,
            rules: vec![ExtractRule {
                path: "X-Request-Id".into(),
                name: "requestId".into(),
            }],
            writeback: ExtractWriteback::default(),
        };
        let outcome = run_extract(&input, &header_config, &shared_ctx).await;
        match outcome {
            NodeOutcome::Passed { output, .. } => {
                assert_eq!(output.as_deref(), Some("requestId = r-1"));
            }
            other => panic!("应通过，实际: {other:?}"),
        }
        assert_eq!(
            bucket_value(&shared_ctx, "extract", "requestId"),
            Some("r-1".to_owned())
        );

        // 求值失败：节点 failed，错误定位到具体规则并携带路径
        let failing = ExtractNodeConfig {
            source: ExtractSource::JsonPath,
            rules: vec![ExtractRule {
                path: "$.absent".into(),
                name: "missing".into(),
            }],
            writeback: ExtractWriteback::default(),
        };
        let outcome = run_extract(&input, &failing, &shared_ctx).await;
        match outcome {
            NodeOutcome::Failed { code, message, .. } => {
                assert_eq!(code, codes::WORKFLOW_EXTRACT_EVAL_FAILED);
                assert!(
                    message.contains("for product missing"),
                    "错误定位到具体规则: {message}"
                );
                assert!(message.contains("$.absent"), "路径可见: {message}");
            }
            other => panic!("应失败，实际: {other:?}"),
        }
    }

    /// 可见性按连线（对靶机端到端）：提取产物对其直接下游请求可见
    /// （me 的 query `{{token}}` 解析为真实 token，进 Secret 消费清单、
    /// URL 写时掩码），对非下游节点不可见（after 的上游是 me 请求节点，
    /// 不产出 token——引用未命中、模板原样保留，URL 无掩码痕迹）。
    #[tokio::test]
    async fn extract_products_visible_only_to_direct_downstream() {
        let fx = Fixture::new().await;
        // 图：Start → login → extract(token) → me（query token={{token}}）
        //     → after（query token={{token}}）→ End
        let extract = WorkflowNode {
            id: "extract".into(),
            name: "提取".into(),
            position: Position { x: 2.0, y: 0.0 },
            config: WorkflowNodeConfig::Extract(ExtractNodeConfig {
                source: ExtractSource::JsonPath,
                rules: vec![ExtractRule {
                    path: "$.token".into(),
                    name: "token".into(),
                }],
                writeback: ExtractWriteback::default(),
            }),
        };
        let query_token = |config: &mut RequestNodeConfig| {
            config.query = vec![OverrideRow {
                name: "token".into(),
                value: "{{token}}".into(),
            }];
        };
        let mut me = request_node("me", "GET /auth/me");
        if let WorkflowNodeConfig::Request(config) = &mut me.config {
            query_token(config);
        }
        let mut after = request_node("after", "GET /healthz");
        if let WorkflowNodeConfig::Request(config) = &mut after.config {
            query_token(config);
        }
        let graph = WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                WorkflowNode {
                    id: "login".into(),
                    name: "登录".into(),
                    position: Position { x: 1.0, y: 0.0 },
                    config: WorkflowNodeConfig::Request(RequestNodeConfig {
                        endpoint_key: Some("POST /auth/login".into()),
                        body: Some(r#"{"username":"admin","password":"123456"}"#.into()),
                        ..Default::default()
                    }),
                },
                extract,
                me,
                after,
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![
                edge(0, "start", "login"),
                edge(1, "login", "extract"),
                edge(2, "extract", "me"),
                edge(3, "me", "after"),
                edge(4, "after", "end"),
            ],
        };
        let workflow_id = fx.seed_workflow("连线可见性", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED, "全链应通过: {dto:?}");

        // 直接下游 me：token 解析成功（Secret 消费值 → URL 写时掩码）
        let me_url = node_record(&dto, "me")
            .request
            .as_ref()
            .expect("me 应有请求明细")
            .url
            .clone();
        assert!(
            me_url.contains("token=***"),
            "直接下游应解析到产物（掩码面）: {me_url}"
        );

        // 非下游 after：引用不可见、模板原样保留（无掩码痕迹——若可见会
        // 同样解析成 Secret 值并掩码为 ***；URL 中 `{{` 经 percent 编码为
        // `%7B%7B`）
        let after_url = node_record(&dto, "after")
            .request
            .as_ref()
            .expect("after 应有请求明细")
            .url
            .clone();
        assert!(
            !after_url.contains("token=***"),
            "非下游节点不得解析到提取产物: {after_url}"
        );
        assert!(
            after_url.contains("%7B%7Btoken%7D%7D"),
            "未命中引用按模板原样保留（percent 编码形态）: {after_url}"
        );
    }

    /// 空规则集：节点 failed（校验清单已拦截，引擎侧兜底 fail-fast——错误
    /// 携带定位描述）。
    #[tokio::test]
    async fn extract_empty_rules_fail_fast() {
        let pool = seeded_memory_pool().await;
        let extract_node = WorkflowNode {
            id: "extract".into(),
            name: "提取".into(),
            position: Position { x: 1.0, y: 0.0 },
            config: WorkflowNodeConfig::Extract(ExtractNodeConfig {
                source: ExtractSource::JsonPath,
                rules: Vec::new(),
                writeback: ExtractWriteback::default(),
            }),
        };
        let graph = extract_direct_graph(extract_node);
        let (input, shared_ctx) = extract_direct_input(
            &pool,
            &graph,
            extract_snapshot("GET", "http://x/", Vec::new(), "{}"),
        );
        let WorkflowNodeConfig::Extract(config) = &input.graph.nodes[3].config else {
            panic!("测试固定提取节点");
        };
        let outcome =
            execute_extract_node(&input, &input.graph.nodes[3], config, &shared_ctx).await;
        match outcome {
            NodeOutcome::Failed { code, message, .. } => {
                assert_eq!(code, codes::WORKFLOW_EXTRACT_EVAL_FAILED);
                assert!(
                    message.contains("no extraction rule"),
                    "空规则集定位描述: {message}"
                );
            }
            other => panic!("应失败，实际: {other:?}"),
        }
    }

    /// 多规则提取直调：同一来源下两条规则各自求值，产物逐个以裸键写入
    /// 本节点输出桶（`token` / `exp` 均可由直接下游引用）；产物摘要逐产物
    /// 「名 = 掩码值」以逗号连接，敏感口径逐产物判定（token 键名命中掩码、
    /// exp 明文）。
    #[tokio::test]
    async fn extract_multi_rules_evaluate_and_inject_each_product() {
        let pool = seeded_memory_pool().await;
        let extract_node = WorkflowNode {
            id: "extract".into(),
            name: "提取".into(),
            position: Position { x: 1.0, y: 0.0 },
            config: WorkflowNodeConfig::Extract(ExtractNodeConfig {
                source: ExtractSource::JsonPath,
                rules: vec![
                    ExtractRule {
                        path: "$.data.token".into(),
                        name: "token".into(),
                    },
                    ExtractRule {
                        path: "$.data.exp".into(),
                        name: "exp".into(),
                    },
                ],
                writeback: ExtractWriteback::default(),
            }),
        };
        let graph = extract_direct_graph(extract_node);
        let (input, shared_ctx) = extract_direct_input(
            &pool,
            &graph,
            extract_snapshot(
                "POST",
                "http://x/login",
                Vec::new(),
                r#"{"data":{"token":"t-1","exp":9}}"#,
            ),
        );
        let WorkflowNodeConfig::Extract(config) = &input.graph.nodes[3].config else {
            panic!("测试固定提取节点");
        };
        let outcome =
            execute_extract_node(&input, &input.graph.nodes[3], config, &shared_ctx).await;
        match outcome {
            NodeOutcome::Passed { output, .. } => {
                assert_eq!(
                    output.as_deref(),
                    Some("token = ***, exp = 9"),
                    "逐产物摘要（token 掩码、exp 明文）"
                );
            }
            other => panic!("应通过，实际: {other:?}"),
        }
        assert_eq!(
            bucket_value(&shared_ctx, "extract", "token"),
            Some("t-1".to_owned()),
            "首条规则产物注入"
        );
        assert_eq!(
            bucket_value(&shared_ctx, "extract", "exp"),
            Some("9".to_owned()),
            "第二条规则产物注入"
        );
    }

    /// 写回分支直调：值来源「产物名.字段路径」按最深产物名命中下钻；全局
    /// 分类语义与 upsert 归集成测试（对靶机链）。
    #[tokio::test]
    async fn extract_writeback_resolves_deep_product_source() {
        let pool = seeded_memory_pool().await;
        // 预置写回目标分类（写回按名命中既有分类）
        variable_repo::insert_category(
            &pool,
            &crate::domain::variable::NewVariableCategory {
                id: "cat-wb".into(),
                workspace_id: Some("w1".into()),
                name: "登录态".into(),
            },
        )
        .await
        .unwrap();
        let extract_node = WorkflowNode {
            id: "extract".into(),
            name: "提取".into(),
            position: Position { x: 1.0, y: 0.0 },
            config: WorkflowNodeConfig::Extract(ExtractNodeConfig {
                source: ExtractSource::JsonPath,
                rules: vec![ExtractRule {
                    path: "$.data".into(),
                    name: "data".into(),
                }],
                writeback: ExtractWriteback {
                    enabled: true,
                    // 值来源带深层字段路径：data 产物的 token 字段
                    product_path: "data.token".into(),
                    key: "token".into(),
                    category_name: Some("登录态".into()),
                    secret: false,
                },
            }),
        };
        let graph = extract_direct_graph(extract_node);
        let (input, shared_ctx) = extract_direct_input(
            &pool,
            &graph,
            extract_snapshot(
                "POST",
                "http://x/login",
                Vec::new(),
                r#"{"data":{"token":"t-deep"}}"#,
            ),
        );
        let WorkflowNodeConfig::Extract(config) = &input.graph.nodes[3].config else {
            panic!("测试固定提取节点");
        };
        let outcome =
            execute_extract_node(&input, &input.graph.nodes[3], config, &shared_ctx).await;
        match outcome {
            NodeOutcome::Passed { writebacks, .. } => {
                assert_eq!(writebacks.len(), 1, "写回清单应有一条");
                assert_eq!(writebacks[0].key, "token");
                assert_eq!(writebacks[0].category_name, "登录态");
                assert_eq!(
                    writebacks[0].value, "t-deep",
                    "深层字段值（secret 关＝明文记录）"
                );
            }
            other => panic!("应通过，实际: {other:?}"),
        }
        // 库内：深层字段值 upsert 入分类
        let variables = variable_repo::list_variables(&pool, "cat-wb")
            .await
            .unwrap();
        assert_eq!(variables.len(), 1);
        assert_eq!(variables[0].key, "token");
        assert_eq!(variables[0].value, "t-deep");
    }

    /// 写回值来源命中第二条产物：按名称遍历本节点产物、首条命中即用（首条
    /// 产物名不命中来源，遍历落到第二条的全等命中）。
    #[tokio::test]
    async fn extract_writeback_hits_second_product() {
        let pool = seeded_memory_pool().await;
        let extract_node = WorkflowNode {
            id: "extract".into(),
            name: "提取".into(),
            position: Position { x: 1.0, y: 0.0 },
            config: WorkflowNodeConfig::Extract(ExtractNodeConfig {
                source: ExtractSource::JsonPath,
                rules: vec![
                    ExtractRule {
                        path: "$.data".into(),
                        name: "data".into(),
                    },
                    ExtractRule {
                        path: "$.data.token".into(),
                        name: "token".into(),
                    },
                ],
                writeback: ExtractWriteback {
                    enabled: true,
                    // 值来源全等命中第二条产物的名称
                    product_path: "token".into(),
                    key: "token".into(),
                    category_name: Some("登录态".into()),
                    secret: false,
                },
            }),
        };
        let graph = extract_direct_graph(extract_node);
        let (input, shared_ctx) = extract_direct_input(
            &pool,
            &graph,
            extract_snapshot(
                "POST",
                "http://x/login",
                Vec::new(),
                r#"{"data":{"token":"t-second"}}"#,
            ),
        );
        let WorkflowNodeConfig::Extract(config) = &input.graph.nodes[3].config else {
            panic!("测试固定提取节点");
        };
        let outcome =
            execute_extract_node(&input, &input.graph.nodes[3], config, &shared_ctx).await;
        match outcome {
            NodeOutcome::Passed { writebacks, .. } => {
                assert_eq!(writebacks.len(), 1, "写回清单应有一条");
                assert_eq!(writebacks[0].key, "token");
                assert_eq!(
                    writebacks[0].value, "t-second",
                    "命中第二条产物的整值"
                );
            }
            other => panic!("应通过，实际: {other:?}"),
        }
        // 库内：写回按未命中分类名自愈重建后写入
        let categories = variable_repo::list_workspace_categories(&pool, "w1")
            .await
            .unwrap();
        let category = categories
            .iter()
            .find(|category| category.name == "登录态")
            .expect("写回分类应自愈重建");
        let variables = variable_repo::list_variables(&pool, &category.id)
            .await
            .unwrap();
        assert_eq!(variables.len(), 1);
        assert_eq!(variables[0].value, "t-second");
    }

    /// 节点超时覆写生效：接口用户数据带 1s 档，节点覆写 200ms 压过接口档——
    /// 5s 慢响应在覆写档位即超时失败（耗时远小于接口档，同时钉住毫秒单位：
    /// 覆写值若按秒解释不会在 1s 内失败）。
    #[tokio::test]
    async fn node_timeout_override_beats_endpoint_timeout() {
        let fx = Fixture::new().await;
        crate::infrastructure::user_data_repo::upsert(
            &fx.pool,
            "s1",
            "GET /api/slow",
            &crate::domain::user_data::UserDataInput {
                body: None,
                params: "[]".into(),
                headers: "[]".into(),
                timeout_seconds: Some(1),
                auth: None,
                path_override: None,
                method_override: None,
            },
        )
        .await
        .unwrap();
        let mut graph = chain_graph(&[Some("GET /api/slow")]);
        if let WorkflowNodeConfig::Request(config) = &mut graph.nodes[1].config {
            config.query = vec![OverrideRow {
                name: "ms".into(),
                value: "5000".into(),
            }];
            config.timeout_ms = Some(200);
        }
        let workflow_id = fx.seed_workflow("节点超时覆写", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_FAILED, "{dto:?}");
        let record = node_record(&dto, "n0");
        assert_eq!(record.status, STATUS_FAILED);
        assert_eq!(record.error_code.as_deref(), Some(codes::TIMEOUT));
        assert!(
            record.duration_ms.unwrap_or(i64::MAX) < 1000,
            "覆写 200ms 应压过接口 1s 档: {:?}",
            record.duration_ms
        );
    }

    /// 节点未覆写（timeoutMs 缺省 None）：继承现行为——接口用户数据 1s 档
    /// 照常生效，5s 慢响应在接口档超时失败（耗时覆盖接口档）。
    #[tokio::test]
    async fn node_timeout_absent_inherits_endpoint_timeout() {
        let fx = Fixture::new().await;
        crate::infrastructure::user_data_repo::upsert(
            &fx.pool,
            "s1",
            "GET /api/slow",
            &crate::domain::user_data::UserDataInput {
                body: None,
                params: "[]".into(),
                headers: "[]".into(),
                timeout_seconds: Some(1),
                auth: None,
                path_override: None,
                method_override: None,
            },
        )
        .await
        .unwrap();
        let mut graph = chain_graph(&[Some("GET /api/slow")]);
        if let WorkflowNodeConfig::Request(config) = &mut graph.nodes[1].config {
            config.query = vec![OverrideRow {
                name: "ms".into(),
                value: "5000".into(),
            }];
        }
        let workflow_id = fx.seed_workflow("节点超时继承", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_FAILED, "{dto:?}");
        let record = node_record(&dto, "n0");
        assert_eq!(record.status, STATUS_FAILED);
        assert_eq!(record.error_code.as_deref(), Some(codes::TIMEOUT));
        assert!(
            record.duration_ms.unwrap_or(0) >= 1000,
            "未覆写应继承接口 1s 档: {:?}",
            record.duration_ms
        );
    }

    /// 写回链图：Start → 登录请求 → 提取 token（写回配置直传）→ End。
    /// 不接后续消费节点（写回面单独验证，不依赖下游）。
    fn writeback_chain_graph(writeback: ExtractWriteback) -> WorkflowGraph {
        WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                WorkflowNode {
                    id: "login".into(),
                    name: "登录".into(),
                    position: Position { x: 1.0, y: 0.0 },
                    config: WorkflowNodeConfig::Request(RequestNodeConfig {
                        endpoint_key: Some("POST /auth/login".into()),
                        body: Some(r#"{"username":"admin","password":"123456"}"#.into()),
                        ..Default::default()
                    }),
                },
                node(
                    "extract",
                    WorkflowNodeConfig::Extract(ExtractNodeConfig {
                        source: ExtractSource::JsonPath,
                        rules: vec![ExtractRule {
                            path: "$.token".into(),
                            name: "token".into(),
                        }],
                        writeback,
                    }),
                ),
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![
                edge(0, "start", "login"),
                edge(1, "login", "extract"),
                edge(2, "extract", "end"),
            ],
        }
    }

    /// 写回清单进执行记录：条目＝键、分类、敏感标记，值按条目敏感标记掩码
    /// （默认开＝掩码占位；显式关＝用户声明非敏感的写回如实明文记录）。
    #[tokio::test]
    async fn writeback_entries_recorded_with_mask_per_secret() {
        let fx = Fixture::new().await;
        let writeback = |secret| ExtractWriteback {
            enabled: true,
            product_path: "token".into(),
            key: "token".into(),
            category_name: Some("登录态".into()),
            secret,
        };

        // 敏感开（默认口径）：值掩码占位
        let workflow_id = fx
            .seed_workflow("写回掩码", &writeback_chain_graph(writeback(true)))
            .await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED);
        let extract_record = node_record(&dto, "extract");
        assert_eq!(extract_record.writebacks.len(), 1);
        let entry = &extract_record.writebacks[0];
        assert_eq!(entry.key, "token");
        assert_eq!(entry.category_name, "登录态");
        assert!(entry.secret);
        assert_eq!(entry.value, redact::MASK, "敏感写回的值掩码占位");

        // 敏感关：明文如实记录（用户显式声明非敏感）
        let workflow_id = fx
            .seed_workflow("写回明文", &writeback_chain_graph(writeback(false)))
            .await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED);
        let entry = &node_record(&dto, "extract").writebacks[0];
        assert!(!entry.secret);
        assert!(
            !entry.value.is_empty() && entry.value != redact::MASK,
            "非敏感写回明文记录"
        );
        // 变量敏感标记随写回更新：第一段以默认口径写入 secret=true，此处
        // 显式关的写回把覆盖后的标记同步收敛为关（正向收敛——公开旧值被
        // 敏感写回标记为敏感——由写回自愈重建测试的预置 stale 值覆盖）
        let categories = variable_repo::list_workspace_categories(&fx.pool, "w1")
            .await
            .unwrap();
        let category = categories
            .iter()
            .find(|category| category.name == "登录态")
            .expect("写回分类应存在");
        let variables = variable_repo::list_variables(&fx.pool, &category.id)
            .await
            .unwrap();
        assert_eq!(variables.len(), 1);
        assert!(!variables[0].secret, "敏感标记随写回配置同步");
    }

    /// 写回≠激活：写非激活分类不进生效链（不污染），激活后经生效变量集
    /// 可见——普通接口 Tab 与 CLI `api run` 的 `{{token}}` 解析消费同一
    /// 生效集（发送链变量源单点），故生效集可见即非工作流调用面可用。
    #[tokio::test]
    async fn writeback_to_inactive_category_reaches_effective_set_only_after_activation() {
        let fx = Fixture::new().await;
        // 生效链预置另一激活分类（非写回目标）
        let _category = variable_repo::insert_category(
            &fx.pool,
            &crate::domain::variable::NewVariableCategory {
                id: "cat-active".into(),
                workspace_id: Some("w1".into()),
                name: "其他".into(),
            },
        )
        .await
        .unwrap();
        variable_repo::set_active_category(&fx.pool, "w1", Some("cat-active"))
            .await
            .unwrap();

        let graph = writeback_chain_graph(ExtractWriteback {
            enabled: true,
            product_path: "token".into(),
            key: "token".into(),
            category_name: Some("登录态".into()),
            secret: true,
        });
        let workflow_id = fx.seed_workflow("非激活写回", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED);

        // 非激活分类写回：生效链不含该值
        let effective = crate::services::variable::load_effective(&fx.pool, "w1")
            .await
            .unwrap();
        assert!(
            !effective.iter().any(|v| v.key == "token"),
            "非激活分类写回不得污染生效链"
        );

        // 激活写回目标分类：生效集携带写回值（真实 token，非掩码——值恒
        // 明文入库，掩码是展示端口径）
        let categories = variable_repo::list_workspace_categories(&fx.pool, "w1")
            .await
            .unwrap();
        let category = categories
            .iter()
            .find(|category| category.name == "登录态")
            .expect("写回分类应存在");
        variable_repo::set_active_category(&fx.pool, "w1", Some(&category.id))
            .await
            .unwrap();
        let effective = crate::services::variable::load_effective(&fx.pool, "w1")
            .await
            .unwrap();
        let token = effective
            .iter()
            .find(|v| v.key == "token")
            .expect("激活后写回值应在生效集");
        assert!(!token.value.is_empty() && token.value != redact::MASK);
        assert!(token.secret, "敏感标记随写回带出生效集");
    }

    /// 执行到即写、后续失败不回滚：写回之后的请求失败（引用失效）不撤回
    /// 已写回值；执行期不回写编辑模型（节点配置保持原样）。
    #[tokio::test]
    async fn late_failure_keeps_writeback_and_node_config_unchanged() {
        let fx = Fixture::new().await;
        let mut graph = writeback_chain_graph(ExtractWriteback {
            enabled: true,
            product_path: "token".into(),
            key: "token".into(),
            category_name: Some("登录态".into()),
            secret: true,
        });
        // 链尾失败注入＝必败断言（写在请求之后——断言上游恒为请求节点）：
        // 提取写回已发生，断言失败传播不回滚
        graph.nodes.push(WorkflowNode {
            id: "post".into(),
            name: String::new(),
            position: Position { x: 5.0, y: 0.0 },
            config: WorkflowNodeConfig::Request(RequestNodeConfig {
                endpoint_key: Some("GET /healthz".into()),
                ..Default::default()
            }),
        });
        graph.nodes.push(WorkflowNode {
            id: "verify".into(),
            name: String::new(),
            position: Position { x: 6.0, y: 0.0 },
            config: WorkflowNodeConfig::Assert(AssertNodeConfig {
                rules: vec![AssertRule::StatusCode {
                    expected: "599".into(),
                }],
            }),
        });
        graph.edges.push(WorkflowEdge {
            id: "e9".into(),
            source: "extract".into(),
            target: "post".into(),
            label: None,
        });
        graph.edges.push(WorkflowEdge {
            id: "e10".into(),
            source: "post".into(),
            target: "verify".into(),
            label: None,
        });
        graph
            .edges
            .retain(|edge| edge.target != "end" || edge.source != "extract");
        graph.edges.push(WorkflowEdge {
            id: "e11".into(),
            source: "verify".into(),
            target: "end".into(),
            label: None,
        });
        let workflow_id = fx.seed_workflow("后段失败", &graph).await;
        let before = crate::infrastructure::workflow_repo::get(&fx.pool, &workflow_id)
            .await
            .unwrap()
            .expect("工作流应存在");

        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_FAILED);
        assert_eq!(
            node_status(&dto, "extract"),
            STATUS_PASSED,
            "写回节点先于失败点执行"
        );
        assert_eq!(node_status(&dto, "verify"), STATUS_FAILED);

        // 已写回值保留（不回滚）
        let categories = variable_repo::list_workspace_categories(&fx.pool, "w1")
            .await
            .unwrap();
        let category = categories
            .iter()
            .find(|category| category.name == "登录态")
            .expect("写回分类应存在");
        let variables = variable_repo::list_variables(&fx.pool, &category.id)
            .await
            .unwrap();
        assert_eq!(variables.len(), 1);
        assert!(!variables[0].value.is_empty(), "后段失败不得撤回已写回值");

        // 执行期不回写编辑模型：graph 行与执行前一致
        let after = crate::infrastructure::workflow_repo::get(&fx.pool, &workflow_id)
            .await
            .unwrap()
            .expect("工作流应存在");
        assert_eq!(before.graph, after.graph, "执行不得改写节点配置");
    }

    /// 名单式投影端到端（提取面）：非敏感键的 JSONPath 产物明文进记录
    /// 与事件（明文同值仍走执行内变量上下文供后续节点引用）；敏感键产物
    /// 掩码由 token 用例（login_extract_writeback_chain_passes_with_writeback）
    /// 钉住。
    #[tokio::test]
    async fn extract_non_sensitive_jsonpath_output_recorded_in_plaintext() {
        let fx = Fixture::new().await;
        let graph = WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                request_node("probe", "GET /healthz"),
                node(
                    "extract",
                    WorkflowNodeConfig::Extract(ExtractNodeConfig {
                        source: ExtractSource::JsonPath,
                        rules: vec![ExtractRule {
                            path: "$.status".into(),
                            name: "status".into(),
                        }],
                        writeback: ExtractWriteback::default(),
                    }),
                ),
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![
                edge(0, "start", "probe"),
                edge(1, "probe", "extract"),
                edge(2, "extract", "end"),
            ],
        };
        let workflow_id = fx.seed_workflow("提取明文", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED, "全链应通过: {dto:?}");
        let record = node_record(&dto, "extract");
        assert_eq!(
            record.output.as_deref(),
            Some("status = ok"),
            "非敏感产物明文（行摘要形态）"
        );
    }

    /// 注入面取样快照（status / body 文本自定）。
    fn snapshot_of(status: u16, body: &str) -> UpstreamResponse {
        UpstreamResponse {
            status,
            headers: Vec::new(),
            body_text: body.to_owned(),
            secret_values: Vec::new(),
            request: NodeRequestDetail {
                method: "GET".into(),
                url: "http://target/".into(),
            },
            response: NodeResponseDetail {
                status,
                body: String::new(),
            },
        }
    }

    /// 注入单元：请求节点终态后产出 `status`（状态码文本，非敏感）与
    /// `body`（响应原文，保守敏感）两个裸键条目——写入本节点输出桶，无
    /// 节点名前缀（可见性由下游入边判定，书写名不进解析链）。
    #[tokio::test]
    async fn request_output_entries_inject_status_and_body_keys() {
        let entries = request_output_entries(&snapshot_of(201, r#"{"t":1}"#));
        assert_eq!(entries.len(), 2, "status 与 body 两键: {entries:?}");
        assert_eq!(entries[0].0, "status");
        assert_eq!(entries[0].1.value, "201");
        assert!(!entries[0].1.secret, "状态码天然非敏感");
        assert_eq!(entries[1].0, "body");
        assert_eq!(entries[1].1.value, r#"{"t":1}"#, "body 注入响应原文");
        assert!(
            entries[1].1.secret,
            "响应原文敏感性未知，保守带 secret 标记"
        );
    }
}
