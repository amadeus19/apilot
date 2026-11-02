//! 工作流执行记录领域模型：执行是过程数据，与编辑模型（[`super::workflow`]）
//! 严格分离——执行永不改写图。
//!
//! 终态词表与 Run Record 状态词对齐（passed / failed / cancelled）；节点
//! 终态含 skipped（失败与取消传播时未执行节点的留痕）。记录只落终态——
//! 在途状态经事件流实时推送（`workflow:event`），不落库。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::domain::variable::{EffectiveVariable, VariableSource};

/// 执行 / 节点共用终态词（工作流与节点同词表，消费端单一语义）。
pub const STATUS_PASSED: &str = "passed";
pub const STATUS_FAILED: &str = "failed";
pub const STATUS_CANCELLED: &str = "cancelled";
pub const STATUS_SKIPPED: &str = "skipped";

/// 写回清单条目（执行记录面）：写回发生的键、目标分类与敏感标记快照。
/// value 口径随 secret：开＝掩码占位（明文只在执行内流转与库内），关＝
/// 明文（用户声明非敏感的写回如实记录）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WritebackEntry {
    pub key: String,
    pub category_name: String,
    pub secret: bool,
    pub value: String,
}

/// 断言结果条目（执行记录面）：单条规则的实际 vs 期望与判定。actual 按
/// 名单式敏感口径投影——路径尾段键名命中敏感名单（或取值回显本次消费的
/// Secret 值）才掩码，非敏感字符串明文呈现（「期望 vs 实际」并列可见），
/// 布尔 / 数字等标量原样保留（判定依据可见）；状态码天然非敏感明文。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssertionEntry {
    /// 规则类型词：statusCode / jsonPath / exists / contains
    pub rule_kind: String,
    /// JSONPath 定位面（状态码规则无）
    pub path: Option<String>,
    /// 期望值（存在规则无）
    pub expected: Option<String>,
    pub actual: String,
    pub passed: bool,
}

/// 请求节点的请求明细（执行记录面）：方法与最终 URL。URL 在写入时完成
/// Secret 消费值全文替换掩码（不可复原）——记录与事件是展示与输出面，
/// 明文只在执行内变量上下文流转，不进记录。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRequestDetail {
    pub method: String,
    pub url: String,
}

/// 请求节点的响应明细（执行记录面）：状态码与响应体掩码摘要。状态码天然
/// 非敏感明文；响应体按掩码摘要口径（合法 JSON 保留结构与标量、字符串值
/// 一律掩码，非 JSON 为体量说明）——诊断价值与敏感口径并存。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeResponseDetail {
    pub status: u16,
    pub body: String,
}

/// 单节点执行记录（终态行）：状态、起止与耗时、失败错误。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeExecutionRecord {
    pub node_id: String,
    /// passed / failed / skipped / cancelled（[`STATUS_PASSED`] 等常量词）
    pub status: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    /// 节点产物摘要（参数提取取到的值、存变量落键的摘要）。输出面口径：
    /// 按名单式敏感口径投影——JSONPath 产物按路径尾段键名（或 Secret 消费
    /// 值回显）判定敏感才掩码，非敏感产物明文呈现；整包文本产物保守掩码；
    /// 状态码等天然非敏感产物原样呈现。明文值只在执行内变量上下文流转，
    /// 不进记录与事件。
    #[serde(default)]
    pub output: Option<String>,
    /// 请求节点的请求明细（方法＋URL；URL 的 Secret 消费值写时掩码）。
    /// 旧记录无此字段，反序列化回落 None。
    #[serde(default)]
    pub request: Option<NodeRequestDetail>,
    /// 请求节点的响应明细（状态码＋响应体掩码摘要）。旧记录回落 None。
    #[serde(default)]
    pub response: Option<NodeResponseDetail>,
    /// 写回清单（存变量节点写回成功时逐条记录；值按条目敏感标记掩码）
    #[serde(default)]
    pub writebacks: Vec<WritebackEntry>,
    /// 断言结果（断言节点逐规则判定；期望 vs 实际）
    #[serde(default)]
    pub assertions: Vec<AssertionEntry>,
}

