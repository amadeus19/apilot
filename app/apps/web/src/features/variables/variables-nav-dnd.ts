import type { TreeDropMode } from '@workspace/ui/components'

import { navDropModeAt } from '@/lib/use-nav-drag-sort'

/**
 * 左栏变量树（分类›变量）分类排序的拖拽落点判定（纯函数，可单测）。
 *
 * 层级约束：只有分类行可拖、可作落点；分类排序在本层 scope 内进行——
 * 全局组与当前空间组是树上的两个固定区，跨区、未知 id、自拖自均不可落；
 * 变量行不参与排序（变量无排序命令，序＝落库序）。中段悬停按上下半分
 * 折算为 before / after（单点在共享协议层 navDropModeAt），动作 index
 * 为摘除自身后的插入位（与 variable.move_category 口径一致）。
 */

/** 树节点数据：分类行（folder）与变量键行（leaf）（variables-view 消费） */
export type VariableNavNode =
  | {
      kind: 'category'
      id: string
      name: string
      isGlobal: boolean
      /** 激活态（清单视图直读后随节点下传，行渲染不再自订查询） */
      activated: boolean
    }
  | {
      kind: 'variable'
      id: string
      /** 行显示名＝变量 key */
      name: string
      categoryId: string
      secret: boolean
    }

/** 两级导航树索引：节点表 + 根序（全局区在前、本空间区在后）+ 分类内变量序 */
export interface VariableNavIndex {
  nodes: Map<string, VariableNavNode>
  rootChildren: string[]
  childrenOf: Map<string, string[]>
}

/** 一条可执行的排序动作（与 variable.move_category 参数一一对应） */
export interface VariableNavDropAction {
  kind: 'category'
  id: string
  index: number
}

/** 分类所在 scope（全局组 / 本空间组）内的显示序（树根序过滤同区分类） */
export function categoryScopeOrder(index: VariableNavIndex, isGlobal: boolean): string[] {
  return index.rootChildren.filter((id) => {
    const node = index.nodes.get(id)
    return node?.kind === 'category' && node.isGlobal === isGlobal
  })
}

/**
 * 计算拖拽落点：返回 null＝此处不可落（不显示指示器、不触发落下）；
 * 返回值携带指示器形态与可直接下发的排序动作。
 */
export function computeVariablesNavDrop(
  source: VariableNavNode,
  target: VariableNavNode,
  /** 悬停点在目标行内的纵向比例（0 顶 1 底） */
  ratio: number,
  index: VariableNavIndex,
): { indicator: TreeDropMode; action: VariableNavDropAction } | null {
  if (source.kind !== 'category' || target.kind !== 'category') return null
  if (source.id === target.id || source.isGlobal !== target.isGlobal) return null
  const scope = categoryScopeOrder(index, source.isGlobal)
  if (!scope.includes(source.id)) return null
  const siblings = scope.filter((id) => id !== source.id)
  const at = siblings.indexOf(target.id)
  if (at < 0) return null
  const mode = navDropModeAt(ratio)
  return {
    indicator: mode,
    action: { kind: 'category', id: source.id, index: mode === 'before' ? at : at + 1 },
  }
}
