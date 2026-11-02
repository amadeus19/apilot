import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useTabsStore, type TabMeta } from '@/stores/tabs.store'

// workflow-api 换替身：saveSession 落库与 dispose 的取消联动不进 IPC
const workflowSave = vi.fn()
vi.mock('../workflow-api', () => ({
  workflowSave: (...args: unknown[]) => workflowSave(...args),
  workflowCancel: vi.fn().mockResolvedValue(true),
  workflowKeys: {
    list: (workspaceId: string) => ['workflow', 'list', workspaceId],
    load: (id: string) => ['workflow', 'load', id],
  },
}))

import { reclaimClosedWorkflowTabs, useWorkflowCloseGuard } from '../workflow-close'
import { useWorkflowEditorStore } from '../workflow-editor.store'
import { useWorkflowExecutionStore } from '../execution.store'
import type { WorkflowDto } from '../workflow-api'
import type { WorkflowGraph } from '../workflow-model'

function graph(tag: string): WorkflowGraph {
  return {
    schemaVersion: 1,
    nodes: [{ id: 'n1', name: tag, position: { x: 0, y: 0 }, config: { type: 'start' } }],
    edges: [],
  }
}

function dto(id: string, name: string): WorkflowDto {
  return {
    id,
    workspaceId: 'w1',
    name,
    graph: graph('base'),
    groupId: null,
    createdAt: '2026-10-24T00:00:00Z',
    updatedAt: '2026-10-24T00:00:00Z',
  }
}

function workflowTab(id: string, title: string): TabMeta {
  return { id: `workflow:${id}`, kind: 'workflow', title, key: id, preview: false }
}

/** 播种编辑会话＋执行槽（回收断言的基准数据） */
function seedWorkflow(id: string, title: string): TabMeta {
  useWorkflowEditorStore.getState().seed(dto(id, title))
  useWorkflowExecutionStore.setState((state) => ({
    executions: {
      ...state.executions,
      [id]: {
        executionId: '',
        workflowId: id,
        status: 'running',
        nodes: {},
        order: [],
        activeEdgeIds: new Set(),
      },
    },
  }))
  return workflowTab(id, title)
}

/** 关闭动作替身：从 tabs store 移除受影响 Tab（与真实 close 动作同效） */
function closeAction(tabs: readonly TabMeta[]): () => void {
  const ids = new Set(tabs.map((tab) => tab.id))
  return () => {
    useTabsStore.setState((state) => ({
      tabs: state.tabs.filter((tab) => !ids.has(tab.id)),
    }))
  }
}

// 宿主渲染弹层（与 TabBar 同样的接线），守卫入口经按钮触发（纯 DOM 驱动）
function Host({ affected, action }: { affected: readonly TabMeta[]; action: () => void }) {
  const { guardClose, closeGuardDialog } = useWorkflowCloseGuard()
  return (
    <>
      <button
        type="button"
        data-testid="guard-trigger"
        onClick={() => guardClose(affected, action)}
      >
        守卫关闭
      </button>
      {closeGuardDialog}
    </>
  )
}

/** 渲染宿主并触发守卫关闭（每个守卫用例的起点） */
function guardCloseVia(affected: readonly TabMeta[], action: () => void) {
  render(<Host affected={affected} action={action} />)
  act(() => fireEvent.click(screen.getByTestId('guard-trigger')))
}

beforeEach(() => {
  useTabsStore.setState({ tabs: [], activeTabId: null })
  useWorkflowEditorStore.setState({ sessions: {} })
  useWorkflowExecutionStore.setState({ executions: {}, executionIndex: {} })
  vi.clearAllMocks()
  workflowSave.mockResolvedValue(undefined)
})

describe('reclaimClosedWorkflowTabs：关闭回收', () => {
  it('动作波及的工作流 Tab：编辑会话 discard＋执行槽 dispose（取消在途）', () => {
    const tab = seedWorkflow('wf1', '登录链')
    useTabsStore.setState({ tabs: [tab] })
    reclaimClosedWorkflowTabs(closeAction([tab]))
    expect(useTabsStore.getState().tabs).toHaveLength(0)
    expect(useWorkflowEditorStore.getState().sessions['wf1']).toBeUndefined()
    expect(useWorkflowExecutionStore.getState().executions['wf1']).toBeUndefined()
  })

  it('动作未波及的工作流 Tab：会话与执行槽原样保留', () => {
    const kept = seedWorkflow('wf1', '保留')
    const closed = seedWorkflow('wf2', '关闭')
    useTabsStore.setState({ tabs: [kept, closed] })
    reclaimClosedWorkflowTabs(closeAction([closed]))
    expect(useWorkflowEditorStore.getState().sessions['wf1']?.workflowId).toBe('wf1')
    expect(useWorkflowExecutionStore.getState().executions['wf1']?.workflowId).toBe('wf1')
    expect(useWorkflowEditorStore.getState().sessions['wf2']).toBeUndefined()
    expect(useWorkflowExecutionStore.getState().executions['wf2']).toBeUndefined()
  })

  it('无工作流 Tab 在动作前后消失：不做任何回收', () => {
    const tab = seedWorkflow('wf1', '登录链')
    useTabsStore.setState({ tabs: [tab] })
    // 空动作：清单无变化，回收逐 Tab 空转
    reclaimClosedWorkflowTabs(() => undefined)
    expect(useWorkflowEditorStore.getState().sessions['wf1']?.workflowId).toBe('wf1')
    expect(useWorkflowExecutionStore.getState().executions['wf1']?.status).toBe('running')
  })
})

