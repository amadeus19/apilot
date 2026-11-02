//! `apilot workflow` 命令组：工作流读取（list / get）、执行前校验
//! （validate）与阻塞执行（run）。操作范围缺省当前工作空间，`--workspace`
//! 可只读定位目标空间（跨空间 id 视同不存在的作用域语义归 Service 单点，
//! 本层不自拼过滤）；执行与校验复用 Core Service 单点实现（零业务逻辑
//! 入本层）。
//!
//! 输出契约：
//! - list / get 走 `data` 包络（api 组惯例）；validate / run 走顶层契约
//!   （`success` 与业务字段同级，与 `api run` 形态一致）。
//! - 脱敏口径分两层：get 的图覆写头行走 domain 读时脱敏投影（与 redact
//!   契约同源，`--show-secrets` 放行）；run 输出来自执行记录，其 request /
//!   response 明细在引擎落笔时已掩码（Secret 值不可复原，`--show-secrets`
//!   不适用）。
//! - validate 的有效性是数据不是命令失败：合法与非法都 exit 0
//!   （CI 消费 `valid` / `issues`；`valid`＝无 error 级问题，warning 只进
//!   清单不推翻，分级与执行入口同源）；not-found 走 `WORKFLOW_NOT_FOUND`
//!   （exit 3）。

use clap::Args;
use clap::Subcommand;
use serde_json::Value;

use super::output::Output;
use crate::app_context::AppContext;
use crate::domain::workflow::{Workflow, WorkflowGraph, masked_graph_for_display};
use crate::domain::workflow_execution::{STATUS_CANCELLED, STATUS_FAILED, STATUS_PASSED};
use crate::domain::workflow_validation::blocks_execution;
use crate::error::AppError;
use crate::error::codes;
use crate::services::workflow_engine::{self, WorkflowEngineCtx, WorkflowExecutionDto};
use crate::services::{workflow, workflow_validate};

#[derive(Debug, Args)]
pub(crate) struct WorkflowCommand {
    #[command(subcommand)]
    pub(super) command: WorkflowSub,
}

#[derive(Debug, Subcommand)]
pub(super) enum WorkflowSub {
    /// 输出当前工作空间工作流清单
    List,
    /// 输出工作流完整结构（节点 / 边 / 覆写配置）
    Get {
        /// 工作流 id（`workflow list` 输出的 id）
        #[arg(value_name = "ID")]
        id: String,
    },
    /// 执行前校验（输出问题清单；合法性见 valid 字段，合法与非法均 exit 0）
    Validate {
        /// 工作流 id（`workflow list` 输出的 id）
        #[arg(value_name = "ID")]
        id: String,
    },
    /// 执行工作流并阻塞至终态（passed=exit 0；failed / cancelled=非 0）
    Run {
        /// 工作流 id（`workflow list` 输出的 id）
        #[arg(value_name = "ID")]
        id: String,
    },
}

/// `apilot workflow list`：目标工作空间全量工作流（缺省＝当前工作空间）。
pub(crate) async fn list(ctx: &AppContext, out: &Output, ws: Option<&str>) -> Result<(), AppError> {
    let workspace = super::resolve_workspace(ctx, ws).await?;
    let items = workflow::list(&ctx.db.pool, &workspace.id).await?;
    let rows: Vec<Vec<String>> = items
        .items
        .iter()
        .map(|item| vec![item.id.clone(), item.name.clone(), item.updated_at.clone()])
        .collect();
    out.success_table(&items, &["ID", "NAME", "UPDATED"], &rows);
    Ok(())
}

/// `apilot workflow get`：单工作流完整结构（图覆写头行读时脱敏）。
pub(crate) async fn get(
    ctx: &AppContext,
    out: &Output,
    ws: Option<&str>,
    id: &str,
) -> Result<(), AppError> {
    scoped_row(ctx, ws, id).await?;
    let mut dto = workflow::load(&ctx.db.pool, id).await?;
    dto.graph = output_graph(&dto.graph, out.show_secrets());
    let value = serde_json::to_value(&dto)
        .map_err(|err| AppError::internal(format!("workflow dto encode failed: {err}")))?;

    let graph = &dto.graph;
    let entries = [
        ("id", dto.id.clone()),
        ("name", dto.name.clone()),
        ("nodes", graph.nodes.len().to_string()),
        ("edges", graph.edges.len().to_string()),
        ("created_at", dto.created_at.clone()),
        ("updated_at", dto.updated_at.clone()),
    ];
    out.success_kv(&value, &entries);
    Ok(())
}

