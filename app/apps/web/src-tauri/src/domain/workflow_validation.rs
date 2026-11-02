//! 工作流执行前校验器：图结构与节点配置判定项的 domain 纯函数核。
//!
//! GUI 与 CLI validate 共用的单一实现（Core 单点，无第二份校验逻辑）：
//! 图结构判定（Start / 孤立节点 / 非法边 / 循环 / Condition Default /
//! Parallel 分支 / Join 上游）在本文件完成；请求引用的有效性是解析派生
//! 面，由 service 层预取稳定键解析结果注入（[`EndpointResolution`]），
//! domain 不触库。校验不短路——全部问题一次列出，错误清单 UI 全量呈现。
//!
//! 保存不做校验（半成品可留）：本清单只在执行前拦截与编辑器错误定位面
//! 消费，不是持久化门槛。

use std::collections::HashMap;

use serde::Serialize;

use crate::domain::variable::normalize_variable_key;
use crate::domain::workflow::{
    EdgesIndex, ExtractNodeConfig, ExtractRule, RequestNodeConfig, WorkflowEdge, WorkflowGraph,
    WorkflowNode, WorkflowNodeConfig, node_of_graph,
};
use crate::domain::workflow_condition::{self, DEFAULT_EDGE_LABEL};
use crate::domain::workflow_execution::{
    UpstreamRequestViolation, closed_template_inners, direct_upstream_ids, match_writeback_source,
    node_produces_key, resolve_upstream_request,
};

/// 校验问题（执行前校验的产出条目）：code 是机器词表（前端按 code 走
/// i18n 词典渲染、CLI JSON 原样输出），message 是事实描述（CLI 与日志的
/// 兜底呈现面），node_id 指向定位节点（图级错误 None——缺 Start 无节点
/// 可定位）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowIssue {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    pub message: String,
}

/// 校验问题码词表（camelCase；前端词典键与 CLI 输出共用，词表演进时
/// 前端对未知 code 回落 message 原文渲染）。
pub mod issue_codes {
    pub const MISSING_START: &str = "missingStart";
    pub const ORPHAN_NODE: &str = "orphanNode";
    pub const INVALID_EDGE: &str = "invalidEdge";
    pub const CYCLE: &str = "cycle";
    pub const CONDITION_DEFAULT_MISSING: &str = "conditionDefaultMissing";
    pub const PARALLEL_NO_BRANCH: &str = "parallelNoBranch";
    pub const JOIN_NO_UPSTREAM: &str = "joinNoUpstream";
    pub const REQUEST_UNBOUND: &str = "requestUnbound";
    pub const REQUEST_INVALID_REF: &str = "requestInvalidRef";
    pub const EXPRESSION_INVALID: &str = "expressionInvalid";
    pub const VARIABLE_REF_INVALID: &str = "variableRefInvalid";
    pub const UPSTREAM_NOT_REQUEST: &str = "upstreamNotRequest";
    /// 提取规则集失效：空规则集 / 产物名空白 / 产物名重名（产物的引用键
    /// 缺失或歧义，error 级）
    pub const EXTRACT_ROW_INVALID: &str = "extractRowInvalid";
    /// 提取节点写回分支启用但必要项缺失（分类名 / 值来源），或值来源不
    /// 命中产物名（error 级）
    pub const EXTRACT_WRITEBACK_INCOMPLETE: &str = "extractWritebackIncomplete";
    /// 模板引用在上游节点产出集中歧义（同一键有多个直接上游会产出，
    /// error 级）：引用键为裸键（不带节点名前缀），可见范围＝消费节点的
    /// 入边 source 节点
    pub const NODE_REFERENCE_AMBIGUOUS: &str = "nodeReferenceAmbiguous";
}

/// 非拦截（warning 级）问题码：只进校验清单提示，不拦执行——运行时按
/// 既有变量缺失语义求值。演进约定：新增判定项默认拦截（error 级），仅
/// 显式登记于此的按 warning 处理（现无 warning 级判定项）。
const WARNING_CODES: &[&str] = &[];

/// 问题是否拦截执行（error 级）。执行入口与 CLI 放行判定共用此单点，
/// 与 warning 码词表同源，不出现两套分级口径。
pub fn blocks_execution(code: &str) -> bool {
    !WARNING_CODES.contains(&code)
}

/// 请求引用解析态（service 层预取注入；domain 不触库）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EndpointResolution {
    /// 稳定键在工作空间内唯一命中
    Found,
    /// 无命中（接口被删除 / 同步回归未恢复）
    NotFound,
    /// 多服务撞车（引用纯键无服务维度）
    Ambiguous,
}

