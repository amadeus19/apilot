//! 工作流执行的调度面：串行推进器（主链与并行分支共用骨架）、并行分支
//! 的并发调度与 Join 归约、重试预算与单节点执行步。

use std::collections::HashSet;
use std::future::Future;

use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use crate::domain::clock::now_rfc3339;
use crate::domain::workflow::{
    EdgesIndex, JoinMode, WorkflowNode, WorkflowNodeConfig, node_of_graph,
};
use crate::domain::workflow_execution::{STATUS_CANCELLED, STATUS_FAILED, STATUS_PASSED};
use crate::error::codes;

use super::events::{WorkflowEvent, emit};
use super::nodes_control::{execute_assert_node, execute_condition_node, execute_delay_node};
use super::nodes_data::{execute_extract_node, execute_request_node};
use super::{
    NodeOutcome, SharedExecAccum, SharedRunContext, SpawnedWorkflow, UpstreamResponse,
};

/// 重试预算（重试节点对直接下游节点的失败重试授权；remaining 随每次
/// 尝试消耗，耗尽后失败照常传播）。
struct RetryBudget {
    target: String,
    max_attempts: u32,
    remaining: u32,
    interval_ms: u64,
}

/// 重试节点通过后生成的下游重试预算（无出边或次数为 0＝不授权）。
fn retry_budget_after(node: &WorkflowNode, edges: &EdgesIndex<'_>) -> Option<RetryBudget> {
    let config = match &node.config {
        WorkflowNodeConfig::Retry(config) => config,
        _ => return None,
    };
    if config.max_attempts == 0 {
        return None;
    }
    let target = edges
        .first_outgoing(&node.id)
        .map(|edge| edge.target.clone())?;
    Some(RetryBudget {
        target,
        max_attempts: config.max_attempts,
        remaining: config.max_attempts,
        interval_ms: config.interval_ms,
    })
}

/// Passed 后的推进决策：条件节点的选中边优先（激活并取其 target），
/// 其余节点取首条出边（End 节点恒终止——它有出边也不推进，串行核的
/// 终点语义）。返回下一节点 id（无＝None，链走完）。
fn advance_current(
    input: &SpawnedWorkflow,
    node: &WorkflowNode,
    selected_edge: Option<&str>,
    edges: &EdgesIndex<'_>,
) -> Option<String> {
    if let Some(edge_id) = selected_edge {
        // selected_edge 恒来自条件执行器对本节点出边的定位（出边索引内
        // 的边 id），查不到即内部不变量被破坏——直接终止推进，不静默回落
        // 首条出边（那会激活错误分支）
        let edge = input.graph.edges.iter().find(|edge| edge.id == edge_id)?;
        emit(
            &input.sink,
            &WorkflowEvent::EdgeActivated {
                execution_id: input.execution_id.clone(),
                edge_id: edge.id.clone(),
            },
        );
        return Some(edge.target.clone());
    }
    let edge = edges
        .first_outgoing(&node.id)
        .filter(|_| !matches!(node.config, WorkflowNodeConfig::End))?;
    emit(
        &input.sink,
        &WorkflowEvent::EdgeActivated {
            execution_id: input.execution_id.clone(),
            edge_id: edge.id.clone(),
        },
    );
    Some(edge.target.clone())
}

/// 单节点记录 + 终态事件的统一落点（主链与并行分支共用）：记录进共享
/// 累积（executed 留痕），事件按终态三向分发。请求节点的 request /
/// response 明细在响应快照留存面同步落记录（快照只在请求节点发送成功时
/// 存在；明细已写时掩码，其余节点恒 None）。
pub(super) fn record_node_terminal(
    input: &SpawnedWorkflow,
    node_id: &str,
    started_at: String,
    duration_ms: u64,
    shared_ctx: &SharedRunContext,
    accum: &SharedExecAccum,
    outcome: &NodeOutcome,
) {
    let (request, response) = shared_ctx
        .lock()
        .expect("执行上下文锁")
        .snapshots
        .get(node_id)
        .map(|snapshot: &UpstreamResponse| {
            (
                Some(snapshot.request.clone()),
                Some(snapshot.response.clone()),
            )
        })
        .unwrap_or((None, None));
    let record = match outcome {
        NodeOutcome::Passed {
            output,
            writebacks,
            assertions,
            ..
        } => crate::domain::workflow_execution::NodeExecutionRecord {
            node_id: node_id.to_owned(),
            status: STATUS_PASSED.to_string(),
            started_at: Some(started_at),
            completed_at: Some(now_rfc3339()),
            duration_ms: Some(duration_ms as i64),
            error_code: None,
            error_message: None,
            output: output.clone(),
            request,
            response,
            writebacks: writebacks.clone(),
            assertions: assertions.clone(),
        },
        NodeOutcome::Failed {
            code,
            message,
            assertions,
        } => crate::domain::workflow_execution::NodeExecutionRecord {
            node_id: node_id.to_owned(),
            status: STATUS_FAILED.to_string(),
            started_at: Some(started_at),
            completed_at: Some(now_rfc3339()),
            duration_ms: Some(duration_ms as i64),
            error_code: Some(code.clone()),
            error_message: Some(message.clone()),
            output: None,
            request,
            response,
            writebacks: Vec::new(),
            assertions: assertions.clone(),
        },
        NodeOutcome::Cancelled => crate::domain::workflow_execution::NodeExecutionRecord {
            node_id: node_id.to_owned(),
            status: STATUS_CANCELLED.to_string(),
            started_at: Some(started_at),
            completed_at: Some(now_rfc3339()),
            duration_ms: Some(duration_ms as i64),
            error_code: None,
            error_message: None,
            output: None,
            request,
            response,
            writebacks: Vec::new(),
            assertions: Vec::new(),
        },
    };
    {
        let mut accum = accum.lock().expect("执行记录锁");
        accum.executed.insert(node_id.to_owned());
        accum.nodes.push(record);
    }
    match outcome {
        NodeOutcome::Passed {
            output, assertions, ..
        } => emit(
            &input.sink,
            &WorkflowEvent::NodeCompleted {
                execution_id: input.execution_id.clone(),
                node_id: node_id.to_owned(),
                duration_ms,
                output: output.clone(),
                assertions: assertions.clone(),
            },
        ),
        NodeOutcome::Failed {
            code,
            message,
            assertions,
        } => emit(
            &input.sink,
            &WorkflowEvent::NodeFailed {
                execution_id: input.execution_id.clone(),
                node_id: node_id.to_owned(),
                error_code: code.clone(),
                error_message: message.clone(),
                assertions: assertions.clone(),
            },
        ),
        NodeOutcome::Cancelled => emit(
            &input.sink,
            &WorkflowEvent::NodeCancelled {
                execution_id: input.execution_id.clone(),
                node_id: node_id.to_owned(),
            },
        ),
    }
}

