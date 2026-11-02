//! 工作流领域实体：编辑模型（节点＋边判别联合 10 类）与图序列化形态。
//!
//! 编辑模型与执行模型严格分离：本文件只描述持久化的编辑模型
//! （Workflow / WorkflowNode / WorkflowEdge）；执行记录（WorkflowExecution /
//! NodeExecution）由执行引擎独立建模。React Flow 的 Node/Edge 只是视图层，
//! 不得与本模型混用。
//!
//! 序列化口径：节点配置用内部 tag 判别联合（`"type"` 字段 camelCase），
//! 未知 kind 或缺失字段反序列化即失败——图是编辑模型的唯一权威形态，
//! 宁可报 WORKFLOW_GRAPH_INVALID 也不静默丢数据。
//!
//! 读时投影：[`masked_graph_for_display`] 提供展示面的读时脱敏——不改动
//! 图本体（落库与线上契约保持 domain 类型三合一），掩码判定与 redact 契约
//! 同源；穷尽 match 使节点 kind 演进时编译期暴露，脱敏不静默失效。

use std::collections::{BTreeSet, HashMap};

use sqlx::FromRow;

use crate::domain::redact;

/// 图序列化版本（结构变化必须经迁移处理）。v3：参数提取收单来源多规则
/// 配置（行式 `rows` 图与旧散字段图读侧桥接归一，无需数据迁移），存变量
/// 节点自词表移除（含它的旧图反序列化即失败——图损坏口径）。
pub const GRAPH_SCHEMA_VERSION: u32 = 3;

/// 节点类型全集（10 类）：流程（开始 / 结束）、请求、数据（参数提取）、
/// 逻辑（条件判断 / 并行 / Join）、控制（延时 / 重试 / 断言）。存变量已
/// 并入参数提取的写回分支，不再是独立节点。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowNodeKind {
    Start,
    End,
    Request,
    Extract,
    Condition,
    Parallel,
    Join,
    Delay,
    Retry,
    Assert,
}

/// 画布坐标（px）。
#[derive(Debug, Clone, Copy, PartialEq, Default, serde::Serialize, serde::Deserialize)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

/// 请求节点的参数覆写（叠加在引用接口用户数据之上，不改接口本体）。
/// 行形态取发送所需最小集（name / value）；启用开关与标注列不进覆写模型。
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverrideRow {
    pub name: String,
    pub value: String,
}

/// 请求节点配置：稳定键引用（同步接口＝EndpointKey，手工接口＝UUID）+
/// 参数覆写。永不复制接口定义快照；endpoint_key 为 None＝待绑定占位。
/// 覆写面＝path 模板参数（path_params 按名代入 `{param}` 洞）＋ query 行；
/// header 覆写已取消（Content-Type 等由接口用户数据承担）——serde 默认
/// 忽略旧图残留的 `header` 键（未开 deny_unknown_fields，读侧零迁移）。
/// body：None＝从未编辑（编辑器显示接口预填、发送跟随接口用户数据）；
/// 空串＝用户显式清空（发送同样跟随接口——执行层与 None 等价，区分只在
/// 编辑器显示面）。
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestNodeConfig {
    #[serde(default)]
    pub endpoint_key: Option<String>,
    #[serde(default)]
    pub query: Vec<OverrideRow>,
    /// path 模板参数填值行（name＝模板 `{param}` 名；值空行发送面跳过，
    /// 占位洞原样保留——与未覆写行为一致）
    #[serde(default)]
    pub path_params: Vec<OverrideRow>,
    #[serde(default)]
    pub body: Option<String>,
    /// 节点超时覆写（毫秒）：Some＝节点档压过接口用户数据与全局档（覆写
    /// 不动接口本体）；None／缺字段（serde default，旧图兼容）＝继承现行为。
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// 参数提取来源四选。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExtractSource {
    #[default]
    JsonPath,
    Header,
    StatusCode,
    Text,
}

/// 写回敏感标记的 serde 缺省值（token 场景默认口径：写回即视为敏感）。
fn default_writeback_secret() -> bool {
    true
}

/// 参数提取节点的写回分支（单行写回，enabled 默认关）：写回值来源恒为本
/// 节点产物（`product_path`＝产物名，可带 `.` 深层字段路径——对象 / 数组
/// 产物按字段路径求值）；目标分类名快照（全局分类不可作目标），执行时按
/// 名在本空间解析、未命中按名重建。key＝目标变量键（模型保留、UI 不展示
/// 键字段：选择写回值时自动写值尾段，读侧对缺键旧图按同口径补尾段）。
/// secret 默认开——写回值多为 token 类凭据，敏感标记随写回同步到变量，
/// 掩码在展示与输出全路径生效。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractWriteback {
    #[serde(default)]
    pub enabled: bool,
    /// 写回值来源：产物名（顶层）或 `产物名.字段路径`（深层取值）
    #[serde(default)]
    pub product_path: String,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub category_name: Option<String>,
    #[serde(default = "default_writeback_secret")]
    pub secret: bool,
}

