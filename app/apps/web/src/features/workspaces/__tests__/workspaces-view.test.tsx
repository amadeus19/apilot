import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { toastStore } from '@workspace/ui/components'
import { ResizeObserverMock } from '@/test/setup'
import { createQueryWrapper } from '@/test/render-providers'

import { useTabsStore } from '@/stores/tabs.store'
import { WorkspaceSwitcher } from '../workspace-switcher'
import { useWorkspacesStore } from '../workspaces.store'
import { WorkspacesView } from '../workspaces-view'
import { WorkspacesDialogHost } from '../workspaces-dialogs'

// —— IPC invoke 替换：按命令名分派 ——
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const WORKSPACES = {
  items: [
    { id: 'w1', name: '默认工作空间', baseUrl: null, auth: null, isCurrent: true },
    { id: 'w2', name: '第二空间', baseUrl: null, auth: null, isCurrent: false },
  ],
  currentId: 'w1',
}

const SERVICES: Record<string, unknown[]> = {
  w1: [
    {
      id: 's1',
      workspaceId: 'w1',
      name: '用户服务',
      docUrl: '/swagger/v1.json',
      docType: 'openapi',
      sortOrder: 0,
    },
    {
      id: 's2',
      workspaceId: 'w1',
      name: '手工容器',
      docUrl: null,
      docType: 'openapi',
      sortOrder: 1,
    },
  ],
  w2: [],
}

/** 渲染树视图并模拟虚拟化视口（jsdom 无布局：offsetHeight + 手动触发 ResizeObserver）。
 *  全局对话框宿主随挂（对齐 AppShell 的真实形态：视图发信号、宿主呈现并消费）。
 *  可选传入搜索接线（过滤行为测试用）。 */
