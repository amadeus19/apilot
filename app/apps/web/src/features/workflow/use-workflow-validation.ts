import * as React from 'react'

import { useCurrentWorkspaceTreeQuery } from '@/features/workspaces/api'
import { reportError } from '@/services/error-center'

import { workflowValidate, type WorkflowIssueDto } from './workflow-api'
import type { WorkflowGraph } from './workflow-model'

/**
 * 执行前校验接线（图变更防抖重校验）：错误定位面的清单与失效引用节点集
 * 的单一来源。图每次落定防抖重校验；接口树重拉（dataUpdatedAt：删接口 /
 * 同步回归等解析面变化）同样触发——失效是解析派生态，引用面变了警示必须
 * 跟着翻新。返回的 setIssues 供运行前强制重校验写入（校验失败不得启动
 * 执行；保存不被校验拦截，本态只做拦截与定位呈现）。
 */
export function useWorkflowValidation(workflowId: string, sessionGraph: WorkflowGraph) {
  const [issues, setIssues] = React.useState<WorkflowIssueDto[]>([])
  const { dataUpdatedAt: treeUpdatedAt } = useCurrentWorkspaceTreeQuery()
  React.useEffect(() => {
    let stale = false
    const timer = setTimeout(() => {
      void workflowValidate(workflowId, sessionGraph)
        .then((next) => {
          if (!stale) setIssues(next)
        })
        .catch((error) => {
          if (!stale) reportError(error)
        })
    }, 800)
    // 依赖变更即作废在途回包：晚到的旧校验结果不得覆盖运行前校验刚
    // 写入的清单（并发竞态面）
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [workflowId, sessionGraph, treeUpdatedAt])
  // 失效引用节点集（派生态，不落库）：卡片警示、节点卡重接引导与
  // drop 重接路由共用
  const invalidRefIds = React.useMemo(() => {
    const ids = new Set<string>()
    for (const issue of issues) {
      if (issue.code === 'requestInvalidRef' && issue.nodeId != null) ids.add(issue.nodeId)
    }
    return ids
  }, [issues])
  return { issues, setIssues, invalidRefIds }
}
