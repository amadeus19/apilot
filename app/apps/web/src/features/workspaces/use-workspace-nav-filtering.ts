import * as React from 'react'

import { useWorkspacesStore } from './workspaces.store'
import { expandNavForFilter, type WorkspaceNavFilterResult } from './workspace-nav-filter'

/**
 * 工作空间树过滤接线（树展开会话态之上的快照机，与接口树 useTreeFiltering
 * 同构，读写 useWorkspacesStore.treeExpandedIds）：
 * - 进入过滤模式：快照当前展开（清除时恢复），命中服务行的父工作空间自动
 *   展开（并集；过滤中用户的手动折叠随查询变化被重展开）；
 * - 清除过滤：恢复快照；
 * - 过滤中的手动折叠不落快照（快照只在进入那一刻定格）。
 */
export function useWorkspaceNavFiltering(
  filterActive: boolean,
  filterResult: WorkspaceNavFilterResult | null,
): void {
  const setTreeExpandedIds = useWorkspacesStore((s) => s.setTreeExpandedIds)
  const snapshotRef = React.useRef<string[] | null>(null)
  const prevFilterActiveRef = React.useRef(false)

  React.useEffect(() => {
    const wasActive = prevFilterActiveRef.current
    if (filterActive && !wasActive) {
      snapshotRef.current = useWorkspacesStore.getState().treeExpandedIds
    }
    if (filterActive && filterResult) {
      // 同内容不重复写入：本 effect 会随过滤结果引用变化重跑（树索引每轮
      // 渲染换新引用时尤其如此），无条件写新数组会让 store 更新驱动的重渲染
      // 再造过滤结果，形成「写 → 重渲染 → 再写」的更新环
      const base = useWorkspacesStore.getState().treeExpandedIds
      const next = expandNavForFilter(base, filterResult.ancestorsToExpand)
      const unchanged = next.length === base.length && next.every((id, i) => base[i] === id)
      if (!unchanged) setTreeExpandedIds(next)
    }
    if (!filterActive && wasActive) {
      setTreeExpandedIds(snapshotRef.current ?? [])
      snapshotRef.current = null
    }
    prevFilterActiveRef.current = filterActive
  }, [filterActive, filterResult, setTreeExpandedIds])
}