describe('useWorkflowCloseGuard：脏态关闭守卫', () => {
  it('无脏会话：不弹层，直接执行关闭并回收', () => {
    const tab = seedWorkflow('wf1', '登录链')
    useTabsStore.setState({ tabs: [tab] })
    guardCloseVia([tab], closeAction([tab]))
    expect(useTabsStore.getState().tabs).toHaveLength(0)
    expect(useWorkflowEditorStore.getState().sessions['wf1']).toBeUndefined()
    // 弹层未出现
    expect(screen.queryByTestId('tabbar-close-save')).toBeNull()
  })

  it('有脏会话：挂起弹层不执行；不保存关闭＝丢弃回收', async () => {
    const tab = seedWorkflow('wf1', '登录链')
    useTabsStore.setState({ tabs: [tab] })
    useWorkflowEditorStore.getState().applyGraph('wf1', graph('edited'))
    guardCloseVia([tab], closeAction([tab]))
    // 弹层挂起（Base UI 弹层挂载异步）：Tab 未关、会话还在
    await vi.waitFor(() => screen.getByTestId('tabbar-close-save'))
    expect(useTabsStore.getState().tabs).toHaveLength(1)

    act(() => fireEvent.click(screen.getByTestId('tabbar-close-discard')))
    await waitFor(() => expect(useTabsStore.getState().tabs).toHaveLength(0))
    expect(useWorkflowEditorStore.getState().sessions['wf1']).toBeUndefined()
    expect(useWorkflowExecutionStore.getState().executions['wf1']).toBeUndefined()
  })

  it('取消＝仅关弹层：Tab、会话、执行槽全部原样', async () => {
    const tab = seedWorkflow('wf1', '登录链')
    useTabsStore.setState({ tabs: [tab] })
    useWorkflowEditorStore.getState().applyGraph('wf1', graph('edited'))
    guardCloseVia([tab], closeAction([tab]))
    await vi.waitFor(() => screen.getByRole('button', { name: '取消' }))
    act(() => fireEvent.click(screen.getByRole('button', { name: '取消' })))
    expect(useTabsStore.getState().tabs).toHaveLength(1)
    expect(useWorkflowEditorStore.getState().sessions['wf1']?.dirty).toBe(true)
    expect(useWorkflowExecutionStore.getState().executions['wf1']?.status).toBe('running')
    await waitFor(() => expect(screen.queryByTestId('tabbar-close-save')).toBeNull())
  })

  it('保存并关闭：保存成功后执行关闭并回收', async () => {
    const tab = seedWorkflow('wf1', '登录链')
    useTabsStore.setState({ tabs: [tab] })
    useWorkflowEditorStore.getState().applyGraph('wf1', graph('edited'))
    guardCloseVia([tab], closeAction([tab]))
    await vi.waitFor(() => screen.getByTestId('tabbar-close-save'))
    act(() => fireEvent.click(screen.getByTestId('tabbar-close-save')))
    await waitFor(() => expect(useTabsStore.getState().tabs).toHaveLength(0))
    expect(workflowSave).toHaveBeenCalledWith('wf1', graph('edited'))
    expect(useWorkflowEditorStore.getState().sessions['wf1']).toBeUndefined()
    expect(useWorkflowExecutionStore.getState().executions['wf1']).toBeUndefined()
  })

  it('保存失败（脏态仍在）中止关闭：Tab 与脏会话保留，用户可重试', async () => {
    const tab = seedWorkflow('wf1', '登录链')
    useTabsStore.setState({ tabs: [tab] })
    useWorkflowEditorStore.getState().applyGraph('wf1', graph('edited'))
    workflowSave.mockRejectedValueOnce(new Error('落库失败'))
    guardCloseVia([tab], closeAction([tab]))
    await vi.waitFor(() => screen.getByTestId('tabbar-close-save'))
    act(() => fireEvent.click(screen.getByTestId('tabbar-close-save')))
    await waitFor(() => expect(screen.queryByTestId('tabbar-close-save')).toBeNull())
    expect(useTabsStore.getState().tabs).toHaveLength(1)
    expect(useWorkflowEditorStore.getState().sessions['wf1']?.dirty).toBe(true)
  })
})
