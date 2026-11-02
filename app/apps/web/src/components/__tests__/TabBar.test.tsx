import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TabBar } from '../layout/TabBar'
import { createQueryWrapper } from '@/test/render-providers'
import { makeEndpointNodeId } from '@/lib/tree-identity'
import { useResponseStore } from '@/features/http/response.store'
import { useTabsStore, WORKSPACE_SETTINGS_TAB_ID } from '@/stores/tabs.store'

// TabBar 订阅树全量（Tab 方法徽章数据源）：测试环境无 Tauri，query 静默失败即可
const invokeMock = vi.hoisted(() => vi.fn().mockRejectedValue(new Error('no tauri in tests')))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

beforeEach(() => {
  useTabsStore.setState({ tabs: [], activeTabId: null })
  // 响应条目跨用例隔离（在途指示数据源；模块级 store 不随用例重置）
  useResponseStore.setState({ entries: {} })
})

describe('TabBar（消费 tabs store）', () => {
  it('空态提示（无 tab）', () => {
    render(<TabBar />, { wrapper: createQueryWrapper() })
    expect(screen.getByRole('tablist', { name: '标签栏' })).toBeInTheDocument()
    expect(screen.getByText('无打开的标签页')).toBeInTheDocument()
  })

  it('渲染 Tab 序列：激活 aria-selected、预览态标题去强调、详情 Tab 标题＝工作空间名', () => {
    const store = useTabsStore.getState()
    store.openEndpoint({ serviceId: 's1', key: 'k1', title: '接口A' }, 'persistent')
    store.openEndpoint({ serviceId: 's1', key: 'k2', title: '接口B' }, 'preview')
    store.openWorkspaceSettings({ workspaceId: 'w1', name: '空间一', mode: 'persistent' })
    render(<TabBar />, { wrapper: createQueryWrapper() })

    const tabs = screen.getAllByTestId('tabbar-tab')
    expect(tabs).toHaveLength(3)
    // 最后打开的详情 Tab 处于激活态
    expect(tabs[2]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[0]).toHaveAttribute('aria-selected', 'false')
    expect(tabs[0]).toHaveTextContent('接口A')
    expect(tabs[1]).toHaveAttribute('data-preview')
    expect(tabs[1]).not.toHaveAttribute('aria-selected', 'true')
    // 预览态＝标题去强调；斜体在中文上是合成倾斜，不作为线索
    expect(screen.getByText('接口B')).toHaveClass('text-muted-foreground')
    expect(screen.getByText('接口B')).not.toHaveClass('italic')
    expect(screen.getByText('接口A')).not.toHaveClass('text-muted-foreground')
    // 详情 Tab 标题＝工作空间名（数据；重命名经 setTabTitle 同步）
    expect(tabs[2]).toHaveTextContent('空间一')
  })

  it('详情 Tab 标题空值兜底字典文案', () => {
    const store = useTabsStore.getState()
    store.openWorkspaceSettings({ workspaceId: 'w1', name: '', mode: 'persistent' })
    render(<TabBar />, { wrapper: createQueryWrapper() })
    expect(screen.getByTestId('tabbar-tab')).toHaveTextContent('工作空间设置')
  })

  it('点击＝激活；双击＝预览转常驻', async () => {
    const user = userEvent.setup()
    const store = useTabsStore.getState()
    store.openEndpoint({ serviceId: 's1', key: 'k1', title: '接口A' }, 'persistent')
    store.openEndpoint({ serviceId: 's1', key: 'k2', title: '接口B' }, 'preview')
    render(<TabBar />, { wrapper: createQueryWrapper() })

    await user.click(screen.getByText('接口A'))
    expect(useTabsStore.getState().activeTabId).toBe(makeEndpointNodeId('s1', 'k1'))

    await user.dblClick(screen.getByText('接口B'))
    expect(useTabsStore.getState().tabs[1]?.preview).toBe(false)
    expect(useTabsStore.getState().activeTabId).toBe(makeEndpointNodeId('s1', 'k2'))
  })

  it('键盘：←→ 切换激活（焦点跟随）、Enter＝激活、Ctrl+Enter 不再转正', async () => {
    const user = userEvent.setup()
    const store = useTabsStore.getState()
    store.openEndpoint({ serviceId: 's1', key: 'k1', title: '接口A' }, 'persistent')
    store.openEndpoint({ serviceId: 's1', key: 'k2', title: '接口B' }, 'preview')
    render(<TabBar />, { wrapper: createQueryWrapper() })
    // roving tabindex：Tab 进入落激活行（接口B，最后打开）
    await user.tab()
    await user.keyboard('{ArrowLeft}')
    expect(useTabsStore.getState().activeTabId).toBe(makeEndpointNodeId('s1', 'k1'))
    // Enter＝激活（tablist 惯例）：激活移到焦点行
    await user.keyboard('{ArrowRight}')
    await user.keyboard('{Enter}')
    expect(useTabsStore.getState().activeTabId).toBe(makeEndpointNodeId('s1', 'k2'))
    // Ctrl+Enter 归全局发送命令（TabBar 不拦不转正）：预览标记保持
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(useTabsStore.getState().tabs[1]?.preview).toBe(true)
  })

  it('右键菜单：关闭其他 / 关闭右侧 / 关闭全部', async () => {
    const store = useTabsStore.getState()
    store.openEndpoint({ serviceId: 's1', key: 'k1', title: '接口A' }, 'persistent')
    store.openEndpoint({ serviceId: 's1', key: 'k2', title: '接口B' }, 'persistent')
    store.openEndpoint({ serviceId: 's1', key: 'k3', title: '接口C' }, 'persistent')
    render(<TabBar />, { wrapper: createQueryWrapper() })
    // 对接口B（中间行）开菜单：关闭右侧只余 A、B
    fireEvent.contextMenu(screen.getByText('接口B'))
    await userEvent.click(screen.getByText('关闭右侧标签页'))
    expect(useTabsStore.getState().tabs.map((tab) => tab.title)).toEqual(['接口A', '接口B'])
    fireEvent.contextMenu(screen.getByText('接口A'))
    await userEvent.click(screen.getByText('关闭其他标签页'))
    expect(useTabsStore.getState().tabs.map((tab) => tab.title)).toEqual(['接口A'])
    // 单 Tab：关闭其他 / 关闭右侧禁用，关闭全部仍可用
    fireEvent.contextMenu(screen.getByText('接口A'))
    expect(screen.getByText('关闭其他标签页')).toHaveAttribute('data-disabled')
    await userEvent.click(screen.getByText('关闭全部标签页'))
    expect(useTabsStore.getState().tabs).toHaveLength(0)
  })

  it('中键＝关闭对应 Tab', () => {
    const store = useTabsStore.getState()
    store.openEndpoint({ serviceId: 's1', key: 'k1', title: '接口A' }, 'persistent')
    render(<TabBar />, { wrapper: createQueryWrapper() })
    fireEvent(
      screen.getByTestId('tabbar-tab'),
      new MouseEvent('auxclick', { button: 1, bubbles: true }),
    )
    expect(useTabsStore.getState().tabs).toHaveLength(0)
  })

  it('关闭钮：关闭对应 Tab（激活指针按右邻语义由 store 裁决）', async () => {
    const user = userEvent.setup()
    const store = useTabsStore.getState()
    store.openEndpoint({ serviceId: 's1', key: 'k1', title: '接口A' }, 'persistent')
    store.openEndpoint({ serviceId: 's1', key: 'k2', title: '接口B' }, 'persistent')
    render(<TabBar />, { wrapper: createQueryWrapper() })

    await user.click(screen.getByRole('button', { name: '关闭 接口A' }))
    const state = useTabsStore.getState()
    expect(state.tabs.map((tab) => tab.id)).toEqual([makeEndpointNodeId('s1', 'k2')])
    expect(state.activeTabId).toBe(makeEndpointNodeId('s1', 'k2'))
  })

  it('工作空间详情 Tab 的关闭钮标签跟随工作空间名标题', () => {
    useTabsStore
      .getState()
      .openWorkspaceSettings({ workspaceId: 'w1', name: '空间一', mode: 'persistent' })
    render(<TabBar />, { wrapper: createQueryWrapper() })
    expect(screen.getByRole('button', { name: '关闭 空间一' })).toBeInTheDocument()
    void WORKSPACE_SETTINGS_TAB_ID
  })

  it('发送中的 Tab 标题旁有进行中 spinner，终态落定后自然摘除', () => {
    const store = useTabsStore.getState()
    store.openEndpoint({ serviceId: 's1', key: 'k1', title: '接口A' }, 'persistent')
    store.openEndpoint({ serviceId: 's1', key: 'k2', title: '接口B' }, 'persistent')
    const tabA = makeEndpointNodeId('s1', 'k1')
    useResponseStore.setState({
      entries: { [tabA]: { phase: 'sending', result: null, error: null, startedAt: Date.now() } },
    })
    render(<TabBar />, { wrapper: createQueryWrapper() })
    const tabs = screen.getAllByTestId('tabbar-tab')
    // 仅在途 Tab 有指示（切 Tab 后请求后台继续的可见线索）
    expect(within(tabs[0]!).getByTestId('tabbar-tab-spinner')).toBeInTheDocument()
    expect(within(tabs[1]!).queryByTestId('tabbar-tab-spinner')).not.toBeInTheDocument()
    // 语义经 role=status 交给读屏器（标签走字典同键）
    expect(within(tabs[0]!).getByRole('status')).toHaveAttribute('aria-label', '发送中…')
    // store 落定终态（结果由后台写回）后指示随订阅更新摘除（act 内更新
    // 触发已挂载组件重渲）
    act(() => {
      useResponseStore.setState({
        entries: { [tabA]: { phase: 'done', result: null, error: null, startedAt: null } },
      })
    })
    expect(within(tabs[0]!).queryByTestId('tabbar-tab-spinner')).not.toBeInTheDocument()
  })
})