impl Default for ExtractWriteback {
    fn default() -> Self {
        Self {
            enabled: false,
            product_path: String::new(),
            key: String::new(),
            category_name: None,
            secret: true,
        }
    }
}

/// 写回值的键尾段（`data.token` → `token`，与前端选择写回值时的自动落键
/// 同口径）：取最后一个点切分的尾段，无点即整名。产物路径是点分段引用键
/// （无引号与下标语法），与路径模板的尾键 `tail_key_of_path`（含引号属性
/// 与下标段处理）分属两个域，结果可能不同。
fn tail_segment_of_product_path(product_path: &str) -> String {
    let trimmed = product_path.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    trimmed
        .rsplit_once('.')
        .map_or(trimmed, |(_, tail)| tail)
        .to_owned()
}

impl<'de> serde::Deserialize<'de> for ExtractWriteback {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        /// 桥接读形态：字段齐备直读；变量键是 UI 已退场的槽位，缺键或空白
        /// 时按「写回值尾段」补齐（与 UI 选择写回值的自动落键同口径），旧图
        /// 缺键不拦执行。
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Bridge {
            #[serde(default)]
            enabled: bool,
            #[serde(default)]
            product_path: String,
            #[serde(default)]
            key: Option<String>,
            #[serde(default)]
            category_name: Option<String>,
            #[serde(default = "default_writeback_secret")]
            secret: bool,
        }
        let bridge = Bridge::deserialize(deserializer)?;
        let key = match bridge.key {
            Some(key) if !key.trim().is_empty() => key,
            _ if bridge.enabled && !bridge.product_path.trim().is_empty() => {
                tail_segment_of_product_path(&bridge.product_path)
            }
            _ => String::new(),
        };
        Ok(Self {
            enabled: bridge.enabled,
            product_path: bridge.product_path,
            key,
            category_name: bridge.category_name,
            secret: bridge.secret,
        })
    }
}

/// 参数提取规则（节点内一条取值规则）：path＝取值路径（JSONPath / 响应头
/// 名；状态码与文本源不用路径，空串占位），name＝产物名（产物的引用键：
/// `{{产物名}}`，可见范围＝本节点的直接下游节点）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractRule {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub name: String,
}

/// 参数提取节点配置：节点级单来源（一个节点只配一个来源）＋多条提取规则
/// （逐规则取值，产物名是产物的引用键）＋写回分支（节点级单条，写回值来
/// 源按名称命中本节点任一规则产物）。历史形态读侧桥接归一：行式 `rows`
/// 图同源行逐行映射为规则（异源行丢弃）、旧散字段图归一为单条规则（产物
/// 名缺省取路径尾键）；序列化恒多规则形态（`rules` 恒为数组，空集＝待配
/// 置，交校验报「无提取规则」）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractNodeConfig {
    #[serde(default)]
    pub source: ExtractSource,
    #[serde(default)]
    pub rules: Vec<ExtractRule>,
    #[serde(default)]
    pub writeback: ExtractWriteback,
}

impl Default for ExtractNodeConfig {
    fn default() -> Self {
        Self {
            source: ExtractSource::default(),
            rules: Vec::new(),
            writeback: ExtractWriteback::default(),
        }
    }
}

impl<'de> serde::Deserialize<'de> for ExtractNodeConfig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        /// 桥接读形态：多规则直读、行式 `rows` 图（历史承载）、旧散字段图
        /// （`source` / `path` 顶层散列）
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Bridge {
            #[serde(default)]
            rules: Option<Vec<ExtractRule>>,
            #[serde(default)]
            rows: Option<Vec<BridgeRow>>,
            #[serde(default)]
            source: Option<ExtractSource>,
            #[serde(default)]
            path: Option<String>,
            #[serde(default)]
            name: Option<String>,
            #[serde(default)]
            writeback: Option<ExtractWriteback>,
        }
        /// 行式图的历史行元素（同 source 的行逐行归一为规则）
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct BridgeRow {
            #[serde(default)]
            source: ExtractSource,
            #[serde(default)]
            path: String,
            #[serde(default)]
            name: String,
        }
        let bridge = Bridge::deserialize(deserializer)?;
        let (source, rules) = if let Some(rules) = bridge.rules {
            // 多规则直读：空数组原样保留（交校验报「无提取规则」）
            (bridge.source.unwrap_or_default(), rules)
        } else if let Some(rows) = bridge.rows.filter(|rows| !rows.is_empty()) {
            // 行式图归一：source 取首行；同 source 的行逐行映射为规则，异源
            // 行丢弃（与旧「只取首行」口径相比数据只多不少）
            let source = rows[0].source;
            let rules = rows
                .iter()
                .filter(|row| row.source == source)
                .map(|row| ExtractRule {
                    path: row.path.clone(),
                    name: row.name.clone(),
                })
                .collect();
            (source, rules)
        } else {
            // 顶层散字段：归一为单条规则；产物名显式携带（含空串，交校验）
            // 或取路径尾键
            let path = bridge.path.unwrap_or_default();
            let name = bridge.name.unwrap_or_else(|| tail_key_of_path(&path));
            (
                bridge.source.unwrap_or_default(),
                vec![ExtractRule { path, name }],
            )
        };
        Ok(Self {
            source,
            rules,
            writeback: bridge.writeback.unwrap_or_default(),
        })
    }
}

