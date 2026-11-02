//! 工作流执行引擎：串行核（Start → 请求 → … → End）、条件分支与并行 /
//! Join / 延时 / 重试的调度、事件推送与执行记录。
//!
//! 职责与边界：
//! - 引擎在 Rust 中执行、经 `workflow:event` 推送各态事件，React 只渲染
//!   不轮询（架构铁律）；事件词表：workflow.started / node.queued /
//!   node.started / node.completed / node.failed / edge.activated /
//!   workflow.completed / workflow.failed / workflow.cancelled，另按执行
//!   语义补 node.cancelled / node.skipped（取消与失败传播的节点留痕事件）。
//!   落库状态与事件一一对应（词表见 [`events`]）。
//! - 请求节点复用 HTTP 引擎与发送装配链（synthesize → compose）与
//!   Variable Resolver（生效集逐节点现取——执行期写回改变生效集时不许
//!   缓存整轮），但执行记录独立存储、不写 run_records（接口执行历史
//!   与工作流执行记录分域）。
//! - 执行内变量解析链（`{{变量}}` 求值输入层序）：节点输出 ＞ 工作流变量
//!   ＞ 生效变量集（domain `merge_execution_variables` 合成）。节点输出按
//!   节点分桶存放（请求节点写 status / body，提取节点写逐规则产物名，均
//!   为不带节点名前缀的裸键），消费节点的可见范围＝其直接上游节点（入边
//!   source）的输出桶并集，按边序合并；深层字段经 `{{产物名.字段}}` 惰性
//!   求值。写回分支按分类名快照写回指定分类（自愈重建、upsert、不回滚）。
//!   节点产物进执行记录时按敏感口径掩码占位（明文只在执行内上下文流转）。
//! - 条件节点（IF / ELSE IF / ELSE）：按配置序短路求值，首个真值分支激活
//!   对应出边（边 label＝分支 id），全不满足激活 DEFAULT 出边；执行后
//!   产物摘要记录实际表达式与选中分支。
//! - 并行节点（Parallel）：真并发启动全部分支（Tokio spawn，每分支一条
//!   任务），分支内串行推进；Join 汇聚（等待全部 / 任一）后由归约面放行
//!   下游。失败传播矩阵（第一版定案）：任一分支失败 → 整流 failed（固定
//!   中断，与串行链同口径）；取消传播到全部分支；any 模式等待全部分支
//!   结束后判定（任一成功到达即满足）——不做中途取消未达分支（失败恒
//!   整流失败，提前放行的下游执行会被失败传播作废）。分支内不支持再嵌
//!   并行（扁平并行第一版口径，NOT_IMPLEMENTED fail-fast）。
//! - 延时节点：固定等待，取消随时中断。重试节点：授权直接下游节点失败
//!   后按次数与间隔重试（重试尝试不发中间事件，事件序保持每节点一组
//!   终态；耗尽后错误信息前缀重试口径照常传播；取消不重试）。
//! - 接口解析＝工作流所属空间内按稳定键跨服务（引用纯键不含服务维度，
//!   撞车＝ENDPOINT_AMBIGUOUS；失效是解析派生态，不落库）。
//! - 并发闸：同一工作流至多一个在途执行（TaskRegistry 键 `workflow:<id>`），
//!   在途时拒绝新执行（WORKFLOW_ALREADY_RUNNING）；取消链落
//!   CancellationToken；完成后从登记处移除。
//!
//! 资源所有权：执行任务归 TaskRegistry（键 `workflow:<id>`）；事件出口
//! 经闭包注入（services 层不持 AppHandle，同 send 链 SseEventSink 先例）；
//! 响应收体恒 PreviewOnly（不落临时文件），请求响应快照取 Preview 前缀
//! （≤64KB 有界）供提取 / 断言消费——快照按请求节点 id 分键存放，并行
//! 分支各自的提取互不踩踏。
//!
//! 模块结构：[`events`]（事件词表与执行记录 DTO）→ [`schedule`]（串行
//! 推进器与并行调度）→ [`nodes_data`] / [`nodes_control`]（节点执行器）；
//! 本文件是对外 interface（execute / cancel / last_execution）与共享执行
//! 状态（任务体输入、执行上下文、节点终态）的家。