/// 执行前校验全清单。产出顺序＝检查序（图级 → 逐边 → 逐节点），清单
/// 呈现保持稳定；endpoint_resolutions 必须覆盖图中全部请求引用键（缺键
/// 视为命中——预取方的契约，不在校验器内误报）。
pub fn validate_workflow(
    graph: &WorkflowGraph,
    endpoint_resolutions: &HashMap<String, EndpointResolution>,
) -> Vec<WorkflowIssue> {
    let mut issues = Vec::new();
    let index = EdgesIndex::new(graph);

    // Start 存在（图级：无节点可定位）
    if !graph
        .nodes
        .iter()
        .any(|node| matches!(node.config, WorkflowNodeConfig::Start))
    {
        issues.push(issue(
            issue_codes::MISSING_START,
            None,
            "workflow has no Start node".to_owned(),
        ));
    }

    // 非法边：端点悬空 / 自环 / Start 入边 / End 出边 / 条件分支标注违例
    for edge in &graph.edges {
        if let Some(message) = invalid_edge_reason(graph, edge) {
            issues.push(issue(
                issue_codes::INVALID_EDGE,
                Some(edge.source.clone()),
                message,
            ));
        }
    }

    // 孤立节点：与任何边都不相连（执行到不了也修不动）
    for node in &graph.nodes {
        if !index.is_connected(&node.id) {
            issues.push(issue(
                issue_codes::ORPHAN_NODE,
                Some(node.id.clone()),
                format!("node is not connected to any edge: {}", node.id),
            ));
        }
    }

    // 循环：执行核的推进语义遇环不终止（Loop 节点未在词表），直接拦截
    if let Some(node_id) = find_cycle(graph, &index) {
        issues.push(issue(
            issue_codes::CYCLE,
            Some(node_id),
            "workflow graph contains a cycle".to_owned(),
        ));
    }

    // 逐节点判定（顺序随图节点序，清单稳定）
    for node in &graph.nodes {
        match &node.config {
            WorkflowNodeConfig::Condition(config) => {
                // Default 兜底出口恒必有：全不满足时引擎无处可去
                if index
                    .outgoing_labeled(&node.id, DEFAULT_EDGE_LABEL)
                    .is_none()
                {
                    issues.push(issue(
                        issue_codes::CONDITION_DEFAULT_MISSING,
                        Some(node.id.clone()),
                        format!(
                            "condition node has no {} outgoing edge: {}",
                            DEFAULT_EDGE_LABEL, node.id
                        ),
                    ));
                }
                // 分支表达式可解析（无变量上下文求值——变量缺失是执行期
                // 态不判错，这里只拦语法结构）
                for branch in &config.branches {
                    if let Err(err) =
                        workflow_condition::evaluate_expression(&branch.expression, &|_| None)
                    {
                        issues.push(issue(
                            issue_codes::EXPRESSION_INVALID,
                            Some(node.id.clone()),
                            format!("condition expression cannot be parsed: {err}"),
                        ));
                    }
                }
            }
            WorkflowNodeConfig::Parallel => {
                if index.outgoing_of(&node.id).is_empty() {
                    issues.push(issue(
                        issue_codes::PARALLEL_NO_BRANCH,
                        Some(node.id.clone()),
                        format!("parallel node has no outgoing branches: {}", node.id),
                    ));
                }
            }
            WorkflowNodeConfig::Join(_) => {
                if index.first_incoming(&node.id).is_none() {
                    issues.push(issue(
                        issue_codes::JOIN_NO_UPSTREAM,
                        Some(node.id.clone()),
                        format!("join node references no branch: {}", node.id),
                    ));
                }
            }
            WorkflowNodeConfig::Request(config) => {
                match &config.endpoint_key {
                    None => issues.push(issue(
                        issue_codes::REQUEST_UNBOUND,
                        Some(node.id.clone()),
                        format!("request node is not bound to an endpoint: {}", node.id),
                    )),
                    Some(key) => match endpoint_resolutions.get(key) {
                        Some(EndpointResolution::NotFound) => issues.push(issue(
                            issue_codes::REQUEST_INVALID_REF,
                            Some(node.id.clone()),
                            format!("referenced endpoint not found: {key}"),
                        )),
                        Some(EndpointResolution::Ambiguous) => issues.push(issue(
                            issue_codes::REQUEST_INVALID_REF,
                            Some(node.id.clone()),
                            format!("referenced endpoint is ambiguous across services: {key}"),
                        )),
                        _ => {}
                    },
                }
                // 变量引用合法（覆写值与 body 的 {{name}} 模板）
                for message in invalid_template_ref_messages(config) {
                    issues.push(issue(
                        issue_codes::VARIABLE_REF_INVALID,
                        Some(node.id.clone()),
                        message,
                    ));
                }
            }
            WorkflowNodeConfig::Extract(config) => {
                // 上游必须是请求节点（响应的唯一产出口）
                if let Some(message) = upstream_request_violation(graph, &node.id) {
                    issues.push(issue(
                        issue_codes::UPSTREAM_NOT_REQUEST,
                        Some(node.id.clone()),
                        message,
                    ));
                }
                // 规则集判定：空规则集即无产物可产（引用与写回全空转）
                if config.rules.is_empty() {
                    issues.push(issue(
                        issue_codes::EXTRACT_ROW_INVALID,
                        Some(node.id.clone()),
                        format!("extract node has no extraction rule: {}", node.id),
                    ));
                }
                // 产物名判定：逐规则空白名即产物的引用键缺失；节点内非空
                // 产物名重名即引用歧义（空名已单独报，不进重复判定，节点级
                // 单条报告——message 不区分具体规则）
                let mut seen_names: Vec<&str> = Vec::new();
                let mut has_duplicate = false;
                for rule in &config.rules {
                    let name = rule.name.trim();
                    if name.is_empty() {
                        issues.push(issue(
                            issue_codes::EXTRACT_ROW_INVALID,
                            Some(node.id.clone()),
                            format!("extract node has an empty product name: {}", node.id),
                        ));
                    } else if seen_names.contains(&name) {
                        has_duplicate = true;
                    } else {
                        seen_names.push(name);
                    }
                }
                if has_duplicate {
                    issues.push(issue(
                        issue_codes::EXTRACT_ROW_INVALID,
                        Some(node.id.clone()),
                        format!("extract node has duplicate product names: {}", node.id),
                    ));
                }
                // 写回分支必要项（启用才判：分类名 / 变量键 / 值来源齐备且
                // 值来源命中任一规则产物名）
                for message in incomplete_writeback_messages(config) {
                    issues.push(issue(
                        issue_codes::EXTRACT_WRITEBACK_INCOMPLETE,
                        Some(node.id.clone()),
                        message,
                    ));
                }
            }
            WorkflowNodeConfig::Assert(_) => {
                // 断言的上游必须是请求节点（响应的唯一产出口）
                if let Some(message) = upstream_request_violation(graph, &node.id) {
                    issues.push(issue(
                        issue_codes::UPSTREAM_NOT_REQUEST,
                        Some(node.id.clone()),
                        message,
                    ));
                }
            }
            WorkflowNodeConfig::Start
            | WorkflowNodeConfig::End
            | WorkflowNodeConfig::Delay(_)
            | WorkflowNodeConfig::Retry(_) => {}
        }

        // 模板引用的上游歧义判定（连线作用域的静态近似）：引用键为裸键，
        // 可见范围＝本节点入边 source 节点的输出桶并集——同一键有两个不
        // 同直接上游会产出即歧义（error，拦截执行）；命中 0 或 1 不报，
        // 单段可能是普通变量、多段可能是点号变量键的深层钻取，静态不可
        // 判定，交运行时既有变量缺失语义
        issues.extend(ambiguous_reference_issues(graph, node));
    }

    issues
}

/// 单条问题的统一构造点（code 词表收敛在常量，避免散落字符串）。
fn issue(code: &str, node_id: Option<String>, message: String) -> WorkflowIssue {
    WorkflowIssue {
        code: code.to_owned(),
        node_id,
        message,
    }
}

/// 提取节点写回分支的必要项（启用才判）：分类名 / 值来源逐项缺失分条
/// 描述；值来源（产物名，可带深层字段路径）不命中本节点任一规则产物名
/// 同样拦截。变量键不在清单（UI 已退场键槽位，读侧按写回值尾段补齐）。
/// 全局分类不可作写回目标属执行期判定面（分类是否全局需查库），不在本
/// 清单。
fn incomplete_writeback_messages(config: &ExtractNodeConfig) -> Vec<String> {
    let writeback = &config.writeback;
    if !writeback.enabled {
        return Vec::new();
    }
    let mut messages = Vec::new();
    if writeback
        .category_name
        .as_deref()
        .map_or(true, |name| name.trim().is_empty())
    {
        messages.push("extract writeback is enabled without a category name".to_owned());
    }
    if !writeback_product_resolves(&config.rules, &writeback.product_path) {
        messages.push(format!(
            "extract writeback source does not match any product name: {}",
            writeback.product_path
        ));
    }
    messages
}

/// 写回值来源是否命中本节点任一规则产物名：命中判定走
/// [`crate::domain::workflow_execution::match_writeback_source`] 单点（与
/// 引擎求值同一口径）。
fn writeback_product_resolves(rules: &[ExtractRule], product_path: &str) -> bool {
    let names: Vec<&str> = rules.iter().map(|rule| rule.name.as_str()).collect();
    match_writeback_source(&names, product_path).is_some()
}