/// 单节点执行步（主链与并行分支共用）：queued / started 事件 → 执行
/// （重试预算在途时对失败拦截重试）→ 记录与终态事件。重试尝试不发中间
/// 事件、不落中间记录（事件序保持每节点一组终态；记录只落终态）。
async fn run_node_step(
    input: &SpawnedWorkflow,
    node: &WorkflowNode,
    shared_ctx: &SharedRunContext,
    edges: &EdgesIndex<'_>,
    accum: &SharedExecAccum,
    token: &CancellationToken,
    mut retry: Option<&mut RetryBudget>,
) -> NodeOutcome {
    emit(
        &input.sink,
        &WorkflowEvent::NodeQueued {
            execution_id: input.execution_id.clone(),
            node_id: node.id.clone(),
        },
    );
    emit(
        &input.sink,
        &WorkflowEvent::NodeStarted {
            execution_id: input.execution_id.clone(),
            node_id: node.id.clone(),
        },
    );
    let started_at = now_rfc3339();
    let started = Instant::now();
    let outcome = loop {
        let raw = run_node(input, node, shared_ctx, edges, token).await;
        let NodeOutcome::Failed {
            code,
            message,
            assertions,
        } = raw
        else {
            break raw;
        };
        let Some(budget) = &mut retry else {
            break NodeOutcome::Failed {
                code,
                message,
                assertions,
            };
        };
        if budget.target != node.id {
            break NodeOutcome::Failed {
                code,
                message,
                assertions,
            };
        }
        if budget.remaining == 0 {
            break NodeOutcome::Failed {
                code,
                message: format!(
                    "retry budget exhausted after {} retries: {message}",
                    budget.max_attempts
                ),
                assertions,
            };
        }
        // 进入重试：本轮尝试的断言明细不外发（重试尝试不发中间事件）
        budget.remaining -= 1;
        // 等待重试间隔后重新执行（取消随时中断，不重试）
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(budget.interval_ms)) => {}
            _ = token.cancelled() => break NodeOutcome::Cancelled,
        }
    };
    let duration_ms = started.elapsed().as_millis() as u64;
    record_node_terminal(
        input,
        &node.id,
        started_at,
        duration_ms,
        shared_ctx,
        accum,
        &outcome,
    );
    outcome
}

/// 并行调度的归约结果（主循环按它继续推进或终结）。
enum ParallelReduction {
    /// 继续下游（Some＝汇聚 Join 的出边目标；None 表示无后续）
    Continue(Option<String>),
    /// 无汇聚 Join：分支各自自然结束，工作流在此收尾（终态归约 passed）
    FlowEnd,
    Failed(String, String),
    Cancelled,
}

