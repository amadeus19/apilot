import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ResizeObserverMock } from '@/test/setup'
import type { TreeRowData } from '@workspace/ui/components'

import { WorkflowsView, WorkflowRowContent } from '../workflows-view'
import { useSettingsStore } from '@/stores/settings.store'
import {
  workflowGroupDelete,
  workflowGroupList,
  workflowGroupMove,
  workflowList,
  workflowMove,
} from '../workflow-api'
import type { WorkflowExecutionUiState } from '../execution.store'
import type { WorkflowNavNode } from '../workflow-nav-tree'
import type { WorkflowSummaryDto } from '../workflow-api'

// workflow-api 换替身（保留 workflowKeys 真实形状——失效匹配依赖键一致），
// 删除分组的失效编排是本文件新增测试的对象
vi.mock('../workflow-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workflow-api')>()
  return {
    ...actual,
    workflowList: vi.fn(),
    workflowGroupList: vi.fn(),
    workflowGroupDelete: vi.fn(),
    workflowMove: vi.fn(),
    workflowGroupMove: vi.fn(),
  }
})

// 工作空间查询桩（组件只读 currentId；测试环境 IPC 不可直连）
vi.mock('@/features/workspaces/api', () => ({
  useWorkspacesQuery: () => ({ data: { currentId: 'w1' } }),
}))

// 偏好落库替身（固定切换的 fire-and-forget persist 不打真实 invoke）
vi.mock('@/services/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ipc')>()
  return { ...actual, setSetting: vi.fn().mockResolvedValue(undefined) }
})

// 导出导入走系统对话框，模块加载即引入，桩掉
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(),
  open: vi.fn(),
}))

/**
 * 工作流行形态（测试环境 locale 解析为 zh-CN，文案按 zh-CN 字典断言）：
 * - 行＝名称＋常显运行钮＋缩进（无折叠指示行补一格 chevron 空位，与工作
 *   空间树子行同口径）；历史结果不落行（最近结果徽标与写回 chip 均不
 *   渲染），执行完成反馈由 run-flow 的右下角 toast 承担；
 * - running 态＝进度计数徽标「执行中 · N/M」，乐观态（事件未达、order 空）
 *   只显示「执行中」不带计数。
 */

const ROW: TreeRowData<WorkflowNavNode> = {
  id: 'wf1',
  name: '慢链',
  data: { kind: 'workflow', id: 'wf1', name: '慢链' },
  depth: 0,
  indentPx: 0,
  isFolder: false,
  isExpanded: false,
  isSelected: false,
  isFocused: false,
}

function item(overrides: Partial<WorkflowSummaryDto> = {}): WorkflowSummaryDto {
  return {
    id: 'wf1',
    name: '慢链',
    groupId: null,
    lastStatus: 'passed',
    hasWriteback: false,
    updatedAt: '2026-10-24T00:00:00Z',
    ...overrides,
  }
}

function runningSlot(
  nodes: WorkflowExecutionUiState['nodes'],
  order: string[],
): WorkflowExecutionUiState {
  return {
    executionId: 'e1',
    workflowId: 'wf1',
    status: 'running',
    nodes,
    order,
    activeEdgeIds: new Set(),
  }
}

function renderRow(overrides: {
  row?: Partial<TreeRowData<WorkflowNavNode>>
  item?: Partial<WorkflowSummaryDto>
  execution?: WorkflowExecutionUiState
  pinned?: boolean
  onTogglePin?: () => void
}) {
  render(
    <WorkflowRowContent
      row={{ ...ROW, ...overrides.row }}
      execution={overrides.execution}
      onRun={vi.fn()}
      onStop={vi.fn()}
      pinned={overrides.pinned}
      onTogglePin={overrides.onTogglePin}
    />,
  )
}

/** 喂树滚动容器视口高度（setup 的 ResizeObserver stub 不自动触发；
 * 与 packages/ui 树测试的 simulateViewport 同口径） */
function simulateTreeViewport(container: HTMLElement, height: number): void {
  const scrollEl = container.querySelector<HTMLElement>('[data-slot="tree-scroll"]')
  if (!scrollEl) throw new Error('tree scroll element not found')
  Object.defineProperty(scrollEl, 'offsetHeight', { configurable: true, value: height })
  const observer = ResizeObserverMock.instances.at(-1)
  act(() => {
    observer?.callback([] as ResizeObserverEntry[], observer as unknown as ResizeObserver)
  })
}

/** 挂载第五视图并喂视口：首帧 queries 在途＝空态渲染，树随数据到达才
 * 挂载；滚动容器就位后再喂高度（树行走 react-virtual 虚拟化，jsdom 无
 * 自动测量） */
