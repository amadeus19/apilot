/**
 * 工作流域领域模型的 TS 镜像：与 Rust `domain/workflow.rs` 的 serde 形态
 * 一一对应（camelCase、配置判别联合内部 tag `"type"`），序列化往返的
 * 双端一致性由 Rust 侧 domain 测试与本侧 model 测试共同钉住。
 *
 * 编辑模型与执行模型严格分离：本文件只描述持久化的编辑模型
 * （Workflow / WorkflowNode / WorkflowEdge）；React Flow 的 Node/Edge
 * 只是视图层，不得与本模型混用（边界转换单点在 canvas-converter）。
 */

/** 节点类型全集（10 类）的 kind 面（渲染与校验分发用）。存变量已并入
 * 参数提取的写回分支，不再是独立节点。 */
export type WorkflowNodeKind =
  | 'start'
  | 'end'
  | 'request'
  | 'extract'
  | 'condition'
  | 'parallel'
  | 'join'
  | 'delay'
  | 'retry'
  | 'assert'

/** 面板分组（节点选择面板五组：流程 / 请求 / 数据 / 逻辑 / 控制）。 */
export type WorkflowPanelGroup = 'flow' | 'request' | 'data' | 'logic' | 'control'

/** 画布坐标（px）。 */
export interface Position {
  x: number
  y: number
}

/** 请求节点参数覆写行（叠加在引用接口用户数据之上）。 */
export interface OverrideRow {
  name: string
  value: string
}

/**
 * 请求节点配置：稳定键引用＋参数覆写；endpointKey null＝待绑定占位。
 * 覆写面＝path 模板参数（pathParams，按名代入 `{param}` 洞）＋ query 行；
 * header 覆写已取消（Content-Type 等由接口用户数据承担，旧图 header 键由
 * Rust serde 读侧忽略）。body：null＝从未编辑（编辑器显示接口预填、发送
 * 跟随接口用户数据）；空串＝用户显式清空（发送同样跟随接口——执行层与
 * null 等价，区分只在编辑器显示面）。timeoutMs（毫秒）＝节点超时覆写：
 * null＝继承（全局档＋接口用户数据，与 Rust serde 缺字段回落一致），
 * 非空＝节点档压过下游所有档位。
 */
export interface RequestNodeConfig {
  type: 'request'
  endpointKey: string | null
  query: OverrideRow[]
  pathParams: OverrideRow[]
  body: string | null
  timeoutMs: number | null
}

/**
 * 路径模板的 `{param}` 段名（`/users/{id}` → `['id']`）：`{{变量}}` 双括号
 * 是变量引用占位，跳过不产出；未闭合的 `{` 起余段全为字面。与 Rust 引擎
 * `template_placeholders` 同口径，双端测试钉住。
 */
export function pathTemplateParams(template: string): string[] {
  const names: string[] = []
  let rest = template
  for (;;) {
    const start = rest.indexOf('{')
    if (start < 0) break
    const after = rest.slice(start + 1)
    const end = after.indexOf('}')
    if (end < 0) break
    const inner = after.slice(0, end)
    if (!inner.startsWith('{')) names.push(inner)
    rest = after.slice(end + 1)
  }
  return names
}

/** 参数提取来源四选（jsonPath 的显示名 Body 只改文案，枚举与序列化不动）。 */
export type ExtractSource = 'jsonPath' | 'header' | 'statusCode' | 'text'

/** 提取节点写回分支（单行写回，enabled 默认关）：写回值来源恒为本节点
 * 产物（productPath＝产物名，可带「.」深层字段路径）；key＝目标变量键
 * （模型保留、UI 不展示键字段：选择写回值时自动写值尾段）；categoryName＝
 * 目标分类名快照（全局分类不可作目标）；secret 默认开。 */
export interface ExtractWriteback {
  enabled: boolean
  productPath: string
  key: string
  categoryName: string | null
  secret: boolean
}

/** 提取规则（单条）：取值路径＋产物名；产物名供 {{节点名.产物名}} 引用。 */
export interface ExtractRule {
  path: string
  name: string
}

/** 参数提取节点配置：单来源多规则提取（来源节点级选一次，rules 逐条配
 * 取值路径＋产物名，一个节点产出多个命名产物）＋写回分支（写回值下拉
 * 列出全部产物）。历史形态（v2 散字段 / 行式 rows 图 / 旧单条提取）由
 * Rust serde 桥接读侧归一为多规则形态，前端只接收归一后的形态。 */
export interface ExtractNodeConfig {
  type: 'extract'
  source: ExtractSource
  rules: ExtractRule[]
  writeback: ExtractWriteback
}

/** 条件分支行（IF / ELSE IF）。 */
export interface ConditionBranch {
  id: string
  expression: string
}

