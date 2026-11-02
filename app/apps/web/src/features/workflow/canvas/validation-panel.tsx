import { XCircleIcon } from 'lucide-react'

import { cn } from 'cn'

import { type DictKey, useI18n } from '@/i18n'

import type { WorkflowIssueDto } from '../workflow-api'

/**
 * 校验错误清单（底部控制台校验 tab 的面板体）：执行前校验的逐条行，点击
 * 行定位对应节点（图级问题无定位——行不可点）。数据源＝编辑器的校验状态
 * （图变更防抖重校验、运行前强制重校验），本组件纯渲染。无问题不渲染（
 * 不占画布空间）。标题行、计数徽标与外层容器归控制台，本组件只承载列表
 * 本体。文案按 code 走词典，未知 code 回落 message 原文（词表演进不冒充
 * 已知态）。
 */

/** 校验码 → 文案键（与 Rust issue_codes 词表对齐；缺键回落 message） */
const ISSUE_MESSAGE_KEYS: Record<string, DictKey> = {
  missingStart: 'workflows.validationMissingStart',
  orphanNode: 'workflows.validationOrphanNode',
  invalidEdge: 'workflows.validationInvalidEdge',
  cycle: 'workflows.validationCycle',
  conditionDefaultMissing: 'workflows.validationConditionDefaultMissing',
  parallelNoBranch: 'workflows.validationParallelNoBranch',
  joinNoUpstream: 'workflows.validationJoinNoUpstream',
  requestUnbound: 'workflows.validationRequestUnbound',
  requestInvalidRef: 'workflows.validationRequestInvalidRef',
  expressionInvalid: 'workflows.validationExpressionInvalid',
  variableRefInvalid: 'workflows.validationVariableRefInvalid',
  upstreamNotRequest: 'workflows.validationUpstreamNotRequest',
  extractRowInvalid: 'workflows.validationExtractRowInvalid',
  extractWritebackIncomplete: 'workflows.validationExtractWritebackIncomplete',
  nodeReferenceAmbiguous: 'workflows.validationNodeReferenceAmbiguous',
}

export function ValidationPanel({
  issues,
  nodeNames,
  onLocate,
}: {
  issues: readonly WorkflowIssueDto[]
  /** nodeId → 展示名（kind 名兜底由调用方完成，与执行面板同口径） */
  nodeNames: ReadonlyMap<string, string>
  onLocate: (nodeId: string) => void
}) {
  if (issues.length === 0) return null

  return (
    <ul
      className="max-h-32 min-h-0 overflow-y-auto px-2.5 pb-2"
      data-testid="workflow-validation-list"
    >
      {issues.map((issue, index) => (
        <ValidationRow
          key={`${issue.code}-${issue.nodeId ?? 'graph'}-${index}`}
          issue={issue}
          name={issue.nodeId != null ? (nodeNames.get(issue.nodeId) ?? issue.nodeId) : undefined}
          onLocate={onLocate}
        />
      ))}
    </ul>
  )
}

function ValidationRow({
  issue,
  name,
  onLocate,
}: {
  issue: WorkflowIssueDto
  name: string | undefined
  onLocate: (nodeId: string) => void
}) {
  const { t } = useI18n()
  const messageKey = ISSUE_MESSAGE_KEYS[issue.code]
  const description = messageKey != null ? t(messageKey, { name: name ?? '' }) : issue.message
  // 图级问题（无 nodeId）不可定位，纯展示
  const clickable = issue.nodeId != null
  return (
    <li>
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-xs text-destructive',
          clickable && 'hover:bg-accent',
        )}
        onClick={() => issue.nodeId != null && onLocate(issue.nodeId)}
        data-testid="workflow-validation-row"
        data-code={issue.code}
      >
        <XCircleIcon aria-hidden className="size-3 shrink-0" />
        <span className="min-w-0 truncate" title={issue.message}>
          {description}
        </span>
      </button>
    </li>
  )
}
