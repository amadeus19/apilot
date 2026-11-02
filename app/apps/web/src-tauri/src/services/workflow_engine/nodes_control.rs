//! 控制面节点执行器：断言节点（逐规则判定、固定中断）、条件节点（分支
//! 短路求值与选边）、延时节点（固定等待，取消随时中断）。

use std::collections::HashMap;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::domain::workflow::{
    ConditionNodeConfig, DelayNodeConfig, EdgesIndex, WorkflowNode,
};
use crate::domain::workflow_condition::{DEFAULT_EDGE_LABEL, ConditionOutcome, evaluate_branches};
use crate::domain::workflow_execution::{
    ExecutionVariable, merge_execution_variables, resolve_deep_reference,
};
use crate::error::codes;
use crate::services::variable::load_effective;

use super::nodes_data::{upstream_request_snapshot, visible_upstream_outputs};
use super::{NodeOutcome, SharedRunContext, SpawnedWorkflow};

/// 断言节点执行：上游必须是请求节点（引擎约束——完整校验清单归校验器），
/// 对其响应快照逐规则求值（AND 组合，求值器在 domain 层）。全部通过＝
/// 节点 passed（产物摘要＝通过计数）；任一失败＝节点 failed（固定中断
/// 传播：后续 skipped、整流 failed），错误信息携带失败规则的期望 vs 实际。
/// 逐条结果（actual 已按名单式口径投影：敏感键 / Secret 回显掩码、非敏感
/// 明文）进执行记录与 node.completed 事件。
pub(super) fn execute_assert_node(
    input: &SpawnedWorkflow,
    node: &WorkflowNode,
    config: &crate::domain::workflow::AssertNodeConfig,
    shared_ctx: &SharedRunContext,
) -> NodeOutcome {
    let snapshot = match upstream_request_snapshot(
        input,
        node,
        shared_ctx,
        "assert",
        codes::WORKFLOW_ASSERT_SOURCE_INVALID,
    ) {
        Ok(snapshot) => snapshot,
        Err(outcome) => return outcome,
    };
    let assertions = crate::domain::workflow_assert::evaluate_assertions(
        config,
        snapshot.status,
        &snapshot.body_text,
        &snapshot.secret_values,
    );
    let total = assertions.len();
    let failed: Vec<&crate::domain::workflow_execution::AssertionEntry> =
        assertions.iter().filter(|entry| !entry.passed).collect();
    if failed.is_empty() {
        NodeOutcome::Passed {
            output: Some(format!("assertions {total}/{total} passed")),
            writebacks: Vec::new(),
            assertions,
            selected_edge: None,
        }
    } else {
        let detail = failed
            .iter()
            .map(|entry| {
                let path = entry
                    .path
                    .as_deref()
                    .map(|path| format!(" at {path}"))
                    .unwrap_or_default();
                match &entry.expected {
                    Some(expected) => {
                        format!(
                            "{}{} expected {} actual {}",
                            entry.rule_kind, path, expected, entry.actual
                        )
                    }
                    None => format!(
                        "{}{} to exist, actual {}",
                        entry.rule_kind, path, entry.actual
                    ),
                }
            })
            .collect::<Vec<_>>()
            .join("; ");
        NodeOutcome::Failed {
            code: codes::WORKFLOW_ASSERT_FAILED.to_string(),
            message: format!("{} of {total} assertions failed: {detail}", failed.len()),
            assertions,
        }
    }
}