/// `apilot workflow validate`：执行前校验全清单（合法性是数据，exit 0）。
pub(crate) async fn validate(
    ctx: &AppContext,
    out: &Output,
    ws: Option<&str>,
    id: &str,
) -> Result<(), AppError> {
    scoped_row(ctx, ws, id).await?;
    let issues = workflow_validate::validate(&ctx.db.pool, id, None).await?;
    // 有效性＝无 error 级问题（分级单点与执行入口同源）：warning 级只进
    // 清单提示不推翻 valid——CI 消费口径与 run / GUI 的放行判定一致，不
    // 在本层重写分级清单
    let valid = !issues.iter().any(|issue| blocks_execution(&issue.code));
    let payload = serde_json::json!({
        "success": true,
        "valid": valid,
        "issues": issues,
    });
    // 文本行：无问题输出 "valid"；有问题逐条照列（含不推翻 valid 的
    // warning 行——清单呈现与 JSON issues 同源，不因放行而隐藏）
    let lines = if issues.is_empty() {
        vec!["valid".to_owned()]
    } else {
        issues
            .iter()
            .map(|issue| {
                format!(
                    "{} {} {}",
                    issue.code,
                    issue.node_id.as_deref().unwrap_or("-"),
                    issue.message
                )
            })
            .collect()
    };
    out.success_with_human(&payload, &lines);
    Ok(())
}

/// `apilot workflow run`：执行工作流至终态（阻塞语义同 api run）。
/// passed → exit 0；failed → 终态错误码（exit 4/1，逐节点明细随 error.details）；
/// cancelled（Ctrl+C）→ exit 130。
pub(crate) async fn run(
    ctx: &AppContext,
    out: &Output,
    ws: Option<&str>,
    id: &str,
) -> Result<(), AppError> {
    scoped_row(ctx, ws, id).await?;

    // Ctrl+C 侧车：信号到 → cancel_all（CLI 进程同时至多一个执行；引擎响应
    // 取消落 cancelled 记录，主流程随后以 CANCELLED 包络退出 130）
    let tasks = ctx.tasks.clone();
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            tasks.cancel_all();
        }
    });

    let engine_ctx = WorkflowEngineCtx {
        pool: &ctx.db.pool,
        registry: &ctx.tasks,
        http: &ctx.http,
        sink: None,
    };
    let exec = workflow_engine::execute(&engine_ctx, id).await?;
    render_run(out, &exec)
}

/// 终态分发渲染：passed 顶层契约输出；failed / cancelled 转错误包络
/// （执行载荷随 details 下发——CI 失败路径仍可消费逐节点明细）。
fn render_run(out: &Output, exec: &WorkflowExecutionDto) -> Result<(), AppError> {
    match exec.status.as_str() {
        STATUS_PASSED => {
            let lines = human_lines(exec);
            out.success_with_human(&execution_payload(exec), &lines);
            Ok(())
        }
        STATUS_CANCELLED => Err(
            AppError::new(codes::CANCELLED, "workflow execution cancelled")
                .with_details(execution_payload(exec)),
        ),
        STATUS_FAILED => {
            let err = AppError::new(
                exec.error_code
                    .clone()
                    .unwrap_or_else(|| codes::INTERNAL.to_string()),
                exec.error_message
                    .clone()
                    .unwrap_or_else(|| "workflow failed".to_owned()),
            )
            .with_details(execution_payload(exec));
            Err(err)
        }
        _ => Err(AppError::internal(format!(
            "workflow execution ended with unknown status: {}",
            exec.status
        ))),
    }
}

