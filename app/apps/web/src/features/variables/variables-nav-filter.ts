import type { VariableNavIndex, VariableNavNode } from './variables-nav-dnd'

/**
 * 左栏变量树搜索过滤（纯函数，仿接口树 selector.filterApiTree 口径）：
 * 匹配分类名与变量 key（不区分大小写），非匹配行隐藏而非高亮；命中变量
 * 行时其父分类行保留，可见子图只保留可见节点间的边；空查询返回 null＝
 * 非过滤模式（用全量索引）。
 */

/** 过滤结果：命中行的可见子图（消费方据此替换树索引与展开集） */
export interface VariablesNavFilterResult {
  index: VariableNavIndex
  /** 命中变量的父分类 id 并集（进入过滤时自动展开，保证命中项可见） */
  ancestorsToExpand: string[]
  hasMatches: boolean
}

/** 过滤变量树：不命中行不显示，命中变量的父分类保留；空查询返回 null（非过滤） */
export function filterVariablesNav(
  index: VariableNavIndex,
  rawQuery: string,
): VariablesNavFilterResult | null {
  const query = rawQuery.trim().toLowerCase()
  if (query === '') return null

  const matchIds = new Set<string>()
  for (const node of index.nodes.values()) {
    if (node.name.toLowerCase().includes(query)) matchIds.add(node.id)
  }

  // 可见集＝命中行 ∪ 命中变量的父分类（两级树祖先链只有一层）
  const visible = new Set<string>(matchIds)
  const ancestorsToExpand: string[] = []
  for (const id of matchIds) {
    const node = index.nodes.get(id)
    if (node?.kind !== 'variable') continue
    if (!visible.has(node.categoryId)) {
      visible.add(node.categoryId)
      ancestorsToExpand.push(node.categoryId)
    }
  }

  const nodes = new Map<string, VariableNavNode>()
  const childrenOf = new Map<string, string[]>()
  const rootChildren: string[] = []
  for (const id of visible) {
    const node = index.nodes.get(id)
    if (!node) continue
    nodes.set(id, node)
    const children = (index.childrenOf.get(id) ?? []).filter((childId) => visible.has(childId))
    childrenOf.set(id, children)
  }
  for (const id of index.rootChildren) {
    if (visible.has(id)) rootChildren.push(id)
  }

  return {
    index: { nodes, rootChildren, childrenOf },
    ancestorsToExpand,
    hasMatches: matchIds.size > 0,
  }
}

/** 进入过滤模式的展开合并（纯函数）：基线展开 ∪ 命中变量的父分类 */
export function expandForVariablesFilter(
  baseExpanded: string[],
  ancestorsToExpand: string[],
): string[] {
  if (ancestorsToExpand.length === 0) return baseExpanded
  return Array.from(new Set([...baseExpanded, ...ancestorsToExpand]))
}
