import { expandObservedFields } from '../extract-observed'
import { isTextBodyKind, parseBodyDraft } from '@/features/workbench/body-envelope'
import type { OverrideRow, WorkflowGraph, WorkflowNode } from '../workflow-model'

/**
 * 请求节点入参编辑期纯派生：上游提取产物引用候选（值输入下拉的数据面，
 * 按连线识别上游——引用写 `{{产物名}}` / `{{产物名.字段}}` 裸键，可见范围
 * ＝本请求节点直接上游提取节点的输出）与预填行投影（定义参数行 ∪ 自由
 * 覆写行、路径模板参数行）。候选与投影都是显示层派生——落库形态只有
 * 覆写行（OverrideRow）与体文本，编辑落库走 upsert 单点，无新增结构，
 * 手改引用不冲突。不含 React，供 RequestEditor 与测试共用。编辑模型与
 * 执行模型严格分离：本模块只读编辑态图与接口定义参数，实测数据（最近
 * 执行掩码响应体的解析根）由调用方注入。
 */

/** 入边一跳扫描单点：`nodeId` 的直接上游中 kind 命中的节点（按图边序、
 * 节点序去重；id → 节点经索引直查）。上游识别两路（提取节点集 / 请求
 * 节点锚）共用同一扫描，口径不出现第二份。 */
function upstreamNodesOfKind(
  graph: WorkflowGraph,
  nodeId: string,
  kind: WorkflowNode['config']['type'],
): WorkflowNode[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const found: WorkflowNode[] = []
  for (const edge of graph.edges) {
    if (edge.target !== nodeId) continue
    const node = byId.get(edge.source)
    if (node?.config.type === kind && !found.includes(node)) {
      found.push(node)
    }
  }
  return found
}

/** 当前请求节点的直接上游提取节点 id（入边一跳；图节点序去重） */
export function upstreamExtractNodeIds(graph: WorkflowGraph, requestId: string): string[] {
  return upstreamNodesOfKind(graph, requestId, 'extract').map((node) => node.id)
}

/** 提取节点的上游请求节点 id（实测响应体的定位锚；无图或无上游请求＝null） */
export function extractUpstreamRequestId(
  graph: WorkflowGraph | undefined,
  extractNodeId: string,
): string | null {
  if (!graph) return null
  return upstreamNodesOfKind(graph, extractNodeId, 'request')[0]?.id ?? null
}

/**
 * 候选收集（去重展平）：顶层候选＝直接上游提取节点逐规则产物裸名
 * （`产物名`）；Body 源的对象 / 数组产物经实测根一层展开深层字段
 * （`产物名.键`，数组产物为 `产物名.0.键`），无实测数据只出顶层。产物名
 * 为空不出候选（模板无从引用；产物名缺失由校验面板另报）。候选序＝上游
 * 节点序逐规则展开，同引用只出一次。
 */
export function collectMappingCandidates(
  graph: WorkflowGraph,
  requestId: string,
  observedRoots: ReadonlyMap<string, unknown | null>,
): string[] {
  const seen = new Set<string>()
  const candidates: string[] = []
  const addRef = (ref: string) => {
    if (!seen.has(ref)) {
      seen.add(ref)
      candidates.push(ref)
    }
  }
  for (const nodeId of upstreamExtractNodeIds(graph, requestId)) {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId)
    if (node == null || node.config.type !== 'extract') continue
    const observedRoot = observedRoots.get(nodeId) ?? null
    const config = node.config
    for (const rule of config.rules) {
      const productName = rule.name.trim()
      if (productName === '') continue
      addRef(productName)
      if (config.source === 'jsonPath') {
        for (const field of expandObservedFields(productName, rule.path, observedRoot)) {
          addRef(field)
        }
      }
    }
  }
  return candidates
}

// —— 预填行投影与覆写行 upsert（定义参数预填 / 路径模板字段的显示派生）——

/** 接口定义的 query 参数（doc parameters location=query 的编辑面投影） */
export interface QueryDefinedParam {
  name: string
  /** 必填标记（只作视觉呈现，不阻断保存——校验口径不变） */
  required: boolean
}

