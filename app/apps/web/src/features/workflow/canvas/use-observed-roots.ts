import * as React from 'react'

import { useIpcQuery } from '@/services/ipc-query'

import { parseObservedBody } from '../extract-observed'
import { workflowKeys, workflowLastExecution } from '../workflow-api'
import type { WorkflowGraph } from '../workflow-model'
import { extractUpstreamRequestId } from './request-mapping'

/**
 * 实测数据源（最近一次执行回看面）的共享取数面：把指定上游请求节点的
 * 掩码响应体解析为产物展开用的解析根。请求节点入参候选与提取写回分支的
 * 实测字段展开共用同一管线（同 queryKey 由 TanStack 缓存自动去重），定位
 * 与解析口径不出现第二份（上游请求定位复用 request-mapping 单点）。
 */

/** 提取节点集各自的实测解析根（提取节点 id → 其上游请求响应体解析根；
 * 无图／无记录＝null，产物展开按无实测数据降级只出顶层） */
export function useObservedRoots(
  workflowId: string | null | undefined,
  graph: WorkflowGraph | undefined,
  extractNodeIds: readonly string[],
): ReadonlyMap<string, unknown | null> {
  const executionQuery = useIpcQuery({
    queryKey: workflowKeys.lastExecution(workflowId ?? ''),
    queryFn: () => workflowLastExecution(workflowId ?? ''),
    enabled: workflowId != null,
  })
  return React.useMemo(() => {
    const roots = new Map<string, unknown | null>()
    if (graph == null) return roots
    for (const extractId of extractNodeIds) {
      const upstreamRequestId = extractUpstreamRequestId(graph, extractId)
      const record =
        upstreamRequestId != null
          ? executionQuery.data?.nodes.find((entry) => entry.nodeId === upstreamRequestId)
          : undefined
      roots.set(extractId, parseObservedBody(record?.response?.body ?? null))
    }
    return roots
  }, [graph, extractNodeIds, executionQuery.data])
}

/** 单个上游请求节点的实测解析根（无上游 / 无记录＝null） */
export function useObservedRoot(
  workflowId: string | null | undefined,
  upstreamRequestId: string | null,
  enabled = true,
): unknown | null {
  const executionQuery = useIpcQuery({
    queryKey: workflowKeys.lastExecution(workflowId ?? ''),
    queryFn: () => workflowLastExecution(workflowId ?? ''),
    enabled: workflowId != null && enabled,
  })
  return React.useMemo(() => {
    if (!upstreamRequestId) return null
    const record = executionQuery.data?.nodes.find((entry) => entry.nodeId === upstreamRequestId)
    return parseObservedBody(record?.response?.body ?? null)
  }, [executionQuery.data, upstreamRequestId])
}
