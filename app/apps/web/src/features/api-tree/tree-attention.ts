import { useTreeExpandedStore } from './tree-state.store'
import type { ApiTreeIndex } from './selector'

/**
 * 树注意力内核：把树的注意力引到某节点——展开其祖先链（与既有展开
 * 合并去重）并选中目标行。「激活 Tab 跟随」与「外部定位」两条路径共用；
 * 是否清过滤等路径差异由调用方叠加，展开合并只此一份。
 */

/** 展开祖先并选中；节点未知（过滤子图外 / 数据未达）时不动作 */
export function focusTreeNode(index: ApiTreeIndex | null, nodeId: string): void {
  const node = index?.nodes.get(nodeId)
  if (!node) return
  const state = useTreeExpandedStore.getState()
  const base = state.expandedIds
  const missing = node.parentIds.filter((id) => !base.includes(id))
  if (missing.length > 0) state.setExpanded([...base, ...missing])
  state.setActiveNode(nodeId)
}
