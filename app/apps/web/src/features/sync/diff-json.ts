/**
 * 同步 diff 的纯函数工具：Monaco JSON diff 的旧 / 新两侧文本重建＋确认段
 * 的跨服务聚合 / 分组 / 稳定键拆解。
 *
 * 文本重建：行级双快照按契约声明序序列化——Added 行只进新侧、Removed 行
 * 只进旧侧、Unchanged 行两侧同值（变更即行级高亮）。序列化恒
 * `JSON.stringify(x, null, 2)`：TS 对象保插入序，与「Rust struct 声明序＋
 * 空值省略」锚定口径一致（双端 fixture 钉住），键序稳定无噪声。
 */

import type {
  BodyKeyChange,
  DiffKind,
  DiffOutcome,
  DiffSummary,
  EndpointDiff,
  KeySnap,
  ParamChange,
  ResponseChange,
} from './diff-contract'

/** 单接口的旧 / 新 JSON 文本对（DiffEditor 的 original / modified） */
export interface JsonTextPair {
  original: string
  modified: string
}

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/** 参数页签：name → 参数快照对象（两侧按对齐序同构） */
export function paramsJsonText(params: readonly ParamChange[]): JsonTextPair {
  const original: Record<string, unknown> = {}
  const modified: Record<string, unknown> = {}
  for (const row of params) {
    if (row.old !== undefined) original[row.name] = row.old
    if (row.new !== undefined) modified[row.name] = row.new
  }
  return { original: serialize(original), modified: serialize(modified) }
}

/** 响应页签：status → { description, keys }（key 级明细嵌套同构） */
export function responsesJsonText(responses: readonly ResponseChange[]): JsonTextPair {
  const original: Record<string, unknown> = {}
  const modified: Record<string, unknown> = {}
  for (const row of responses) {
    if (row.oldDescription !== undefined || row.keys.length > 0) {
      original[row.status] = responseNode(row, 'old')
    }
    if (row.newDescription !== undefined || row.keys.length > 0) {
      modified[row.status] = responseNode(row, 'new')
    }
  }
  return { original: serialize(original), modified: serialize(modified) }
}

function responseNode(row: ResponseChange, side: 'old' | 'new'): Record<string, unknown> {
  const node: Record<string, unknown> = {}
  const description = side === 'old' ? row.oldDescription : row.newDescription
  if (description !== undefined) node.description = description
  const keys: Record<string, KeySnap> = {}
  for (const key of row.keys) {
    const snap = side === 'old' ? key.old : key.new
    if (snap !== undefined) keys[key.keyPath] = snap
  }
  node.keys = keys
  return node
}

/**
 * 请求体 Schema diff 折叠区：扁平点路径行重建嵌套骨架形状（`[]` 段保持
 * 原样作为 items 键标识），叶子值＝类型快照（schemaType / required）。
 * 两侧各自成树：行缺失侧自然无该分支（增删行级高亮）。
 */
export function bodySchemaJsonText(bodyKeys: readonly BodyKeyChange[]): JsonTextPair {
  const original: Record<string, unknown> = {}
  const modified: Record<string, unknown> = {}
  for (const row of bodyKeys) {
    const segments = row.keyPath.split('.')
    if (row.old !== undefined) insertPath(original, segments, row.old)
    if (row.new !== undefined) insertPath(modified, segments, row.new)
  }
  return { original: serialize(original), modified: serialize(modified) }
}

function insertPath(root: Record<string, unknown>, segments: string[], snap: KeySnap): void {
  let node = root
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!
    let child: unknown = node[segment]
    if (typeof child !== 'object' || child === null) {
      child = {}
      node[segment] = child
    }
    node = child as Record<string, unknown>
  }
  node[segments[segments.length - 1]!] = snap
}

/** 变更计数（行芯片：增 / 删 / 改，Unchanged 不计） */
export function changeCounts(changes: {
  params?: readonly ParamChange[]
  bodyKeys?: readonly BodyKeyChange[]
  responses?: readonly ResponseChange[]
}): { added: number; removed: number; changed: number } {
  let added = 0
  let removed = 0
  let changed = 0
  const tally = (change: string | undefined): void => {
    if (change === 'added') added += 1
    else if (change === 'removed') removed += 1
    else if (change === 'changed') changed += 1
  }
  for (const p of changes.params ?? []) tally(p.change)
  for (const b of changes.bodyKeys ?? []) tally(b.change)
  for (const r of changes.responses ?? []) tally(r.change)
  return { added, removed, changed }
}

/**
 * 稳定键拆解（`GET /users` → 方法＋路径）。键规则事实源＝Rust
 * `Definition::stable_key`（`方法 + 空格 + 路由模板`，方法恒规范化大写、
 * 路由模板不含空白）——恰好一个空格，首空格即分界。
 */
export function splitStableKey(key: string): { method: string; path: string } {
  const index = key.indexOf(' ')
  return { method: key.slice(0, index), path: key.slice(index + 1) }
}

/** 跨服务汇总聚合（确认段主级三芯片与次级注记的数据源；多服务计数相加） */
export function aggregateTotals(diffs: readonly DiffOutcome[]): DiffSummary {
  return diffs.reduce<DiffSummary>(
    (acc, diff) => ({
      added: acc.added + diff.summary.added,
      changed: acc.changed + diff.summary.changed,
      removed: acc.removed + diff.summary.removed,
      unchanged: acc.unchanged + diff.summary.unchanged,
    }),
    { added: 0, changed: 0, removed: 0, unchanged: 0 },
  )
}

/** 跨服务按种类抽取 diff 行（serviceId 随行——多服务同名稳定键不混淆） */
export function groupDiffsByKind(
  diffs: readonly DiffOutcome[],
  kind: DiffKind,
): { serviceId: string; diff: EndpointDiff }[] {
  return diffs.flatMap((outcome) =>
    outcome.diffs
      .filter((d) => d.kind === kind)
      .map((d) => ({ serviceId: outcome.serviceId, diff: d })),
  )
}