/// 工作流执行记录（workflow_executions 行；nodes 经 JSON 序列化存 `nodes_json` 列）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowExecution {
    pub id: String,
    pub workflow_id: String,
    /// passed / failed / cancelled
    pub status: String,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub nodes: Vec<NodeExecutionRecord>,
}

impl WorkflowExecution {
    /// 新执行记录骨架（终态字段空缺，由执行引擎在终态时填充）。
    pub fn started(id: String, workflow_id: String, started_at: String) -> Self {
        Self {
            id,
            workflow_id,
            status: String::new(),
            started_at,
            completed_at: None,
            duration_ms: None,
            error_code: None,
            error_message: None,
            nodes: Vec::new(),
        }
    }
}

/// 执行内变量条目（工作流变量 / 节点输出两层共用的值载体）。不携带来源层
/// 标记——执行内产物的「来源」就是执行本身，不走 VariableSource 的空间
/// 兜底链语义；合成进解析输入时 source 以占位填充（仅解析面消费 key /
/// value / secret，不出任何 DTO）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionVariable {
    pub value: String,
    pub secret: bool,
}

/// 提取产物深层引用的惰性求值（`{{产物名.字段}}` 的取值核心）：键未
/// 命中精确变量时，按点切分从最长前缀起尝试——前缀命中变量键且其值为
/// 合法 JSON 时，其余段作字段路径（点分段：对象按键、数组按下标）求值。
/// 字符串取值去引号，其余标量 / 结构序列化原文。产物名与字段路径的分界
/// 按最长前缀优先（产物名含点也能命中）；无 JSON 前缀命中＝未命中（保持
/// 既有变量缺失语义，模板原样保留）。返回（取值文本，命中前缀键）——
/// 敏感标记等前缀变量的属性由调用方按前缀键回查。请求节点模板解析与
/// 条件表达式求值共用本单点，手写引用自动同享。
pub fn resolve_deep_reference(
    lookup_prefix: &dyn Fn(&str) -> Option<String>,
    key: &str,
) -> Option<(String, String)> {
    let key = key.trim();
    let mut cuts: Vec<usize> = key.match_indices('.').map(|(index, _)| index).collect();
    // 最长前缀优先（切分位置从右往左：prefix 取点前全部，field 取其后）
    cuts.reverse();
    for index in cuts {
        let prefix = key[..index].trim();
        let field = key[index + 1..].trim();
        if prefix.is_empty() || field.is_empty() {
            continue;
        }
        let Some(value) = lookup_prefix(prefix) else {
            continue;
        };
        let Ok(root) = serde_json::from_str::<serde_json::Value>(&value) else {
            continue;
        };
        if let Some(hit) = json_field_value_text_value(&root, field) {
            return Some((hit, prefix.to_owned()));
        }
    }
    None
}

/// JSON 值的深层字段求值（点分段：对象按键、数组按下标；末段为字符串去
/// 引号，其余序列化原文）。供 [`resolve_deep_reference`] 递段与测试。
fn json_field_value_text_value(root: &serde_json::Value, field: &str) -> Option<String> {
    let mut current = root;
    for segment in field.split('.') {
        current = match current {
            serde_json::Value::Object(map) => map.get(segment)?,
            serde_json::Value::Array(items) => {
                let index: usize = segment.parse().ok()?;
                items.get(index)?
            }
            _ => return None,
        };
    }
    Some(match current {
        serde_json::Value::String(text) => text.clone(),
        other => other.to_string(),
    })
}