mod events;
mod nodes_control;
mod nodes_data;
mod schedule;

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use sqlx::SqlitePool;
use tokio_util::sync::CancellationToken;

use crate::domain::clock::now_rfc3339;
use crate::domain::run_id::new_workflow_execution_id;
use crate::domain::workflow::{WorkflowGraph, WorkflowNodeConfig};
use crate::domain::workflow_execution::{
    ExecutionVariable, NodeExecutionRecord, STATUS_CANCELLED, STATUS_FAILED, STATUS_SKIPPED,
    WorkflowExecution,
};
use crate::error::codes;
use crate::error::AppError;
use crate::infrastructure::workflow_execution_repo;
use crate::tasks::TaskRegistry;

pub use events::{WorkflowEvent, WorkflowEventSink, WorkflowExecutionDto};
use events::emit;
use schedule::{advance_serial, SerialHost};

/// 工作流执行任务键（并发闸与取消的寻址单点）。
pub fn workflow_task_key(workflow_id: &str) -> String {
    format!("workflow:{workflow_id}")
}

/// 引擎编排输入（GUI AppState / 测试夹具投影到同一结构）。
pub struct WorkflowEngineCtx<'a> {
    pub pool: &'a SqlitePool,
    pub registry: &'a TaskRegistry,
    pub http: &'a crate::services::http::HttpService,
    /// 事件出口（None＝静默执行，纯单测面）
    pub sink: Option<WorkflowEventSink>,
}

/// spawn 任务体的 owned 输入（不借用 ctx：Client 与全局超时档在 spawn 前
/// 快照捕获，任务体内不再触碰 ctx）。Clone 供并行分支任务各自持有一份
/// （图模型规模有限，整包克隆成本可忽略，换取任务的 'static 简单性）。
#[derive(Clone)]
pub(super) struct SpawnedWorkflow {
    pub(super) pool: SqlitePool,
    pub(super) execution_id: String,
    pub(super) workflow_id: String,
    pub(super) workspace_id: String,
    pub(super) graph: WorkflowGraph,
    pub(super) sink: Option<WorkflowEventSink>,
    pub(super) client: reqwest::Client,
    pub(super) timeout_global: Option<u64>,
}

/// 取消在途执行（返回是否有在途任务被取消）。
pub fn cancel(registry: &TaskRegistry, workflow_id: &str) -> bool {
    registry.cancel(&workflow_task_key(workflow_id))
}

/// 执行工作流至终态（阻塞语义，与 http.send 一致）：执行记录落库后返回。
/// 查找失败（工作流不存在 / 图损坏 / 缺 Start）不产生执行记录；并发闸
/// 命中拒绝新执行。
pub async fn execute(
    ctx: &WorkflowEngineCtx<'_>,
    workflow_id: &str,
) -> Result<WorkflowExecutionDto, AppError> {
    let task_key = workflow_task_key(workflow_id);
    if ctx.registry.is_running(&task_key) {
        return Err(already_running(workflow_id));
    }
    let row = crate::services::workflow::get_or_not_found(ctx.pool, workflow_id).await?;
    let graph = crate::services::workflow::parse_or_graph_invalid(&row.graph, workflow_id)?;
    // 执行前校验全清单（图结构＋引用解析）：error 级问题拒绝启动，问题
    // 清单随错误 details 下发（GUI 错误面板与 CLI 输出共用），不产生执行
    // 记录；warning 级问题（如节点引用不可达）只进校验清单提示，不拦运行
    let issues = crate::services::workflow_validate::validate_for_execution(
        ctx.pool,
        &row.workspace_id,
        &graph,
    )
    .await?;
    let blocking: Vec<_> = issues
        .iter()
        .filter(|issue| crate::domain::workflow_validation::blocks_execution(&issue.code))
        .collect();
    if !blocking.is_empty() {
        return Err(AppError::new(
            codes::WORKFLOW_NOT_EXECUTABLE,
            format!(
                "workflow has {} validation error(s): {workflow_id}",
                blocking.len()
            ),
        )
        .with_details(serde_json::json!({ "workflowId": workflow_id, "issues": issues })));
    }

    let execution_id = new_workflow_execution_id();
    let (tx, rx) = tokio::sync::oneshot::channel::<WorkflowExecution>();
    let spawned = SpawnedWorkflow {
        pool: ctx.pool.clone(),
        execution_id,
        workflow_id: row.id,
        workspace_id: row.workspace_id,
        graph,
        sink: ctx.sink.clone(),
        client: ctx.http.client(),
        timeout_global: ctx.http.settings().timeout_seconds,
    };
    let spawn_result = ctx.registry.spawn(&task_key, move |token| {
        let spawned = spawned;
        async move {
            let outcome = run_workflow(spawned, token).await;
            let _ = tx.send(outcome);
        }
    });
    // spawn 期的同键竞态（检查与登记之间插入的并发执行）同码拒绝
    if let Err(err) = spawn_result {
        return if err.code == codes::TASK_KEY_EXISTS {
            Err(already_running(workflow_id))
        } else {
            Err(err)
        };
    }
    let execution = rx
        .await
        .map_err(|_| AppError::internal("workflow task dropped before completion"))?;
    // 完成后清理登记（仅清理已结束条目）
    if !ctx.registry.is_running(&task_key) {
        ctx.registry.remove(&task_key);
    }
    Ok(WorkflowExecutionDto::from(execution))
}

