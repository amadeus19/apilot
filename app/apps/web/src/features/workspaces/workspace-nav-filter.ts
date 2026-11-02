import type { WorkspaceNavIndex, WorkspaceNavNode } from './workspace-nav-dnd'

/**
 * 左栏工作空间树搜索过滤（纯函数，与接口树 selector 同构）：匹配
 * 工作空间名与服务名（不区分大小写），命中服务行时父工作空间行保留
 * （两级树的命中祖先只有一个层级）；空查询返回 null＝不过滤。
 */

/** 过滤结果：可见子图索引 + 命中父级（自动展开集）+ 命中标记 */
export interface WorkspaceNavFilterResult {
  /** 过滤可见子图（只含命中行与其父工作空间行之间的边） */
  index: WorkspaceNavIndex
  /** 命中服务行的父工作空间 id（进入过滤时自动展开，保证命中项可见） */
  ancestorsToExpand: string[]
  hasMatches: boolean
}

/** 过滤树：不命中行不显示，命中服务行的父工作空间保留；空查询返回 null（非过滤） */
export function filterWorkspaceNav(
  index: WorkspaceNavIndex,
  rawQuery: string,
): WorkspaceNavFilterResult | null {
  const query = rawQuery.trim().toLowerCase()
  if (query === '') return null

  const matchIds = new Set<string>()
  for (const node of index.nodes.values()) {
    if (node.name.toLowerCase().includes(query)) matchIds.add(node.id)
  }

  // 可见集＝命中行 ∪ 命中服务行的父工作空间
  const visible = new Set<string>(matchIds)
  const ancestorsToExpand: string[] = []
  for (const id of matchIds) {
    const node = index.nodes.get(id)
    if (node?.kind === 'service' && !visible.has(node.workspaceId)) {
      visible.add(node.workspaceId)
      ancestorsToExpand.push(node.workspaceId)
    }
  }

  const nodes = new Map<string, WorkspaceNavNode>()
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
    index: { nodes, childrenOf, rootChildren },
    ancestorsToExpand,
    hasMatches: matchIds.size > 0,
  }
}

/** 进入过滤模式的展开合并（纯函数）：基线展开 ∪ 命中父级 */
export function expandNavForFilter(baseExpanded: string[], ancestorsToExpand: string[]): string[] {
  if (ancestorsToExpand.length === 0) return baseExpanded
  return Array.from(new Set([...baseExpanded, ...ancestorsToExpand]))
}
