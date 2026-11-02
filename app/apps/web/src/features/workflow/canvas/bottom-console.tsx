import * as React from 'react'

import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react'

import { cn } from 'cn'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@workspace/ui/components'

import { useI18n } from '@/i18n'

import { useWorkflowExecutionStore } from '../execution.store'
import type { WorkflowIssueDto } from '../workflow-api'
import { ExecutionPanel } from './execution-panel'
import { ValidationPanel } from './validation-panel'
import { FLOW_STATUS_KEYS } from './execution-state'
import type { WorkflowConsoleTab } from './console-tab'

/**
 * 底部控制台（编辑器底部单一容器）：校验 / 执行双 tab 合并原两个独立标题
 * 行面板——h-7 标题行承载 tab（键盘导航与方向键切换由 Tabs 原语承担）＋
 * 计数徽标（校验 tab 显问题数，0 时无徽标；执行 tab 显执行状态词，无执行
 * 记录时无词；数字与词本身即信息，色彩只做辅助强调）＋折叠钮（折叠语义
 * 归控制台整体，收起双 tab 内容区）。双 tab 均空时整体不渲染（空面板不占
 * 画布空间）；单侧有内容时仍显双 tab，空侧置灰。面板体（滚动区、行渲染、
 * 定位逻辑）归两面板组件，本容器只做标题行与内容切换。
 */

export function WorkflowBottomConsole({
  workflowId,
  issues,
  nodeNames,
  onLocate,
  activeTab,
  onTabChange,
}: {
  workflowId: string
  issues: readonly WorkflowIssueDto[]
  /** nodeId → 展示名（kind 名兜底由调用方完成） */
  nodeNames: ReadonlyMap<string, string>
  onLocate: (nodeId: string) => void
  activeTab: WorkflowConsoleTab
  onTabChange: (tab: WorkflowConsoleTab) => void
}) {
  const { t } = useI18n()
  const slot = useWorkflowExecutionStore((s) => s.executions[workflowId])
  const [collapsed, setCollapsed] = React.useState(false)
  const hasIssues = issues.length > 0
  const hasExecution = slot != null

  if (!hasIssues && !hasExecution) return null

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => {
        if (value === 'validation' || value === 'execution') onTabChange(value)
      }}
      className="shrink-0 gap-0 border-t"
    >
      <div
        className="flex h-7 shrink-0 items-center gap-1 px-1"
        data-testid="workflow-console-header"
      >
        <TabsList variant="line" className="h-7">
          <TabsTrigger value="validation" disabled={!hasIssues} className="text-xs">
            {t('workflows.consoleTabValidation')}
            {hasIssues && (
              <span className="text-[11px] font-medium text-destructive tabular-nums">
                {issues.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="execution" disabled={!hasExecution} className="text-xs">
            {t('workflows.consoleTabExecution')}
            {slot != null && (
              <span
                className={cn(
                  'text-[11px] text-muted-foreground',
                  slot.status === 'failed' && 'text-destructive',
                )}
              >
                {t(FLOW_STATUS_KEYS[slot.status])}
              </span>
            )}
          </TabsTrigger>
        </TabsList>
        <span className="flex-1" />
        <button
          type="button"
          className="flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-accent"
          aria-label={collapsed ? t('workflows.consoleExpand') : t('workflows.consoleCollapse')}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((prev) => !prev)}
          data-testid="workflow-console-collapse"
        >
          {collapsed ? (
            <ChevronUpIcon aria-hidden className="size-3 text-muted-foreground" />
          ) : (
            <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground" />
          )}
        </button>
      </div>
      {!collapsed && (
        <>
          <TabsContent
            value="validation"
            data-testid="workflow-validation-panel"
            data-count={issues.length}
          >
            <ValidationPanel issues={issues} nodeNames={nodeNames} onLocate={onLocate} />
          </TabsContent>
          <TabsContent
            value="execution"
            data-testid="workflow-execution-panel"
            data-status={slot?.status}
          >
            <ExecutionPanel workflowId={workflowId} nodeNames={nodeNames} onLocate={onLocate} />
          </TabsContent>
        </>
      )}
    </Tabs>
  )
}
