import * as React from 'react'

import { cn } from 'cn'

import { useI18n, type DictKey } from '@/i18n'
import { reportError } from '@/services/error-center'

import { useWorkflowExecutionStore, type NodeExecutionUiState } from '../execution.store'
import { workflowLastExecution } from '../workflow-api'
import { EXECUTION_STATUS_VISUALS, isHttpSuccessStatus } from './execution-state'

/**
 * 执行面板（底部控制台执行 tab 的面板体）：最近一次执行的逐节点列表——
 * 状态、耗时、错误摘要与产物摘要，点击行定位 / 聚焦节点，失败行展开完整
 * 错误详情，请求节点行展开请求 / 响应明细（状态码＋方法＋URL＋响应摘要，
 * Rust 侧已按掩码口径产出，纯呈现），存变量行展开写回清单并提示「写回不
 * 等于激活」——激活只经变量视图进行，本面板只引导不代做。数据源＝执行事
 * 件 store（事件流实时归约，不轮询）；面板挂载时播种最近一次执行记录（回
 * 看面），在途执行优先于历史记录（store 播种纪律）。无执行态不渲染（不占
 * 画布空间）。标题行、状态徽标与外层容器归控制台。状态图标与配色取执行
 * 状态单一映射源。
 */

/** 断言规则类型词 → 文案键（未识别词回落原文渲染，词表演进不冒充已知态） */
const ASSERT_RULE_KIND_KEYS: Record<string, DictKey> = {
  statusCode: 'workflows.assertRuleStatusCode',
  jsonPath: 'workflows.assertRuleJsonPath',
  exists: 'workflows.assertRuleExists',
  contains: 'workflows.assertRuleContains',
}

