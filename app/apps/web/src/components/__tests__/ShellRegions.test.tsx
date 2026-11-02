import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useSyncWizardStore } from '@/stores/sync.store'
import { workbenchKeys } from '@/services/workbench-api'
import { useSettingsStore } from '@/stores/settings.store'
import { workflowKeys } from '@/features/workflow/workflow-api'
import { createQueryWrapper } from '@/test/render-providers'
import { StatusBar } from '../layout/StatusBar'
import { TabBar } from '../layout/TabBar'
import { WorkspaceWelcome } from '../layout/WorkspaceWelcome'

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn().mockResolvedValue('0.1.0'),
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockRejectedValue(new Error('no tauri in tests')),
}))
// 运行协议替身（状态栏固定段点击触发的入参断言对象）
vi.mock('@/features/workflow/run-flow', () => ({
  executeWorkflowGuarded: vi.fn(),
}))

import { executeWorkflowGuarded } from '@/features/workflow/run-flow'

/** 同步向导 store 复位（档位用例直写 store，测试间互不串档） */
function resetSyncStore(): void {
  useSyncWizardStore.setState({
    open: false,
    phase: 'select',
    selectedServiceIds: [],
    runs: {},
    applying: false,
    applyOutcomes: {},
    lastSummary: null,
  })
}

/** 偏好 store 复位（固定段用例直写 workflowPins，测试间互不串档） */
function resetSettingsStore(): void {
  useSettingsStore.getState().hydrateFromBoot(null, null)
}

/** 当前空间 + 工作流清单缓存种子（固定段名称解析与第五视图同源同键） */
function workspaceWithWorkflows(items: { id: string; name: string }[]) {
  return createQueryWrapper((queryClient) => {
    queryClient.setQueryData(workbenchKeys.workspaces(), {
      items: [{ id: 'ws-2', name: '当前空间', baseUrl: null, auth: null, isCurrent: true }],
      currentId: 'ws-2',
    })
    queryClient.setQueryData(workflowKeys.list('ws-2'), {
      items: items.map((item) => ({
        ...item,
        groupId: null,
        lastStatus: null,
        hasWriteback: false,
        updatedAt: '2026-11-01T00:00:00Z',
      })),
    })
  })
}

