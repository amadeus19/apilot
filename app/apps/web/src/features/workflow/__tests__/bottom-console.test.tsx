import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'

// IPC 不进单测：面板挂载播种与 store 取消联动都换替身
vi.mock('../workflow-api', () => ({
  workflowLastExecution: vi.fn().mockResolvedValue(null),
  workflowCancel: vi.fn().mockResolvedValue(true),
}))

import { useWorkflowExecutionStore } from '../execution.store'
import type { WorkflowIssueDto } from '../workflow-api'
import { WorkflowBottomConsole } from '../canvas/bottom-console'
import { consoleTabFallback, consoleTabForRunSignal } from '../canvas/console-tab'

/**
 * 底部控制台（校验 / 执行双 tab 容器）：双空不渲染（不占画布空间）、
 * 计数徽标与面板内容一致（校验 tab 问题数 / 执行 tab 状态词）、空侧
 * 置灰、折叠归标题行整体、tab 点击切换回调；自动切换规则的纯函数口径
 * （运行信号与空侧回落）。
 */

const NODE_NAMES = new Map([
  ['n1', '登录'],
  ['n2', '查询'],
])

const ISSUES: WorkflowIssueDto[] = [
  { code: 'requestUnbound', nodeId: 'n1', message: 'request node is not bound: n1' },
  { code: 'missingStart', message: 'workflow has no Start node' },
]

function seedSlot(status: 'running' | 'passed' | 'failed' | 'cancelled') {
  useWorkflowExecutionStore.setState({
    executions: {
      wf1: {
        executionId: 'e1',
        workflowId: 'wf1',
        status,
        nodes: { n1: { status: 'passed' } },
        order: ['n1'],
        activeEdgeIds: new Set(),
      },
    },
    executionIndex: { e1: 'wf1' },
  })
}

function renderConsole(props: {
  issues?: readonly WorkflowIssueDto[]
  activeTab?: 'validation' | 'execution'
  onTabChange?: (tab: 'validation' | 'execution') => void
}) {
  const onLocate = vi.fn()
  render(
    <WorkflowBottomConsole
      workflowId="wf1"
      issues={props.issues ?? []}
      nodeNames={NODE_NAMES}
      onLocate={onLocate}
      activeTab={props.activeTab ?? 'validation'}
      onTabChange={props.onTabChange ?? vi.fn()}
    />,
  )
  return onLocate
}

beforeEach(() => {
  useWorkflowExecutionStore.setState({ executions: {}, executionIndex: {} })
})

describe('控制台自动切换规则（纯函数口径）', () => {
  it('运行信号：问题清单非空＝被拒跳校验；空＝放行即启动跳执行', () => {
    expect(consoleTabForRunSignal(2)).toBe('validation')
    expect(consoleTabForRunSignal(0)).toBe('execution')
  })

  it('空侧回落：活跃侧失去内容而另一侧有内容时切换，双侧都有内容不回落', () => {
    expect(consoleTabFallback('validation', false, true)).toBe('execution')
    expect(consoleTabFallback('execution', true, false)).toBe('validation')
    expect(consoleTabFallback('validation', true, true)).toBeNull()
    expect(consoleTabFallback('execution', false, false)).toBeNull()
  })
})

describe('底部控制台容器', () => {
  it('双 tab 均空不渲染（空面板不占画布空间）', () => {
    renderConsole({})
    expect(screen.queryByTestId('workflow-console-header')).not.toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  })

  it('仅校验有内容：双 tab 均显，校验徽标为问题数，空执行 tab 置灰且无状态词', () => {
    renderConsole({ issues: ISSUES })
    const validationTab = screen.getByRole('tab', { name: /校验/ })
    const executionTab = screen.getByRole('tab', { name: /执行/ })
    expect(within(validationTab).getByText('2')).toBeInTheDocument()
    // Base UI Tab 置灰＝aria-disabled 语义态（原生 disabled 属性不落 DOM）
    expect(executionTab).toHaveAttribute('aria-disabled', 'true')
    expect(within(executionTab).queryByText('执行中')).toBeNull()
    // 默认校验 tab 活跃：问题行可见
    expect(screen.getByTestId('workflow-validation-panel')).toBeInTheDocument()
    expect(screen.getByText('请求节点「登录」未绑定接口')).toBeInTheDocument()
  })

  it('仅执行有内容：执行徽标为状态词（running→执行中），data-status 随槽位', () => {
    seedSlot('running')
    renderConsole({ activeTab: 'execution' })
    const executionTab = screen.getByRole('tab', { name: /执行/ })
    expect(within(executionTab).getByText('执行中')).toBeInTheDocument()
    expect(screen.getByTestId('workflow-execution-panel')).toHaveAttribute('data-status', 'running')
    // 校验 tab 置灰（无问题）
    expect(screen.getByRole('tab', { name: /校验/ })).toHaveAttribute('aria-disabled', 'true')
  })

  it('执行失败态徽标走警示色（失败词文本即信息，色彩辅助）', () => {
    seedSlot('failed')
    renderConsole({ activeTab: 'execution' })
    const badge = within(screen.getByRole('tab', { name: /执行/ })).getByText('失败')
    expect(badge.className).toContain('text-destructive')
  })

  it('点击 tab 回调切换（键盘导航与方向键由 Tabs 原语承担）', async () => {
    const user = userEvent.setup()
    const onTabChange = vi.fn()
    seedSlot('passed')
    renderConsole({ issues: ISSUES, activeTab: 'validation', onTabChange })
    await user.click(screen.getByRole('tab', { name: /执行/ }))
    expect(onTabChange).toHaveBeenCalledWith('execution')
  })

  it('折叠语义归标题行整体：收起后双 tab 内容区消失、tablist 保留，再点恢复', async () => {
    const user = userEvent.setup()
    renderConsole({ issues: ISSUES })
    const collapse = screen.getByTestId('workflow-console-collapse')
    await user.click(collapse)
    expect(screen.queryByTestId('workflow-validation-panel')).not.toBeInTheDocument()
    expect(screen.getByRole('tablist')).toBeInTheDocument()
    expect(collapse).toHaveAttribute('aria-expanded', 'false')
    await user.click(collapse)
    expect(screen.getByTestId('workflow-validation-panel')).toBeInTheDocument()
    expect(collapse).toHaveAttribute('aria-expanded', 'true')
  })
})