/// JSON 文本 + 字段路径 → 取值文本（[`resolve_deep_reference`] 的段求值
/// 暴露面：解析器层在自身数据形态上复用同一切分语义时共用）。
pub fn json_field_value_text(root_text: &str, field: &str) -> Option<String> {
    let root = serde_json::from_str::<serde_json::Value>(root_text).ok()?;
    json_field_value_text_value(&root, field.trim())
}

/// 执行内变量解析链合成（`{{变量}}` 求值的输入层序）：
/// **节点输出可见层 ＞ 工作流变量 ＞ 生效变量集**——同名键后铺覆盖先铺
/// （与 [`crate::domain::variable::compose_effective`] 的铺层同法）。执行内
/// 两层由引擎在逐节点执行时现取现写（执行内写回改变变量集时不许缓存整轮）。
///
/// `node_outputs` 是消费节点的可见层：其直接上游节点输出桶按边序并集后的
/// 平铺键值（由引擎在图上就地合成后传入，本函数不感知图）。输出按键字典序
/// 稳定排列（BTreeMap 语义，同名键在层内无冲突）。
pub fn merge_execution_variables(
    effective: Vec<EffectiveVariable>,
    workflow_vars: &BTreeMap<String, ExecutionVariable>,
    node_outputs: &BTreeMap<String, ExecutionVariable>,
) -> Vec<EffectiveVariable> {
    // 铺层顺序＝优先级从低到高：生效变量集 → 工作流变量 → 节点输出
    let mut layered: BTreeMap<String, EffectiveVariable> =
        effective.into_iter().map(|v| (v.key.clone(), v)).collect();
    // source 占位：解析器只消费 key / value / secret，执行内产物不出 DTO
    for (key, entry) in workflow_vars {
        layered.insert(
            key.clone(),
            EffectiveVariable {
                key: key.clone(),
                value: entry.value.clone(),
                secret: entry.secret,
                source: VariableSource::Active,
            },
        );
    }
    for (key, entry) in node_outputs {
        layered.insert(
            key.clone(),
            EffectiveVariable {
                key: key.clone(),
                value: entry.value.clone(),
                secret: entry.secret,
                source: VariableSource::Active,
            },
        );
    }
    layered.into_values().collect()
}

// —— 执行域共享口径单点（引擎注入与校验清单共用的判定核；两侧各自桥
// 接自身数据形态，判定逻辑不出现第二份）——

/// 请求节点输出桶的 `status` 裸键（状态码引用键）。
pub const REQUEST_OUTPUT_STATUS_KEY: &str = "status";

/// 请求节点输出桶的 `body` 裸键（响应原文引用键）。
pub const REQUEST_OUTPUT_BODY_KEY: &str = "body";

/// 节点是否产出给定裸键（引擎注入与校验歧义判定的共享单点）：请求节点
/// 产出 [`REQUEST_OUTPUT_STATUS_KEY`] / [`REQUEST_OUTPUT_BODY_KEY`] 两键；
/// 提取节点产出其规则产物名集（trim 非空）；其余节点不产出。桶键为不带
/// 节点名前缀的裸键，可见性由消费节点的入边（连线作用域）判定。
pub fn node_produces_key(config: &crate::domain::workflow::WorkflowNodeConfig, key: &str) -> bool {
    use crate::domain::workflow::WorkflowNodeConfig as Config;
    match config {
        Config::Request(_) => key == REQUEST_OUTPUT_STATUS_KEY || key == REQUEST_OUTPUT_BODY_KEY,
        Config::Extract(config) => config.rules.iter().any(|rule| rule.name.trim() == key),
        _ => false,
    }
}

/// 写回值来源的产物命中（引擎求值与校验判定的共享单点）：`product_path`
/// （trim）对产物名序列按首条命中——精确全等返回（名，None），
/// `产物名.字段` 前缀命中返回（名，Some(字段路径)）；名字 trim 后空不入
/// 判定。无命中＝None（校验侧拦截、引擎侧兜底 fail-fast）。
pub fn match_writeback_source<'a, 'b>(
    product_names: &'a [&'a str],
    product_path: &'b str,
) -> Option<(&'a str, Option<&'b str>)> {
    let path = product_path.trim();
    if path.is_empty() {
        return None;
    }
    for name in product_names {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        if path == name {
            return Some((name, None));
        }
        if let Some(field) = path.strip_prefix(name).and_then(|rest| rest.strip_prefix('.')) {
            return Some((name, Some(field)));
        }
    }
    None
}