/// 条件节点执行：变量解析链与请求节点同口径（生效集现取＋执行内两层），
/// 分支序列按配置序短路求值（domain 求值器）；命中分支激活对应出边
/// （边 label＝分支 id），全不满足激活 DEFAULT 出边。产物摘要记录实际
/// 表达式与选中分支（「✓ 表达式 → 分支」）。表达式解析失败＝节点 failed
/// （执行前全量校验归校验器，引擎只对实际求值路径报错）；命中分支（含
/// Default）无对应出边＝图与分支标注不一致，fail-fast。
pub(super) async fn execute_condition_node(
    input: &SpawnedWorkflow,
    node: &WorkflowNode,
    config: &ConditionNodeConfig,
    shared_ctx: &SharedRunContext,
    edges: &EdgesIndex<'_>,
) -> NodeOutcome {
    // 生效集现取（await 在前），执行内两层锁内 clone（guard 不跨 await）
    let effective = match load_effective(&input.pool, &input.workspace_id).await {
        Ok(effective) => effective,
        Err(err) => return NodeOutcome::from_error(err),
    };
    let (workflow_vars, buckets) = {
        let ctx = shared_ctx.lock().expect("执行上下文锁");
        (ctx.workflow_vars.clone(), ctx.node_outputs.clone())
    };
    // 可见层就地合成（锁外，图数据不持锁）：本节点的可见输出＝入边 source
    // 节点输出桶并集（连线作用域，一跳）
    let node_outputs = visible_upstream_outputs(&input.graph, &node.id, &buckets);
    let table: HashMap<String, ExecutionVariable> =
        merge_execution_variables(effective, &workflow_vars, &node_outputs)
            .into_iter()
            .map(|variable| {
                (
                    variable.key,
                    ExecutionVariable {
                        value: variable.value,
                        secret: variable.secret,
                    },
                )
            })
            .collect();
    let resolve = |key: &str| {
        table.get(key).map(|v| v.value.clone()).or_else(|| {
            // 精确键未命中走深层引用惰性求值（提取产物 {{产物名.字段}} 与
            // 手写引用同享；求值核心与解析器同一单点）
            resolve_deep_reference(
                &|prefix: &str| table.get(prefix).map(|v| v.value.clone()),
                key,
            )
            .map(|(value, _prefix)| value)
        })
    };

    let outcome: ConditionOutcome = match evaluate_branches(&config.branches, &resolve) {
        Ok(outcome) => outcome,
        Err(reason) => {
            return NodeOutcome::failed(
                codes::WORKFLOW_CONDITION_EVAL_FAILED.to_string(),
                format!("condition expression failed: {reason}"),
            );
        }
    };
    let wanted_label = outcome.branch_id.as_deref().unwrap_or(DEFAULT_EDGE_LABEL);
    let Some(edge) = edges.outgoing_labeled(&node.id, wanted_label) else {
        return NodeOutcome::failed(
            codes::WORKFLOW_BRANCH_EDGE_MISSING.to_string(),
            format!(
                "condition branch edge is missing: node {} has no outgoing edge labeled {wanted_label}",
                node.id
            ),
        );
    };
    // 选中边由主循环 advance_current 按返回的 selected_edge 统一激活
    // （单点 emit，避免同边重复事件）
    // 产物摘要：实际表达式与选中分支（DEFAULT＝无分支满足的兜底去向）
    let summary = match outcome.branch_id {
        Some(_) => format!("✓ {} → {wanted_label}", outcome.expression),
        None => format!("no branch matched → {wanted_label}"),
    };
    NodeOutcome::Passed {
        output: Some(summary),
        writebacks: Vec::new(),
        assertions: Vec::new(),
        selected_edge: Some(edge.id.clone()),
    }
}