export function ExecutionPanel({
  workflowId,
  nodeNames,
  onLocate,
}: {
  workflowId: string
  /** nodeId → 展示名（kind 名兜底由调用方完成，面板不做 kind 分发） */
  nodeNames: ReadonlyMap<string, string>
  onLocate: (nodeId: string) => void
}) {
  const slot = useWorkflowExecutionStore((s) => s.executions[workflowId])
  const seedFromRecord = useWorkflowExecutionStore((s) => s.seedFromRecord)

  // 挂载时播种最近一次执行记录（回看面；在途槽位优先，seed 幂等）。
  // IPC 失败与运行失败同口径走错误中心（无记录＝null 是正常路径不走 catch）
  React.useEffect(() => {
    let cancelled = false
    void workflowLastExecution(workflowId)
      .then((record) => {
        if (record && !cancelled) seedFromRecord(record)
      })
      .catch((error) => {
        if (!cancelled) reportError(error)
      })
    return () => {
      cancelled = true
    }
    // onLocate 由调用方以 useCallback 稳定提供；挂载消费一次即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId, seedFromRecord])

  if (!slot || slot.order.length === 0) return null

  return (
    <ul
      className="max-h-32 min-h-0 overflow-y-auto px-2.5 pb-2"
      data-testid="workflow-execution-list"
    >
      {slot.order.map((nodeId) => (
        <ExecutionRow
          key={nodeId}
          nodeId={nodeId}
          state={slot.nodes[nodeId]}
          name={nodeNames.get(nodeId) ?? nodeId}
          onLocate={onLocate}
        />
      ))}
    </ul>
  )
}

/** 单节点行：状态图标＋名称＋耗时＋产物摘要；失败行展开错误详情，请求
 * 节点行展开请求 / 响应明细（状态码＋方法＋URL＋响应摘要），存变量行
 * 展开写回清单（键＋目标分类＋掩码值＋激活引导），断言行展开逐规则
 * 结果（期望 vs 实际并列） */
function ExecutionRow({
  nodeId,
  state,
  name,
  onLocate,
}: {
  nodeId: string
  state: NodeExecutionUiState | undefined
  name: string
  onLocate: (nodeId: string) => void
}) {
  const { t } = useI18n()
  const status = state?.status ?? 'queued'
  const visual = EXECUTION_STATUS_VISUALS[status]
  const Icon = visual.icon
  const failed = status === 'failed'
  const assertions = state?.assertions ?? []
  // 请求 / 响应明细与写回清单只经终态记录播种进入（事件不携带），过程态无明细
  const request = state?.request
  const response = state?.response
  const writebacks = state?.writebacks ?? []
  const hasHttpDetail = request != null || response != null
  const expandable = failed || assertions.length > 0 || hasHttpDetail || writebacks.length > 0
  // 失败行点击＝定位节点＋行内展开错误详情；请求 / 断言行展开各自明细；
  // 其余行点击＝定位
  const [expanded, setExpanded] = React.useState(false)
  const handleClick = () => {
    onLocate(nodeId)
    if (expandable) setExpanded((prev) => !prev)
  }
  return (
    <li>
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-xs hover:bg-accent',
          failed && 'text-destructive',
        )}
        onClick={handleClick}
        data-testid="workflow-execution-row"
        data-status={status}
      >
        <Icon aria-hidden className={cn('size-3 shrink-0', visual.rowClassName)} />
        <span className="min-w-0 truncate" title={name}>
          {name}
        </span>
        {state?.output != null && (
          <span
            className="min-w-0 truncate font-mono text-micro text-muted-foreground"
            title={state.output}
          >
            {state.output}
          </span>
        )}
        <span className="flex-1" />
        {failed && state?.errorMessage != null ? (
          <span className="min-w-0 truncate text-micro" title={state.errorMessage}>
            {state.errorMessage}
          </span>
        ) : (
          <span className="shrink-0 text-micro text-muted-foreground tabular-nums">
            {state?.durationMs != null
              ? t('workflows.executionDuration', { ms: state.durationMs })
              : ''}
          </span>
        )}
      </button>
      {expandable && expanded && (
        <div
          className="rounded-sm bg-accent/60 px-2 py-1.5 text-micro break-all"
          data-testid="workflow-execution-row-detail"
        >
          {failed && state?.errorMessage != null && (
            <div className="mb-1">
              {state.errorCode != null && (
                <span className="font-mono text-muted-foreground">{state.errorCode} · </span>
              )}
              {state.errorMessage}
            </div>
          )}
          {hasHttpDetail && (
            <div className="mb-1" data-testid="workflow-execution-request-detail">
              <div className="flex items-start gap-1">
                {response != null && (
                  <span
                    className={cn(
                      'shrink-0 font-medium tabular-nums',
                      isHttpSuccessStatus(response.status) ? 'text-success' : 'text-destructive',
                    )}
                  >
                    {response.status}
                  </span>
                )}
                {request != null && (
                  <span className="min-w-0 font-mono text-muted-foreground">
                    {request.method} {request.url}
                  </span>
                )}
              </div>
              {response != null && response.body !== '' && (
                <div className="mt-0.5 font-mono text-muted-foreground">{response.body}</div>
              )}
            </div>
          )}
          {writebacks.length > 0 && (
            <div className="mb-1" data-testid="workflow-execution-writebacks">
              {writebacks.map((entry) => (
                <div key={entry.key} className="flex items-start gap-1">
                  <span className="shrink-0 font-medium">{entry.key}</span>
                  <span className="min-w-0 font-mono text-muted-foreground">
                    {t('workflows.executionWritebackEntry', {
                      category: entry.categoryName,
                      value: entry.value,
                    })}
                  </span>
                </div>
              ))}
              <p className="mt-0.5 text-muted-foreground">
                {t('workflows.executionWritebackHint')}
              </p>
            </div>
          )}
          {assertions.length > 0 && (
            <ul data-testid="workflow-execution-assertions">
              {assertions.map((entry, index) => {
                const ruleKey = ASSERT_RULE_KIND_KEYS[entry.ruleKind]
                return (
                  <li key={index} className="flex items-start gap-1">
                    <span
                      className={cn(
                        'shrink-0 font-medium',
                        entry.passed ? 'text-success' : 'text-destructive',
                      )}
                    >
                      {entry.passed ? '✓' : '✗'}
                    </span>
                    <span className="min-w-0">
                      {ruleKey != null ? t(ruleKey) : entry.ruleKind}
                      {entry.path != null && (
                        <span className="font-mono text-muted-foreground"> {entry.path}</span>
                      )}
                      <span className="font-mono text-muted-foreground">
                        {' '}
                        {entry.expected != null
                          ? t('workflows.assertExpectedActual', {
                              expected: entry.expected,
                              actual: entry.actual,
                            })
                          : t('workflows.assertActualOnly', { actual: entry.actual })}
                      </span>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </li>
  )
}
