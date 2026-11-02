import type { TreeDropMode } from '@workspace/ui/components'

import { navDropModeAt } from '@/lib/use-nav-drag-sort'

/**
 * 左栏两级导航树（工作空间›服务）的拖拽落点判定（纯函数，可单测）。
 *
 * 层级约束：工作空间只能在根层序列内重排（一次到位的整批有序 id 表）；
 * 服务只能在所属工作空间的服务序列内重排（摘除自身后的插入位）。两级
 * 树无容器落点（inside 一律拒绝）：跨空间、跨层级、未知 id、自拖自均
 * 不可落；中段悬停按上下半分折算为 before / after（单点在共享协议层
 * navDropModeAt）。
 */

/** 树节点数据：工作空间行（folder）与服务行（leaf） */
export type WorkspaceNavNode =
  | { kind: 'workspace'; id: string; name: string; isCurrent: boolean }
  | { kind: 'service'; id: string; workspaceId: string; name: string; docUrl: string | null }

/** 两级导航树索引：节点表 + 根序（工作空间序）+ 组内序（空间内服务序） */
export interface WorkspaceNavIndex {
  nodes: Map<string, WorkspaceNavNode>
  /** 根层工作空间 id 序 */
  rootChildren: string[]
  /** 工作空间 id → 其下服务 id 序 */
  childrenOf: Map<string, string[]>
}

/** 一条可执行的排序动作（与排序 IPC 参数一一对应） */
export type WorkspaceNavDropAction =
  { kind: 'workspace'; orderedIds: string[] } | { kind: 'service'; id: string; index: number }

/**
 * 计算拖拽落点：返回 null＝此处不可落（不显示指示器、不触发落下）；
 * 返回值携带指示器形态与可直接下发 IPC 的动作。
 */
export function computeNavDrop(
  source: WorkspaceNavNode,
  target: WorkspaceNavNode,
  /** 悬停点在目标行内的纵向比例（0 顶 1 底） */
  ratio: number,
  index: WorkspaceNavIndex,
): { indicator: TreeDropMode; action: WorkspaceNavDropAction } | null {
  if (source.id === target.id) return null

  if (source.kind === 'workspace') {
    // 工作空间仅根层 before/after：未知源 id（占位行）同样拒绝
    if (target.kind !== 'workspace') return null
    if (!index.rootChildren.includes(source.id)) return null
    const order = index.rootChildren.filter((id) => id !== source.id)
    const at = order.indexOf(target.id)
    if (at < 0) return null
    const mode = navDropModeAt(ratio)
    const orderedIds = [...order]
    orderedIds.splice(mode === 'before' ? at : at + 1, 0, source.id)
    return { indicator: mode, action: { kind: 'workspace', orderedIds } }
  }

  // 服务仅同工作空间内 before/after；index 为摘除自身后的插入位
  // （与 service.move_to 口径一致）。未知源 id（占位行 / 空间无此服务）与
  // 跨空间目标均拒绝
  const group = index.childrenOf.get(source.workspaceId) ?? []
  if (!group.includes(source.id)) return null
  if (target.kind !== 'service' || target.workspaceId !== source.workspaceId) return null
  const siblings = group.filter((id) => id !== source.id)
  const at = siblings.indexOf(target.id)
  if (at < 0) return null
  const mode = navDropModeAt(ratio)
  return {
    indicator: mode,
    action: { kind: 'service', id: source.id, index: mode === 'before' ? at : at + 1 },
  }
}