/// 路径尾键（产物名缺省建议值）：取最后一个点切分的尾段，引号属性段
/// （`['token']`）取引号内内容，数组下标段（`[0]`）取段前的属性名，其余
/// 剥根符与引号；无键（根符 / 空串）不产出（产物名留空交校验）。
pub fn tail_key_of_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let tail = trimmed.rsplit_once('.').map_or(trimmed, |(_, tail)| tail);
    if let Some(open) = tail.rfind('[') {
        let inner = tail[open + 1..]
            .strip_suffix(']')
            .unwrap_or(&tail[open + 1..]);
        let quoted = inner
            .strip_prefix('\'')
            .or_else(|| inner.strip_prefix('"'))
            .and_then(|q| q.strip_suffix('\'').or_else(|| q.strip_suffix('"')));
        if let Some(key) = quoted.filter(|key| !key.is_empty()) {
            return key.to_owned();
        }
        // 数组下标段：键取下标前的属性名（无属性名＝无键）
        let head = tail[..open]
            .trim_start_matches('$')
            .trim_matches(|c| c == '\'' || c == '"')
            .trim();
        return if head.is_empty() {
            String::new()
        } else {
            head.to_owned()
        };
    }
    let stripped = tail
        .trim_start_matches('$')
        .trim_matches(|c| c == '\'' || c == '"')
        .trim();
    if stripped.is_empty() {
        String::new()
    } else {
        stripped.to_owned()
    }
}

/// 条件分支（IF / ELSE IF 行）：id 是分支出口的稳定标识（边以它标注目标
/// 分支）；表达式语法由条件求值器统一定义。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConditionBranch {
    pub id: String,
    pub expression: String,
}

/// 条件判断节点配置：IF / ELSE IF 行集；ELSE（Default）出口不进配置——
/// 它是节点恒有的兜底端口，由边标签标注。
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConditionNodeConfig {
    #[serde(default)]
    pub branches: Vec<ConditionBranch>,
}

/// Join 汇聚模式：等待全部分支 / 任一分支完成即放行。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JoinMode {
    #[default]
    All,
    Any,
}

/// Join 节点配置。
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinNodeConfig {
    #[serde(default)]
    pub mode: JoinMode,
}

/// 延时节点配置（固定等待，毫秒）。
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelayNodeConfig {
    #[serde(default)]
    pub duration_ms: u64,
}

/// 重试节点配置：失败重试次数与重试间隔。
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryNodeConfig {
    #[serde(default)]
    pub max_attempts: u32,
    #[serde(default)]
    pub interval_ms: u64,
}

/// 断言规则判别联合（行式规则，全部满足 AND 才通过）：
/// 状态码等于 / JSONPath 期望值 / 存在 / 包含。对象＝上游请求响应。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AssertRule {
    /// 响应状态码等于期望值
    StatusCode { expected: String },
    /// JSONPath 取值等于期望值
    JsonPath { path: String, expected: String },
    /// JSONPath 取值存在（非 null / 非缺失）
    Exists { path: String },
    /// 包含：path 存在时查 JSONPath 取值的文本包含，缺省查响应体文本包含
    Contains {
        #[serde(default)]
        path: Option<String>,
        value: String,
    },
}

/// 断言节点配置。
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssertNodeConfig {
    #[serde(default)]
    pub rules: Vec<AssertRule>,
}

/// 节点配置判别联合（10 类，内部 tag 判别；未知 tag 反序列化即失败——
/// 含已移除的存变量 kind 的旧图同样报图损坏）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WorkflowNodeConfig {
    Start,
    End,
    Request(RequestNodeConfig),
    Extract(ExtractNodeConfig),
    Condition(ConditionNodeConfig),
    Parallel,
    Join(JoinNodeConfig),
    Delay(DelayNodeConfig),
    Retry(RetryNodeConfig),
    Assert(AssertNodeConfig),
}

impl WorkflowNodeConfig {
    /// 节点类型（判别联合的 kind 面，供渲染与校验分发）。
    pub fn kind(&self) -> WorkflowNodeKind {
        match self {
            WorkflowNodeConfig::Start => WorkflowNodeKind::Start,
            WorkflowNodeConfig::End => WorkflowNodeKind::End,
            WorkflowNodeConfig::Request(_) => WorkflowNodeKind::Request,
            WorkflowNodeConfig::Extract(_) => WorkflowNodeKind::Extract,
            WorkflowNodeConfig::Condition(_) => WorkflowNodeKind::Condition,
            WorkflowNodeConfig::Parallel => WorkflowNodeKind::Parallel,
            WorkflowNodeConfig::Join(_) => WorkflowNodeKind::Join,
            WorkflowNodeConfig::Delay(_) => WorkflowNodeKind::Delay,
            WorkflowNodeConfig::Retry(_) => WorkflowNodeKind::Retry,
            WorkflowNodeConfig::Assert(_) => WorkflowNodeKind::Assert,
        }
    }
}