fn already_running(workflow_id: &str) -> AppError {
    AppError::new(
        codes::WORKFLOW_ALREADY_RUNNING,
        format!("workflow already has a running execution: {workflow_id}"),
    )
}

/// 取工作流最近一次执行记录（执行面板回看面；无记录＝None）。
pub async fn last_execution(
    pool: &SqlitePool,
    workflow_id: &str,
) -> Result<Option<WorkflowExecutionDto>, AppError> {
    match workflow_execution_repo::get_by_workflow(pool, workflow_id).await? {
        Some(exec) => Ok(Some(WorkflowExecutionDto::from(exec))),
        None => Ok(None),
    }
}

/// 节点执行结果（终态三向；错误取引擎链路 AppError 的 code / message）。
#[derive(Debug)]
pub(super) enum NodeOutcome {
    /// 通过（output＝节点产物摘要，已按敏感口径掩码；无产物＝None。
    /// writebacks / assertions＝进执行记录与事件的结构化产物，非本类节点
    /// 恒为空表——存变量节点的写回清单与断言节点的逐规则结果）。
    /// selected_edge＝条件节点选中的出边 id（主循环按它激活边并推进，
    /// 不走「首条出边」默认序）；其余节点恒 None。
    Passed {
        output: Option<String>,
        writebacks: Vec<crate::domain::workflow_execution::WritebackEntry>,
        assertions: Vec<crate::domain::workflow_execution::AssertionEntry>,
        selected_edge: Option<String>,
    },
    /// 失败（assertions 仅断言节点携带——失败判定的逐条结果同样入记录，
    /// 其余节点恒空表）
    Failed {
        code: String,
        message: String,
        assertions: Vec<crate::domain::workflow_execution::AssertionEntry>,
    },
    Cancelled,
}

impl NodeOutcome {
    /// 无结构化产物的通过（Start / End / 请求 / 提取 / 条件 / 延时 /
    /// 重试 / 并行节点——产物只有摘要面）
    pub(super) fn passed(output: Option<String>) -> Self {
        Self::Passed {
            output,
            writebacks: Vec::new(),
            assertions: Vec::new(),
            selected_edge: None,
        }
    }

    /// 无断言明细的失败（全部非断言失败路径共用；断言节点失败携带逐条
    /// 结果，走 Failed 显式构造）
    pub(super) fn failed(code: String, message: String) -> Self {
        Self::Failed {
            code,
            message,
            assertions: Vec::new(),
        }
    }

    pub(super) fn from_error(err: AppError) -> Self {
        if err.code == codes::CANCELLED {
            Self::Cancelled
        } else {
            Self::failed(err.code, err.message)
        }
    }
}