/** 条件判断节点配置。 */
export interface ConditionNodeConfig {
  type: 'condition'
  branches: ConditionBranch[]
}

/** Join 汇聚模式。 */
export type JoinMode = 'all' | 'any'

/** Join 节点配置。 */
export interface JoinNodeConfig {
  type: 'join'
  mode: JoinMode
}

/** 延时节点配置。 */
export interface DelayNodeConfig {
  type: 'delay'
  durationMs: number
}

/** 重试节点配置。 */
export interface RetryNodeConfig {
  type: 'retry'
  maxAttempts: number
  intervalMs: number
}

/** 断言规则判别联合（行式规则，AND 组合）。 */
export type AssertRule =
  | { type: 'statusCode'; expected: string }
  | { type: 'jsonPath'; path: string; expected: string }
  | { type: 'exists'; path: string }
  | { type: 'contains'; path: string | null; value: string }

/** 断言节点配置。 */
export interface AssertNodeConfig {
  type: 'assert'
  rules: AssertRule[]
}

/** 节点配置判别联合（10 类；与 Rust `WorkflowNodeConfig` serde tag 对齐；
 * 含已移除的存变量 kind 的旧图由 Rust 读侧按图损坏拒绝）。 */
export type WorkflowNodeConfig =
  | { type: 'start' }
  | { type: 'end' }
  | RequestNodeConfig
  | ExtractNodeConfig
  | ConditionNodeConfig
  | { type: 'parallel' }
  | JoinNodeConfig
  | DelayNodeConfig
  | RetryNodeConfig
  | AssertNodeConfig

/** 工作流节点：id＝实例身份（uuid），边的端点与执行定位都以它索引。 */
export interface WorkflowNode {
  id: string
  name: string
  position: Position
  config: WorkflowNodeConfig
}

/** 工作流边：有向连线；label 用于条件分支标注（分支 id 或 DEFAULT）。 */
export interface WorkflowEdge {
  id: string
  source: string
  target: string
  label: string | null
}

/** 工作流图（graph JSON 形态）：节点＋边＋schemaVersion。 */
export interface WorkflowGraph {
  schemaVersion: number
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

/**
 * 当前图序列化版本（与 Rust GRAPH_SCHEMA_VERSION 对齐）。v3：参数提取收
 * 单来源配置（行式 rows 图与旧散字段图读侧归一），存变量节点自词表移除。
 */
export const GRAPH_SCHEMA_VERSION = 3

/**
 * 敏感值掩码字面量（与 Rust `redact::MASK` 对齐的双端常量）：导出文件中的
 * 敏感覆写值以此形态存在，导入报告据此提示用户补全。
 */
export const REDACT_MASK = '***'

/** 新建空图（当前 schema 版本）。 */
export function emptyGraph(): WorkflowGraph {
  return { schemaVersion: GRAPH_SCHEMA_VERSION, nodes: [], edges: [] }
}

/** kind 值守卫（跨边界载荷白名单校验：拖放载荷等外部输入用）。 */
export function isWorkflowNodeKind(value: unknown): value is WorkflowNodeKind {
  return (
    value === 'start' ||
    value === 'end' ||
    value === 'request' ||
    value === 'extract' ||
    value === 'condition' ||
    value === 'parallel' ||
    value === 'join' ||
    value === 'delay' ||
    value === 'retry' ||
    value === 'assert'
  )
}

/** 配置 → kind 面（渲染与校验分发的单点）。 */
export function nodeKindOf(config: WorkflowNodeConfig): WorkflowNodeKind {
  return config.type
}

/**
 * 路径尾键（产物名缺省建议值）：取最后一个点切分的尾段，引号属性段
 * （`['token']`）取引号内内容，数组下标段（`[0]`）取段前的属性名，其余
 * 剥根符与引号；无键（根符 / 空串）不产出。与 Rust `tail_key_of_path`
 * 同一口径，双端测试钉住。
 */
export function tailKeyOfPath(path: string): string {
  const trimmed = path.trim()
  if (trimmed === '') return ''
  const tail = trimmed.split('.').pop() ?? trimmed
  const bracket = tail.lastIndexOf('[')
  if (bracket >= 0) {
    const inner = tail.slice(bracket + 1).replace(/\]$/, '')
    const quoted = inner.match(/^['"](.*)['"]$/)
    if (quoted?.[1]) return quoted[1]
    const head = tail
      .slice(0, bracket)
      .replace(/^\$/, '')
      .replace(/^['"]|['"]$/g, '')
      .trim()
    return head
  }
  const stripped = tail
    .replace(/^\$/, '')
    .replace(/^['"]|['"]$/g, '')
    .trim()
  return stripped
}

/** 写回分支缺省形态（关闭；secret 默认开）。 */
export function emptyWriteback(): ExtractWriteback {
  return { enabled: false, productPath: '', key: '', categoryName: null, secret: true }
}