/// 工作流节点：用户可读名＋画布位置＋类型化配置。
/// id 为节点实例身份（uuid），边的端点与执行定位都以它索引。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNode {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub position: Position,
    pub config: WorkflowNodeConfig,
}

/// 工作流边：有向连线；label 用于条件分支标注（分支 id 或 DEFAULT）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    #[serde(default)]
    pub label: Option<String>,
}

/// 工作流图（graph 列的 JSON 形态）：节点＋边＋schemaVersion。
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowGraph {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub nodes: Vec<WorkflowNode>,
    #[serde(default)]
    pub edges: Vec<WorkflowEdge>,
}

impl WorkflowGraph {
    /// 新建空图（当前 schema 版本）。
    pub fn empty() -> Self {
        WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: Vec::new(),
            edges: Vec::new(),
        }
    }
}

/// 存储的工作流（graph 列为 JSON 文本；解析由服务层经 [`parse_graph`] 完成）。
/// group_id＝所属分组（None＝未分组；分组删除时由 FK SET NULL 回落）。
/// sort_order＝树内呈现序（按归属桶独立编号；移动整桶重写，删除留空洞）。
#[derive(Debug, Clone, FromRow)]
pub struct Workflow {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub graph: String,
    pub group_id: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 新建工作流的输入（身份由调用方生成）。
pub struct NewWorkflow {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub graph: String,
    pub group_id: Option<String>,
}

/// 存储的工作流分组（第五视图分组树行；名称唯一性按工作空间由服务层校验，
/// sort_order＝组间呈现序）。
#[derive(Debug, Clone, FromRow)]
pub struct WorkflowGroup {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub sort_order: i64,
    pub created_at: String,
}

/// 新建工作流分组的输入（身份由调用方生成）。
pub struct NewWorkflowGroup {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
}

/// graph 列 JSON → 图模型（读侧单点：损坏报错不静默）。
pub fn parse_graph(raw: &str) -> Result<WorkflowGraph, serde_json::Error> {
    serde_json::from_str(raw)
}

/// 图内节点查找（执行期上游定位与校验器共用；图规模有限，线性查找足够）。
pub fn node_of_graph<'a>(graph: &'a WorkflowGraph, node_id: &str) -> Option<&'a WorkflowNode> {
    graph.nodes.iter().find(|node| node.id == node_id)
}

/// 出边 / 入边索引（图查询单点：执行引擎与执行前校验器共用，不在消费方
/// 复制图遍历）。生命周期随借用图。
/// outgoing＝全量保序出边（条件选中与并行分支的调度面、串行推进取
/// 首条）；first_incoming＝首条入边（提取 / 断言的上游定位）。
pub struct EdgesIndex<'a> {
    outgoing: HashMap<&'a str, Vec<&'a WorkflowEdge>>,
    incoming: HashMap<&'a str, &'a WorkflowEdge>,
}

impl<'a> EdgesIndex<'a> {
    pub fn new(graph: &'a WorkflowGraph) -> Self {
        let mut outgoing: HashMap<&'a str, Vec<&'a WorkflowEdge>> = HashMap::new();
        for edge in &graph.edges {
            outgoing.entry(edge.source.as_str()).or_default().push(edge);
        }
        let mut incoming: HashMap<&'a str, &'a WorkflowEdge> = HashMap::new();
        for edge in &graph.edges {
            incoming.entry(edge.target.as_str()).or_insert(edge);
        }
        Self { outgoing, incoming }
    }

    /// 首条出边（串行推进与重试授权的下游定位）。
    pub fn first_outgoing(&self, node_id: &str) -> Option<&'a WorkflowEdge> {
        self.outgoing
            .get(node_id)
            .and_then(|list| list.first())
            .copied()
    }

    /// 全量保序出边（并行分支调度面；无出边＝空表）。
    pub fn outgoing_of(&self, node_id: &str) -> &[&'a WorkflowEdge] {
        self.outgoing.get(node_id).map(Vec::as_slice).unwrap_or(&[])
    }

    /// 按出边 label 定位（条件节点选中分支的边；label＝分支 id 或 DEFAULT）。
    pub fn outgoing_labeled(&self, node_id: &str, label: &str) -> Option<&'a WorkflowEdge> {
        self.outgoing
            .get(node_id)
            .and_then(|list| {
                list.iter()
                    .find(|edge| edge.label.as_deref() == Some(label))
            })
            .copied()
    }

    /// 首条入边（提取 / 断言的上游定位）。
    pub fn first_incoming(&self, node_id: &str) -> Option<&'a WorkflowEdge> {
        self.incoming.get(node_id).copied()
    }

    /// 节点是否与任何边相连（孤立节点判定面）。
    pub fn is_connected(&self, node_id: &str) -> bool {
        self.outgoing.contains_key(node_id) || self.incoming.contains_key(node_id)
    }
}

