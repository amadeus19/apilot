import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryWrapper } from '@/test/render-providers'
import { useAppStore } from '@/stores/app.store'
import { useSettingsStore } from '@/stores/settings.store'
import { useTabsStore, type TabMeta } from '@/stores/tabs.store'
import { workbenchKeys } from '@/services/workbench-api'
import { variableKeys } from '@/features/variables/variable-api'

import { CommandPaletteDialog } from '../command-palette'
import { useCommandsStore } from '../commands.store'
import { useCommandDispatcher } from '../use-command-dispatcher'
import { useGlobalCommands } from '../global-commands'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

function PaletteHost() {
  useGlobalCommands()
  useCommandDispatcher()
  return <CommandPaletteDialog />
}

function pressCtrlShiftP() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, key: 'P' }))
  })
}

const TABS: TabMeta[] = [
  {
    id: 'endpoint:s1:e1',
    kind: 'endpoint',
    title: '登录',
    serviceId: 's1',
    key: 'e1',
    preview: false,
  },
  {
    id: 'workspaceSettings',
    kind: 'workspaceSettings',
    title: '',
    preview: false,
  },
]

beforeEach(() => {
  // 面板挂载 useWorkspacesQuery（环境动态段数据源）：空清单兜底避免既有
  // 用例拉到 undefined 的 Query 警告；currentId null＝环境动态段不渲染
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === 'workspace.list') return Promise.resolve({ items: [], currentId: null })
    return Promise.resolve(undefined)
  })
  useCommandsStore.setState({ commands: [], paletteOpen: false })
  useAppStore.setState({ settingsOpen: false, leftView: 'apis' })
  useSettingsStore.setState({ keybindings: {} })
  useTabsStore.setState({ tabs: [], activeTabId: null })
})

afterEach(() => {
  useCommandsStore.setState({ commands: [], paletteOpen: false })
})

describe('命令面板', () => {
  it('Ctrl+Shift+P 开关面板；面板按组渲染 8 命令（面板开关与参数化族不出现）', () => {
    render(<PaletteHost />, { wrapper: createQueryWrapper() })
    pressCtrlShiftP()
    expect(useCommandsStore.getState().paletteOpen).toBe(true)
    expect(screen.getByTestId('command-palette-list')).toBeInTheDocument()
    expect(screen.getByText('切到接口树视图')).toBeInTheDocument()
    expect(screen.getByText('关闭当前标签')).toBeInTheDocument()
    expect(screen.getByText('关闭全部标签')).toBeInTheDocument()
    expect(screen.getByText('打开设置')).toBeInTheDocument()
    expect(screen.getByText('检查更新')).toBeInTheDocument()
    expect(screen.getByText('切换明暗主题')).toBeInTheDocument()
    expect(screen.getByText('聚焦左栏搜索')).toBeInTheDocument()
    // 面板开关自身与参数化族不进面板清单（对话框标题同文，须限定在清单内断言）
    const list = screen.getByTestId('command-palette-list')
    expect(within(list).queryByText('命令面板')).not.toBeInTheDocument()
    expect(within(list).queryByText('切换到标签')).not.toBeInTheDocument()
  })

  it('Tab 动态段即时求值：渲染「切换到标签 N」，点击激活对应 Tab 并关闭面板', () => {
    act(() => {
      useTabsStore.setState({ tabs: TABS, activeTabId: TABS[0]!.id })
    })
    render(<PaletteHost />, { wrapper: createQueryWrapper() })
    pressCtrlShiftP()
    expect(screen.getByText(/切换到标签 1/)).toBeInTheDocument()
    expect(screen.getByText(/切换到标签 2/)).toBeInTheDocument()
    fireEvent.click(screen.getByText(/切换到标签 2/))
    expect(useTabsStore.getState().activeTabId).toBe('workspaceSettings')
    expect(useCommandsStore.getState().paletteOpen).toBe(false)
  })

  it('点击命令执行并关闭面板（打开设置）', () => {
    render(<PaletteHost />, { wrapper: createQueryWrapper() })
    pressCtrlShiftP()
    fireEvent.click(screen.getByText('打开设置'))
    expect(useAppStore.getState().settingsOpen).toBe(true)
    expect(useCommandsStore.getState().paletteOpen).toBe(false)
  })

  it('搜索无匹配时显示无结果态', () => {
    render(<PaletteHost />, { wrapper: createQueryWrapper() })
    pressCtrlShiftP()
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: '不存在的命令xyz' } })
    expect(screen.getByText('无匹配命令')).toBeInTheDocument()
  })
})

describe('命令面板·环境动态段（激活分类切换）', () => {
  /** 预热 workspaces / categories / effective 缓存的自建客户端（返回它供失效断言） */
  function renderWithWarmCache() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    queryClient.setQueryData(workbenchKeys.workspaces(), {
      items: [],
      currentId: 'w1',
    })
    queryClient.setQueryData(variableKeys.categories('w1'), {
      items: [
        { id: 'g1', name: '全局公共', isGlobal: true, sortOrder: 0 },
        { id: 'c1', name: '开发环境', isGlobal: false, sortOrder: 1 },
        { id: 'c2', name: '生产环境', isGlobal: false, sortOrder: 2 },
      ],
      activeCategoryId: 'c1',
    })
    queryClient.setQueryData(variableKeys.effective('w1'), { items: [] })
    render(<PaletteHost />, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    })
    pressCtrlShiftP()
    return queryClient
  }

  it('动态段即时求值：只列本空间分类，当前环境打勾；点选即切并关闭面板', async () => {
    renderWithWarmCache()
    const list = screen.getByTestId('command-palette-list')
    expect(within(list).getByText('激活分类：开发环境')).toBeInTheDocument()
    expect(within(list).getByText('激活分类：生产环境')).toBeInTheDocument()
    expect(within(list).queryByText('激活分类：全局公共')).not.toBeInTheDocument()
    // 当前激活行打勾（data-checked 驱动行尾勾选图标）
    expect(
      within(list).getByText('激活分类：开发环境').closest('[data-slot="command-item"]'),
    ).toHaveAttribute('data-checked', 'true')

    fireEvent.click(within(list).getByText('激活分类：生产环境'))
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('variable.set_active_category', {
        workspaceId: 'w1',
        categoryId: 'c2',
      })
    })
    expect(useCommandsStore.getState().paletteOpen).toBe(false)
  })

  it('「全部不激活」行切换为 null；切换后生效集键失效（右栏即时刷新依据）', async () => {
    const queryClient = renderWithWarmCache()
    fireEvent.click(screen.getByText('全部不激活'))
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('variable.set_active_category', {
        workspaceId: 'w1',
        categoryId: null,
      })
    })
    await waitFor(() => {
      expect(queryClient.getQueryState(variableKeys.effective('w1'))?.isInvalidated).toBe(true)
    })
  })
})