/// 延时节点执行：固定等待（取消随时中断；零延时直通）。
pub(super) async fn execute_delay_node(
    config: &DelayNodeConfig,
    token: &CancellationToken,
) -> NodeOutcome {
    if config.duration_ms == 0 {
        return NodeOutcome::passed(Some("0 ms".to_owned()));
    }
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_millis(config.duration_ms)) => {
            NodeOutcome::passed(Some(format!("{} ms", config.duration_ms)))
        }
        _ = token.cancelled() => NodeOutcome::Cancelled,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::redact;
    use crate::domain::workflow::{
        AssertNodeConfig, AssertRule, ExtractNodeConfig, ExtractRule, ExtractSource,
        ExtractWriteback, GRAPH_SCHEMA_VERSION, OverrideRow, Position, RequestNodeConfig,
        WorkflowGraph, WorkflowNode, WorkflowNodeConfig,
    };
    use crate::domain::workflow_execution::{STATUS_FAILED, STATUS_PASSED, STATUS_SKIPPED};
    use crate::services::workflow_engine::execute;
    use crate::test_support::{
        Fixture, edge, edge_labeled, issues_of, node, node_record, node_status, request_node,
    };

    // —— 断言节点（行式规则 AND、固定中断、终态归约）——

    /// 断言链图：Start → 登录 → 断言（规则由调用方注入）→（可选）后续请求 → End。
    fn assert_chain_graph(
        rules: Vec<crate::domain::workflow::AssertRule>,
        with_downstream: bool,
    ) -> WorkflowGraph {
        let mut nodes = vec![
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
                "assert",
                WorkflowNodeConfig::Assert(AssertNodeConfig { rules }),
            ),
        ];
        let mut edges = vec![edge(0, "start", "login"), edge(1, "login", "assert")];
        let mut last = "assert".to_string();
        if with_downstream {
            nodes.push(request_node("me", "GET /auth/me"));
            edges.push(edge(2, "assert", "me"));
            last = "me".to_string();
        }
        nodes.push(node("end", WorkflowNodeConfig::End));
        edges.push(edge(3, &last, "end"));
        WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes,
            edges,
        }
    }

    /// 登录链挂断言全绿：状态码 200 ＋ `$.token` 存在全部满足 → 断言节点
    /// passed、整流 passed；逐条结果进执行记录与 node.completed 事件
    /// （非断言节点的事件不携带 assertions 字段）。
    #[tokio::test]
    async fn assert_node_passes_green_chain_and_records_entries() {
        let fx = Fixture::new().await;
        let graph = assert_chain_graph(
            vec![
                AssertRule::StatusCode {
                    expected: "200".into(),
                },
                AssertRule::Exists {
                    path: "$.token".into(),
                },
            ],
            false,
        );
        let workflow_id = fx.seed_workflow("断言绿", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED);
        let record = node_record(&dto, "assert");
        assert_eq!(record.status, STATUS_PASSED);
        assert_eq!(record.assertions.len(), 2);
        assert!(record.assertions.iter().all(|entry| entry.passed));
        assert_eq!(record.output.as_deref(), Some("assertions 2/2 passed"));
        // 状态码条目明文、存在条目的键名（token）命中敏感名单掩码
        assert_eq!(record.assertions[0].actual, "200");
        assert_eq!(record.assertions[1].actual, redact::MASK);

        // 事件面：断言节点的 node.completed 携带逐条结果；login 不携带
        let events = fx.events.lock().expect("事件锁");
        let completed: Vec<&serde_json::Value> = events
            .iter()
            .filter(|event| event["event"] == "node.completed")
            .collect();
        let assert_event = completed
            .iter()
            .find(|event| event["nodeId"] == "assert")
            .expect("断言节点完成事件应存在");
        let entries = assert_event["assertions"]
            .as_array()
            .expect("断言事件应携带结果数组");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["ruleKind"], "statusCode");
        assert_eq!(entries[0]["expected"], "200");
        assert_eq!(entries[0]["actual"], "200");
        let login_event = completed
            .iter()
            .find(|event| event["nodeId"] == "login")
            .expect("登录节点完成事件应存在");
        assert!(
            login_event.get("assertions").is_none(),
            "非断言节点不携带断言字段"
        );
    }

    /// 断言失败＝固定中断：断言节点 failed（错误信息携带期望 vs 实际）、
    /// 后续节点 skipped、整流 failed；失败条目同进执行记录与事件。
    #[tokio::test]
    async fn assert_failure_interrupts_flow_with_expected_vs_actual() {
        let fx = Fixture::new().await;
        let graph = assert_chain_graph(
            vec![
                AssertRule::StatusCode {
                    expected: "500".into(),
                },
                AssertRule::Exists {
                    path: "$.token".into(),
                },
            ],
            true,
        );
        let workflow_id = fx.seed_workflow("断言红", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_FAILED);
        let record = node_record(&dto, "assert");
        assert_eq!(record.status, STATUS_FAILED);
        assert_eq!(
            record.error_code.as_deref(),
            Some(codes::WORKFLOW_ASSERT_FAILED)
        );
        // 期望 vs 实际并列可见（状态码条目双方都非敏感，明文呈现）
        let message = record.error_message.as_deref().expect("失败原因应可见");
        assert!(message.contains("1 of 2"), "失败计数可见: {message}");
        assert!(message.contains("expected 500"), "期望值可见: {message}");
        assert!(message.contains("actual 200"), "实际值可见: {message}");
        assert_eq!(node_status(&dto, "me"), STATUS_SKIPPED, "后续节点固定中断");
        assert_eq!(node_status(&dto, "end"), STATUS_SKIPPED);

        // 记录与事件同携失败条目（判否与判过并列，逐条如实；node.failed
        // 携带 assertions——实时面板的失败明细唯一来路）
        assert_eq!(record.assertions.len(), 2);
        assert!(!record.assertions[0].passed);
        assert!(record.assertions[1].passed);
        let events = fx.events.lock().expect("事件锁");
        let assert_event = events
            .iter()
            .find(|event| event["event"] == "node.completed" && event["nodeId"] == "assert");
        assert!(
            assert_event.is_none(),
            "失败节点推 node.failed 而非 node.completed"
        );
        let failed_event = events
            .iter()
            .find(|event| event["event"] == "node.failed" && event["nodeId"] == "assert")
            .expect("断言失败事件应存在");
        assert_eq!(failed_event["errorCode"], codes::WORKFLOW_ASSERT_FAILED);
        let failed_entries = failed_event["assertions"]
            .as_array()
            .expect("断言失败事件应携带逐条结果");
        assert_eq!(failed_entries.len(), 2);
        assert_eq!(failed_entries[0]["passed"], false);
        assert_eq!(failed_entries[0]["expected"], "500");
        assert_eq!(failed_entries[0]["actual"], "200");
    }

    /// 名单式投影端到端（断言面）：非敏感字符串键的实际值明文进执行记录
    /// 与事件——「期望 vs 实际」并列可见，失败修复闭环恢复；敏感键掩码
    /// 由 token 用例（assert_node_passes_green_chain_and_records_entries）
    /// 钉住。投影单点在后端引擎，GUI 与 CLI 消费同一记录，口径天然一致。
    #[tokio::test]
    async fn assert_non_sensitive_string_actual_recorded_in_plaintext() {
        let fx = Fixture::new().await;
        // /healthz 响应体 {"status":"ok"}：status 不在敏感键名单
        let graph = WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                request_node("probe", "GET /healthz"),
                node(
                    "assert",
                    WorkflowNodeConfig::Assert(AssertNodeConfig {
                        rules: vec![
                            AssertRule::JsonPath {
                                path: "$.status".into(),
                                expected: "ok".into(),
                            },
                            AssertRule::Contains {
                                path: Some("$.status".into()),
                                value: "ok".into(),
                            },
                        ],
                    }),
                ),
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![
                edge(0, "start", "probe"),
                edge(1, "probe", "assert"),
                edge(2, "assert", "end"),
            ],
        };
        let workflow_id = fx.seed_workflow("断言明文", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED);
        let record = node_record(&dto, "assert");
        assert!(record.assertions.iter().all(|entry| entry.passed));
        assert_eq!(
            record.assertions[0].actual, "ok",
            "非敏感字符串实际值明文呈现"
        );
        assert_eq!(record.assertions[1].actual, "ok");
        // 事件面同口径（node.completed 携带逐条结果）
        let events = fx.events.lock().expect("事件锁");
        let assert_event = events
            .iter()
            .find(|event| event["event"] == "node.completed" && event["nodeId"] == "assert")
            .expect("断言节点完成事件应存在");
        let entries = assert_event["assertions"].as_array().expect("断言数组");
        assert_eq!(entries[0]["actual"], "ok");
    }

    /// 断言上游不是请求节点时执行即拦截（引擎约束：WORKFLOW_ASSERT_SOURCE_INVALID）。
    #[tokio::test]
    async fn assert_upstream_must_be_request_node() {
        let fx = Fixture::new().await;
        let graph = WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                node(
                    "assert",
                    WorkflowNodeConfig::Assert(AssertNodeConfig {
                        rules: vec![AssertRule::StatusCode {
                            expected: "200".into(),
                        }],
                    }),
                ),
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![edge(0, "start", "assert"), edge(1, "assert", "end")],
        };
        let workflow_id = fx.seed_workflow("断言上游非法", &graph).await;
        let err = execute(&fx.ctx(), &workflow_id).await.unwrap_err();
        assert_eq!(err.code, codes::WORKFLOW_NOT_EXECUTABLE);
        let issues = issues_of(&err);
        assert_eq!(issues[0]["code"], "upstreamNotRequest");
        assert_eq!(issues[0]["nodeId"], "assert");
    }

    // —— 条件节点（分支求值、选边激活、未选分支 skipped）——

    /// 条件分支图：Start → 登录（状态码 200）→ 提取状态码（产物
    /// login_status）→ 条件（表达式由调用方注入，经 `{{login_status}}`
    /// 引用产物——条件的直接上游是提取节点，连线作用域内可见）→ 两分支
    /// 各一请求 → End。分支出边 label＝分支 id（b_yes / b_no），Default
    /// 出边 label＝DEFAULT。
    fn condition_chain_graph(expression: &str) -> WorkflowGraph {
        let login = request_node("login", "GET /api/error/{status}");
        let mut login = login;
        if let WorkflowNodeConfig::Request(config) = &mut login.config {
            config.query = vec![OverrideRow {
                name: "status".into(),
                value: "200".into(),
            }];
        }
        let mut extract = node(
            "extract",
            WorkflowNodeConfig::Extract(ExtractNodeConfig {
                source: ExtractSource::StatusCode,
                rules: vec![ExtractRule {
                    path: String::new(),
                    name: "login_status".into(),
                }],
                writeback: ExtractWriteback::default(),
            }),
        );
        extract.name = "提取".into();
        WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                login,
                extract,
                node(
                    "condition",
                    WorkflowNodeConfig::Condition(ConditionNodeConfig {
                        branches: vec![
                            crate::domain::workflow::ConditionBranch {
                                id: "b_yes".into(),
                                expression: expression.to_owned(),
                            },
                            // b_no 行恒不命中（999）：两分支节点图里它只作
                            // skipped 验证面，兜底走向 DEFAULT
                            crate::domain::workflow::ConditionBranch {
                                id: "b_no".into(),
                                expression: "{{login_status}} == 999".into(),
                            },
                        ],
                    }),
                ),
                request_node("yes", "GET /healthz"),
                request_node("no", "GET /healthz"),
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![
                edge(0, "start", "login"),
                edge(1, "login", "extract"),
                edge(2, "extract", "condition"),
                edge_labeled(3, "condition", "yes", Some("b_yes")),
                edge_labeled(4, "condition", "no", Some("b_no")),
                edge_labeled(5, "condition", "end", Some(DEFAULT_EDGE_LABEL)),
            ],
        }
    }

    /// 真值分支走通：命中分支的下游节点执行、其余分支（含 Default 出边
    /// 目标）节点 skipped；产物摘要记录实际表达式与选中分支。
    #[tokio::test]
    async fn condition_true_branch_runs_and_others_skip() {
        let fx = Fixture::new().await;
        let graph = condition_chain_graph("{{login_status}} == 200");
        let workflow_id = fx.seed_workflow("条件真", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED, "{dto:?}");
        for id in ["login", "extract", "condition", "yes"] {
            assert_eq!(node_record(&dto, id).status, STATUS_PASSED, "{id} 应通过");
        }
        assert_eq!(node_status(&dto, "no"), STATUS_SKIPPED, "未选分支 skipped");
        // 产物摘要：实际表达式 → 选中分支 label
        let record = node_record(&dto, "condition");
        assert_eq!(
            record.output.as_deref(),
            Some("✓ {{login_status}} == 200 → b_yes")
        );
        // 事件面：仅选中出边激活（b_yes 边 e3）；未选分支（e4）与 Default
        // 边（e5）不激活；激活集含前置链路（e0–e2）
        let activated: Vec<String> = fx
            .events
            .lock()
            .expect("事件锁")
            .iter()
            .filter(|event| event["event"] == "edge.activated")
            .filter_map(|event| event["edgeId"].as_str())
            .map(str::to_owned)
            .collect();
        assert!(
            activated.contains(&"e3".to_owned())
                && !activated.contains(&"e4".to_owned())
                && !activated.contains(&"e5".to_owned()),
            "只激活命中分支的出边: {activated:?}"
        );
    }

    /// 全不满足走 Default：DEFAULT 出边目标执行、分支节点 skipped、摘要
    /// 记录兜底去向。
    #[tokio::test]
    async fn condition_default_branch_takes_over_when_none_matches() {
        let fx = Fixture::new().await;
        let graph = condition_chain_graph("{{login_status}} == 599");
        let workflow_id = fx.seed_workflow("条件兜底", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED, "{dto:?}");
        assert_eq!(node_status(&dto, "condition"), STATUS_PASSED);
        assert_eq!(
            node_status(&dto, "end"),
            STATUS_PASSED,
            "Default 出边直达 end 并执行"
        );
        assert_eq!(node_status(&dto, "yes"), STATUS_SKIPPED);
        assert_eq!(node_status(&dto, "no"), STATUS_SKIPPED);
        assert_eq!(
            node_record(&dto, "condition").output.as_deref(),
            Some("no branch matched → DEFAULT")
        );
    }

    /// 表达式解析失败＝执行前拦截（expressionInvalid 可定位），不到执行期。
    #[tokio::test]
    async fn condition_malformed_expression_fails_the_node() {
        let fx = Fixture::new().await;
        let graph = condition_chain_graph("{{login_status}} ~~ 200");
        let workflow_id = fx.seed_workflow("条件坏式", &graph).await;
        let err = execute(&fx.ctx(), &workflow_id).await.unwrap_err();
        assert_eq!(err.code, codes::WORKFLOW_NOT_EXECUTABLE);
        let issues = issues_of(&err);
        assert_eq!(issues[0]["code"], "expressionInvalid");
        assert_eq!(issues[0]["nodeId"], "condition");
    }

    /// 条件分支缺出边：分支目标节点变孤立，执行前被孤立项拦截（引擎的
    /// WORKFLOW_BRANCH_EDGE_MISSING fail-fast 保留为纵深防御，不再从
    /// execute 可达）。
    #[tokio::test]
    async fn condition_branch_without_edge_fails_the_node() {
        let fx = Fixture::new().await;
        let mut graph = condition_chain_graph("{{login_status}} == 200");
        graph
            .edges
            .retain(|edge| edge.label.as_deref() != Some("b_yes"));
        let workflow_id = fx.seed_workflow("条件缺边", &graph).await;
        let err = execute(&fx.ctx(), &workflow_id).await.unwrap_err();
        assert_eq!(err.code, codes::WORKFLOW_NOT_EXECUTABLE);
        let issues = issues_of(&err);
        assert_eq!(issues[0]["code"], "orphanNode");
        assert_eq!(issues[0]["nodeId"], "yes");
    }

    /// 对靶机集成：按登录响应状态分支走不同链——登录 200（提取状态码 →
    /// 产物注入）→ 条件命中 yes 分支（healthz）；未选分支 skipped。
    #[tokio::test]
    async fn condition_routes_by_login_status_against_target() {
        let fx = Fixture::new().await;
        let graph = condition_chain_graph("{{login_status}} == 200");
        let workflow_id = fx.seed_workflow("登录分支", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED, "{dto:?}");
        assert_eq!(node_status(&dto, "yes"), STATUS_PASSED, "命中分支下游执行");
        assert_eq!(node_status(&dto, "no"), STATUS_SKIPPED, "另一分支 skipped");
    }

    // —— 上游响应裸键引用（{{status}} / {{body}}）——

    /// 上游引用条件图：Start → 登录请求 → 条件（表达式由调用方注入）→
    /// 两分支各一请求 → End。与 condition_chain_graph 的差别只在：不经过
    /// 提取 / 存变量链，条件直接引用上游请求节点的输出桶（status / body
    /// 裸键）。
    fn upstream_reference_condition_graph(expression: &str) -> WorkflowGraph {
        let login = request_node("login", "GET /healthz");
        WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                login,
                node(
                    "condition",
                    WorkflowNodeConfig::Condition(ConditionNodeConfig {
                        branches: vec![crate::domain::workflow::ConditionBranch {
                            id: "b_yes".into(),
                            expression: expression.to_owned(),
                        }],
                    }),
                ),
                request_node("yes", "GET /healthz"),
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![
                edge(0, "start", "login"),
                edge(1, "login", "condition"),
                edge_labeled(4, "condition", "yes", Some("b_yes")),
                edge_labeled(6, "condition", "end", Some(DEFAULT_EDGE_LABEL)),
            ],
        }
    }

    /// 端到端（对靶机）：条件表达式 `{{status}} == 200` 直接引用上游请求
    /// 节点的输出桶，真实状态码命中分支（不经过提取 / 存变量链）。
    #[tokio::test]
    async fn condition_hits_branch_via_upstream_status_reference() {
        let fx = Fixture::new().await;
        let graph = upstream_reference_condition_graph("{{status}} == 200");
        let workflow_id = fx.seed_workflow("名引用状态", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED, "{dto:?}");
        assert_eq!(node_status(&dto, "condition"), STATUS_PASSED);
        assert_eq!(
            node_record(&dto, "condition").output.as_deref(),
            Some("✓ {{status}} == 200 → b_yes"),
            "引用真实上游节点状态码命中分支"
        );
        assert_eq!(node_status(&dto, "yes"), STATUS_PASSED);
        assert_eq!(
            node_status(&dto, "end"),
            STATUS_SKIPPED,
            "DEFAULT 出边未走，end 留 skipped 痕"
        );
    }

    /// 端到端：body 字段引用（响应原文 contains 判定）同样命中。
    #[tokio::test]
    async fn condition_hits_branch_via_upstream_body_reference() {
        let fx = Fixture::new().await;
        let graph = upstream_reference_condition_graph("{{body}} contains ok");
        let workflow_id = fx.seed_workflow("名引用原文", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED, "{dto:?}");
        assert_eq!(node_status(&dto, "yes"), STATUS_PASSED, "body 引用命中分支");
    }

    /// 端到端：引用键无上游产出（`{{ghost.status}}` 首段 ghost 不在产出
    /// 集）＝静态不报、运行时按既有变量缺失语义求值（不命中 → DEFAULT
    /// 兜底）。
    #[tokio::test]
    async fn non_producing_reference_runs_to_default() {
        let fx = Fixture::new().await;
        let graph = upstream_reference_condition_graph("{{ghost.status}} == 200");
        let workflow_id = fx.seed_workflow("引用断裂", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED, "缺失引用不拦截运行: {dto:?}");
        assert_eq!(
            node_record(&dto, "condition").output.as_deref(),
            Some("no branch matched → DEFAULT"),
            "缺失引用不命中分支，走兜底出口"
        );
        assert_eq!(node_status(&dto, "end"), STATUS_PASSED, "经 DEFAULT 到 end");
        assert_eq!(node_status(&dto, "yes"), STATUS_SKIPPED);
    }

    // —— 延时 ——

    /// 延时生效：节点 passed 且整流耗时 ≥ 配置延时。
    #[tokio::test]
    async fn delay_node_waits_configured_duration() {
        let fx = Fixture::new().await;
        let graph = WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                node(
                    "delay",
                    WorkflowNodeConfig::Delay(DelayNodeConfig { duration_ms: 300 }),
                ),
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![edge(0, "start", "delay"), edge(1, "delay", "end")],
        };
        let workflow_id = fx.seed_workflow("延时", &graph).await;
        let dto = execute(&fx.ctx(), &workflow_id).await.unwrap();
        assert_eq!(dto.status, STATUS_PASSED);
        assert_eq!(node_status(&dto, "delay"), STATUS_PASSED);
        assert!(
            dto.duration_ms.unwrap_or(0) >= 300,
            "整流耗时应 ≥ 延时配置: {:?}",
            dto.duration_ms
        );
        assert_eq!(node_record(&dto, "delay").output.as_deref(), Some("300 ms"));
    }

    /// 延时期间取消：延时节点 cancelled、工作流 cancelled。
    #[tokio::test]
    async fn delay_node_cancellation_interrupts_wait() {
        let fx = Fixture::new().await;
        let graph = WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                node(
                    "delay",
                    WorkflowNodeConfig::Delay(DelayNodeConfig {
                        duration_ms: 30_000,
                    }),
                ),
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![edge(0, "start", "delay"), edge(1, "delay", "end")],
        };
        let workflow_id = fx.seed_workflow("延时取消", &graph).await;
        let ctx = fx.ctx();
        let execution = execute(&ctx, &workflow_id);
        tokio::pin!(execution);
        let dto = tokio::select! {
            result = &mut execution => result.unwrap(),
            _ = tokio::time::sleep(Duration::from_millis(300)) => {
                fx.registry.cancel(&crate::services::workflow_engine::workflow_task_key(
                    &workflow_id,
                ));
                execution.await.unwrap()
            }
        };
        assert_eq!(dto.status, crate::domain::workflow_execution::STATUS_CANCELLED);
        assert_eq!(
            node_status(&dto, "delay"),
            crate::domain::workflow_execution::STATUS_CANCELLED
        );
        assert_eq!(node_status(&dto, "end"), STATUS_SKIPPED);
    }
}
