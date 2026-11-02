import type { TreeDropMode } from '@workspace/ui/components'

import {
  PINNED_GROUP_ID,
  makeServiceNodeId,
  parseCategoryNodeId,
  parseServiceNodeId,
  type ApiTreeIndex,
  type ApiTreeNode,
} from './selector'

/**
 * 接口树拖拽落点判定（纯函数，可单测）。
 *
 * 层级约束：分类只能在分类序列内移动（可跨服务，服务直属、不嵌套）；
 * 接口只能在同服务的接口分组内移动（散层 ↔ 分类）；服务只能在工作空间
 * 服务序列内重排。置顶组是虚拟视图（组内行的真实位置在原分组），不参与
 * 拖拽；「进入」语义（inside）只对 接口→分类/服务、分类→服务 成立，
 * 其余目标的中段悬停按上下半分折算为 before / after。
 */

/** 一条可执行的拖拽落点动作（与树 IPC 参数一一对应） */
export type TreeDropAction =
  | { kind: 'endpoint'; serviceId: string; categoryId: string | null; index: number }
  | { kind: 'category'; id: string; targetServiceId: string; index: number }
  | { kind: 'service'; id: string; index: number }

/** 悬停位置 → 落点意图：容器目标分三分，其余按上下半分 */
export function treeDropModeAt(acceptsInside: boolean, ratio: number): TreeDropMode {
  if (!acceptsInside) return ratio < 0.5 ? 'before' : 'after'
  if (ratio < 1 / 3) return 'before'
  if (ratio > 2 / 3) return 'after'
  return 'inside'
}

/** 接口分组序（排除被拖项后）：分类组取分类子级，散层取服务子级中的接口 */
function endpointGroupSiblings(
  index: ApiTreeIndex,
  groupNodeId: string,
  excludeId: string,
): ApiTreeNode[] {
  return (index.childrenOf.get(groupNodeId) ?? [])
    .filter((id) => id !== excludeId)
    .map((id) => index.nodes.get(id))
    .filter((node): node is ApiTreeNode => node?.kind === 'endpoint')
}

/** 目标服务的分类序列（排除被拖项后） */
function categorySiblings(
  index: ApiTreeIndex,
  serviceId: string,
  excludeId: string,
): ApiTreeNode[] {
  const groupNodeId = makeServiceNodeId(serviceId)
  return (index.childrenOf.get(groupNodeId) ?? [])
    .filter((id) => id !== excludeId)
    .map((id) => index.nodes.get(id))
    .filter((node): node is ApiTreeNode => node?.kind === 'category')
}

/**
 * 计算拖拽落点：返回 null＝此处不可落（不显示指示器）；
 * 返回值携带指示器形态与可直接下发 IPC 的动作。
 */
export function computeTreeDrop(
  source: ApiTreeNode,
  target: ApiTreeNode,
  /** 悬停点在目标行内的纵向比例（0 顶 1 底） */
  ratio: number,
  index: ApiTreeIndex,
): { indicator: TreeDropMode; action: TreeDropAction } | null {
  if (source.id === target.id) return null
  if (target.kind === 'pinnedGroup') return null
  if (source.parentIds.includes(PINNED_GROUP_ID)) return null

  if (source.kind === 'endpoint') {
    if (!source.serviceId || !source.key) return null
    if (target.kind === 'category') {
      // 进目标分类（限同服务）：整行都视为进入
      const categoryId = parseCategoryNodeId(target.id)
      if (!categoryId || target.parentIds[0] !== makeServiceNodeId(source.serviceId)) return null
      return {
        indicator: 'inside',
        action: {
          kind: 'endpoint',
          serviceId: source.serviceId,
          categoryId,
          index: endpointGroupSiblings(index, target.id, source.id).length,
        },
      }
    }
    if (target.kind === 'service') {
      // 进散层（限同服务）
      const serviceId = parseServiceNodeId(target.id)
      if (!serviceId || serviceId !== source.serviceId) return null
      return {
        indicator: 'inside',
        action: {
          kind: 'endpoint',
          serviceId,
          categoryId: null,
          index: endpointGroupSiblings(index, target.id, source.id).length,
        },
      }
    }
    if (target.kind === 'endpoint') {
      // 插到目标接口前 / 后（限同服务同层级语义：目标所在分组）
      if (!target.serviceId || target.serviceId !== source.serviceId) return null
      const groupNodeId = target.parentIds[0] ?? ''
      if (groupNodeId === PINNED_GROUP_ID) return null
      const siblings = endpointGroupSiblings(index, groupNodeId, source.id)
      const at = siblings.findIndex((node) => node.id === target.id)
      if (at < 0) return null
      const mode = treeDropModeAt(false, ratio)
      return {
        indicator: mode,
        action: {
          kind: 'endpoint',
          serviceId: source.serviceId,
          categoryId: target.categoryId ?? null,
          index: mode === 'before' ? at : at + 1,
        },
      }
    }
    return null
  }

  if (source.kind === 'category') {
    const categoryId = parseCategoryNodeId(source.id)
    if (!categoryId) return null
    if (target.kind === 'category') {
      // 插到目标分类前 / 后（目标分类所属服务，可跨服务）
      const targetServiceId = parseServiceNodeId(target.parentIds[0] ?? '')
      if (!targetServiceId) return null
      const siblings = categorySiblings(index, targetServiceId, source.id)
      const at = siblings.findIndex((node) => node.id === target.id)
      if (at < 0) return null
      const mode = treeDropModeAt(false, ratio)
      return {
        indicator: mode,
        action: {
          kind: 'category',
          id: categoryId,
          targetServiceId,
          index: mode === 'before' ? at : at + 1,
        },
      }
    }
    if (target.kind === 'service') {
      // 进目标服务的分类序列末尾
      const targetServiceId = parseServiceNodeId(target.id)
      if (!targetServiceId) return null
      return {
        indicator: 'inside',
        action: {
          kind: 'category',
          id: categoryId,
          targetServiceId,
          index: categorySiblings(index, targetServiceId, source.id).length,
        },
      }
    }
    return null
  }

  if (source.kind === 'service') {
    const serviceId = parseServiceNodeId(source.id)
    if (!serviceId || target.kind !== 'service') return null
    const at = index.rootChildren.filter((id) => id !== source.id).indexOf(target.id)
    if (at < 0) return null
    const mode = treeDropModeAt(false, ratio)
    return {
      indicator: mode,
      action: { kind: 'service', id: serviceId, index: mode === 'before' ? at : at + 1 },
    }
  }

  return null
}