/** query 区显示行：定义参数行（名称固定、恒显示、可清空）与自由覆写行 */
export interface QueryDisplayRow {
  name: string
  required: boolean
  /** 当前值：定义行取落库同名行值（无＝空＝不覆写），自由行即行值 */
  value: string
  /** true＝定义参数行（无删除钮，删除语义＝清空值）；false＝自由行 */
  defined: boolean
  /** 自由行在落库行集中的下标（删行定位）；定义行恒 -1 */
  rowIndex: number
}

/**
 * query 区显示行投影：定义参数行在前（doc parameters 序），值取落库同名行
 * （无同名行＝空＝不覆写该参数）；落库行中定义外的自由行按原序缀后。纯
 * 派生不落库——用户在定义行输入值时才经 upsert 进落库行集，重绑换接口后
 * 定义行随之切换（重绑＝新配置播种的显示面）。
 */
export function displayQueryRows(
  query: readonly OverrideRow[],
  definedParams: readonly QueryDefinedParam[],
): QueryDisplayRow[] {
  const definedNames = new Set(definedParams.map((param) => param.name))
  const rows: QueryDisplayRow[] = definedParams.map((param) => ({
    ...param,
    value: query.find((row) => row.name === param.name)?.value ?? '',
    defined: true,
    rowIndex: -1,
  }))
  query.forEach((row, index) => {
    if (!definedNames.has(row.name)) {
      rows.push({
        name: row.name,
        required: false,
        value: row.value,
        defined: false,
        rowIndex: index,
      })
    }
  })
  return rows
}

/** path 区显示行：模板参数名（定义侧）＋落库同名行值（无＝空＝不填充） */
export interface PathDisplayRow {
  name: string
  value: string
}

/**
 * path 区显示行投影：稳定键路径模板的 `{param}` 段逐参数一行，值取落库
 * pathParams 同名行（无同名行＝空＝不填充，占位洞执行期原样保留）。无
 * 模板参数＝空集（调用方整区不渲染）。纯派生不落库，与 query 预填同一
 * upsert 通道。
 */
export function displayPathRows(
  pathParams: readonly OverrideRow[],
  templateParams: readonly string[],
): PathDisplayRow[] {
  return templateParams.map((name) => ({
    name,
    value: pathParams.find((row) => row.name === name)?.value ?? '',
  }))
}

/**
 * 覆写行 upsert 单点（定义参数行与 path 行的落库通道）：值非空＝同名行
 * upsert（无行追加、有行改值）；值空白＝移除同名行——「行值空＝不覆写该
 * 参数」的落库形态（无行即无覆写，引擎对残留空白行同样跳过）。行序保持
 * 既有行位置，新行缀尾。
 */
export function upsertOverrideValue(
  rows: readonly OverrideRow[],
  name: string,
  value: string,
): OverrideRow[] {
  if (value.trim() === '') {
    return rows.filter((row) => row.name !== name)
  }
  const hit = rows.find((row) => row.name === name)
  if (hit) {
    return rows.map((row) => (row.name === name ? { ...row, value } : row))
  }
  return [...rows, { name, value }]
}

/**
 * body 预填文本（节点 body 从未编辑时的显示面）：接口用户数据 body 的
 * 文本载体（信封 text 系与旧纯文本原文）优先，无则定义侧请求体 example
 * 的序列化文本，都无＝空串。form 系行载体无法进纯文本覆写面，静默降级
 * 为不预填（空串，不弹错）。预填只是显示派生——落库形态保持 config.body
 * 为 null，用户编辑（含清空）才落字符串，无渲染期回灌。
 */
export function prefilledBodyText(
  userDataBody: string | null | undefined,
  requestBodyExample: unknown,
): string {
  if (userDataBody != null && userDataBody !== '') {
    const draft = parseBodyDraft(userDataBody)
    return isTextBodyKind(draft.kind) ? draft.text : ''
  }
  if (requestBodyExample != null) {
    try {
      return JSON.stringify(requestBodyExample, null, 2) ?? ''
    } catch {
      return ''
    }
  }
  return ''
}
