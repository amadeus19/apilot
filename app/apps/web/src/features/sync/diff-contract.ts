/**
 * 同步 diff 契约的 TS 镜像（`sync.diff` IPC 载荷）。
 *
 * 键序与空值省略口径由双端夹具钉住（`src/test/fixtures/sync-diff-contract.json`，
 * Rust 侧 `domain/sync/diff.rs` 锚定测试共享同一份表）——任一端改契约
 * 声明序或空值省略口径，另一端立红。前端 Monaco JSON diff 的旧 / 新两侧
 * 文本按本契约重建（行级 old / new 双快照：Added 行只进新侧、Removed 只进
 * 旧侧、Unchanged 行两侧同值）。
 */

/** 接口级变更种类（Unchanged 接口不产 EndpointDiff 行，只进 summary 计数） */
export type DiffKind = 'added' | 'changed' | 'removed'

/** 明细行级变更种类（参数 / 请求体 key / 响应行通用） */
export type RowChange = 'added' | 'removed' | 'changed' | 'unchanged'

/** 参数快照（行级 old / new 载荷；example 不进 diff 契约） */
export interface ParamSnap {
  location: string
  required: boolean
  paramType: string
  format?: string
  description?: string
}

/** 请求体 / 响应 schema 的叶子 key 快照（粒度＝类型 + required） */
export interface KeySnap {
  schemaType: string
  required: boolean
}

/** 参数行（全量行含 Unchanged；Added 行无 old、Removed 行无 new） */
export interface ParamChange {
  name: string
  change: RowChange
  old?: ParamSnap
  new?: ParamSnap
}

/** 请求体 key 行（keyPath 为嵌套点路径，array 元素以 `[]` 后缀展开） */
export interface BodyKeyChange {
  keyPath: string
  change: RowChange
  old?: KeySnap
  new?: KeySnap
}

/** 响应行（行＝状态码；keys 为该状态码 schema 的 key 级明细） */
export interface ResponseChange {
  status: string
  change: RowChange
  oldDescription?: string
  newDescription?: string
  keys: BodyKeyChange[]
}

/** 单接口 diff（Removed 接口明细为空集，呈现走保留卡不用 diff） */
export interface EndpointDiff {
  key: string
  kind: DiffKind
  title: string
  category: string
  params: ParamChange[]
  bodyKeys: BodyKeyChange[]
  responses: ResponseChange[]
}

/** 单服务 diff 汇总（多服务聚合与服务级计数归向导编排层） */
export interface DiffSummary {
  added: number
  changed: number
  removed: number
  unchanged: number
}

/** `sync.diff` IPC 载荷 */
export interface DiffOutcome {
  serviceId: string
  generation: number
  summary: DiffSummary
  diffs: EndpointDiff[]
}