/// 并行节点执行：自身瞬时通过（「启动分支」即职责完成），激活全部出边，
/// 每条出边 spawn 一条分支任务（Tokio 真并发），等待全部分支结束后归约：
/// - 任一分支 failed → 整流 failed（固定中断；Join 与其下游 skipped）
/// - 无失败但任一 cancelled → 整流 cancelled
/// - 全成功：分支汇聚到同一 Join（all＝全部分支到达 / any＝任一到达）→
///   Join 补 passed 记录并继续其出边；零 Join → 工作流自然收尾；
///   多 Join 或到达数不满足模式 → WORKFLOW_JOIN_INVALID
async fn run_parallel_node(
    input: &SpawnedWorkflow,
    node: &WorkflowNode,
    shared_ctx: &SharedRunContext,
    edges: &EdgesIndex<'_>,
    accum: &SharedExecAccum,
    token: &CancellationToken,
) -> ParallelReduction {
    let out_edges = edges.outgoing_of(&node.id);
    if out_edges.is_empty() {
        return ParallelReduction::Failed(
            codes::WORKFLOW_NOT_EXECUTABLE.to_string(),
            format!("parallel node has no outgoing branches: {}", node.id),
        );
    }
    // 并行节点自身 queued / started → passed（瞬时；分支启动即职责完成）
    emit(
        &input.sink,
        &WorkflowEvent::NodeQueued {
            execution_id: input.execution_id.clone(),
            node_id: node.id.clone(),
        },
    );
    emit(
        &input.sink,
        &WorkflowEvent::NodeStarted {
            execution_id: input.execution_id.clone(),
            node_id: node.id.clone(),
        },
    );
    let parallel_started_at = now_rfc3339();
    let parallel_started = Instant::now();
    for edge in out_edges {
        emit(
            &input.sink,
            &WorkflowEvent::EdgeActivated {
                execution_id: input.execution_id.clone(),
                edge_id: edge.id.clone(),
            },
        );
    }
    record_node_terminal(
        input,
        &node.id,
        parallel_started_at.clone(),
        parallel_started.elapsed().as_millis() as u64,
        shared_ctx,
        accum,
        &NodeOutcome::passed(None),
    );

    // 每条出边一条分支任务（真并发；共享执行上下文与记录累积）
    let mut handles = Vec::with_capacity(out_edges.len());
    for edge in out_edges {
        let task_input = input.clone();
        let start = edge.target.clone();
        let ctx = shared_ctx.clone();
        let accum = accum.clone();
        let token = token.clone();
        handles.push(tokio::spawn(run_branch_task(
            task_input, start, ctx, accum, token,
        )));
    }
    let mut ends = Vec::with_capacity(handles.len());
    // 分支 panic（如共享锁毒化）视为引擎内部错误：照常等完其余分支再
    // 归约失败，不留终态落库后仍在发事件的孤儿分支任务
    let mut panic_message: Option<String> = None;
    for handle in handles {
        match handle.await {
            Ok(end) => ends.push(end),
            Err(err) => {
                if panic_message.is_none() {
                    panic_message = Some(format!("parallel branch task failed: {err}"));
                }
            }
        }
    }
    if let Some(message) = panic_message {
        return ParallelReduction::Failed(codes::INTERNAL.to_string(), message);
    }

    // 失败传播（固定中断，与串行链同口径）：任一分支 failed → 整流 failed
    if let Some(end) = ends.iter().find(|end| end.status == STATUS_FAILED) {
        let (code, message) = end
            .error
            .clone()
            .expect("failed branch must carry an error");
        return ParallelReduction::Failed(code, message);
    }
    if ends.iter().any(|end| end.status == STATUS_CANCELLED) {
        return ParallelReduction::Cancelled;
    }

    // 全成功：按汇聚 Join 归约
    let joins: HashSet<&str> = ends.iter().filter_map(|end| end.join.as_deref()).collect();
    match joins.len() {
        0 => ParallelReduction::FlowEnd,
        1 => {
            let join_id = joins.into_iter().next().expect("len checked");
            let join_node =
                node_of_graph(&input.graph, join_id).expect("branch join id must exist in graph");
            let WorkflowNodeConfig::Join(join_config) = &join_node.config else {
                return ParallelReduction::Failed(
                    codes::WORKFLOW_JOIN_INVALID.to_string(),
                    format!("branch convergence target is not a join node: {join_id}"),
                );
            };
            let arrived = ends
                .iter()
                .filter(|end| end.join.as_deref() == Some(join_id))
                .count();
            let satisfied = match join_config.mode {
                JoinMode::All => arrived == ends.len(),
                JoinMode::Any => arrived >= 1,
            };
            if !satisfied {
                return ParallelReduction::Failed(
                    codes::WORKFLOW_JOIN_INVALID.to_string(),
                    format!(
                        "join mode {:?} not satisfied: {arrived} of {} branches arrived at {join_id}",
                        join_config.mode,
                        ends.len()
                    ),
                );
            }
            // Join 补 passed 记录与事件（等待窗口＝分支调度起点到归约点）
            emit(
                &input.sink,
                &WorkflowEvent::NodeQueued {
                    execution_id: input.execution_id.clone(),
                    node_id: join_node.id.clone(),
                },
            );
            emit(
                &input.sink,
                &WorkflowEvent::NodeStarted {
                    execution_id: input.execution_id.clone(),
                    node_id: join_node.id.clone(),
                },
            );
            record_node_terminal(
                input,
                &join_node.id,
                parallel_started_at,
                parallel_started.elapsed().as_millis() as u64,
                shared_ctx,
                accum,
                &NodeOutcome::passed(None),
            );
            let next = advance_current(input, join_node, None, edges);
            ParallelReduction::Continue(next)
        }
        _ => ParallelReduction::Failed(
            codes::WORKFLOW_JOIN_INVALID.to_string(),
            format!("parallel branches converge to multiple joins: {joins:?}"),
        ),
    }
}

/// 串行推进的链终点（主链与并行分支共用的推进器返回值）：终态三向＋到
/// 达的汇聚 Join（None＝未到达 Join 自然或中断停止；主链无 Join 拦截路径，
/// join 恒 None）。
pub(super) struct BranchEnd {
    pub(super) status: &'static str,
    pub(super) error: Option<(String, String)>,
    pub(super) join: Option<String>,
}