/// 消费节点的直接上游节点 id（连线作用域共享口径）：入边 source 按图边
/// 序去重（平行边不重复计数）。可见层＝各上游节点输出桶的并集（同名键
/// 边序后到覆盖先到，歧义由校验层静态拦截）。
pub fn direct_upstream_ids<'a>(
    graph: &'a crate::domain::workflow::WorkflowGraph,
    node_id: &str,
) -> Vec<&'a str> {
    let mut ids: Vec<&str> = Vec::new();
    for edge in &graph.edges {
        if edge.target == node_id && !ids.contains(&edge.source.as_str()) {
            ids.push(edge.source.as_str());
        }
    }
    ids
}

/// 数据消费节点（提取 / 断言）的上游请求节点解析（引擎执行与校验清单的
/// 共享口径）：入边 source 必须是请求节点（响应的唯一产出口），快照与
/// 记录明细按其节点 id 取。Ok＝上游请求节点；Err＝违规形态（文案由调用
/// 方按自身输出面拼装——校验清单与节点失败错误的措辞各自独立）。
pub fn resolve_upstream_request<'a>(
    graph: &'a crate::domain::workflow::WorkflowGraph,
    node_id: &str,
) -> Result<&'a crate::domain::workflow::WorkflowNode, UpstreamRequestViolation> {
    use crate::domain::workflow::{WorkflowNodeKind, node_of_graph};
    let upstream = graph
        .edges
        .iter()
        .find(|edge| edge.target == node_id)
        .and_then(|edge| node_of_graph(graph, edge.source.as_str()));
    let Some(upstream) = upstream else {
        return Err(UpstreamRequestViolation::NoUpstream);
    };
    if upstream.config.kind() != WorkflowNodeKind::Request {
        return Err(UpstreamRequestViolation::NotRequest(upstream.config.kind()));
    }
    Ok(upstream)
}

/// 上游请求节点约束的违规形态（[`resolve_upstream_request`] 的失败面）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpstreamRequestViolation {
    /// 无入边（上游缺失）
    NoUpstream,
    /// 首条入边 source 不是请求节点（携带实际 kind 供定位文案）
    NotRequest(crate::domain::workflow::WorkflowNodeKind),
}

/// 文本中闭合 `{{...}}` 模板的内部段序列（引用判定的共享扫描口径）：
/// 按出现序返回各闭合模板的内部段原文（未 trim，trim 与键名合法性归调
/// 用方）。未闭合的起始定界不视为模板（余段按字面，与变量 resolver 求值
/// 口径一致——`domain::variable_resolver::resolve_value` 的扫描循环是
/// 同一口径的求值侧实现）。
pub fn closed_template_inners(text: &str) -> Vec<&str> {
    const START: &str = "{{";
    const END: &str = "}}";
    let mut inners = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(START) {
        let after = &rest[start + START.len()..];
        let Some(end) = after.find(END) else {
            break;
        };
        inners.push(&after[..end]);
        rest = &after[end + END.len()..];
    }
    inners
}

#[cfg(test)]
mod tests {
    use super::*;

    fn effective(key: &str, value: &str) -> EffectiveVariable {
        EffectiveVariable {
            key: key.to_owned(),
            value: value.to_owned(),
            secret: false,
            source: VariableSource::Active,
        }
    }

    fn exec_var(value: &str) -> ExecutionVariable {
        ExecutionVariable {
            value: value.to_owned(),
            secret: true,
        }
    }