async function mountView(searchQuery = '') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={client}>
      <WorkflowsView searchQuery={searchQuery} />
    </QueryClientProvider>,
  )
  await waitFor(() => {
    expect(view.container.querySelector('[data-slot="tree-scroll"]')).not.toBeNull()
  })
  simulateTreeViewport(view.container, 300)
  return view
}

describe('WorkflowRowContent：干净行与缩进口径', () => {
  it('非 running：不渲染历史结果徽标（最近通过也不落行），运行钮常显', () => {
    renderRow({})
    expect(screen.queryByText('已通过')).not.toBeInTheDocument()
    expect(screen.queryByText('失败')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workflows-row-progress')).not.toBeInTheDocument()
    expect(screen.getByTestId('workflows-row-run')).toBeInTheDocument()
  })

  it('缩进补一格 chevron 空位（18px）：与工作空间树子行同口径', () => {
    const { container } = render(
      <WorkflowRowContent
        row={{ ...ROW, depth: 1, indentPx: 14 }}
        execution={undefined}
        onRun={vi.fn()}
        onStop={vi.fn()}
      />,
    )
    const shell = container.firstElementChild as HTMLElement
    expect(shell.style.paddingInlineStart).toBe('32px')
  })

  it('running 乐观态（事件未达、order 空）：进度徽标只显示「执行中」', () => {
    renderRow({ execution: runningSlot({}, []) })
    const badge = screen.getByTestId('workflows-row-progress')
    expect(badge).toHaveTextContent('执行中')
    expect(screen.getByTestId('workflows-row-stop')).toBeInTheDocument()
  })

  it('running 事件态：计数「执行中 · 1/2」随槽位派生', () => {
    renderRow({
      execution: runningSlot({ a: { status: 'passed' }, b: { status: 'running' } }, ['a', 'b']),
    })
    expect(screen.getByTestId('workflows-row-progress')).toHaveTextContent('执行中 · 1/2')
  })
})

describe('WorkflowRowContent：写回标记 chip 不再渲染', () => {
  it('hasWriteback 真假均不渲染 chip（完成反馈走右下角 toast）', () => {
    renderRow({ item: { hasWriteback: true } })
    expect(screen.queryByTestId('workflows-row-writeback')).not.toBeInTheDocument()
    renderRow({ item: { hasWriteback: false } })
    expect(screen.queryByTestId('workflows-row-writeback')).not.toBeInTheDocument()
  })
})

describe('WorkflowRowContent：状态栏固定切换', () => {
  it('未固定：Pin 钮 aria-label「固定到状态栏」，点击触发固定回调', () => {
    const onTogglePin = vi.fn()
    renderRow({ pinned: false, onTogglePin })
    const pin = screen.getByTestId('workflows-row-pin')
    expect(pin).toHaveAttribute('aria-label', '固定到状态栏')
    fireEvent.click(pin)
    expect(onTogglePin).toHaveBeenCalledOnce()
  })

  it('已固定：常亮态 aria-label 切「取消固定」，再点取消', () => {
    const onTogglePin = vi.fn()
    renderRow({ pinned: true, onTogglePin })
    const pin = screen.getByTestId('workflows-row-pin')
    expect(pin).toHaveAttribute('aria-label', '取消固定')
    fireEvent.click(pin)
    expect(onTogglePin).toHaveBeenCalledOnce()
  })

  it('宿主未接线（onTogglePin 缺省）：Pin 钮不渲染', () => {
    renderRow({})
    expect(screen.queryByTestId('workflows-row-pin')).not.toBeInTheDocument()
  })
})

describe('WorkflowsView：删除分组的缓存失效', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(workflowList).mockResolvedValue({ items: [] })
    vi.mocked(workflowGroupList).mockResolvedValue({
      items: [{ id: 'g1', name: '组一', createdAt: '2026-10-24T00:00:00Z' }],
    })
    vi.mocked(workflowGroupDelete).mockResolvedValue(undefined)
  })

  it('删除分组成功后 groups 与 list 查询各重拉一次（组行消失、成员回落未分组）', async () => {
    await mountView()

    // 分组行渲染（首拉各一次）
    expect(await screen.findByText('组一')).toBeInTheDocument()
    expect(workflowGroupList).toHaveBeenCalledTimes(1)
    expect(workflowList).toHaveBeenCalledTimes(1)

    // 右键分组行 → 菜单「删除」→ 确认框确认
    const row = screen.getByText('组一').closest('[role="treeitem"]') as HTMLElement
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByText('删除'))
    fireEvent.click(await screen.findByTestId('workflow-group-delete-confirm'))

    // onSuccess 双失效：groups 前缀刷组清单，list 前缀刷成员归属——
    // 缺任何一份都会出现组行残留或成员未回落
    await waitFor(() => {
      expect(workflowGroupList).toHaveBeenCalledTimes(2)
      expect(workflowList).toHaveBeenCalledTimes(2)
    })
  })
})