/// 串行推进器的宿主面：注入特殊节点的拦截策略（Join / Parallel 的语义
/// 归属随宿主面不同，其余推进骨架完全一致）。
pub(super) enum SerialHost {
    /// 工作流主链：Parallel 是并发调度面（spawn 分支 → Join 归约 → 继续
    /// 下游），Join 不拦截（直达由 run_node fail-fast）。
    MainChain,
    /// 并行分支：到达 Join 即登记归约停止（Join 由归约面统一补记录与放
    /// 行），嵌套 Parallel 拦 NOT_IMPLEMENTED（扁平并行第一版口径）。
    Branch,
}

/// 串行推进器（主链与并行分支共用的单一推进循环）：取消检查 → 取节点 →
/// 特殊节点拦截（按宿主面注入）→ 单节点执行步 → 重试授权 → 沿边推进，
/// 失败 / 取消携带终态停止。两处调用共享同一份骨架与事件口径，拦截策略
/// 与终态容器差异全部收敛在 SerialHost 与返回值的映射上。
///
/// 返回类型显式声明 Send：分支任务经 tokio::spawn 执行，嵌套 async fn 的
/// 不透明 future 逐层推导 Send 证明在 spawn 边界无法闭合，改由本定义点
/// 对具体 async 块一次性证明（内部无跨 await 的非 Send 捕获）。
pub(super) fn advance_serial<'a>(
    input: &'a SpawnedWorkflow,
    start: Option<String>,
    shared_ctx: &'a SharedRunContext,
    accum: &'a SharedExecAccum,
    token: &'a CancellationToken,
    host: SerialHost,
) -> impl Future<Output = BranchEnd> + Send + 'a {
    async move {
        let edges = EdgesIndex::new(&input.graph);
        let mut current: Option<String> = start;
        let mut retry_budget: Option<RetryBudget> = None;
        while let Some(node_id) = current {
            // 取消落在节点间隙（在途请求之外）：无节点转 cancelled，当前及
            // 未执行节点一并 skipped（与在途取消同终态口径）
            if token.is_cancelled() {
                return BranchEnd {
                    status: STATUS_CANCELLED,
                    error: None,
                    join: None,
                };
            }
            let Some(node) = node_of_graph(&input.graph, &node_id) else {
                break;
            };

            // 特殊节点拦截（按宿主面）：主链的 Parallel 是并发调度面，分支的
            // Join / Parallel 是归约登记与扁平并行边界
            match host {
                SerialHost::MainChain => {
                    if matches!(node.config, WorkflowNodeConfig::Parallel) {
                        match run_parallel_node(input, node, shared_ctx, &edges, accum, token).await
                        {
                            ParallelReduction::Continue(next) => {
                                current = next;
                                continue;
                            }
                            ParallelReduction::FlowEnd => {
                                return BranchEnd {
                                    status: STATUS_PASSED,
                                    error: None,
                                    join: None,
                                };
                            }
                            ParallelReduction::Failed(code, message) => {
                                return BranchEnd {
                                    status: STATUS_FAILED,
                                    error: Some((code, message)),
                                    join: None,
                                };
                            }
                            ParallelReduction::Cancelled => {
                                return BranchEnd {
                                    status: STATUS_CANCELLED,
                                    error: None,
                                    join: None,
                                };
                            }
                        }
                    }
                }
                SerialHost::Branch => {
                    // 到达 Join：登记归约并停止（Join 由归约面统一补记录与放行）
                    if matches!(node.config, WorkflowNodeConfig::Join(_)) {
                        return BranchEnd {
                            status: STATUS_PASSED,
                            error: None,
                            join: Some(node_id),
                        };
                    }
                    if matches!(node.config, WorkflowNodeConfig::Parallel) {
                        return BranchEnd {
                            status: STATUS_FAILED,
                            error: Some((
                                codes::NOT_IMPLEMENTED.to_string(),
                                "nested parallel inside a branch is not supported".to_owned(),
                            )),
                            join: None,
                        };
                    }
                }
            }

            let is_retry_node = matches!(node.config, WorkflowNodeConfig::Retry(_));
            let outcome = run_node_step(
                input,
                node,
                shared_ctx,
                &edges,
                accum,
                token,
                retry_budget.as_mut(),
            )
            .await;
            // 重试节点通过后为直接下游授权重试预算（次数 0＝无重试语义直通）
            if is_retry_node {
                retry_budget = retry_budget_after(node, &edges);
            }
            match outcome {
                NodeOutcome::Passed { selected_edge, .. } => {
                    current = advance_current(input, node, selected_edge.as_deref(), &edges);
                }
                NodeOutcome::Failed { code, message, .. } => {
                    return BranchEnd {
                        status: STATUS_FAILED,
                        error: Some((code, message)),
                        join: None,
                    };
                }
                NodeOutcome::Cancelled => {
                    return BranchEnd {
                        status: STATUS_CANCELLED,
                        error: None,
                        join: None,
                    };
                }
            }
        }
        BranchEnd {
            status: STATUS_PASSED,
            error: None,
            join: None,
        }
    }
}