/// 上游请求节点响应快照（提取 / 断言消费面）：状态码、响应头与响应体
/// Preview 前缀文本（≤64KB 有界，PreviewOnly 收体产物的只读投影）。
/// `secret_values`＝本次请求消费的 Secret 变量值清单（提取 / 断言产物
/// 名单式投影的回显判定素材）。`request` / `response`＝执行记录面明细
/// （URL 已按 Secret 消费清单写时掩码、响应体已按掩码摘要口径），响应
/// 快照留存时同步落记录。
#[derive(Clone)]
pub(super) struct UpstreamResponse {
    pub(super) status: u16,
    pub(super) headers: Vec<(String, String)>,
    pub(super) body_text: String,
    pub(super) secret_values: Vec<String>,
    pub(super) request: crate::domain::workflow_execution::NodeRequestDetail,
    pub(super) response: crate::domain::workflow_execution::NodeResponseDetail,
}

/// 执行内上下文（一次执行的变量与请求响应真相，逐节点推进时更新）：
/// - `workflow_vars`：存变量节点的执行内传递层（键 → 值）；
/// - `node_outputs`：节点输出层（节点 id → 产出桶，键为不带节点名前缀的
///   裸键）——请求节点写 status / body，提取节点写逐规则产物名；消费面
///   按入边 source 取桶并集（连线作用域），跨节点不共享键空间；
/// - `snapshots`：请求响应快照（请求节点 id → 快照）——提取 / 断言节点
///   按入边 source 取，per-node 键隔离使并行分支各自的提取互不踩踏。
/// 跨主链与并行分支共享（Arc + Mutex；锁粒度＝单字段读写短临界区，
/// guard 恒不跨 await）。
pub(super) struct RunContext {
    pub(super) workflow_vars: BTreeMap<String, ExecutionVariable>,
    pub(super) node_outputs: BTreeMap<String, BTreeMap<String, ExecutionVariable>>,
    pub(super) snapshots: BTreeMap<String, UpstreamResponse>,
}

impl RunContext {
    pub(super) fn new() -> Self {
        Self {
            workflow_vars: BTreeMap::new(),
            node_outputs: BTreeMap::new(),
            snapshots: BTreeMap::new(),
        }
    }
}

/// 共享执行上下文锁（变量层 / 节点输出 / 响应快照）。毒化口径：临界区
/// panic 视为引擎内部 bug 的不可恢复路径，取锁统一 expect 崩溃（与执行
/// 记录锁同口径），不做毒化恢复——恢复读取可能落在不一致的半写状态。
pub(super) type SharedRunContext = Arc<Mutex<RunContext>>;

/// 执行记录累积（主链与并行分支共享；并行分支的节点记录按锁序到达
/// 归档，终态时统一组装 WorkflowExecution）。毒化口径同共享执行上下
/// 文锁：expect 崩溃、不恢复。
#[derive(Default)]
pub(super) struct ExecAccum {
    pub(super) nodes: Vec<NodeExecutionRecord>,
    pub(super) executed: HashSet<String>,
}

pub(super) type SharedExecAccum = Arc<Mutex<ExecAccum>>;