describe('StatusBar', () => {
  afterEach(() => {
    resetSyncStore()
    resetSettingsStore()
    vi.mocked(executeWorkflowGuarded).mockClear()
  })

  it('三段回显：工作空间 / 无同步动作时同步段不渲染、版本真实', async () => {
    render(<StatusBar />, { wrapper: createQueryWrapper() })
    // 工作空间查询失败（测试无 Tauri）＝无当前空间：注意态空态文案
    expect(screen.getByTestId('statusbar-workspace')).toHaveTextContent('未选择工作空间')
    // 本次会话无同步动作＝同步段整段不渲染（不显示误导性的「尚未同步」）
    expect(screen.queryByTestId('statusbar-sync')).not.toBeInTheDocument()
    // getVersion 异步解析后回填
    await vi.waitFor(() =>
      expect(screen.getByTestId('statusbar-version')).toHaveTextContent('v0.1.0'),
    )
  })

  it('工作空间段回显当前空间名（与标题栏切换器同源缓存）', () => {
    render(<StatusBar />, {
      wrapper: createQueryWrapper((queryClient) => {
        queryClient.setQueryData(workbenchKeys.workspaces(), {
          items: [
            { id: 'ws-1', name: '演示空间', baseUrl: null, auth: null, isCurrent: false },
            { id: 'ws-2', name: '当前空间', baseUrl: null, auth: null, isCurrent: true },
          ],
          currentId: 'ws-2',
        })
      }),
    })
    expect(screen.getByTestId('statusbar-workspace')).toHaveTextContent('当前空间')
  })

  it('同步段档位：会话进行中＝同步中、完成＝已同步计数、带失败＝部分失败', () => {
    // 拉取进行中（running 段）
    useSyncWizardStore.setState({
      phase: 'running',
      runs: { 'svc-a': { status: 'fetching' }, 'svc-b': { status: 'queued' } },
    })
    render(<StatusBar />, { wrapper: createQueryWrapper() })
    expect(screen.getByTestId('statusbar-sync')).toHaveTextContent('同步中…')
    cleanup()

    // 全部成功并应用（done 段、无 skipped）
    useSyncWizardStore.setState({
      phase: 'done',
      runs: { 'svc-a': { status: 'ok' }, 'svc-b': { status: 'ok' } },
      applyOutcomes: {
        'svc-a': { added: 1, changed: 0, removed: 0, unchanged: 2 },
        'svc-b': { added: 0, changed: 0, removed: 0, unchanged: 3 },
      },
    })
    render(<StatusBar />, { wrapper: createQueryWrapper() })
    expect(screen.getByTestId('statusbar-sync')).toHaveTextContent('已同步 2 个服务')
    cleanup()

    // 一成一败（done 段、skipped＝拉取或对比失败）
    useSyncWizardStore.setState({
      phase: 'done',
      runs: { 'svc-a': { status: 'ok' }, 'svc-b': { status: 'skipped' } },
      applyOutcomes: { 'svc-a': { added: 1, changed: 0, removed: 0, unchanged: 0 } },
    })
    render(<StatusBar />, { wrapper: createQueryWrapper() })
    expect(screen.getByTestId('statusbar-sync')).toHaveTextContent('已同步 1 · 失败 1')
    cleanup()

    // 全部失败（done 段、无一应用成功）
    useSyncWizardStore.setState({
      phase: 'done',
      runs: { 'svc-a': { status: 'skipped' }, 'svc-b': { status: 'skipped' } },
      applyOutcomes: {},
    })
    render(<StatusBar />, { wrapper: createQueryWrapper() })
    expect(screen.getByTestId('statusbar-sync')).toHaveTextContent('同步失败')
    cleanup()
  })

  it('固定段：无固定＝整段不渲染（不占位）', () => {
    render(<StatusBar />, {
      wrapper: workspaceWithWorkflows([{ id: 'wf-9', name: '发布流水线' }]),
    })
    expect(screen.queryByTestId('statusbar-pinned')).not.toBeInTheDocument()
  })

  it('固定段：有固定渲染名称（title 显全名），点击直跑且入参与清单行同协议', async () => {
    useSettingsStore.setState({ workflowPins: { 'ws-2': 'wf-9' } })
    render(<StatusBar />, {
      wrapper: workspaceWithWorkflows([{ id: 'wf-9', name: '发布流水线' }]),
    })
    const pinned = await screen.findByTestId('statusbar-pinned')
    expect(pinned).toHaveTextContent('发布流水线')
    expect(pinned).toHaveAttribute('title', '发布流水线')
    expect(pinned).toHaveAttribute('aria-label', '运行固定工作流')
    fireEvent.click(pinned)
    expect(executeWorkflowGuarded).toHaveBeenCalledExactlyOnceWith({
      workflowId: 'wf-9',
      name: '发布流水线',
      onIssues: expect.any(Function),
    })
  })

  it('固定段：固定 id 不在当前空间清单（被删）＝整段自愈隐藏', () => {
    useSettingsStore.setState({ workflowPins: { 'ws-2': 'wf-gone' } })
    render(<StatusBar />, {
      wrapper: workspaceWithWorkflows([{ id: 'wf-9', name: '发布流水线' }]),
    })
    expect(screen.queryByTestId('statusbar-pinned')).not.toBeInTheDocument()
  })
})

describe('TabBar', () => {
  it('空态提示（无 tab）', () => {
    render(<TabBar />, { wrapper: createQueryWrapper() })
    expect(screen.getByRole('tablist', { name: '标签栏' })).toBeInTheDocument()
    expect(screen.getByText('无打开的标签页')).toBeInTheDocument()
  })
})

describe('WorkspaceWelcome', () => {
  it('logo＋版本＋引导文案', async () => {
    render(<WorkspaceWelcome />, { wrapper: createQueryWrapper() })
    expect(screen.getByRole('img', { name: 'APilot' })).toBeInTheDocument()
    expect(screen.getByText('从左栏选择或新建接口，开始调试。')).toBeInTheDocument()
    await vi.waitFor(() => expect(screen.getByText('v0.1.0')).toBeInTheDocument())
  })
})