    #[test]
    fn execution_layers_override_effective_by_priority() {
        let effective = vec![
            effective("token", "from-effective"),
            effective("keep", "base"),
        ];
        let mut workflow_vars = BTreeMap::new();
        workflow_vars.insert("token".to_owned(), exec_var("from-workflow"));
        let mut node_outputs = BTreeMap::new();
        node_outputs.insert("token".to_owned(), exec_var("from-node"));
        let merged = merge_execution_variables(effective, &workflow_vars, &node_outputs);
        let find = |key: &str| {
            merged
                .iter()
                .find(|v| v.key == key)
                .map(|v| v.value.clone())
        };
        // 三层同键：节点输出最高
        assert_eq!(find("token").as_deref(), Some("from-node"));
        // 未被覆盖的生效键原样保留
        assert_eq!(find("keep").as_deref(), Some("base"));
    }

    #[test]
    fn workflow_vars_override_effective_without_node_outputs() {
        let effective = vec![effective("token", "from-effective")];
        let mut workflow_vars = BTreeMap::new();
        workflow_vars.insert("token".to_owned(), exec_var("from-workflow"));
        let merged = merge_execution_variables(effective, &workflow_vars, &BTreeMap::new());
        let token = merged.iter().find(|v| v.key == "token").expect("键必须在");
        assert_eq!(token.value, "from-workflow");
        assert!(token.secret, "执行内变量的 secret 标记随写入口径带出");
    }