/// 工作流执行主流程：Start 起沿边推进，逐节点 queued → started → 终态
/// 事件；Parallel 节点触发分支并发调度与 Join 归约；失败 / 取消中断传播
/// （后续未执行节点 skipped），工作流终态落库。
async fn run_workflow(input: SpawnedWorkflow, token: CancellationToken) -> WorkflowExecution {
    let started = Instant::now();
    let mut exec = WorkflowExecution::started(
        input.execution_id.clone(),
        input.workflow_id.clone(),
        now_rfc3339(),
    );
    emit(
        &input.sink,
        &WorkflowEvent::WorkflowStarted {
            execution_id: input.execution_id.clone(),
            workflow_id: input.workflow_id.clone(),
        },
    );

    let shared_ctx: SharedRunContext = Arc::new(Mutex::new(RunContext::new()));
    let accum: SharedExecAccum = Arc::new(Mutex::new(ExecAccum::default()));

    // 主链起点＝Start 节点；全程推进（含并行调度面的承接）委托串行推进器
    let start: Option<String> = input
        .graph
        .nodes
        .iter()
        .find(|node| matches!(node.config, WorkflowNodeConfig::Start))
        .map(|node| node.id.clone());
    let end = advance_serial(
        &input,
        start,
        &shared_ctx,
        &accum,
        &token,
        SerialHost::MainChain,
    )
    .await;
    // 主链无 Join 拦截路径：到达 Join 的归约登记只在分支面出现，join 恒
    // None，终态容器只取 status 与 error
    let status: &str = end.status;
    let flow_error: Option<(String, String)> = end.error;

    // 已执行节点的记录按累积序并入（主链序＋并行分支锁序到达序）；库序
    // 契约＝执行序在前、skipped 尾部（前端执行面板回看以库序为展示序）
    exec.nodes
        .extend(accum.lock().expect("执行记录锁").nodes.iter().cloned());
    // 未执行节点 skipped（失败 / 取消传播；事件与落库记录一一对应）
    let executed: HashSet<String> = accum.lock().expect("执行记录锁").executed.clone();
    for node in &input.graph.nodes {
        if !executed.contains(&node.id) {
            exec.nodes.push(NodeExecutionRecord {
                node_id: node.id.clone(),
                status: STATUS_SKIPPED.to_string(),
                started_at: None,
                completed_at: None,
                duration_ms: None,
                error_code: None,
                error_message: None,
                output: None,
                request: None,
                response: None,
                writebacks: Vec::new(),
                assertions: Vec::new(),
            });
            emit(
                &input.sink,
                &WorkflowEvent::NodeSkipped {
                    execution_id: input.execution_id.clone(),
                    node_id: node.id.clone(),
                },
            );
        }
    }

    let duration_ms = started.elapsed().as_millis() as u64;
    exec.status = status.to_string();
    exec.completed_at = Some(now_rfc3339());
    exec.duration_ms = Some(duration_ms as i64);
    match (status, flow_error) {
        (STATUS_FAILED, Some((code, message))) => {
            exec.error_code = Some(code.clone());
            exec.error_message = Some(message.clone());
        }
        _ => {}
    }

    // 执行记录终态单次写入（取消与失败同留痕；写库失败仅留痕不外抛——
    // 任务体无错误回传通道，终态已定）
    if let Err(err) = workflow_execution_repo::upsert(&input.pool, &exec).await {
        tracing::warn!(%err, "workflow execution record write failed");
    }

    emit(
        &input.sink,
        &match status {
            STATUS_FAILED => WorkflowEvent::WorkflowFailed {
                execution_id: input.execution_id.clone(),
                workflow_id: input.workflow_id.clone(),
                duration_ms,
                error_code: exec.error_code.clone(),
                error_message: exec.error_message.clone(),
            },
            STATUS_CANCELLED => WorkflowEvent::WorkflowCancelled {
                execution_id: input.execution_id.clone(),
                workflow_id: input.workflow_id.clone(),
                duration_ms,
            },
            _ => WorkflowEvent::WorkflowCompleted {
                execution_id: input.execution_id.clone(),
                workflow_id: input.workflow_id.clone(),
                duration_ms,
            },
        },
    );
    exec
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::workflow::OverrideRow;
    use crate::domain::workflow_execution::STATUS_PASSED;
    use crate::test_support::{
        chain_graph, event_ids, issues_of, last_record, node_status, Fixture,
    };
    use std::time::Duration;
    use tokio_util::sync::CancellationToken as Token;

    #[tokio::test]
    async fn serial_chain_runs_to_passed_with_complete_event_sequence() {
        let fx = Fixture::new().await;
        let graph = chain_graph(&[
            Some("GET /healthz"),
            Some("GET /healthz"),
            Some("GET /healthz"),
        ]);
        let workflow_id = fx.seed_workflow("链", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED);
        assert_eq!(dto.nodes.len(), 5, "start + 3 请求 + end");
        assert!(dto.nodes.iter().all(|node| node.status == STATUS_PASSED));
        // 事件序完整：workflow.started → 节点逐个（queued/started/completed
        // ＋出边 activated）→ workflow.completed；End 无出边事件
        let expected: Vec<String> = [
            "workflow.started",
            "node.queued:start",
            "node.started:start",
            "node.completed:start",
            "edge.activated:e0",
            "node.queued:n0",
            "node.started:n0",
            "node.completed:n0",
            "edge.activated:e1",
            "node.queued:n1",
            "node.started:n1",
            "node.completed:n1",
            "edge.activated:e2",
            "node.queued:n2",
            "node.started:n2",
            "node.completed:n2",
            "edge.activated:e3",
            "node.queued:end",
            "node.started:end",
            "node.completed:end",
            "workflow.completed",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        assert_eq!(event_ids(&fx.events), expected, "事件须按执行顺序逐个推送");
        // 落库记录与返回一致（每工作流恒一条）
        let record = last_record(&fx.pool, &workflow_id).await;
        assert_eq!(record.id, dto.id);
        assert_eq!(record.status, STATUS_PASSED);
        // 任务登记已清（完成即 remove 纪律；条目残留时 is_running 亦为
        // false，故以 remove 返回值直接断言条目不残留）
        assert!(!fx.registry.remove(&workflow_task_key(&workflow_id)));
    }

    /// 中途取消：在途节点 cancelled、未启动节点 skipped、工作流 cancelled
    /// 且留痕为最近一次。
    #[tokio::test]
    async fn cancel_midflow_records_cancelled_and_skips_rest() {
        let fx = Fixture::new().await;
        let mut graph = chain_graph(&[Some("GET /api/slow"), Some("GET /healthz")]);
        // slow 节点覆写 query ms=3000（慢到可稳定取消；同时验证覆写叠加真实生效）
        if let WorkflowNodeConfig::Request(config) = &mut graph.nodes[1].config {
            config.query = vec![OverrideRow {
                name: "ms".into(),
                value: "3000".into(),
            }];
        }
        let workflow_id = fx.seed_workflow("慢链", &graph).await;
        let ctx = fx.ctx();
        let execution = execute(&ctx, &workflow_id);
        tokio::pin!(execution);
        let dto = tokio::select! {
            result = &mut execution => result.unwrap(),
            _ = tokio::time::sleep(Duration::from_millis(300)) => {
                assert!(fx.registry.is_running(&workflow_task_key(&workflow_id)));
                fx.registry.cancel(&workflow_task_key(&workflow_id));
                execution.await.unwrap()
            }
        };
        assert_eq!(dto.status, STATUS_CANCELLED);
        assert_eq!(node_status(&dto, "start"), STATUS_PASSED);
        assert_eq!(
            node_status(&dto, "n0"),
            STATUS_CANCELLED,
            "在途节点转 cancelled"
        );
        assert_eq!(
            node_status(&dto, "n1"),
            STATUS_SKIPPED,
            "未启动节点 skipped"
        );
        assert_eq!(node_status(&dto, "end"), STATUS_SKIPPED);
        // 取消同留痕（最近一次记录）
        let record = last_record(&fx.pool, &workflow_id).await;
        assert_eq!(record.status, STATUS_CANCELLED);
        assert!(!fx.registry.is_running(&workflow_task_key(&workflow_id)));
    }

    /// 取消落在节点间隙（无在途请求可转 cancelled）：未启动节点一律
    /// skipped、工作流 cancelled 且同样留痕。
    #[tokio::test]
    async fn cancel_between_nodes_skips_rest_and_cancels_flow() {
        let fx = Fixture::new().await;
        let graph = chain_graph(&[Some("GET /healthz")]);
        let workflow_id = fx.seed_workflow("间隙", &graph).await;
        let token = Token::new();
        token.cancel();
        let input = SpawnedWorkflow {
            pool: fx.pool.clone(),
            execution_id: new_workflow_execution_id(),
            workflow_id: workflow_id.clone(),
            workspace_id: "w1".into(),
            graph,
            sink: None,
            client: fx.http.client(),
            timeout_global: None,
        };
        let exec = run_workflow(input, token).await;
        assert_eq!(exec.status, STATUS_CANCELLED);
        assert!(exec.nodes.iter().all(|node| node.status == STATUS_SKIPPED));
        let record = last_record(&fx.pool, &workflow_id).await;
        assert_eq!(record.status, STATUS_CANCELLED);
    }

    /// 并发闸：在途时第二执行被拒（稳定错误码 WORKFLOW_ALREADY_RUNNING）；
    /// 在途执行完成并释放键后，同流可再次执行。
    #[tokio::test]
    async fn second_execution_rejected_while_running() {
        let fx = Fixture::new().await;
        let mut graph = chain_graph(&[Some("GET /api/slow")]);
        if let WorkflowNodeConfig::Request(config) = &mut graph.nodes[1].config {
            config.query = vec![OverrideRow {
                name: "ms".into(),
                value: "1500".into(),
            }];
        }
        let workflow_id = fx.seed_workflow("闸", &graph).await;
        let ctx = fx.ctx();
        let first = execute(&ctx, &workflow_id);
        tokio::pin!(first);
        let rejection = tokio::select! {
            result = &mut first => {
                result.unwrap();
                execute(&ctx, &workflow_id).await
            }
            _ = tokio::time::sleep(Duration::from_millis(300)) => {
                execute(&ctx, &workflow_id).await
            }
        };
        // 第一笔仍在途：第二笔被并发闸拒绝
        let err = rejection.unwrap_err();
        assert_eq!(err.code, codes::WORKFLOW_ALREADY_RUNNING);
        // 首笔完成（释放键）后可再执行
        let first_dto = first.await.unwrap();
        assert_eq!(first_dto.status, STATUS_PASSED);
        let rerun = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(rerun.status, STATUS_PASSED);
        assert!(!fx.registry.is_running(&workflow_task_key(&workflow_id)));
    }

    /// 覆盖写：同一工作流连跑两次，执行记录恒一条、内容为最近一次。
    #[tokio::test]
    async fn record_overwritten_each_run() {
        let fx = Fixture::new().await;
        let graph = chain_graph(&[Some("GET /healthz")]);
        let workflow_id = fx.seed_workflow("覆盖", &graph).await;
        let first = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(first.status, STATUS_PASSED);
        let second = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_ne!(first.id, second.id);
        let count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM workflow_executions WHERE workflow_id = ?")
                .bind(&workflow_id)
                .fetch_one(&fx.pool)
                .await
                .unwrap();
        assert_eq!(count.0, 1);
        let record = last_record(&fx.pool, &workflow_id).await;
        assert_eq!(record.id, second.id);
    }

    /// 失效引用（稳定键解析不到）执行前拦截：WORKFLOW_NOT_EXECUTABLE 携带
    /// 问题清单（requestInvalidRef 可定位）、不产生执行记录；缺 Start 同样
    /// 拒绝且不留痕。失败传播（后续 skipped）由断言 / 提取失败链路覆盖。
    #[tokio::test]
    async fn invalid_reference_rejected_before_execution() {
        let fx = Fixture::new().await;
        let graph = chain_graph(&[Some("GET /missing"), Some("GET /healthz")]);
        let workflow_id = fx.seed_workflow("断链", &graph).await;
        let err = execute(&fx.ctx(), &workflow_id).await.unwrap_err();
        assert_eq!(err.code, codes::WORKFLOW_NOT_EXECUTABLE);
        let issues = issues_of(&err);
        assert_eq!(issues[0]["code"], "requestInvalidRef");
        assert_eq!(issues[0]["nodeId"], "n0");
        assert!(
            workflow_execution_repo::get_by_workflow(&fx.pool, &workflow_id)
                .await
                .unwrap()
                .is_none()
        );

        // 缺 Start：执行拒绝、无执行记录（图级问题无可定位节点）
        let mut broken = chain_graph(&[Some("GET /healthz")]);
        broken.nodes.remove(0);
        let broken_id = fx.seed_workflow("无起点", &broken).await;
        let err = execute(&fx.ctx(), &broken_id).await.unwrap_err();
        assert_eq!(err.code, codes::WORKFLOW_NOT_EXECUTABLE);
        let issues = issues_of(&err);
        assert_eq!(issues[0]["code"], "missingStart");
        assert!(
            workflow_execution_repo::get_by_workflow(&fx.pool, &broken_id)
                .await
                .unwrap()
                .is_none()
        );
    }

    /// 同链闭环：同一工作流先含失效引用（执行被拒、无记录），保存修复后
    /// 可正常执行——校验拦截与放行在同一工作流生命周期内闭环。
    #[tokio::test]
    async fn execute_succeeds_after_issues_fixed() {
        let fx = Fixture::new().await;
        let workflow_id = fx
            .seed_workflow("先错后对", &chain_graph(&[Some("GET /missing")]))
            .await;
        let err = execute(&fx.ctx(), &workflow_id).await.unwrap_err();
        assert_eq!(err.code, codes::WORKFLOW_NOT_EXECUTABLE);

        // 修复：重接为健康引用后放行
        crate::services::workflow::save(
            &fx.pool,
            &workflow_id,
            &chain_graph(&[Some("GET /healthz")]),
        )
        .await
        .unwrap();
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED);
    }

    /// 领域不变式：执行不改接口用户数据（逐字段对账；路径与方法覆写
    /// 同入对账——执行期仅提取面归一，不回写库内原值）。
    #[tokio::test]
    async fn user_data_invariant_unchanged_by_execution() {
        let fx = Fixture::new().await;
        crate::infrastructure::user_data_repo::upsert(
            &fx.pool,
            "s1",
            "GET /healthz",
            &crate::domain::user_data::UserDataInput {
                body: None,
                params: r#"[{"name":"verbose","value":"true"}]"#.into(),
                headers: r#"[{"name":"X-Custom","value":"1"}]"#.into(),
                timeout_seconds: None,
                auth: None,
                // 路径覆写指向同一路径（请求行为不变）；方法覆写留小写，
                // 验证发送面归一大写仅作用于请求、库内原值不动
                path_override: Some("/healthz".into()),
                method_override: Some("get".into()),
            },
        )
        .await
        .unwrap();
        let before = crate::infrastructure::user_data_repo::get(&fx.pool, "s1", "GET /healthz")
            .await
            .unwrap();
        let graph = chain_graph(&[Some("GET /healthz")]);
        let workflow_id = fx.seed_workflow("不变式", &graph).await;
        execute(&fx.ctx(), &workflow_id).await.unwrap();
        let after = crate::infrastructure::user_data_repo::get(&fx.pool, "s1", "GET /healthz")
            .await
            .unwrap();
        let (before, after) = (before.unwrap(), after.unwrap());
        assert_eq!(before.body, after.body);
        assert_eq!(before.params, after.params);
        assert_eq!(before.headers, after.headers);
        assert_eq!(before.timeout_seconds, after.timeout_seconds);
        assert_eq!(before.auth, after.auth);
        assert_eq!(before.path_override, after.path_override);
        assert_eq!(
            after.method_override.as_deref(),
            Some("get"),
            "方法覆写库内原值不被归一回写"
        );
    }

    /// 非 2xx 响应不是节点失败（传输成功＝passed，语义成败交断言等下游
    /// 消费者，与 HTTP 域 RunState 口径一致）。
    #[tokio::test]
    async fn error_status_response_is_node_passed() {
        let fx = Fixture::new().await;
        let mut graph = chain_graph(&[Some("GET /api/error/{status}")]);
        if let WorkflowNodeConfig::Request(config) = &mut graph.nodes[1].config {
            config.query = vec![OverrideRow {
                name: "status".into(),
                value: "404".into(),
            }];
        }
        let workflow_id = fx.seed_workflow("错误样本", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED);
        assert!(dto.nodes.iter().all(|node| node.status == STATUS_PASSED));
    }

    /// 占位请求节点（未绑定）执行前拦截（requestUnbound 可定位）。
    #[tokio::test]
    async fn unbound_request_node_rejected_before_execution() {
        let fx = Fixture::new().await;
        let graph = chain_graph(&[None]);
        let workflow_id = fx.seed_workflow("占位", &graph).await;
        let err = execute(&fx.ctx(), &workflow_id).await.unwrap_err();
        assert_eq!(err.code, codes::WORKFLOW_NOT_EXECUTABLE);
        let issues = issues_of(&err);
        assert_eq!(issues[0]["code"], "requestUnbound");
        assert_eq!(issues[0]["nodeId"], "n0");
    }
}
