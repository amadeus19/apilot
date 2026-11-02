import * as React from 'react'

import { useTreeExpandedStore } from './tree-state.store'
import { expandForFilter, type ApiTreeFilterResult } from './selector'

/**
 * 树过滤接线（会话展开 store 之上的快照机）：
 * - 进入过滤模式：快照当前展开（清除时恢复），命中祖先自动展开（并集；
 *   过滤中用户的手动折叠随查询变化被重展开）；
 * - 清除过滤：恢复快照；
 * - 过滤中的手动折叠不落快照（快照只在进入那一刻定格）。
 */
export function useTreeFiltering(
  filterActive: boolean,
  filterResult: ApiTreeFilterResult | null,
): void {
  const setExpanded = useTreeExpandedStore((s) => s.setExpanded)
  const snapshotRef = React.useRef<string[] | null>(null)
  const prevFilterActiveRef = React.useRef(false)

  React.useEffect(() => {
    const wasActive = prevFilterActiveRef.current
    if (filterActive && !wasActive) {
      snapshotRef.current = useTreeExpandedStore.getState().expandedIds
    }
    if (filterActive && filterResult) {
      setExpanded(
        expandForFilter(
          useTreeExpandedStore.getState().expandedIds,
          filterResult.ancestorsToExpand,
        ),
      )
    }
    if (!filterActive && wasActive) {
      setExpanded(snapshotRef.current ?? [])
      snapshotRef.current = null
    }
    prevFilterActiveRef.current = filterActive
  }, [filterActive, filterResult, setExpanded])
}