/// 上游请求节点判定（Extract / Assert 共用：响应的唯一产出口）。判定走
/// [`crate::domain::workflow_execution::resolve_upstream_request`] 单点
/// （与引擎执行同一口径）；合法＝None；违规＝错误信息（无上游与上游非
/// 请求分列措辞）。
fn upstream_request_violation(graph: &WorkflowGraph, node_id: &str) -> Option<String> {
    match resolve_upstream_request(graph, node_id) {
        Ok(_) => None,
        Err(UpstreamRequestViolation::NotRequest(_)) => Some(format!(
            "upstream of node must be a request node: {node_id}"
        )),
        Err(UpstreamRequestViolation::NoUpstream) => Some(format!(
            "node has no upstream request node: {node_id}"
        )),
    }
}

/// 边合法性判定（None＝合法；Some＝违规描述）。
fn invalid_edge_reason(graph: &WorkflowGraph, edge: &WorkflowEdge) -> Option<String> {
    let source = node_of_graph(graph, edge.source.as_str());
    let target = node_of_graph(graph, edge.target.as_str());
    let (Some(source), Some(target)) = (source, target) else {
        return Some(format!("edge connects a missing node: {}", edge.id));
    };
    if edge.source == edge.target {
        return Some(format!("edge is a self loop: {}", edge.id));
    }
    if matches!(target.config, WorkflowNodeConfig::Start) {
        return Some(format!(
            "Start node cannot have incoming edges: {}",
            edge.id
        ));
    }
    if matches!(source.config, WorkflowNodeConfig::End) {
        return Some(format!("End node cannot have outgoing edges: {}", edge.id));
    }
    match &source.config {
        // 条件出边必须标注分支（引擎按 label 定位选中分支，无标注的边
        // 永远选不中且会干扰分支枚举）；label 必须命中分支 id 或 DEFAULT
        WorkflowNodeConfig::Condition(config) => {
            let label_ok = match edge.label.as_deref() {
                Some(DEFAULT_EDGE_LABEL) => true,
                Some(branch_id) => config.branches.iter().any(|branch| branch.id == branch_id),
                None => false,
            };
            if !label_ok {
                return Some(format!(
                    "condition edge label does not match any branch or {DEFAULT_EDGE_LABEL}: {}",
                    edge.id
                ));
            }
        }
        // 非条件节点的出边不参与分支语义，带标注即漂移
        _ if edge.label.is_some() => {
            return Some(format!(
                "only condition nodes may label outgoing edges: {}",
                edge.id
            ));
        }
        _ => {}
    }
    None
}

/// 有向环检测（白灰黑 DFS；返回环上任一节点 id）。首个发现的环即报告，
/// 不逐环刷屏——修复后重跑校验自然暴露其余环。
fn find_cycle(graph: &WorkflowGraph, index: &EdgesIndex<'_>) -> Option<String> {
    #[derive(Clone, Copy, PartialEq)]
    enum Color {
        White,
        Gray,
        Black,
    }
    let mut color: HashMap<&str, Color> = graph
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), Color::White))
        .collect();

    fn visit<'a>(
        id: &'a str,
        graph: &'a WorkflowGraph,
        color: &mut HashMap<&'a str, Color>,
        index: &EdgesIndex<'a>,
    ) -> Option<String> {
        color.insert(id, Color::Gray);
        for edge in index.outgoing_of(id) {
            // 自环 / Start 入边 / End 出边已由非法边项覆盖，不重复计入
            // 环检测（三类边参与的环必然伴随对应非法边条目，排除不漏报）
            if edge.source == edge.target
                || matches!(
                    node_of_graph(graph, edge.source.as_str()).map(|n| &n.config),
                    Some(WorkflowNodeConfig::End)
                )
                || matches!(
                    node_of_graph(graph, edge.target.as_str()).map(|n| &n.config),
                    Some(WorkflowNodeConfig::Start)
                )
            {
                continue;
            }
            match color.get(edge.target.as_str()) {
                Some(Color::Gray) => return Some(edge.target.clone()),
                Some(Color::White) => {
                    if let Some(found) = visit(edge.target.as_str(), graph, color, index) {
                        return Some(found);
                    }
                }
                Some(Color::Black) => {}
                None => {}
            }
        }
        color.insert(id, Color::Black);
        None
    }

    for node in &graph.nodes {
        if color.get(node.id.as_str()) == Some(&Color::White)
            && let Some(found) = visit(node.id.as_str(), graph, &mut color, index)
        {
            return Some(found);
        }
    }
    None
}

/// 请求节点配置内的模板引用检查：覆写行值与 body 中每个闭合 `{{...}}`
/// 的名字必须过变量键规则（空名 / 超长即配置错误；未闭合按 resolver 口径
/// 是字面文本不判错）。返回违规描述列表（一模板一条）。
fn invalid_template_ref_messages(config: &RequestNodeConfig) -> Vec<String> {
    let mut texts: Vec<&str> = config
        .query
        .iter()
        .chain(config.path_params.iter())
        .map(|row| row.value.as_str())
        .collect();
    if let Some(body) = &config.body {
        texts.push(body);
    }
    let mut messages = Vec::new();
    for text in texts {
        for name in invalid_template_names(text) {
            messages.push(format!("invalid variable reference: {{{{{name}}}}}"));
        }
    }
    messages
}

/// 扫描文本中名字不合法的闭合模板（name 收集 trim 后原文，供描述回显）。
/// 闭合模板的扫描走 [`closed_template_inners`] 单点（与引擎 / resolver
/// 的「未闭合按字面」口径同源）。
fn invalid_template_names(text: &str) -> Vec<String> {
    closed_template_inners(text)
        .into_iter()
        .filter(|inner| normalize_variable_key(inner.trim()).is_err())
        // 回显模板原文（trim 前的内部段），描述与用户输入一致
        .map(str::to_owned)
        .collect()
}

/// 节点配置中可携带 `{{...}}` 引用的模板文本：条件分支表达式与请求
/// 节点的覆写值 / body。其余节点类型不携带模板文本，不参与引用判定。
fn node_reference_templates(node: &WorkflowNode) -> Vec<&str> {
    match &node.config {
        WorkflowNodeConfig::Condition(config) => config
            .branches
            .iter()
            .map(|branch| branch.expression.as_str())
            .collect(),
        WorkflowNodeConfig::Request(config) => {
            let mut texts: Vec<&str> = config
                .query
                .iter()
                .chain(config.path_params.iter())
                .map(|row| row.value.as_str())
                .collect();
            if let Some(body) = &config.body {
                texts.push(body);
            }
            texts
        }
        _ => Vec::new(),
    }
}

/// 扫描文本中闭合 `{{...}}` 的模板名（trim 后原文，供判定与描述回显）。
/// 闭合模板的扫描走 [`closed_template_inners`] 单点（未闭合按字面不判）。
fn template_tokens(text: &str) -> Vec<String> {
    closed_template_inners(text)
        .into_iter()
        .map(|inner| inner.trim().to_owned())
        .collect()
}

/// 上游节点会产出的键集是否覆盖给定裸键：判定走
/// [`crate::domain::workflow_execution::node_produces_key`] 单点（与引擎
/// 注入侧的桶键形态同一实现——请求节点产出 status / body，提取节点产出
/// 规则产物名集；引擎写入面见 workflow_engine 的请求输出条目与提取产物
/// 注入）。
fn upstream_produces(node: &WorkflowNode, key: &str) -> bool {
    node_produces_key(&node.config, key)
}