/// 图 → 引用的接口稳定键集合（去重收集全部请求节点的非空引用；「稳定键 →
/// 引用工作流」反查与失效恢复的扫描面单点）。
pub fn referenced_endpoint_keys(graph: &WorkflowGraph) -> BTreeSet<String> {
    graph
        .nodes
        .iter()
        .filter_map(|node| match &node.config {
            WorkflowNodeConfig::Request(config) => config
                .endpoint_key
                .as_deref()
                .filter(|key| !key.is_empty())
                .map(str::to_owned),
            _ => None,
        })
        .collect()
}

/// 图内任一参数提取节点开启写回分支（清单行写回标记的判定面，纯图扫描
/// 不触库）：命中即该工作流执行时会向目标变量分类写值。只描述「会写回」
/// 的存在性，逐条写回明细归执行记录面。
pub fn has_enabled_category_writeback(graph: &WorkflowGraph) -> bool {
    graph.nodes.iter().any(|node| match &node.config {
        WorkflowNodeConfig::Extract(config) => config.writeback.enabled,
        _ => false,
    })
}

/// 图的读时脱敏投影（展示面）：请求节点覆写行（query / path_params）的
/// name 命中敏感头名单（[`redact::is_sensitive_header`]，与 redact 契约
/// 同源、判定不区分大小写）→ value 替换为 [`redact::MASK`]；其余结构原样
/// 返回（body 是非机密槽位语义，原样）。输入图不被改动；`--show-secrets`
/// 放行归消费层（放行即不调用本投影）。
///
/// 穷尽 match 是演进护栏：节点 config 新增 kind 时此处编译失败，强制裁决
/// 新配置是否携带机密槽位——脱敏不随图 schema 演进静默失效。
pub fn masked_graph_for_display(graph: &WorkflowGraph) -> WorkflowGraph {
    let mut masked = graph.clone();
    for node in &mut masked.nodes {
        match &mut node.config {
            WorkflowNodeConfig::Request(config) => {
                for row in config.query.iter_mut().chain(config.path_params.iter_mut()) {
                    if redact::is_sensitive_header(&row.name) {
                        row.value = redact::MASK.to_owned();
                    }
                }
            }
            // 其余 kind 不携带机密槽位（覆写行仅请求节点持有；写回分支的
            // 分类名是目标定位非机密值）；显式列举各臂保持穷尽，新增 kind
            // 漏裁决时编译报错。
            WorkflowNodeConfig::Start
            | WorkflowNodeConfig::End
            | WorkflowNodeConfig::Extract(_)
            | WorkflowNodeConfig::Condition(_)
            | WorkflowNodeConfig::Parallel
            | WorkflowNodeConfig::Join(_)
            | WorkflowNodeConfig::Delay(_)
            | WorkflowNodeConfig::Retry(_)
            | WorkflowNodeConfig::Assert(_) => {}
        }
    }
    masked
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 全 10 类节点的样例图（每类带非默认配置字段，防字段漂移漏测）。
    fn sample_graph() -> WorkflowGraph {
        WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: vec![
                WorkflowNode {
                    id: "n1".into(),
                    name: "开始".into(),
                    position: Position { x: 0.0, y: 0.0 },
                    config: WorkflowNodeConfig::Start,
                },
                WorkflowNode {
                    id: "n2".into(),
                    name: "登录".into(),
                    position: Position { x: 120.0, y: 0.0 },
                    config: WorkflowNodeConfig::Request(RequestNodeConfig {
                        endpoint_key: Some("post /api/auth/login".into()),
                        query: vec![OverrideRow {
                            name: "verbose".into(),
                            value: "true".into(),
                        }],
                        path_params: vec![OverrideRow {
                            name: "id".into(),
                            value: "42".into(),
                        }],
                        body: Some(r#"{"user":"a"}"#.into()),
                        timeout_ms: Some(30_000),
                    }),
                },
                WorkflowNode {
                    id: "n3".into(),
                    name: "取 token".into(),
                    position: Position { x: 240.0, y: 0.0 },
                    config: WorkflowNodeConfig::Extract(ExtractNodeConfig {
                        source: ExtractSource::JsonPath,
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
                },
                WorkflowNode {
                    id: "n5".into(),
                    name: "判断".into(),
                    position: Position { x: 480.0, y: 0.0 },
                    config: WorkflowNodeConfig::Condition(ConditionNodeConfig {
                        branches: vec![ConditionBranch {
                            id: "b1".into(),
                            expression: "{{login.status}} == 200".into(),
                        }],
                    }),
                },
                WorkflowNode {
                    id: "n6".into(),
                    name: "并行".into(),
                    position: Position { x: 600.0, y: 0.0 },
                    config: WorkflowNodeConfig::Parallel,
                },
                WorkflowNode {
                    id: "n7".into(),
                    name: "汇聚".into(),
                    position: Position { x: 720.0, y: 0.0 },
                    config: WorkflowNodeConfig::Join(JoinNodeConfig {
                        mode: JoinMode::Any,
                    }),
                },
                WorkflowNode {
                    id: "n8".into(),
                    name: "等待".into(),
                    position: Position { x: 840.0, y: 0.0 },
                    config: WorkflowNodeConfig::Delay(DelayNodeConfig { duration_ms: 500 }),
                },
                WorkflowNode {
                    id: "n9".into(),
                    name: "重试".into(),
                    position: Position { x: 960.0, y: 0.0 },
                    config: WorkflowNodeConfig::Retry(RetryNodeConfig {
                        max_attempts: 3,
                        interval_ms: 1000,
                    }),
                },
                WorkflowNode {
                    id: "n10".into(),
                    name: "断言".into(),
                    position: Position { x: 1080.0, y: 0.0 },
                    config: WorkflowNodeConfig::Assert(AssertNodeConfig {
                        rules: vec![
                            AssertRule::StatusCode {
                                expected: "200".into(),
                            },
                            AssertRule::JsonPath {
                                path: "$.success".into(),
                                expected: "true".into(),
                            },
                            AssertRule::Exists {
                                path: "$.data.id".into(),
                            },
                            AssertRule::Contains {
                                path: None,
                                value: "ok".into(),
                            },
                        ],
                    }),
                },
                WorkflowNode {
                    id: "n11".into(),
                    name: "结束".into(),
                    position: Position { x: 1200.0, y: 0.0 },
                    config: WorkflowNodeConfig::End,
                },
            ],
            edges: vec![WorkflowEdge {
                id: "e1".into(),
                source: "n1".into(),
                target: "n2".into(),
                label: Some("b1".into()),
            }],
        }
    }

    #[test]
    fn graph_json_roundtrip_preserves_discriminated_union() {
        let graph = sample_graph();
        let json = serde_json::to_string(&graph).unwrap();
        let parsed = parse_graph(&json).unwrap();
        assert_eq!(parsed, graph);
        // 判别联合 kind 面完整：10 类逐一可判别
        let kinds: Vec<WorkflowNodeKind> = parsed.nodes.iter().map(|n| n.config.kind()).collect();
        assert_eq!(kinds.len(), 10);
        assert_eq!(
            kinds,
            vec![
                WorkflowNodeKind::Start,
                WorkflowNodeKind::Request,
                WorkflowNodeKind::Extract,
                WorkflowNodeKind::Condition,
                WorkflowNodeKind::Parallel,
                WorkflowNodeKind::Join,
                WorkflowNodeKind::Delay,
                WorkflowNodeKind::Retry,
                WorkflowNodeKind::Assert,
                WorkflowNodeKind::End,
            ]
        );
    }

    #[test]
    fn unknown_node_config_kind_is_rejected() {
        let json = r#"{"schemaVersion":1,"nodes":[{"id":"x","name":"n","position":{"x":0,"y":0},"config":{"type":"mystery"}}],"edges":[]}"#;
        assert!(parse_graph(json).is_err(), "未知 kind 必须拒绝，不静默降级");
    }

    /// 存变量 kind 已自词表移除：含它的旧图反序列化即失败（图损坏口径，
    /// 零迁移——用户确认该节点未正式使用）
    #[test]
    fn legacy_set_variable_kind_is_rejected_as_corrupt_graph() {
        let json = r#"{"schemaVersion":2,"nodes":[{"id":"n1","name":"存","position":{"x":0,"y":0},"config":{"type":"setVariable","key":"token","inExecution":true,"writeback":{"enabled":false,"secret":true}}}],"edges":[]}"#;
        let err = parse_graph(json).unwrap_err();
        assert!(
            err.to_string().contains("unknown variant"),
            "setVariable 应按未知 variant 报图损坏: {err}"
        );
    }

    /// 历史形态读侧桥接为多规则：旧散字段图（schema v2）归一为单条规则、
    /// 产物名取路径尾键；行式图同源行逐行映射为规则（异源行丢弃）；多规则
    /// 形态直读（空数组原样保留）；写回分支随图保留，缺键补值尾段。序列化
    /// 恒多规则形态。
    #[test]
    fn legacy_extract_configs_bridge_to_multi_rules() {
        // v2 散字段：单条规则，产物名缺省取路径尾键
        let parsed: ExtractNodeConfig =
            serde_json::from_str(r#"{"type":"extract","source":"jsonPath","path":"$.data.token"}"#)
                .unwrap();
        assert_eq!(
            parsed,
            ExtractNodeConfig {
                source: ExtractSource::JsonPath,
                rules: vec![ExtractRule {
                    path: "$.data.token".into(),
                    name: "token".into(),
                }],
                writeback: ExtractWriteback::default(),
            }
        );

        // 行式图（历史承载）：source 取首行，同源行逐行映射为规则
        let parsed: ExtractNodeConfig = serde_json::from_str(
            r#"{"type":"extract","rows":[{"source":"jsonPath","path":"$.a","name":"a"},{"source":"jsonPath","path":"$.b","name":"b"}]}"#,
        )
        .unwrap();
        assert_eq!(
            parsed,
            ExtractNodeConfig {
                source: ExtractSource::JsonPath,
                rules: vec![
                    ExtractRule {
                        path: "$.a".into(),
                        name: "a".into(),
                    },
                    ExtractRule {
                        path: "$.b".into(),
                        name: "b".into(),
                    },
                ],
                writeback: ExtractWriteback::default(),
            }
        );

        // 行式图异源行丢弃：source 取首行，只留同源行（数据只多不少口径）
        let parsed: ExtractNodeConfig = serde_json::from_str(
            r#"{"type":"extract","rows":[{"source":"statusCode","path":"","name":"status"},{"source":"jsonPath","path":"$.a","name":"a"}]}"#,
        )
        .unwrap();
        assert_eq!(
            parsed,
            ExtractNodeConfig {
                source: ExtractSource::StatusCode,
                rules: vec![ExtractRule {
                    path: String::new(),
                    name: "status".into(),
                }],
                writeback: ExtractWriteback::default(),
            }
        );

        // 序列化恒多规则形态：字段显式落键，行式与散字段形态不再写出
        let raw = serde_json::to_string(&parsed).unwrap();
        assert_eq!(
            raw,
            r#"{"source":"statusCode","rules":[{"path":"","name":"status"}],"writeback":{"enabled":false,"productPath":"","key":"","categoryName":null,"secret":true}}"#
        );

        // 多规则直读：rules 键存在即原样保留（空数组不桥接成单条）
        let parsed: ExtractNodeConfig = serde_json::from_str(
            r#"{"type":"extract","source":"jsonPath","rules":[{"path":"$.a","name":"a"}]}"#,
        )
        .unwrap();
        assert_eq!(
            parsed.rules,
            vec![ExtractRule {
                path: "$.a".into(),
                name: "a".into(),
            }]
        );
        let parsed: ExtractNodeConfig =
            serde_json::from_str(r#"{"type":"extract","source":"jsonPath","rules":[]}"#).unwrap();
        assert!(parsed.rules.is_empty(), "空规则集原样保留");

        // 写回分支随旧图可携带（散字段形态 + 写回配置同时归一保留）
        let with_writeback: ExtractNodeConfig = serde_json::from_str(
            r#"{"type":"extract","source":"header","path":"X-Token","writeback":{"enabled":true,"categoryName":"登录态"}}"#,
        )
        .unwrap();
        assert_eq!(
            with_writeback.rules[0].name, "X-Token",
            "header 名无点即整名"
        );
        assert!(with_writeback.writeback.enabled);
        assert_eq!(
            with_writeback.writeback.category_name.as_deref(),
            Some("登录态")
        );
        assert!(with_writeback.writeback.secret, "写回 secret 缺省开");

        // 启用的写回缺变量键：读侧按值尾段补齐（与 UI 自动落键同口径）
        let with_key: ExtractNodeConfig = serde_json::from_str(
            r#"{"type":"extract","source":"jsonPath","path":"$.token","name":"token","writeback":{"enabled":true,"productPath":"data.token","categoryName":"登录态"}}"#,
        )
        .unwrap();
        assert_eq!(with_key.writeback.key, "token", "缺键补写回值尾段");
        assert_eq!(with_key.rules.len(), 1, "散字段归一为单条规则");

        // 散字段直读：显式携带的空产物名按原样保留（空白交校验报）
        let explicit_empty: ExtractNodeConfig =
            serde_json::from_str(r#"{"type":"extract","name":""}"#).unwrap();
        assert_eq!(explicit_empty.rules[0].name, "", "显式空名不补尾键");
        assert_eq!(explicit_empty.source, ExtractSource::JsonPath);
    }

    /// 路径尾键提取：点切尾段、引号属性取引号内、数组下标取段前属性名、
    /// 根符与空串不产出。
    #[test]
    fn tail_key_of_path_extracts_last_segment() {
        assert_eq!(tail_key_of_path("$.data.token"), "token");
        assert_eq!(tail_key_of_path("$.data"), "data");
        assert_eq!(tail_key_of_path("$['access-token']"), "access-token");
        assert_eq!(tail_key_of_path("$.list[0]"), "list", "下标段取段前属性名");
        assert_eq!(tail_key_of_path("X-Token"), "X-Token", "无点即整名");
        assert_eq!(tail_key_of_path("$"), "", "根符无键");
        assert_eq!(tail_key_of_path("  "), "", "空白无键");
    }

    #[test]
    fn empty_graph_defaults_and_tolerance() {
        // 缺省字段容忍：schemaVersion / nodes / edges 缺失按空图回填
        let parsed = parse_graph("{}").unwrap();
        assert_eq!(parsed.schema_version, 0);
        assert!(parsed.nodes.is_empty());
        // 空图工厂恒带当前版本
        assert_eq!(WorkflowGraph::empty().schema_version, GRAPH_SCHEMA_VERSION);
    }

    /// 写回存在性判定：任一提取节点开启写回分支即 true；全关闭（含默认
    /// 缺省）与无提取节点的图为 false。
    #[test]
    fn has_enabled_category_writeback_matches_extract_nodes() {
        // 样例图：n3 提取节点开写回
        assert!(has_enabled_category_writeback(&sample_graph()));

        // 同图关掉唯一写回开关 → false
        let mut graph = sample_graph();
        for node in &mut graph.nodes {
            if let WorkflowNodeConfig::Extract(config) = &mut node.config {
                config.writeback.enabled = false;
            }
        }
        assert!(!has_enabled_category_writeback(&graph));

        // 无提取节点的空图 → false
        assert!(!has_enabled_category_writeback(&WorkflowGraph::empty()));
    }

    /// 请求节点超时覆写的旧图兼容与序列化形态：schema v1 图无 `timeoutMs`
    /// 字段，反序列化回落 None＝继承（全局档＋接口用户数据）；已取消的
    /// `header` 覆写键在旧图中残留，serde 默认忽略未知键（零迁移读侧容忍）；
    /// 覆写值序列化显式落毫秒键，双端镜像随往返保真。
    #[test]
    fn request_timeout_ms_defaults_to_inherit_on_v1_graphs() {
        let v1_json = r#"{"schemaVersion":1,"nodes":[{"id":"n1","name":"登录","position":{"x":0,"y":0},"config":{"type":"request","endpointKey":"GET /x","query":[],"header":[],"body":null}}],"edges":[]}"#;
        let parsed = parse_graph(v1_json).unwrap();
        let WorkflowNodeConfig::Request(config) = &parsed.nodes[0].config else {
            panic!("request 节点形态应保持");
        };
        assert_eq!(config.timeout_ms, None, "缺字段回落继承语义");

        // 覆写值往返保真：Some 毫秒值序列化显式落 `timeoutMs` 键
        let with_override = RequestNodeConfig {
            timeout_ms: Some(30_000),
            ..Default::default()
        };
        let json = serde_json::to_string(&with_override).unwrap();
        assert!(
            json.contains(r#""timeoutMs":30000"#),
            "覆写值应以毫秒键序列化: {json}"
        );
        let roundtripped: RequestNodeConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(roundtripped, with_override);
    }

    /// 读时脱敏投影：敏感名单命中的 query / path_params 行值掩码（大小写
    /// 不敏感）、非名单行与 body 原样（body 非机密槽位语义）、输入图不被
    /// 改动。掩码口径与 CLI 展示输出同源——判定恒走 redact 名单单点。
    #[test]
    fn masked_graph_for_display_masks_sensitive_override_rows_only() {
        let graph = WorkflowGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            nodes: vec![WorkflowNode {
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
                        // 值像凭据但 name 不在名单：不误伤（按 name 判定）
                        OverrideRow {
                            name: "note".into(),
                            value: "bearer-like-value".into(),
                        },
                    ],
                    path_params: vec![
                        OverrideRow {
                            name: "authorization".into(),
                            value: "Bearer tok".into(),
                        },
                        OverrideRow {
                            name: "id".into(),
                            value: "42".into(),
                        },
                    ],
                    body: Some("plain".into()),
                    ..Default::default()
                }),
            }],
            edges: Vec::new(),
        };

        let masked = masked_graph_for_display(&graph);
        let WorkflowNodeConfig::Request(config) = &masked.nodes[0].config else {
            panic!("request 节点形态应保持");
        };
        assert_eq!(config.query[0].value, "1", "非名单行原样");
        assert_eq!(config.query[1].value, redact::MASK, "名单 query 行掩码");
        assert_eq!(
            config.query[2].value, "bearer-like-value",
            "name 未命中不误伤（值内容不入判定）"
        );
        assert_eq!(
            config.path_params[0].value,
            redact::MASK,
            "名单 path_params 行掩码（大小写不敏感）"
        );
        assert_eq!(config.path_params[1].value, "42", "非名单行原样");
        assert_eq!(config.body.as_deref(), Some("plain"), "body 原样");

        // 输入图零改动（读时投影不改本体）
        let WorkflowNodeConfig::Request(original) = &graph.nodes[0].config else {
            panic!("原节点形态");
        };
        assert_eq!(
            original.path_params[0].value, "Bearer tok",
            "输入图不被改动"
        );
    }

    /// 投影的演进护栏：全 10 类节点的图走投影后，非 Request 节点序列化
    /// 逐字节不变（掩码只落在请求节点覆写行上，其余 kind 不被触碰）；
    /// 新增 kind 未裁决敏感槽位时穷尽 match 编译失败，掩码不静默漏。
    #[test]
    fn masked_graph_for_display_leaves_non_request_nodes_untouched() {
        let graph = sample_graph();
        let masked = masked_graph_for_display(&graph);
        for (original, projected) in graph.nodes.iter().zip(masked.nodes.iter()) {
            let is_request = matches!(original.config, WorkflowNodeConfig::Request(_));
            if !is_request {
                assert_eq!(
                    serde_json::to_string(projected).unwrap(),
                    serde_json::to_string(original).unwrap(),
                    "非请求节点投影零改动: {}",
                    original.id
                );
            }
        }
        // 图级结构（边 / schema 版本）原样
        assert_eq!(masked.schema_version, graph.schema_version);
        assert_eq!(masked.edges, graph.edges);
    }
}