/// run 输出顶层契约（JSON 形态即契约；`success:true` 由包络渲染补齐——
/// success_with_human 的 JSON 分支写对象原文，故 success 在此显式携带）。
fn execution_payload(exec: &WorkflowExecutionDto) -> Value {
    serde_json::json!({
        "success": exec.status == STATUS_PASSED,
        "runId": exec.id.clone(),
        "workflowId": exec.workflow_id.clone(),
        "status": exec.status.clone(),
        "startedAt": exec.started_at.clone(),
        "completedAt": exec.completed_at.clone(),
        "durationMs": exec.duration_ms,
        "errorCode": exec.error_code.clone(),
        "errorMessage": exec.error_message.clone(),
        "nodes": exec.nodes.clone(),
    })
}

/// Human 摘要：总览行 + run id + 逐节点状态行。
fn human_lines(exec: &WorkflowExecutionDto) -> Vec<String> {
    let mut lines = vec![format!(
        "Workflow {} {}ms",
        exec.status,
        exec.duration_ms.unwrap_or(0)
    )];
    lines.push(exec.id.clone());
    for node in &exec.nodes {
        lines.push(format!(
            "- {} {} {}",
            node.node_id,
            node.status,
            node.duration_ms
                .map(|ms| format!("{ms}ms"))
                .unwrap_or_default()
        ));
    }
    lines
}

/// 当前空间内取工作流行（读取类命令的存在性闸门）：空间解析归 CLI 入口
/// 面，作用域过滤语义（跨空间 id 与不存在同报 `WORKFLOW_NOT_FOUND`，不
/// 泄露存在性）归 Service 单点。
async fn scoped_row(ctx: &AppContext, ws: Option<&str>, id: &str) -> Result<Workflow, AppError> {
    let workspace = super::resolve_workspace(ctx, ws).await?;
    workflow::get_in_workspace(&ctx.db.pool, id, &workspace.id).await
}