async function renderView(
  viewProps: { searchQuery?: string; onSearchChange?: (value: string) => void } = {},
) {
  const view = render(
    <>
      <WorkspacesView {...viewProps} />
      <WorkspacesDialogHost />
    </>,
    { wrapper: createQueryWrapper() },
  )
  await screen.findByRole('tree', { name: '工作空间清单' })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const scrollEl = view.container.querySelector<HTMLElement>('[data-slot="tree-scroll"]')
  if (scrollEl) {
    Object.defineProperty(scrollEl, 'offsetHeight', { configurable: true, value: 300 })
  }
  act(() => {
    for (const observer of ResizeObserverMock.instances) {
      observer.callback([] as ResizeObserverEntry[], observer as unknown as ResizeObserver)
    }
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  return view
}

/** 展开指定工作空间（模拟用户点击折叠指示后的受控展开集） */
function expandWorkspaces(ids: string[]): void {
  act(() => {
    useWorkspacesStore.getState().setTreeExpandedIds(ids)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  useTabsStore.setState({ tabs: [], activeTabId: null, activationSeq: 0 })
  useWorkspacesStore.setState({
    dialog: null,
    treeSelectedWorkspaceId: null,
    treeExpandedIds: [],
  })
  invokeMock.mockImplementation((cmd: string, args?: { workspaceId?: string }) => {
    if (cmd === 'workspace.list') return Promise.resolve(WORKSPACES)
    if (cmd === 'service.list_by_workspace') {
      return Promise.resolve(SERVICES[args?.workspaceId ?? ''] ?? [])
    }
    return Promise.resolve(undefined)
  })
})

describe('左栏工作空间树视图', () => {
  it('两级树渲染：工作空间行恒在，服务行随展开出现（树不标无文档徽标）', async () => {
    await renderView()
    expect(screen.getByRole('treeitem', { name: '默认工作空间' })).toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: '第二空间' })).toBeInTheDocument()
    // 展开集受控：初始收起，服务行不出现
    expect(screen.queryByRole('treeitem', { name: '用户服务' })).not.toBeInTheDocument()
    expandWorkspaces(['w1'])
    expect(screen.getByRole('treeitem', { name: '用户服务' })).toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: '手工容器' })).toBeInTheDocument()
    // 树是导航面，不承载「无文档地址」事实（详情页服务表格是唯一真相面）
    expect(screen.queryByText('无文档地址')).not.toBeInTheDocument()
  })

  it('点击工作空间行 / 服务行＝选中该空间并打开详情 Tab（现有接缝）', async () => {
    const user = userEvent.setup()
    await renderView()
    expandWorkspaces(['w1'])
    await user.click(screen.getByRole('treeitem', { name: '用户服务' }))
    // 服务行点击：树选中落到其所属工作空间
    expect(useWorkspacesStore.getState().treeSelectedWorkspaceId).toBe('w1')
    // 详情 Tab 打开（工作空间设置页）
    expect(useTabsStore.getState().tabs).toHaveLength(1)

    await user.click(screen.getByRole('treeitem', { name: '第二空间' }))
    expect(useWorkspacesStore.getState().treeSelectedWorkspaceId).toBe('w2')
  })

  it('点击工作空间行＝打开详情不展开；行首箭头＝唯一展开入口（title 随态切换）', async () => {
    const user = userEvent.setup()
    await renderView()
    await user.click(screen.getByRole('treeitem', { name: '默认工作空间' }))
    // 行点击打开详情 Tab，但不触碰展开态（服务行不出现）
    expect(useTabsStore.getState().tabs).toHaveLength(1)
    expect(screen.queryByRole('treeitem', { name: '用户服务' })).not.toBeInTheDocument()
    expect(useWorkspacesStore.getState().treeExpandedIds).toEqual([])

    // 箭头点击＝展开（服务行出现）；工作空间行箭头 title 提示随态切换
    const chevron = screen
      .getByRole('treeitem', { name: '默认工作空间' })
      .querySelector<HTMLElement>('[data-tree-chevron]')!
    expect(chevron).toHaveAttribute('title', '展开')
    await user.click(chevron)
    expect(await screen.findByRole('treeitem', { name: '用户服务' })).toBeInTheDocument()
    expect(useWorkspacesStore.getState().treeExpandedIds).toEqual(['w1'])
    expect(chevron).toHaveAttribute('title', '收起')
  })

  it('激活行名称图标常态主题色；选中样式（竖杠＋底色）由树画、两态叠加', async () => {
    await renderView()
    // 无选中：激活行（当前空间 w1）的图层图标染主题色，非激活行不染
    const currentIcon = screen
      .getByRole('treeitem', { name: '默认工作空间' })
      .querySelector('svg.lucide-layers-2')
    expect(currentIcon).toHaveClass('text-primary')
    expect(
      screen.getByRole('treeitem', { name: '第二空间' }).querySelector('svg.lucide-layers-2'),
    ).not.toHaveClass('text-primary')
    // 选中 w1：树画选中竖杠，激活图标主题色保持（两态叠加）
    act(() => {
      useWorkspacesStore.getState().setTreeSelectedWorkspace('w1')
    })
    expect(currentIcon).toHaveClass('text-primary')
    expect(
      screen
        .getByRole('treeitem', { name: '默认工作空间' })
        .querySelector('[data-slot="tree-row-selected-bar"]'),
    ).not.toBeNull()
  })

  it('右键工作空间行：设为当前（已是当前禁用）/ 重命名 / 删除', async () => {
    const user = userEvent.setup()
    await renderView()
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: '默认工作空间' }))
    const setCurrentItem = screen.getByRole('menuitem', { name: '设为当前' })
    expect(setCurrentItem).toHaveAttribute('data-disabled')
    await user.click(screen.getByRole('menuitem', { name: '重命名' }))
    expect(useWorkspacesStore.getState().dialog).toEqual({
      type: 'ws-rename',
      id: 'w1',
      name: '默认工作空间',
    })
    // 关掉重命名对话框（modal 遮罩外内容不可达，后续断言需树行回归）
    await user.keyboard('{Escape}')

    fireEvent.contextMenu(screen.getByRole('treeitem', { name: '第二空间' }))
    expect(screen.getByRole('menuitem', { name: '设为当前' })).not.toHaveAttribute('data-disabled')
    await user.click(screen.getByRole('menuitem', { name: '设为当前' }))
    expect(invokeMock).toHaveBeenCalledWith('workspace.set_current', { id: 'w2' })
  })

  it('右键服务行：编辑 / 删除；空白区右键＝新建工作空间', async () => {
    const user = userEvent.setup()
    await renderView()
    expandWorkspaces(['w1'])
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: '用户服务' }))
    await user.click(screen.getByRole('menuitem', { name: '编辑' }))
    expect(useWorkspacesStore.getState().dialog).toEqual({
      type: 'service-edit',
      id: 's1',
      name: '用户服务',
      docUrl: '/swagger/v1.json',
    })

    fireEvent.contextMenu(screen.getByTestId('workspaces-tree-body'))
    await user.click(screen.getByRole('menuitem', { name: '新建工作空间' }))
    expect(useWorkspacesStore.getState().dialog).toEqual({ type: 'ws-new' })
  })

  it('双击工作空间行＝设为当前空间（切换直达；服务行无双击语义）', async () => {
    await renderView()
    expandWorkspaces(['w1'])
    fireEvent.dblClick(screen.getByRole('treeitem', { name: '第二空间' }))
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('workspace.set_current', { id: 'w2' })
    })
    // 服务行双击不触发设为当前（双击语义仅工作空间行）
    const before = invokeMock.mock.calls.filter(([cmd]) => cmd === 'workspace.set_current')
    fireEvent.dblClick(screen.getByRole('treeitem', { name: '用户服务' }))
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'workspace.set_current')).toHaveLength(
      before.length,
    )
  })

  it('双击切换成功＝一次性 toast 反馈，action 位可切回原空间', async () => {
    await renderView()
    fireEvent.dblClick(screen.getByRole('treeitem', { name: '第二空间' }))
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('workspace.set_current', { id: 'w2' })
    })
    await waitFor(() => {
      const toast = toastStore
        .getSnapshot()
        .find((item) => item.message.includes('已切换到「第二空间」'))
      expect(toast).toBeDefined()
      expect(toast!.action?.label).toBe('切回')
      // action 位点击＝切回原空间（w1）
      toast!.action!.onClick()
    })
    await vi.waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'workspace.set_current')
      expect(calls).toHaveLength(2)
    })
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'workspace.set_current')[1]![1]).toEqual(
      { id: 'w1' },
    )
  })

  it('双击已是当前的工作空间＝无切换语义不发 invoke；行 title 提示双击手势', async () => {
    await renderView()
    const currentRow = screen.getByRole('treeitem', { name: '默认工作空间' })
    // 双击手势经行 title 自发现（工作空间行有、服务行无）
    expect(currentRow.querySelector('[title="双击设为当前工作空间"]')).not.toBeNull()
    fireEvent.dblClick(currentRow)
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'workspace.set_current')).toHaveLength(0)
    expandWorkspaces(['w1'])
    expect(screen.getByRole('treeitem', { name: '用户服务' }).querySelector('[title]')).toBeNull()
  })

  it('行尾渲染拖拽手柄（工作空间行与服务行，按住才解锁拖拽）', async () => {
    await renderView()
    expandWorkspaces(['w1'])
    expect(
      screen.getByRole('treeitem', { name: '默认工作空间' }).querySelector('[data-drag-handle]'),
    ).not.toBeNull()
    expect(
      screen.getByRole('treeitem', { name: '用户服务' }).querySelector('[data-drag-handle]'),
    ).not.toBeNull()
  })

  it('搜索过滤：命中服务行时父空间保留并自动展开，未命中空间剔除、手柄隐藏', async () => {
    await renderView({ searchQuery: '用户' })
    // 父工作空间行保留（其名不含查询词），命中服务行经自动展开可见
    expect(screen.getByRole('treeitem', { name: '默认工作空间' })).toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: '用户服务' })).toBeInTheDocument()
    // 未命中的兄弟空间从子图剔除
    expect(screen.queryByRole('treeitem', { name: '第二空间' })).not.toBeInTheDocument()
    // 过滤子图不可拖：手柄隐藏
    expect(
      screen.getByRole('treeitem', { name: '用户服务' }).querySelector('[data-drag-handle]'),
    ).toBeNull()
    // 命中父级进展开集（快照机自动展开）
    expect(useWorkspacesStore.getState().treeExpandedIds).toEqual(['w1'])
  })

  it('搜索过滤中点击工作空间行＝照常打开详情（子图交互不降级）', async () => {
    const user = userEvent.setup()
    await renderView({ searchQuery: '第二' })
    // 命中行＝空间行本身（可见子图只含命中行与其祖先，与接口树口径同构）
    expect(screen.getByRole('treeitem', { name: '第二空间' })).toBeInTheDocument()
    expect(screen.queryByRole('treeitem', { name: '默认工作空间' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('treeitem', { name: '第二空间' }))
    expect(useWorkspacesStore.getState().treeSelectedWorkspaceId).toBe('w2')
    expect(useTabsStore.getState().tabs).toHaveLength(1)
  })

  it('清除搜索恢复进入过滤前的展开快照', async () => {
    expandWorkspaces(['w1'])
    const view = await renderView({ searchQuery: '用户' })
    // 过滤中折叠在子图内不落快照：进入前的基线（['w1']）在清除时恢复
    view.rerender(
      <>
        <WorkspacesView searchQuery="" />
        <WorkspacesDialogHost />
      </>,
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(useWorkspacesStore.getState().treeExpandedIds).toEqual(['w1'])
  })

  it('搜索无命中：空态呈现，清除搜索按钮经宿主回调清词', async () => {
    const user = userEvent.setup()
    const onSearchChange = vi.fn()
    // 空态分支无树体，不走过渲染 helper（helper 等待树出现）
    render(<WorkspacesView searchQuery="不存在的词" onSearchChange={onSearchChange} />, {
      wrapper: createQueryWrapper(),
    })
    await screen.findByText('无匹配工作空间或服务')
    await user.click(screen.getByRole('button', { name: '清除搜索' }))
    expect(onSearchChange).toHaveBeenCalledWith('')
  })

  it('双击三连发：前导第二击激活被吞（激活序号不推进），设为当前照常', async () => {
    await renderView()
    const row = screen.getByRole('treeitem', { name: '第二空间' })
    fireEvent.click(row)
    expect(useTabsStore.getState().activationSeq).toBe(1)
    // 双击手势的前导第二击：与首击同身份，吞并窗口内不重复导航
    fireEvent.click(row)
    expect(useTabsStore.getState().activationSeq).toBe(1)
    // 双击语义不回归：设为当前照发
    fireEvent.dblClick(row)
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('workspace.set_current', { id: 'w2' })
    })
  })

  it('右键工作空间行上移/下移：首行禁上、末行禁下', async () => {
    const user = userEvent.setup()
    await renderView()
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: '默认工作空间' }))
    expect(screen.getByRole('menuitem', { name: '上移' })).toHaveAttribute('data-disabled')
    expect(screen.getByRole('menuitem', { name: '下移' })).not.toHaveAttribute('data-disabled')
    // 菜单为 modal 呈现：先 Escape 关闭，再对另一行开菜单
    await user.keyboard('{Escape}')

    fireEvent.contextMenu(screen.getByRole('treeitem', { name: '第二空间' }))
    expect(screen.getByRole('menuitem', { name: '上移' })).not.toHaveAttribute('data-disabled')
    expect(screen.getByRole('menuitem', { name: '下移' })).toHaveAttribute('data-disabled')
  })

  it('工作空间上移＝workspace.reorder 交换相邻两项一次到位', async () => {
    const user = userEvent.setup()
    await renderView()
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: '第二空间' }))
    await user.click(screen.getByRole('menuitem', { name: '上移' }))
    expect(invokeMock).toHaveBeenCalledWith('workspace.reorder', {
      orderedIds: ['w2', 'w1'],
    })
  })

  it('服务行上移/下移：首行禁上、末行禁下；点击走 service.move', async () => {
    const user = userEvent.setup()
    await renderView()
    expandWorkspaces(['w1'])
    // 首行（用户服务）禁上
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: '用户服务' }))
    expect(screen.getByRole('menuitem', { name: '上移' })).toHaveAttribute('data-disabled')
    await user.click(screen.getByRole('menuitem', { name: '下移' }))
    expect(invokeMock).toHaveBeenCalledWith('service.move', { id: 's1', direction: 'down' })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // 末行（手工容器）禁下
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: '手工容器' }))
    expect(screen.getByRole('menuitem', { name: '下移' })).toHaveAttribute('data-disabled')
  })

  it('底部固定「新建工作空间」动作条直接开命名对话框', async () => {
    const user = userEvent.setup()
    await renderView()
    await user.click(screen.getByTestId('workspace-new'))
    expect(useWorkspacesStore.getState().dialog).toEqual({ type: 'ws-new' })
    expect(screen.getByRole('dialog', { name: '新建工作空间' })).toBeInTheDocument()
  })

  it('删除正在查看的空间后树选中清空（不悬空）', async () => {
    const user = userEvent.setup()
    act(() => {
      useWorkspacesStore.getState().setTreeSelectedWorkspace('w2')
    })
    await renderView()
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: '第二空间' }))
    await user.click(screen.getByRole('menuitem', { name: '删除' }))
    expect(useWorkspacesStore.getState().dialog).toEqual({
      type: 'ws-delete',
      id: 'w2',
      name: '第二空间',
    })
    // 确认删除（对话框内 destructive 确认钮）
    await user.click(screen.getByRole('button', { name: '删除' }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(invokeMock).toHaveBeenCalledWith('workspace.delete', { id: 'w2' })
    expect(useWorkspacesStore.getState().treeSelectedWorkspaceId).toBeNull()
  })
})

describe('标题栏工作空间切换器（精简后）', () => {
  it('清单可选当前；无「新建工作空间」「管理工作空间」入口，保留「工作空间设置」', async () => {
    const user = userEvent.setup()
    render(<WorkspaceSwitcher />, { wrapper: createQueryWrapper() })
    await user.click(await screen.findByRole('button', { name: /工作空间: 默认工作空间/ }))
    await screen.findByRole('menu')
    expect(screen.getByRole('menuitem', { name: '第二空间' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: '新建工作空间…' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: '管理工作空间' })).not.toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '工作空间设置' })).toBeInTheDocument()
  })

  it('nonce 新建信号协议无残留（生产者与消费者一并移除）', () => {
    expect('requestNewWorkspace' in useWorkspacesStore.getState()).toBe(false)
    expect('consumeNewWorkspaceRequest' in useWorkspacesStore.getState()).toBe(false)
    expect('newWorkspaceRequest' in useWorkspacesStore.getState()).toBe(false)
  })
})