describe('WorkflowsView：树行拖拽手柄', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(workflowList).mockResolvedValue({
      items: [item({ id: 'w1', name: '登录', groupId: 'g1' })],
    })
    vi.mocked(workflowGroupList).mockResolvedValue({
      items: [{ id: 'g1', name: '组一', createdAt: '2026-10-24T00:00:00Z' }],
    })
  })

  it('非搜索态：分组行与工作流行行尾各渲染拖拽手柄（拖拽唯一入口）', async () => {
    const view = await mountView()
    expect(await screen.findByText('登录')).toBeInTheDocument()
    expect(view.container.querySelectorAll('[data-drag-handle]')).toHaveLength(2)
  })

  it('搜索过滤态：整树禁拖，手柄不渲染', async () => {
    const view = await mountView('登')
    expect(await screen.findByText('登录')).toBeInTheDocument()
    expect(view.container.querySelectorAll('[data-drag-handle]')).toHaveLength(0)
  })
})

describe('WorkflowsView：树行固定到状态栏', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(workflowList).mockResolvedValue({ items: [item({ id: 'w1', name: '登录' })] })
    vi.mocked(workflowGroupList).mockResolvedValue({ items: [] })
    useSettingsStore.getState().hydrateFromBoot(null, null)
  })

  it('点击 Pin：store 写入 workspaceId → workflowId 映射并切常亮态，再点取消', async () => {
    await mountView()
    const pin = await screen.findByTestId('workflows-row-pin')
    expect(pin).toHaveAttribute('aria-label', '固定到状态栏')

    fireEvent.click(pin)
    expect(useSettingsStore.getState().workflowPins).toEqual({ w1: 'w1' })
    expect(screen.getByTestId('workflows-row-pin')).toHaveAttribute('aria-label', '取消固定')

    fireEvent.click(screen.getByTestId('workflows-row-pin'))
    expect(useSettingsStore.getState().workflowPins).toEqual({})
    expect(screen.getByTestId('workflows-row-pin')).toHaveAttribute('aria-label', '固定到状态栏')
  })
})

describe('WorkflowsView：上移 / 下移菜单（指针之外的排序等价路径）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(workflowList).mockResolvedValue({
      items: [
        item({ id: 'w1', name: '登录', groupId: 'g1' }),
        item({ id: 'w2', name: '注册', groupId: 'g1' }),
      ],
    })
    vi.mocked(workflowGroupList).mockResolvedValue({
      items: [
        { id: 'g1', name: '组一', createdAt: '2026-10-24T00:00:00Z' },
        { id: 'g2', name: '组二', createdAt: '2026-10-24T00:00:00Z' },
      ],
    })
    vi.mocked(workflowMove).mockResolvedValue(undefined)
    vi.mocked(workflowGroupMove).mockResolvedValue(undefined)
  })

  it('工作流行上移：按桶内相邻落点下发 move（groupId 随行）', async () => {
    await mountView()
    const row = (await screen.findByText('注册')).closest('[role="treeitem"]') as HTMLElement
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByText('上移'))
    await waitFor(() => {
      expect(workflowMove).toHaveBeenCalledWith('w2', 'g1', 0)
    })
  })

  it('分组行下移：分组序列内相邻重排', async () => {
    await mountView()
    const row = (await screen.findByText('组一')).closest('[role="treeitem"]') as HTMLElement
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByText('下移'))
    await waitFor(() => {
      expect(workflowGroupMove).toHaveBeenCalledWith('g1', 1)
    })
  })
})

describe('WorkflowsView：空态空白右键', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(workflowList).mockResolvedValue({ items: [] })
    vi.mocked(workflowGroupList).mockResolvedValue({ items: [] })
  })

  it('无实体空态：空白右键照样直达「新建」动作集', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    render(
      <QueryClientProvider client={client}>
        <WorkflowsView />
      </QueryClientProvider>,
    )
    const empty = await screen.findByText('尚无工作流')
    fireEvent.contextMenu(empty, { clientX: 12, clientY: 12 })
    expect(await screen.findByTestId('workflows-menu-create')).toBeInTheDocument()
  })
})
