/**
 * 第五视图导航树归约（纯函数，单测点）：工作流清单＋分组清单＋搜索词 →
 * 树索引。树形＝分组（组间序）→ 组内工作流（清单序）→ 未分组工作流
 * （清单序，尾置平铺）。
 *
 * 搜索口径：工作流按名称子串过滤（不区分大小写，与全应用搜索契约一致）；
 * 组内无命中工作流的分组整组隐去（搜索结果不出现空组壳）。
 */

import type { WorkflowGroupDto, WorkflowSummaryDto } from './workflow-api'

/** 树行节点（分组行 / 工作流行二态） */
export type WorkflowNavNode =
  { kind: 'group'; id: string; name: string } | { kind: 'workflow'; id: string; name: string }

/** 树索引（dataLoader 形状的同步视图；组件每渲染由 memo 派生） */
export interface WorkflowNavIndex {
  nodes: Map<string, WorkflowNavNode>
  /** 根子级序：分组（组间序）在前，未分组工作流（清单序）尾置 */
  rootChildren: string[]
  /** 分组 id → 组内工作流 id（清单序；仅收录搜索命中的行） */
  groupChildren: Map<string, string[]>
}

/**
 * 清单＋分组＋搜索词 → 树索引。分组不在清单中的工作流（数据刷新瞬间的
 * 过渡态）按未分组归位，不丢行。
 */
export function buildWorkflowNavIndex(
  items: readonly WorkflowSummaryDto[],
  groups: readonly WorkflowGroupDto[],
  keyword: string,
): WorkflowNavIndex {
  const normalized = keyword.trim().toLowerCase()
  const nodes = new Map<string, WorkflowNavNode>()
  const groupChildren = new Map<string, string[]>()

  for (const group of groups) {
    nodes.set(group.id, { kind: 'group', id: group.id, name: group.name })
    groupChildren.set(group.id, [])
  }

  const ungrouped: string[] = []
  for (const item of items) {
    if (normalized !== '' && !item.name.toLowerCase().includes(normalized)) continue
    nodes.set(item.id, { kind: 'workflow', id: item.id, name: item.name })
    const bucket = item.groupId != null ? groupChildren.get(item.groupId) : undefined
    if (bucket) {
      bucket.push(item.id)
    } else {
      ungrouped.push(item.id)
    }
  }

  // 搜索期空组隐去（组内无命中行就不出组壳）；非搜索期空分组照常显示
  const rootChildren: string[] = []
  for (const group of groups) {
    const children = groupChildren.get(group.id) ?? []
    if (normalized !== '' && children.length === 0) {
      groupChildren.delete(group.id)
      nodes.delete(group.id)
      continue
    }
    rootChildren.push(group.id)
  }
  rootChildren.push(...ungrouped)

  return { nodes, rootChildren, groupChildren }
}