/// 并行分支任务体（spawn 适配）：从分支起点委托串行推进器推进，拦截策
/// 略取分支面（Join 登记归约、嵌套并行 NOT_IMPLEMENTED）。
async fn run_branch_task(
    input: SpawnedWorkflow,
    start_node_id: String,
    shared_ctx: SharedRunContext,
    accum: SharedExecAccum,
    token: CancellationToken,
) -> BranchEnd {
    advance_serial(
        &input,
        Some(start_node_id),
        &shared_ctx,
        &accum,
        &token,
        SerialHost::Branch,
    )
    .await
}

/// 单节点分发：Start / End 直通，Request 走发送链，Extract 走执行内数据流
/// （单来源求值＋写回分支），Condition 走分支求值与选边，Delay 固定等待；
/// Join 由并行归约面统一处理（主链直接到达＝无并行前提，fail-fast）；
/// Retry 是预算授权面（自身瞬时通过）。未支持分支的穷尽匹配保留：新增
/// 节点 kind 漏分支时编译报错。
async fn run_node(
    input: &SpawnedWorkflow,
    node: &WorkflowNode,
    shared_ctx: &SharedRunContext,
    edges: &EdgesIndex<'_>,
    token: &CancellationToken,
) -> NodeOutcome {
    match &node.config {
        WorkflowNodeConfig::Start | WorkflowNodeConfig::End => NodeOutcome::passed(None),
        WorkflowNodeConfig::Request(config) => {
            execute_request_node(input, node, config, shared_ctx, token).await
        }
        WorkflowNodeConfig::Extract(config) => {
            execute_extract_node(input, node, config, shared_ctx).await
        }
        WorkflowNodeConfig::Assert(config) => {
            execute_assert_node(input, node, config, shared_ctx)
        }
        WorkflowNodeConfig::Condition(config) => {
            execute_condition_node(input, node, config, shared_ctx, edges).await
        }
        WorkflowNodeConfig::Delay(config) => execute_delay_node(config, token).await,
        WorkflowNodeConfig::Join(_) => NodeOutcome::failed(
            codes::WORKFLOW_JOIN_INVALID.to_string(),
            format!(
                "join node reached without parallel convergence: {}",
                node.id
            ),
        ),
        WorkflowNodeConfig::Parallel | WorkflowNodeConfig::Retry(_) => NodeOutcome::passed(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::workflow_execution::STATUS_SKIPPED;
    use crate::domain::workflow::{
        AssertNodeConfig, AssertRule, GRAPH_SCHEMA_VERSION, JoinNodeConfig, OverrideRow,
        RequestNodeConfig, RetryNodeConfig, WorkflowGraph,
    };
    use crate::services::workflow_engine::{execute, workflow_task_key};
    use crate::test_support::issues_of;
    use crate::test_support::{
        Fixture, edge, event_ids, node, node_record, node_status, request_node,
    };
    use std::time::Instant;

    /// 重试靶机图：Start → 重试（次数 / 间隔由调用方注入）→ flaky 请求 → End。
    /// flaky 接口用户数据带 1s 超时（靶机前 `fail_times` 次挂起到超时，
    /// 之后立即 200——传输失败 → 重试 → 成功的唯一形态）。
    fn retry_chain_graph(max_attempts: u32, interval_ms: u64) -> WorkflowGraph {
        WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                node(
                    "retry",
                    WorkflowNodeConfig::Retry(RetryNodeConfig {
                        max_attempts,
                        interval_ms,
                    }),
                ),
                request_node("flaky", "GET /api/flaky"),
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![
                edge(0, "start", "retry"),
                edge(1, "retry", "flaky"),
                edge(2, "flaky", "end"),
            ],
        }
    }

    /// 重试「失败 → 重试 → 成功」：flaky 首次挂起超时、第二次成功——
    /// 重试预算内恢复，工作流 passed；重试尝试不发中间事件（flaky 只有一
    /// 组 queued/started/终态事件）。
    #[tokio::test]
    async fn retry_recovers_transient_transport_failure() {
        let fx = Fixture::new().await;
        // flaky 接口用户数据：1s 超时（挂起段超时即传输失败）
        crate::infrastructure::user_data_repo::upsert(
            &fx.pool,
            "s1",
            "GET /api/flaky",
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
        // 注入 1 次故障：首次挂起超时、重试后立即 200——「失败→重试→成功」
        fx.target.set_flaky_failures(1);
        let graph = retry_chain_graph(2, 50);
        let workflow_id = fx.seed_workflow("重试恢复", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED, "{dto:?}");
        assert_eq!(node_status(&dto, "flaky"), STATUS_PASSED);
        // 事件面：重试尝试不发中间事件——flaky 仍是一组 queued/started/终态
        let ids = event_ids(&fx.events);
        let flaky_events: Vec<&String> = ids.iter().filter(|id| id.contains(":flaky")).collect();
        assert_eq!(
            flaky_events.len(),
            3,
            "重试过程不外发中间事件（queued/started/终态各一）: {ids:?}"
        );
        // flaky 终态记录的耗时应覆盖「首次超时 + 间隔 + 第二次成功」
        let record = node_record(&dto, "flaky");
        assert!(
            record.duration_ms.unwrap_or(0) >= 1000,
            "重试总耗时应含首次超时与间隔: {:?}",
            record.duration_ms
        );
    }

    /// 重试耗尽：靶机持续挂起 → 每次尝试超时失败 → 预算耗尽 → 节点
    /// failed（错误信息携带重试口径）、整流 failed。
    #[tokio::test]
    async fn retry_exhaustion_propagates_failure() {
        let fx = Fixture::new().await;
        crate::infrastructure::user_data_repo::upsert(
            &fx.pool,
            "s1",
            "GET /api/flaky",
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
        // fail=99：前 99 次全部挂起（本次执行内必超时），重试 1 次后耗尽
        fx.target.set_flaky_failures(99);
        let graph = retry_chain_graph(1, 50);
        let workflow_id = fx.seed_workflow("重试耗尽", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_FAILED);
        let record = node_record(&dto, "flaky");
        assert_eq!(record.status, STATUS_FAILED);
        let message = record.error_message.as_deref().expect("失败原因可见");
        assert!(
            message.contains("retry budget exhausted"),
            "重试耗尽口径应可见: {message}"
        );
        assert_eq!(node_status(&dto, "end"), STATUS_SKIPPED);
    }

    /// 重试预算生成（纯逻辑直测，不依赖靶机）：重试节点经首条出边授权
    /// 直接下游；次数 0＝不授权；非重试节点恒 None。
    #[test]
    fn retry_budget_follows_first_outgoing_edge() {
        // 次数 0：无重试语义，不授权
        let graph = retry_chain_graph(0, 10);
        let retry_node = node_of_graph(&graph, "retry").unwrap();
        let edges = EdgesIndex::new(&graph);
        assert!(retry_budget_after(retry_node, &edges).is_none());

        let graph = retry_chain_graph(3, 120);
        let retry_node = node_of_graph(&graph, "retry").unwrap();
        let edges = EdgesIndex::new(&graph);
        let budget = retry_budget_after(retry_node, &edges).expect("次数 >0 应授权");
        assert_eq!(budget.target, "flaky");
        assert_eq!(budget.max_attempts, 3);
        assert_eq!(budget.remaining, 3);
        assert_eq!(budget.interval_ms, 120);

        // 非重试节点不授权
        let flaky = node_of_graph(&graph, "flaky").unwrap();
        assert!(retry_budget_after(flaky, &edges).is_none());
    }

    /// 并行三分支（各挂 slow 延时）总耗时 ≈ 最长支：真并发而非串行累加；
    /// Join（all）汇聚后继续下游到 End。
    #[tokio::test]
    async fn parallel_branches_run_concurrently_and_join_all() {
        let fx = Fixture::new().await;
        let slow = |id: &str, ms: &str| {
            let mut node = request_node(id, "GET /api/slow");
            if let WorkflowNodeConfig::Request(config) = &mut node.config {
                config.query = vec![OverrideRow {
                    name: "ms".into(),
                    value: ms.into(),
                }];
            }
            node
        };
        let graph = WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                node("parallel", WorkflowNodeConfig::Parallel),
                slow("a", "400"),
                slow("b", "400"),
                slow("c", "700"),
                node(
                    "join",
                    WorkflowNodeConfig::Join(JoinNodeConfig {
                        mode: JoinMode::All,
                    }),
                ),
                request_node("after", "GET /healthz"),
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![
                edge(0, "start", "parallel"),
                edge(1, "parallel", "a"),
                edge(2, "parallel", "b"),
                edge(3, "parallel", "c"),
                edge(4, "a", "join"),
                edge(5, "b", "join"),
                edge(6, "c", "join"),
                edge(7, "join", "after"),
                edge(8, "after", "end"),
            ],
        };
        let workflow_id = fx.seed_workflow("并行", &graph).await;
        let started = Instant::now();
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        let elapsed = started.elapsed();
        assert_eq!(dto.status, STATUS_PASSED, "{dto:?}");
        for id in ["parallel", "a", "b", "c", "join", "after", "end"] {
            assert_eq!(node_record(&dto, id).status, STATUS_PASSED, "{id} 应通过");
        }
        // 真并发断言：总耗时 ≥ 最长支（700ms）且远小于串行和（1500ms）
        assert!(
            elapsed >= Duration::from_millis(700),
            "总耗时不得短于最长支: {elapsed:?}"
        );
        assert!(
            elapsed < Duration::from_millis(1300),
            "总耗时接近最长支而非串行累加: {elapsed:?}"
        );
        // Join 记录补齐（等待窗口耗时 ≥ 最长支）
        let join = node_record(&dto, "join");
        assert_eq!(join.status, STATUS_PASSED);
        assert!(join.duration_ms.unwrap_or(0) >= 700);
    }

    /// Join all 模式：分支全部到达才放行（靶机三分支全成功）——单支失败
    /// → 整流 failed（固定中断）、Join 与下游 skipped。
    #[tokio::test]
    async fn join_all_with_single_branch_failure_fails_flow() {
        let fx = Fixture::new().await;
        let slow = |id: &str, ms: &str| {
            let mut node = request_node(id, "GET /api/slow");
            if let WorkflowNodeConfig::Request(config) = &mut node.config {
                config.query = vec![OverrideRow {
                    name: "ms".into(),
                    value: ms.into(),
                }];
            }
            node
        };
        // 分支失败注入＝断言节点必败（b 请求成功后断言 599 必然失败）；
        // 失效引用已上移执行前校验，执行期失败面走断言传播
        let graph = WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                node("parallel", WorkflowNodeConfig::Parallel),
                slow("a", "100"),
                node(
                    "b",
                    WorkflowNodeConfig::Request(RequestNodeConfig {
                        endpoint_key: Some("GET /healthz".into()),
                        ..Default::default()
                    }),
                ),
                node(
                    "assert_b",
                    WorkflowNodeConfig::Assert(AssertNodeConfig {
                        rules: vec![AssertRule::StatusCode {
                            expected: "599".into(),
                        }],
                    }),
                ),
                slow("c", "100"),
                node(
                    "join",
                    WorkflowNodeConfig::Join(JoinNodeConfig {
                        mode: JoinMode::All,
                    }),
                ),
                request_node("after", "GET /healthz"),
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![
                edge(0, "start", "parallel"),
                edge(1, "parallel", "a"),
                edge(2, "parallel", "b"),
                edge(3, "parallel", "c"),
                edge(4, "a", "join"),
                edge(5, "b", "assert_b"),
                edge(6, "assert_b", "join"),
                edge(7, "c", "join"),
                edge(8, "join", "after"),
                edge(9, "after", "end"),
            ],
        };
        let workflow_id = fx.seed_workflow("汇聚失败", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_FAILED);
        assert_eq!(
            dto.error_code.as_deref(),
            Some(codes::WORKFLOW_ASSERT_FAILED)
        );
        assert_eq!(node_status(&dto, "b"), STATUS_PASSED, "请求分支留痕");
        assert_eq!(node_status(&dto, "assert_b"), STATUS_FAILED, "失败分支留痕");
        assert_eq!(node_status(&dto, "join"), STATUS_SKIPPED, "汇聚点不执行");
        assert_eq!(node_status(&dto, "after"), STATUS_SKIPPED);
    }

    /// Join any × 单支失败：固定中断语义不分模式——失败分支 failed、
    /// Join 与下游 skipped、整流 failed（any 的「任一满足」只在全成功时
    /// 参与：失败分支不算到达）。
    #[tokio::test]
    async fn join_any_with_single_branch_failure_fails_flow() {
        let fx = Fixture::new().await;
        // 分支失败注入＝断言节点必败（语义同 join_all；失效引用已上移校验）
        let graph = WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                node("parallel", WorkflowNodeConfig::Parallel),
                request_node("a", "GET /healthz"),
                request_node("b", "GET /healthz"),
                node(
                    "assert_b",
                    WorkflowNodeConfig::Assert(AssertNodeConfig {
                        rules: vec![AssertRule::StatusCode {
                            expected: "599".into(),
                        }],
                    }),
                ),
                node(
                    "join",
                    WorkflowNodeConfig::Join(JoinNodeConfig {
                        mode: JoinMode::Any,
                    }),
                ),
                request_node("after", "GET /healthz"),
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![
                edge(0, "start", "parallel"),
                edge(1, "parallel", "a"),
                edge(2, "parallel", "b"),
                edge(3, "a", "join"),
                edge(4, "b", "assert_b"),
                edge(5, "assert_b", "join"),
                edge(6, "join", "after"),
                edge(7, "after", "end"),
            ],
        };
        let workflow_id = fx.seed_workflow("任一汇聚失败", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_FAILED);
        assert_eq!(
            dto.error_code.as_deref(),
            Some(codes::WORKFLOW_ASSERT_FAILED)
        );
        assert_eq!(node_status(&dto, "a"), STATUS_PASSED, "成功分支留痕");
        assert_eq!(node_status(&dto, "assert_b"), STATUS_FAILED);
        assert_eq!(node_status(&dto, "join"), STATUS_SKIPPED);
        assert_eq!(node_status(&dto, "after"), STATUS_SKIPPED);
    }

    /// Join any 模式：等待全部分支结束后判定，任一成功到达即满足（靶机
    /// 两分支全成功）→ Join passed 继续下游。
    #[tokio::test]
    async fn join_any_satisfied_by_any_arriving_branch() {
        let fx = Fixture::new().await;
        let slow = |id: &str, ms: &str| {
            let mut node = request_node(id, "GET /api/slow");
            if let WorkflowNodeConfig::Request(config) = &mut node.config {
                config.query = vec![OverrideRow {
                    name: "ms".into(),
                    value: ms.into(),
                }];
            }
            node
        };
        let graph = WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                node("parallel", WorkflowNodeConfig::Parallel),
                slow("a", "100"),
                slow("b", "100"),
                node(
                    "join",
                    WorkflowNodeConfig::Join(JoinNodeConfig {
                        mode: JoinMode::Any,
                    }),
                ),
                request_node("after", "GET /healthz"),
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![
                edge(0, "start", "parallel"),
                edge(1, "parallel", "a"),
                edge(2, "parallel", "b"),
                edge(3, "a", "join"),
                edge(4, "b", "join"),
                edge(5, "join", "after"),
                edge(6, "after", "end"),
            ],
        };
        let workflow_id = fx.seed_workflow("任一汇聚", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED, "{dto:?}");
        for id in ["a", "b", "join", "after", "end"] {
            assert_eq!(node_record(&dto, id).status, STATUS_PASSED, "{id} 应通过");
        }
    }

    /// 并行取消传播：取消落在并行等待期间 → 全部分支收尾为 cancelled、
    /// Join 与下游 skipped、整流 cancelled。
    #[tokio::test]
    async fn cancellation_propagates_to_all_parallel_branches() {
        let fx = Fixture::new().await;
        let slow = |id: &str| {
            let mut node = request_node(id, "GET /api/slow");
            if let WorkflowNodeConfig::Request(config) = &mut node.config {
                config.query = vec![OverrideRow {
                    name: "ms".into(),
                    value: "3000".into(),
                }];
            }
            node
        };
        let graph = WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                node("parallel", WorkflowNodeConfig::Parallel),
                slow("a"),
                slow("b"),
                slow("c"),
                node(
                    "join",
                    WorkflowNodeConfig::Join(JoinNodeConfig {
                        mode: JoinMode::All,
                    }),
                ),
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![
                edge(0, "start", "parallel"),
                edge(1, "parallel", "a"),
                edge(2, "parallel", "b"),
                edge(3, "parallel", "c"),
                edge(4, "a", "join"),
                edge(5, "b", "join"),
                edge(6, "c", "join"),
                edge(7, "join", "end"),
            ],
        };
        let workflow_id = fx.seed_workflow("并行取消", &graph).await;
        let ctx = fx.ctx();
        let execution = execute(&ctx, &workflow_id);
        tokio::pin!(execution);
        let dto = tokio::select! {
            result = &mut execution => result.unwrap(),
            _ = tokio::time::sleep(Duration::from_millis(300)) => {
                fx.registry.cancel(&workflow_task_key(&workflow_id));
                execution.await.unwrap()
            }
        };
        assert_eq!(dto.status, STATUS_CANCELLED);
        for id in ["a", "b", "c"] {
            assert_eq!(
                node_status(&dto, id),
                STATUS_CANCELLED,
                "{id} 在途分支应 cancelled"
            );
        }
        assert_eq!(node_status(&dto, "join"), STATUS_SKIPPED);
        assert_eq!(node_status(&dto, "end"), STATUS_SKIPPED);
        assert!(
            !fx.registry
                .is_running(&workflow_task_key(
                    &workflow_id
                ))
        );
    }

    /// 并行分支内不允许再嵌并行（扁平并行第一版口径）：嵌套分支 failed
    /// → 整流 failed（NOT_IMPLEMENTED）。
    #[tokio::test]
    async fn nested_parallel_in_branch_fails_flow() {
        let fx = Fixture::new().await;
        let graph = WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                node("parallel", WorkflowNodeConfig::Parallel),
                node("nested", WorkflowNodeConfig::Parallel),
                request_node("leaf", "GET /healthz"),
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![
                edge(0, "start", "parallel"),
                edge(1, "parallel", "nested"),
                edge(2, "nested", "leaf"),
                edge(3, "leaf", "end"),
            ],
        };
        let workflow_id = fx.seed_workflow("嵌套并行", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_FAILED);
        assert_eq!(dto.error_code.as_deref(), Some(codes::NOT_IMPLEMENTED));
    }

    /// 分支未汇聚到 Join 且全部分支自然结束：工作流无汇聚收尾（passed）。
    #[tokio::test]
    async fn parallel_without_join_ends_after_branches() {
        let fx = Fixture::new().await;
        let graph = WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                node("parallel", WorkflowNodeConfig::Parallel),
                request_node("a", "GET /healthz"),
                request_node("b", "GET /healthz"),
            ],
            edges: vec![
                edge(0, "start", "parallel"),
                edge(1, "parallel", "a"),
                edge(2, "parallel", "b"),
            ],
        };
        let workflow_id = fx.seed_workflow("无汇聚", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED, "{dto:?}");
        assert_eq!(node_status(&dto, "a"), STATUS_PASSED);
        assert_eq!(node_status(&dto, "b"), STATUS_PASSED);
    }

    /// 主链直接串行到 Join（无并行前提）：fail-fast WORKFLOW_JOIN_INVALID。
    #[tokio::test]
    async fn join_without_parallel_convergence_fails_flow() {
        let fx = Fixture::new().await;
        let graph = WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                request_node("a", "GET /healthz"),
                node(
                    "join",
                    WorkflowNodeConfig::Join(JoinNodeConfig {
                        mode: JoinMode::All,
                    }),
                ),
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![
                edge(0, "start", "a"),
                edge(1, "a", "join"),
                edge(2, "join", "end"),
            ],
        };
        let workflow_id = fx.seed_workflow("空汇聚", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_FAILED);
        assert_eq!(
            dto.error_code.as_deref(),
            Some(codes::WORKFLOW_JOIN_INVALID)
        );
    }

    /// 并行无出边（无分支可并行）：执行前拦截（parallelNoBranch 可定位）。
    #[tokio::test]
    async fn parallel_without_branches_fails_flow() {
        let fx = Fixture::new().await;
        let graph = WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                node("parallel", WorkflowNodeConfig::Parallel),
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![edge(0, "start", "parallel")],
        };
        let workflow_id = fx.seed_workflow("空并行", &graph).await;
        let err = execute(&fx.ctx(), &workflow_id)
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::WORKFLOW_NOT_EXECUTABLE);
        let issues = issues_of(&err);
        // 清单含孤立 end 与空并行两项；这里断言并行项本身
        let issue = issues
            .iter()
            .find(|issue| issue["code"] == "parallelNoBranch")
            .expect("应有并行分支缺失项");
        assert_eq!(issue["nodeId"], "parallel");
    }
}