    #[test]
    fn empty_layers_fall_back_to_effective() {
        let effective = vec![effective("a", "1")];
        let merged = merge_execution_variables(effective, &BTreeMap::new(), &BTreeMap::new());
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].value, "1");
    }

    /// 点分形态的普通变量键（`名.字段` 可作变量键）与工作流变量同名键的
    /// 层次：节点输出可见层在最上层胜出，三层链序不因键形态改变
    #[test]
    fn dotted_plain_key_overrides_workflow_var_on_same_key() {
        let mut workflow_vars = BTreeMap::new();
        workflow_vars.insert("login.status".to_owned(), exec_var("999"));
        let mut node_outputs = BTreeMap::new();
        node_outputs.insert("login.status".to_owned(), exec_var("200"));
        let merged = merge_execution_variables(Vec::new(), &workflow_vars, &node_outputs);
        let hit = merged
            .iter()
            .find(|v| v.key == "login.status")
            .expect("点分键必须在");
        assert_eq!(hit.value, "200", "节点输出可见层压过同名工作流变量");
    }

    // —— 深层引用的惰性求值（{{名.产物名.字段}} 取值核心）——

    fn map_lookup(map: &BTreeMap<String, String>) -> impl Fn(&str) -> Option<String> + '_ {
        move |prefix: &str| map.get(prefix).cloned()
    }

    /// 对象 / 数组产物深层取值：点分段对象按键、数组按下标，字符串去引号、
    /// 标量与结构序列化原文
    #[test]
    fn deep_reference_descends_json_products() {
        let mut table = BTreeMap::new();
        table.insert(
            "登录.data".to_owned(),
            r#"{"token":"t-1","nest":{"deep":"v"}}"#.to_owned(),
        );
        table.insert("登录.list".to_owned(), r#"[{"id":1},{"id":2}]"#.to_owned());
        table.insert("登录.count".to_owned(), "2".to_owned());
        let lookup = map_lookup(&table);

        assert_eq!(
            resolve_deep_reference(&lookup, "登录.data.token")
                .map(|(v, _)| v)
                .as_deref(),
            Some("t-1"),
            "对象产物一层字段"
        );
        assert_eq!(
            resolve_deep_reference(&lookup, "登录.data.nest.deep")
                .map(|(v, _)| v)
                .as_deref(),
            Some("v"),
            "嵌套深层路径"
        );
        assert_eq!(
            resolve_deep_reference(&lookup, "登录.list.1.id")
                .map(|(v, _)| v)
                .as_deref(),
            Some("2"),
            "数组下标 + 对象键混合（list[1].id）"
        );
        assert_eq!(
            resolve_deep_reference(&lookup, "登录.count")
                .map(|(v, _)| v)
                .as_deref(),
            None,
            "非 JSON 标量值不派生（精确键由上层命中，核心只管深层）"
        );
        assert_eq!(
            resolve_deep_reference(&lookup, "登录.data.absent")
                .map(|(v, _)| v)
                .as_deref(),
            None,
            "字段缺失＝未命中"
        );
        assert_eq!(
            resolve_deep_reference(&lookup, "登录.absent.x")
                .map(|(v, _)| v)
                .as_deref(),
            None,
            "前缀不存在＝未命中"
        );
    }

    /// 最长前缀优先：产物名含点也能命中（先试更长前缀），普通点分变量键
    /// 的整键优先于任何深层切分
    #[test]
    fn deep_reference_prefers_longest_prefix() {
        let mut table = BTreeMap::new();
        table.insert("a.b".to_owned(), r#"{"c":"hit"}"#.to_owned());
        table.insert("a".to_owned(), r#"{"b":{"c":"nested"}}"#.to_owned());
        let lookup = map_lookup(&table);

        assert_eq!(
            resolve_deep_reference(&lookup, "a.b.c")
                .map(|(v, _)| v)
                .as_deref(),
            Some("hit"),
            "最长前缀 a.b 命中产物键"
        );

        let mut only_root = BTreeMap::new();
        only_root.insert("a".to_owned(), r#"{"b":{"c":"nested"}}"#.to_owned());
        let lookup = map_lookup(&only_root);
        assert_eq!(
            resolve_deep_reference(&lookup, "a.b.c")
                .map(|(v, _)| v)
                .as_deref(),
            Some("nested"),
            "短前缀回落求值"
        );
    }

    /// 精确命中优先由调用方保证（resolve_value 先精确后深层）；核心对病态
    /// 输入（空段）按未命中处理
    #[test]
    fn deep_reference_rejects_empty_segments() {
        let table = BTreeMap::from([("a".to_owned(), r#"{"b":"v"}"#.to_owned())]);
        let lookup = map_lookup(&table);
        assert_eq!(resolve_deep_reference(&lookup, "a..b"), None);
        assert_eq!(resolve_deep_reference(&lookup, ".b"), None);
    }

    /// 旧执行记录（无 request / response 明细字段）读取不炸：serde(default)
    /// 回落 None——执行记录是持久数据，字段演进的向后兼容契约。
    #[test]
    fn legacy_node_record_without_details_decodes() {
        let legacy = r#"{
            "nodeId": "n0",
            "status": "passed",
            "startedAt": "2026-10-25T00:00:00Z",
            "completedAt": "2026-10-25T00:00:01Z",
            "durationMs": 12,
            "errorCode": null,
            "errorMessage": null,
            "output": null,
            "writebacks": [],
            "assertions": []
        }"#;
        let record: NodeExecutionRecord = serde_json::from_str(legacy).expect("旧记录必须可读");
        assert_eq!(record.node_id, "n0");
        assert_eq!(record.status, "passed");
        assert!(record.request.is_none(), "缺省明细回落 None");
        assert!(record.response.is_none(), "缺省明细回落 None");

        // 新记录带明细：往返保留
        let record = NodeExecutionRecord {
            request: Some(NodeRequestDetail {
                method: "GET".into(),
                url: "http://x/".into(),
            }),
            response: Some(NodeResponseDetail {
                status: 200,
                body: "***".into(),
            }),
            ..serde_json::from_str::<NodeExecutionRecord>(legacy).unwrap()
        };
        let raw = serde_json::to_string(&record).unwrap();
        let round: NodeExecutionRecord = serde_json::from_str(&raw).unwrap();
        assert_eq!(round, record);
    }
}