/// 模板引用的上游歧义判定：每个闭合模板名取首段（首个点前，trim）在
/// 本节点入边 source 节点（按图边序去重，平行边不重复计数）中统计会产出
/// 该键的节点数，命中 ≥2 即歧义（每模板一条，message 回显模板名原文）。
/// 空首段（`{{.x}}` 形态）不判定。
fn ambiguous_reference_issues(graph: &WorkflowGraph, node: &WorkflowNode) -> Vec<WorkflowIssue> {
    // 直接上游收集走 domain 单点（与引擎可见层同一连线作用域口径）
    let upstream_ids: Vec<&str> = direct_upstream_ids(graph, &node.id);
    let mut issues = Vec::new();
    for text in node_reference_templates(node) {
        for token in template_tokens(text) {
            let head = token.split('.').next().map(str::trim).unwrap_or("");
            if head.is_empty() {
                continue;
            }
            let producers = upstream_ids
                .iter()
                .filter(|id| {
                    node_of_graph(graph, id)
                        .map(|upstream| upstream_produces(upstream, head))
                        .unwrap_or(false)
                })
                .count();
            if producers >= 2 {
                issues.push(issue(
                    issue_codes::NODE_REFERENCE_AMBIGUOUS,
                    Some(node.id.clone()),
                    format!("reference is ambiguous among upstream nodes: {{{{{token}}}}}"),
                ));
            }
        }
    }
    issues
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::workflow::{
        ConditionBranch, ConditionNodeConfig, ExtractRule, ExtractWriteback, RequestNodeConfig,
        WorkflowNode,
    };

    fn node(id: &str, config: WorkflowNodeConfig) -> WorkflowNode {
        WorkflowNode {
            id: id.to_owned(),
            name: String::new(),
            position: crate::domain::workflow::Position { x: 0.0, y: 0.0 },
            config,
        }
    }

    fn edge(id: &str, source: &str, target: &str) -> WorkflowEdge {
        edge_labeled(id, source, target, None)
    }

    fn edge_labeled(id: &str, source: &str, target: &str, label: Option<&str>) -> WorkflowEdge {
        WorkflowEdge {
            id: id.to_owned(),
            source: source.to_owned(),
            target: target.to_owned(),
            label: label.map(str::to_owned),
        }
    }

    /// 健全基线图：Start → 请求 → 提取（带写回分支）→ End 主链，请求同时
    /// 供断言消费（断言上游恒为请求节点，校验全绿）。
    fn healthy_graph() -> WorkflowGraph {
        WorkflowGraph {
            schema_version: crate::domain::workflow::GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                node(
                    "req",
                    WorkflowNodeConfig::Request(RequestNodeConfig {
                        endpoint_key: Some("GET /healthz".into()),
                        ..Default::default()
                    }),
                ),
                node(
                    "extract",
                    WorkflowNodeConfig::Extract(ExtractNodeConfig {
                        source: crate::domain::workflow::ExtractSource::JsonPath,
                        rules: vec![ExtractRule {
                            path: "$.data.token".into(),
                            name: "token".into(),
                        }],
                        writeback: ExtractWriteback {
                            enabled: true,
                            product_path: "token".into(),
                            key: "token".into(),
                            category_name: Some("登录态".into()),
                            secret: true,
                        },
                    }),
                ),
                node(
                    "assert",
                    WorkflowNodeConfig::Assert(crate::domain::workflow::AssertNodeConfig {
                        rules: vec![],
                    }),
                ),
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![
                edge("e1", "start", "req"),
                edge("e2", "req", "extract"),
                edge("e3", "extract", "end"),
                edge("e4", "req", "assert"),
                edge("e5", "assert", "end"),
            ],
        }
    }

    fn resolutions(keys: &[(&str, EndpointResolution)]) -> HashMap<String, EndpointResolution> {
        keys.iter()
            .map(|(key, resolution)| (key.to_string(), resolution.clone()))
            .collect()
    }

    fn codes_of(issues: &[WorkflowIssue]) -> Vec<&str> {
        // code 词表收敛在常量：比对走常量面而非散字符串
        issues
            .iter()
            .map(|issue| match issue.code.as_str() {
                issue_codes::MISSING_START => "missingStart",
                issue_codes::ORPHAN_NODE => "orphanNode",
                issue_codes::INVALID_EDGE => "invalidEdge",
                issue_codes::CYCLE => "cycle",
                issue_codes::CONDITION_DEFAULT_MISSING => "conditionDefaultMissing",
                issue_codes::PARALLEL_NO_BRANCH => "parallelNoBranch",
                issue_codes::JOIN_NO_UPSTREAM => "joinNoUpstream",
                issue_codes::REQUEST_UNBOUND => "requestUnbound",
                issue_codes::REQUEST_INVALID_REF => "requestInvalidRef",
                issue_codes::EXPRESSION_INVALID => "expressionInvalid",
                issue_codes::VARIABLE_REF_INVALID => "variableRefInvalid",
                issue_codes::UPSTREAM_NOT_REQUEST => "upstreamNotRequest",
                issue_codes::EXTRACT_ROW_INVALID => "extractRowInvalid",
                issue_codes::EXTRACT_WRITEBACK_INCOMPLETE => "extractWritebackIncomplete",
                issue_codes::NODE_REFERENCE_AMBIGUOUS => "nodeReferenceAmbiguous",
                other => unreachable!("未收录的校验码: {other}"),
            })
            .collect()
    }

    #[test]
    fn healthy_graph_has_no_issues() {
        let issues = validate_workflow(
            &healthy_graph(),
            &resolutions(&[("GET /healthz", EndpointResolution::Found)]),
        );
        assert!(issues.is_empty(), "健全图不应有校验问题: {issues:?}");
    }

    #[test]
    fn missing_start_has_no_node_anchor() {
        let mut graph = healthy_graph();
        graph
            .nodes
            .retain(|node| !matches!(node.config, WorkflowNodeConfig::Start));
        graph.edges.retain(|edge| edge.source != "start");
        let issues = validate_workflow(
            &graph,
            &resolutions(&[("GET /healthz", EndpointResolution::Found)]),
        );
        assert_eq!(codes_of(&issues), vec!["missingStart"]);
        assert_eq!(issues[0].node_id, None, "缺 Start 无节点可定位");
    }

    #[test]
    fn orphan_node_is_reported() {
        let mut graph = healthy_graph();
        graph.nodes.push(node(
            "lost",
            WorkflowNodeConfig::Delay(crate::domain::workflow::DelayNodeConfig { duration_ms: 1 }),
        ));
        let issues = validate_workflow(
            &graph,
            &resolutions(&[("GET /healthz", EndpointResolution::Found)]),
        );
        assert_eq!(codes_of(&issues), vec!["orphanNode"]);
        assert_eq!(issues[0].node_id.as_deref(), Some("lost"));
    }

    #[test]
    fn dangling_edge_end_outgoing_and_start_incoming_are_invalid_edges() {
        let mut graph = healthy_graph();
        // 端点悬空
        graph.edges.push(edge("bad1", "start", "ghost"));
        // End 出边（目标为真实节点，避免与悬空项混叠）
        graph.nodes.push(node("sink", WorkflowNodeConfig::End));
        graph.edges.push(edge("bad2", "end", "sink"));
        // Start 入边
        graph.edges.push(edge("bad3", "req", "start"));
        // 自环
        graph.edges.push(edge("bad4", "req", "req"));
        let issues = validate_workflow(
            &graph,
            &resolutions(&[("GET /healthz", EndpointResolution::Found)]),
        );
        assert_eq!(codes_of(&issues), vec!["invalidEdge"; 4]);
        assert_eq!(
            issues[0].node_id.as_deref(),
            Some("start"),
            "定位到边 source"
        );
    }

    #[test]
    fn condition_edge_label_rules() {
        let condition = WorkflowNodeConfig::Condition(ConditionNodeConfig {
            branches: vec![ConditionBranch {
                id: "b1".into(),
                expression: "{{a}} == 1".into(),
            }],
        });
        let graph = WorkflowGraph {
            schema_version: crate::domain::workflow::GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                node("cond", condition),
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![
                edge_labeled("e1", "start", "cond", None),
                // 缺 DEFAULT 出边
                edge_labeled("e2", "cond", "end", Some("b1")),
            ],
        };
        let issues = validate_workflow(&graph, &resolutions(&[]));
        assert_eq!(codes_of(&issues), vec!["conditionDefaultMissing"]);

        // label 不命中任何分支
        let graph = WorkflowGraph {
            edges: vec![
                edge("e1", "start", "cond"),
                edge_labeled("e2", "cond", "end", Some("DEFAULT")),
                edge_labeled("e3", "cond", "end", Some("ghost")),
            ],
            ..graph
        };
        let issues = validate_workflow(&graph, &resolutions(&[]));
        assert_eq!(codes_of(&issues), vec!["invalidEdge"]);
        assert_eq!(issues[0].node_id.as_deref(), Some("cond"));
    }

    #[test]
    fn unlabeled_condition_edge_and_labeled_plain_edge_are_invalid() {
        let condition = WorkflowNodeConfig::Condition(ConditionNodeConfig { branches: vec![] });
        let graph = WorkflowGraph {
            schema_version: crate::domain::workflow::GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                node("cond", condition),
                node("end", WorkflowNodeConfig::End),
            ],
            // 条件出边缺 label（DEFAULT 之外）＋普通出边带 label
            edges: vec![
                edge_labeled("e1", "start", "cond", None),
                edge("e2", "cond", "end"),
                edge_labeled("e3", "cond", "end", Some("DEFAULT")),
            ],
        };
        // e2 缺 label → invalidEdge（注意 e3 同时补齐 DEFAULT，无 defaultMissing）
        let issues = validate_workflow(&graph, &resolutions(&[]));
        assert_eq!(codes_of(&issues), vec!["invalidEdge"]);

        let graph = WorkflowGraph {
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                node("plain", WorkflowNodeConfig::Parallel),
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![
                edge("e1", "start", "plain"),
                edge_labeled("e2", "plain", "end", Some("x")),
            ],
            ..WorkflowGraph::empty()
        };
        let issues = validate_workflow(&graph, &resolutions(&[]));
        // plain 有出边即不缺分支（出边非法归 invalidEdge，不叠加 parallelNoBranch）
        assert_eq!(codes_of(&issues), vec!["invalidEdge"]);
    }

    #[test]
    fn cycle_is_detected() {
        let graph = WorkflowGraph {
            schema_version: crate::domain::workflow::GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                node("a", WorkflowNodeConfig::Parallel),
                node("b", WorkflowNodeConfig::Parallel),
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![
                edge("e1", "start", "a"),
                edge("e2", "a", "b"),
                edge("e3", "b", "a"),
                edge("e4", "b", "end"),
            ],
        };
        let issues = validate_workflow(&graph, &resolutions(&[]));
        assert_eq!(codes_of(&issues), vec!["cycle"]);
        assert_eq!(issues[0].node_id.as_deref(), Some("a"), "报告环上节点");
    }

    #[test]
    fn parallel_without_branch_and_join_without_upstream() {
        let graph = WorkflowGraph {
            schema_version: crate::domain::workflow::GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                node("par", WorkflowNodeConfig::Parallel),
                node(
                    "join",
                    WorkflowNodeConfig::Join(crate::domain::workflow::JoinNodeConfig::default()),
                ),
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![edge("e1", "start", "par"), edge("e2", "join", "end")],
        };
        let issues = validate_workflow(&graph, &resolutions(&[]));
        assert_eq!(
            codes_of(&issues),
            vec!["parallelNoBranch", "joinNoUpstream"]
        );
    }

    #[test]
    fn request_unbound_and_invalid_ref() {
        let mut graph = healthy_graph();
        if let WorkflowNodeConfig::Request(config) = &mut graph.nodes[1].config {
            config.endpoint_key = None;
        }
        let issues = validate_workflow(&graph, &HashMap::new());
        assert_eq!(codes_of(&issues), vec!["requestUnbound"]);

        let mut graph = healthy_graph();
        if let WorkflowNodeConfig::Request(config) = &mut graph.nodes[1].config {
            config.endpoint_key = Some("GET /gone".into());
        }
        let issues = validate_workflow(
            &graph,
            &resolutions(&[("GET /gone", EndpointResolution::NotFound)]),
        );
        assert_eq!(codes_of(&issues), vec!["requestInvalidRef"]);
        assert!(
            issues[0].message.contains("not found"),
            "message 区分失效原因: {issues:?}"
        );

        let issues = validate_workflow(
            &graph,
            &resolutions(&[("GET /gone", EndpointResolution::Ambiguous)]),
        );
        assert_eq!(codes_of(&issues), vec!["requestInvalidRef"]);
        assert!(
            issues[0].message.contains("ambiguous"),
            "message 区分失效原因: {issues:?}"
        );
    }

    #[test]
    fn condition_expression_syntax_is_checked() {
        let condition = WorkflowNodeConfig::Condition(ConditionNodeConfig {
            branches: vec![
                // 语法健全（变量缺失是执行期态，不判错）
                ConditionBranch {
                    id: "b1".into(),
                    expression: "{{status}} == 200".into(),
                },
                // 结构残缺
                ConditionBranch {
                    id: "b2".into(),
                    expression: "== 200".into(),
                },
            ],
        });
        let graph = WorkflowGraph {
            schema_version: crate::domain::workflow::GRAPH_SCHEMA_VERSION,
            nodes: vec![
                node("start", WorkflowNodeConfig::Start),
                node("cond", condition),
                node("end", WorkflowNodeConfig::End),
            ],
            edges: vec![
                edge("e1", "start", "cond"),
                edge_labeled("e2", "cond", "end", Some("DEFAULT")),
            ],
        };
        let issues = validate_workflow(&graph, &resolutions(&[]));
        assert_eq!(codes_of(&issues), vec!["expressionInvalid"]);
        assert_eq!(issues[0].node_id.as_deref(), Some("cond"));
    }

    #[test]
    fn template_refs_with_empty_name_are_invalid() {
        let mut graph = healthy_graph();
        if let WorkflowNodeConfig::Request(config) = &mut graph.nodes[1].config {
            config.path_params = vec![crate::domain::workflow::OverrideRow {
                name: "id".into(),
                value: "Bearer {{ }}".into(),
            }];
            config.query = vec![crate::domain::workflow::OverrideRow {
                name: "q".into(),
                value: "{{token}}".into(),
            }];
            config.body = Some(r#"{"a": "{{ok}}", "b": "{{}}" }"#.into());
        }
        let issues = validate_workflow(
            &graph,
            &resolutions(&[("GET /healthz", EndpointResolution::Found)]),
        );
        // path_params 与 body 各有一个空名模板（`{{ }}` / `{{}}`），逐条报告
        assert_eq!(
            codes_of(&issues),
            vec!["variableRefInvalid", "variableRefInvalid"]
        );
        assert!(
            issues[0].message.contains("{{ }}"),
            "描述回显模板原文: {issues:?}"
        );
    }

    #[test]
    fn upstream_of_extract_and_assert_must_be_request() {
        let mut graph = healthy_graph();
        // 提取的上游改为断言（非请求），断言自身无上游：两类非请求上游
        // 逐一报告
        graph.edges.retain(|edge| {
            edge.id != "e2" && edge.id != "e3" && edge.id != "e4" && edge.id != "e5"
        });
        graph.edges.push(edge("e2x", "assert", "extract"));
        graph.edges.push(edge("e3x", "extract", "end"));
        let issues = validate_workflow(
            &graph,
            &resolutions(&[("GET /healthz", EndpointResolution::Found)]),
        );
        assert_eq!(
            codes_of(&issues),
            vec!["upstreamNotRequest", "upstreamNotRequest"]
        );
        assert_eq!(issues[0].node_id.as_deref(), Some("extract"));
        assert_eq!(issues[1].node_id.as_deref(), Some("assert"));
    }

    /// 提取产物名：逐规则空白即产物的引用键缺失
    #[test]
    fn extract_requires_nonempty_product_name() {
        // 空白产物名（statusCode 源天然无路径，仍须有产物名；写回关闭聚焦
        // 产物名单项）
        let mut graph = healthy_graph();
        if let WorkflowNodeConfig::Extract(config) = &mut graph.nodes[2].config {
            config.source = crate::domain::workflow::ExtractSource::StatusCode;
            config.rules = vec![ExtractRule {
                path: String::new(),
                name: "  ".into(),
            }];
            config.writeback = ExtractWriteback::default();
        }
        let issues = validate_workflow(
            &graph,
            &resolutions(&[("GET /healthz", EndpointResolution::Found)]),
        );
        assert_eq!(codes_of(&issues), vec!["extractRowInvalid"]);

        // 产物名齐备：不报
        let mut graph = healthy_graph();
        if let WorkflowNodeConfig::Extract(config) = &mut graph.nodes[2].config {
            config.source = crate::domain::workflow::ExtractSource::StatusCode;
            config.rules = vec![ExtractRule {
                path: String::new(),
                name: "status".into(),
            }];
            config.writeback = ExtractWriteback::default();
        }
        let issues = validate_workflow(
            &graph,
            &resolutions(&[("GET /healthz", EndpointResolution::Found)]),
        );
        assert!(issues.is_empty(), "产物名齐备不应报: {issues:?}");
    }

    /// 规则集判定：空规则集＝无产物可产（单独拦截）；节点内非空产物名
    /// 重名即引用歧义（空名逐规则单独报，不进重复判定）
    #[test]
    fn extract_rules_empty_and_duplicate_product_names() {
        // 空规则集
        let mut graph = healthy_graph();
        if let WorkflowNodeConfig::Extract(config) = &mut graph.nodes[2].config {
            config.rules.clear();
            config.writeback = ExtractWriteback::default();
        }
        let issues = validate_workflow(
            &graph,
            &resolutions(&[("GET /healthz", EndpointResolution::Found)]),
        );
        assert_eq!(codes_of(&issues), vec!["extractRowInvalid"]);
        assert!(
            issues[0].message.contains("no extraction rule"),
            "空规则集分条描述: {issues:?}"
        );

        // 节点内非空产物名重名：单条报告（message 不区分具体规则）
        let mut graph = healthy_graph();
        if let WorkflowNodeConfig::Extract(config) = &mut graph.nodes[2].config {
            config.rules = vec![
                ExtractRule {
                    path: "$.a".into(),
                    name: "dup".into(),
                },
                ExtractRule {
                    path: "$.b".into(),
                    name: " dup ".into(),
                },
            ];
            config.writeback = ExtractWriteback::default();
        }
        let issues = validate_workflow(
            &graph,
            &resolutions(&[("GET /healthz", EndpointResolution::Found)]),
        );
        assert_eq!(codes_of(&issues), vec!["extractRowInvalid"]);
        assert!(
            issues[0].message.contains("duplicate product names"),
            "重名分条描述: {issues:?}"
        );

        // 空名逐规则单独报且不进重复判定（两空名 → 两条空名问题）
        let mut graph = healthy_graph();
        if let WorkflowNodeConfig::Extract(config) = &mut graph.nodes[2].config {
            config.rules = vec![
                ExtractRule {
                    path: "$.a".into(),
                    name: String::new(),
                },
                ExtractRule {
                    path: "$.b".into(),
                    name: "  ".into(),
                },
            ];
            config.writeback = ExtractWriteback::default();
        }
        let issues = validate_workflow(
            &graph,
            &resolutions(&[("GET /healthz", EndpointResolution::Found)]),
        );
        assert_eq!(codes_of(&issues), vec!["extractRowInvalid"; 2]);
        assert!(
            issues
                .iter()
                .all(|issue| issue.message.contains("empty product name")),
            "空名不混入重复判定: {issues:?}"
        );
    }

    /// 写回分支必要项：启用后分类名 / 值来源缺失与值来源不命中产物名分条
    /// 拦截；关闭或齐备不报。变量键不在清单（读侧按值尾段补齐）
    #[test]
    fn extract_writeback_requires_complete_fields() {
        // 缺分类名与值来源
        let mut graph = healthy_graph();
        if let WorkflowNodeConfig::Extract(config) = &mut graph.nodes[2].config {
            config.writeback.category_name = None;
            config.writeback.product_path = String::new();
        }
        let issues = validate_workflow(
            &graph,
            &resolutions(&[("GET /healthz", EndpointResolution::Found)]),
        );
        assert_eq!(
            codes_of(&issues),
            vec!["extractWritebackIncomplete", "extractWritebackIncomplete"]
        );
        assert!(
            issues[0].message.contains("category name"),
            "分类名缺失分条描述: {issues:?}"
        );
        assert!(
            issues[1].message.contains("product name"),
            "值来源缺失分条描述: {issues:?}"
        );

        // 变量键空白不拦（键槽位已退场，读侧按值尾段补齐）
        let mut graph = healthy_graph();
        if let WorkflowNodeConfig::Extract(config) = &mut graph.nodes[2].config {
            config.writeback.key = "  ".into();
        }
        let issues = validate_workflow(
            &graph,
            &resolutions(&[("GET /healthz", EndpointResolution::Found)]),
        );
        assert!(issues.is_empty(), "变量键空白不应拦: {issues:?}");

        // 值来源不命中产物名（深层路径按前缀判定）
        let mut graph = healthy_graph();
        if let WorkflowNodeConfig::Extract(config) = &mut graph.nodes[2].config {
            config.writeback.product_path = "ghost.field".into();
        }
        let issues = validate_workflow(
            &graph,
            &resolutions(&[("GET /healthz", EndpointResolution::Found)]),
        );
        assert_eq!(codes_of(&issues), vec!["extractWritebackIncomplete"]);

        // 深层来源命中产物名：合法（产物为对象时的 token.字段）
        let mut graph = healthy_graph();
        if let WorkflowNodeConfig::Extract(config) = &mut graph.nodes[2].config {
            config.rules = vec![ExtractRule {
                path: "$.data".into(),
                name: "data".into(),
            }];
            config.writeback.product_path = "data.token".into();
            config.writeback.key = "token".into();
        }
        let issues = validate_workflow(
            &graph,
            &resolutions(&[("GET /healthz", EndpointResolution::Found)]),
        );
        assert!(issues.is_empty(), "深层值来源命中产物名不应报: {issues:?}");

        // 关闭写回：字段缺失不判
        let mut graph = healthy_graph();
        if let WorkflowNodeConfig::Extract(config) = &mut graph.nodes[2].config {
            config.writeback = ExtractWriteback::default();
        }
        let issues = validate_workflow(
            &graph,
            &resolutions(&[("GET /healthz", EndpointResolution::Found)]),
        );
        assert!(issues.is_empty(), "写回关闭不判必要项: {issues:?}");
    }

    /// 写回值来源命中任一规则产物名即合法：全等命中第二条规则的产物名、
    /// 深层路径命中第二条规则的产物名前缀均不报
    #[test]
    fn extract_writeback_resolves_any_rule_product_name() {
        // 值来源全等命中第二条规则的产物名
        let mut graph = healthy_graph();
        if let WorkflowNodeConfig::Extract(config) = &mut graph.nodes[2].config {
            config.rules = vec![
                ExtractRule {
                    path: "$.data".into(),
                    name: "data".into(),
                },
                ExtractRule {
                    path: "$.token".into(),
                    name: "token".into(),
                },
            ];
            config.writeback.product_path = "token".into();
        }
        let issues = validate_workflow(
            &graph,
            &resolutions(&[("GET /healthz", EndpointResolution::Found)]),
        );
        assert!(issues.is_empty(), "命中第二条规则产物名不应报: {issues:?}");

        // 深层值来源按前缀命中第二条规则的产物名
        let mut graph = healthy_graph();
        if let WorkflowNodeConfig::Extract(config) = &mut graph.nodes[2].config {
            config.rules = vec![
                ExtractRule {
                    path: "$.a".into(),
                    name: "a".into(),
                },
                ExtractRule {
                    path: "$.data".into(),
                    name: "data".into(),
                },
            ];
            config.writeback.product_path = "data.token".into();
            config.writeback.key = "token".into();
        }
        let issues = validate_workflow(
            &graph,
            &resolutions(&[("GET /healthz", EndpointResolution::Found)]),
        );
        assert!(issues.is_empty(), "深层命中第二条规则产物名不应报: {issues:?}");
    }

    #[test]
    fn issue_serializes_camel_case_without_null_node_id() {
        let value = serde_json::to_value(WorkflowIssue {
            code: issue_codes::MISSING_START.to_owned(),
            node_id: None,
            message: "workflow has no Start node".into(),
        })
        .unwrap();
        assert_eq!(value["code"], "missingStart");
        assert!(value.get("nodeId").is_none(), "图级问题不携带定位节点字段");
        let value = serde_json::to_value(issue(
            issue_codes::ORPHAN_NODE,
            Some("n1".into()),
            "orphan".into(),
        ))
        .unwrap();
        assert_eq!(value["nodeId"], "n1");
    }

    // —— 模板引用的上游歧义判定（裸键 ＋ 连线作用域）——

    /// 上游引用条件图：Start → 上游请求节点序列（每个从 Start 分出并汇入
    /// 条件）→ 条件（表达式由调用方注入）→ End，条件出边（b0 + DEFAULT）
    /// 齐备。上游 id 由调用方给定，节点统一为 GET /healthz 请求便捷面。
    fn upstream_condition_graph(expressions: &[&str], upstream_ids: &[&str]) -> WorkflowGraph {
        let mut nodes = vec![node("start", WorkflowNodeConfig::Start)];
        let mut edges = Vec::new();
        for (index, id) in upstream_ids.iter().enumerate() {
            edges.push(edge(&format!("s{index}"), "start", id));
            nodes.push(request_upstream(id));
            edges.push(edge(&format!("c{index}"), id, "cond"));
        }
        nodes.push(node(
            "cond",
            WorkflowNodeConfig::Condition(ConditionNodeConfig {
                branches: expressions
                    .iter()
                    .enumerate()
                    .map(|(index, expression)| ConditionBranch {
                        id: format!("b{index}"),
                        expression: (*expression).to_owned(),
                    })
                    .collect(),
            }),
        ));
        nodes.push(node("end", WorkflowNodeConfig::End));
        edges.push(edge_labeled("eb0", "cond", "end", Some("b0")));
        edges.push(edge_labeled("edef", "cond", "end", Some("DEFAULT")));
        WorkflowGraph {
            schema_version: crate::domain::workflow::GRAPH_SCHEMA_VERSION,
            nodes,
            edges,
        }
    }

    /// 请求节点便捷面（GET /healthz，产出 status / body）。
    fn request_upstream(id: &str) -> WorkflowNode {
        node(
            id,
            WorkflowNodeConfig::Request(RequestNodeConfig {
                endpoint_key: Some("GET /healthz".into()),
                ..Default::default()
            }),
        )
    }

    /// 提取节点便捷面（JSONPath 单路径多规则，产物名由调用方给定）。
    fn extract_node(id: &str, products: &[&str]) -> WorkflowNode {
        node(
            id,
            WorkflowNodeConfig::Extract(ExtractNodeConfig {
                source: crate::domain::workflow::ExtractSource::JsonPath,
                rules: products
                    .iter()
                    .map(|name| ExtractRule {
                        path: "$.data".into(),
                        name: (*name).to_owned(),
                    })
                    .collect(),
                writeback: ExtractWriteback::default(),
            }),
        )
    }

    /// 提取上游条件图：Start → req_src → extract（产物名由调用方给定）→
    /// 条件（表达式由调用方注入）→ End，条件出边齐备。
    fn extract_condition_graph(expression: &str, products: &[&str]) -> WorkflowGraph {
        let mut graph = upstream_condition_graph(&[expression], &[]);
        graph.nodes.push(request_upstream("req_src"));
        graph.nodes.push(extract_node("extract", products));
        graph.edges.push(edge("s0", "start", "req_src"));
        graph.edges.push(edge("c0", "req_src", "extract"));
        graph.edges.push(edge("c1", "extract", "cond"));
        graph
    }

    /// 单上游请求节点的裸键引用：status / body 均无问题（命中 1 个产出者）
    #[test]
    fn upstream_status_and_body_references_are_clean() {
        for expression in ["{{status}} == 200", "{{body}} contains ok"] {
            let graph = upstream_condition_graph(&[expression], &["req0"]);
            let issues = validate_workflow(
                &graph,
                &resolutions(&[("GET /healthz", EndpointResolution::Found)]),
            );
            assert!(
                issues.is_empty(),
                "单上游裸键引用不应有问题: {expression} → {issues:?}"
            );
        }
    }

    /// 单上游提取节点的产物引用：深层钻取多段形态同样无问题（首段命中
    /// 产物名即 1 个产出者，不判歧义）
    #[test]
    fn upstream_product_reference_is_clean() {
        let graph = extract_condition_graph("{{data.token}} == 1", &["data"]);
        let issues = validate_workflow(
            &graph,
            &resolutions(&[("GET /healthz", EndpointResolution::Found)]),
        );
        assert!(issues.is_empty(), "产物深层钻取引用不应有问题: {issues:?}");
    }

    /// 双上游同产一键即歧义（error 且拦截执行）：两请求节点同产 status、
    /// 两提取节点同产物名两种形态逐一拦截，message 回显模板名原文
    #[test]
    fn ambiguous_reference_among_two_upstreams_is_error() {
        let resolutions_map = resolutions(&[("GET /healthz", EndpointResolution::Found)]);

        // 两请求上游同产 status
        let graph = upstream_condition_graph(&["{{status}} == 200"], &["req0", "req1"]);
        let issues = validate_workflow(&graph, &resolutions_map);
        assert_eq!(codes_of(&issues), vec!["nodeReferenceAmbiguous"]);
        assert_eq!(issues[0].node_id.as_deref(), Some("cond"));
        assert!(
            issues[0].message.contains("{{status}}"),
            "message 回显模板名: {issues:?}"
        );
        assert!(
            blocks_execution(&issues[0].code),
            "引用歧义是 error，拦截运行"
        );

        // 两提取上游同产物名（各自串在自己的请求节点之后）
        let mut graph = extract_condition_graph("{{token}} == 1", &["token"]);
        graph.nodes.push(request_upstream("req_alt"));
        graph.nodes.push(extract_node("extract_alt", &["token"]));
        graph.edges.push(edge("s1", "start", "req_alt"));
        graph.edges.push(edge("c2", "req_alt", "extract_alt"));
        graph.edges.push(edge("c3", "extract_alt", "cond"));
        let issues = validate_workflow(&graph, &resolutions_map);
        assert_eq!(
            codes_of(&issues),
            vec!["nodeReferenceAmbiguous"],
            "双提取同产物名即歧义: {issues:?}"
        );
    }

    /// 无上游产出引用键不报（0 命中）：键形态静态不可判定，可能是普通
    /// 变量或运行时缺失语义，交执行期求值
    #[test]
    fn non_producing_upstream_reference_is_clean() {
        // 两请求上游（只产 status / body），表达式引用 token：无产出者
        let graph = upstream_condition_graph(&["{{token}} == 1"], &["req0", "req1"]);
        let issues = validate_workflow(
            &graph,
            &resolutions(&[("GET /healthz", EndpointResolution::Found)]),
        );
        assert!(issues.is_empty(), "无上游产出的引用不报: {issues:?}");

        // 单请求上游 + 首段不在产出集的形态：同样不报
        let graph = upstream_condition_graph(&["{{login.statuss}} == 200"], &["req0"]);
        let issues = validate_workflow(
            &graph,
            &resolutions(&[("GET /healthz", EndpointResolution::Found)]),
        );
        assert!(issues.is_empty(), "非产出键形态不误报: {issues:?}");
    }

    /// 跨跳引用不静态报：req3 的上游是 req2（请求节点，不产出 token），
    /// extract1 产物对 req3 不可见（一跳口径），但静态无法区分「跨跳引用」
    /// 与「普通变量」，交运行时既有变量缺失语义
    #[test]
    fn cross_hop_reference_is_not_statically_reported() {
        let mut graph = upstream_condition_graph(&["{{token}} == 1"], &[]);
        // Start → req0(登录) → extract1(token) → req2 → req3(cond 的上游)
        graph.nodes.push(request_upstream("req0"));
        graph.nodes.push(extract_node("extract1", &["token"]));
        graph.nodes.push(request_upstream("req2"));
        graph.nodes.push(request_upstream("req3"));
        graph.edges.push(edge("s0", "start", "req0"));
        graph.edges.push(edge("m1", "req0", "extract1"));
        graph.edges.push(edge("m2", "extract1", "req2"));
        graph.edges.push(edge("m3", "req2", "req3"));
        graph.edges.push(edge("m4", "req3", "cond"));
        let issues = validate_workflow(
            &graph,
            &resolutions(&[("GET /healthz", EndpointResolution::Found)]),
        );
        assert!(issues.is_empty(), "跨跳引用不再静态报: {issues:?}");
    }

    /// 请求节点模板（覆写值 / body）中的引用同样被判定（判定面覆盖全部
    /// 模板槽位）：双请求上游同产 status，覆写行引用即歧义、定位到请求节点
    #[test]
    fn reference_ambiguity_in_request_templates_is_checked() {
        // 条件分支保留一个合法表达式（b0 标注须命中既有分支；cond 的入边
        // 仅 req_probe，{{status}} 命中 1 个产出者不判歧义），歧义面挂在
        // req_probe（双请求上游汇入）的路径覆写行
        let mut graph = upstream_condition_graph(&["{{status}} == 1"], &[]);
        graph.nodes.push(WorkflowNode {
            config: WorkflowNodeConfig::Request(RequestNodeConfig {
                endpoint_key: Some("GET /healthz".into()),
                path_params: vec![crate::domain::workflow::OverrideRow {
                    name: "id".into(),
                    value: "{{status}}".into(),
                }],
                ..Default::default()
            }),
            ..request_upstream("req_probe")
        });
        graph.nodes.push(request_upstream("req0"));
        graph.nodes.push(request_upstream("req1"));
        graph.edges.push(edge("s0", "start", "req0"));
        graph.edges.push(edge("s1", "start", "req1"));
        graph.edges.push(edge("p0", "req0", "req_probe"));
        graph.edges.push(edge("p1", "req1", "req_probe"));
        graph.edges.push(edge("p2", "req_probe", "cond"));
        let issues = validate_workflow(
            &graph,
            &resolutions(&[("GET /healthz", EndpointResolution::Found)]),
        );
        assert_eq!(codes_of(&issues), vec!["nodeReferenceAmbiguous"]);
        assert_eq!(
            issues[0].node_id.as_deref(),
            Some("req_probe"),
            "定位到携带模板的请求节点"
        );
    }

    /// 拦截分级单点：WARNING_CODES 现为空表（全拦截），error 码恒拦截
    #[test]
    fn blocks_execution_splits_warning_from_error_codes() {
        assert!(blocks_execution(issue_codes::NODE_REFERENCE_AMBIGUOUS));
        assert!(blocks_execution(issue_codes::MISSING_START));
        assert!(blocks_execution(issue_codes::ORPHAN_NODE));
    }
}