/// get 输出的图准备：`--show-secrets` 放行明文（原样），缺省走 domain
/// 读时脱敏投影（掩码判定与 redact 契约同源单点）。
fn output_graph(graph: &WorkflowGraph, show_secrets: bool) -> WorkflowGraph {
    if show_secrets {
        graph.clone()
    } else {
        masked_graph_for_display(graph)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::redact;
    use crate::domain::workflow::{
        GRAPH_SCHEMA_VERSION, OverrideRow, Position, RequestNodeConfig, WorkflowEdge, WorkflowNode,
        WorkflowNodeConfig,
    };

    /// 测试专用临时目录（不引 tempfile 依赖，stdlib 组合即可）。
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "apilot2-cli-workflow-test-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 顶层契约键集（契约测试钉住——键演进必须显式改此处）。
    #[test]
    fn run_payload_schema_is_stable() {
        let exec = WorkflowExecutionDto {
            id: "wexec_X".into(),
            workflow_id: "wf_X".into(),
            status: "passed".into(),
            started_at: "t0".into(),
            completed_at: Some("t1".into()),
            duration_ms: Some(12),
            error_code: None,
            error_message: None,
            nodes: vec![],
        };
        let payload = execution_payload(&exec);
        let mut keys: Vec<&str> = payload
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "completedAt",
                "durationMs",
                "errorCode",
                "errorMessage",
                "nodes",
                "runId",
                "startedAt",
                "status",
                "success",
                "workflowId",
            ]
        );
        assert_eq!(payload["success"], serde_json::Value::Bool(true));
    }

    /// 节点记录序列化键集（CLI run 输出的逐节点契约；Option 明细序列化为
    /// null——键恒在，schema 稳定）。
    #[test]
    fn node_record_serializes_stable_key_set() {
        let record = crate::domain::workflow_execution::NodeExecutionRecord {
            node_id: "n0".into(),
            status: "passed".into(),
            started_at: Some("t0".into()),
            completed_at: Some("t1".into()),
            duration_ms: Some(3),
            error_code: None,
            error_message: None,
            output: None,
            request: Some(crate::domain::workflow_execution::NodeRequestDetail {
                method: "GET".into(),
                url: "http://x/".into(),
            }),
            response: Some(crate::domain::workflow_execution::NodeResponseDetail {
                status: 200,
                body: "***".into(),
            }),
            writebacks: Vec::new(),
            assertions: Vec::new(),
        };
        let value = serde_json::to_value(&record).unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "assertions",
                "completedAt",
                "durationMs",
                "errorCode",
                "errorMessage",
                "nodeId",
                "output",
                "request",
                "response",
                "startedAt",
                "status",
                "writebacks",
            ]
        );
        assert_eq!(value["request"]["method"], "GET");
        assert_eq!(value["response"]["status"], 200);
    }

    /// get 的图输出准备（lib 内等价钉住 CLI 展示契约）：缺省走 domain
    /// 读时投影——敏感名单命中的 query / path_params 行值掩码、非名单行与
    /// body 原样（掩码口径全量断言归 domain 投影测试）；`--show-secrets`
    /// 放行后与输入图等值。
    #[test]
    fn output_graph_masks_by_default_and_passes_through_with_flag() {
        let node = WorkflowNode {
            id: "n0".into(),
            name: String::new(),
            position: Position { x: 0.0, y: 0.0 },
            config: WorkflowNodeConfig::Request(RequestNodeConfig {
                endpoint_key: Some("GET /x".into()),
                query: vec![
                    OverrideRow {
                        name: "page".into(),
                        value: "1".into(),
                    },
                    OverrideRow {
                        name: "api-key".into(),
                        value: "secret-key".into(),
                    },
                ],
                path_params: vec![OverrideRow {
                    name: "Authorization".into(),
                    value: "Bearer tok".into(),
                }],
                body: Some("plain".into()),
                ..Default::default()
            }),
        };
        let graph = WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: vec![node],
            edges: vec![WorkflowEdge {
                id: "e0".into(),
                source: "start".into(),
                target: "n0".into(),
                label: None,
            }],
        };

        let masked = output_graph(&graph, false);
        let WorkflowNodeConfig::Request(config) = &masked.nodes[0].config else {
            panic!("request 节点形态应保持");
        };
        assert_eq!(config.query[0].value, "1", "非名单行原样");
        assert_eq!(config.query[1].value, redact::MASK, "名单 query 行掩码");
        assert_eq!(
            config.path_params[0].value,
            redact::MASK,
            "名单 path_params 行掩码"
        );
        assert_eq!(
            config.body.as_deref(),
            Some("plain"),
            "body 原样（api get 同口径）"
        );

        assert_eq!(
            output_graph(&graph, true),
            graph,
            "--show-secrets 放行后与输入图等值（明文）"
        );
    }

    /// 操作范围：缺省当前工作空间——本空间命中、跨空间 id 与不存在同报
    /// `WORKFLOW_NOT_FOUND`；`--workspace` 指定空间后可命中该空间内工作流。
    #[tokio::test]
    async fn scoped_row_hides_other_workspace_workflows() {
        let dir = temp_dir("scoped-row");
        let ctx = AppContext::new(dir.clone()).await.unwrap();
        let pool = &ctx.db.pool;
        let (ws,): (String,) = sqlx::query_as("SELECT id FROM workspaces LIMIT 1")
            .fetch_one(pool)
            .await
            .unwrap();
        let created = workflow::create(pool, &ws, "链").await.unwrap();
        let hit = scoped_row(&ctx, None, &created.id).await.unwrap();
        assert_eq!(hit.id, created.id);

        // 他空间行（种空间后落库模拟跨空间 id）
        crate::infrastructure::workspace_repo::test_support::seed_workspace(
            pool,
            "w-other",
            "他空间",
        )
        .await;
        sqlx::query(
            "INSERT INTO workflows (id, workspace_id, name, graph, created_at, updated_at) \
             VALUES ('wf_elsewhere', 'w-other', '他空间', '{}', \
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        )
        .execute(pool)
        .await
        .unwrap();
        for id in ["wf_elsewhere", "wf_missing"] {
            let err = scoped_row(&ctx, None, id).await.unwrap_err();
            assert_eq!(err.code, codes::WORKFLOW_NOT_FOUND, "{id}");
        }

        // 指定目标空间后：该空间工作流可命中（缺省链不受影响）
        let hit = scoped_row(&ctx, Some("他空间"), "wf_elsewhere")
            .await
            .unwrap();
        assert_eq!(hit.id, "wf_elsewhere");
        let hit = scoped_row(&ctx, Some("w-other"), "wf_elsewhere")
            .await
            .unwrap();
        assert_eq!(hit.id, "wf_elsewhere");

        ctx.db.pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
