import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 分栏库替换为测试替身：接线测试只测「库管几何，store 管语义」的接线面，
// 库内部几何行为不在此测（上游已有基线）
vi.mock('react-resizable-panels', async () => await import('@/test/panels-double'))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    onResized: vi.fn().mockResolvedValue(() => {}),
  }),
}))
const invokeMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn().mockResolvedValue('0.1.0'),
}))

import { AppShell } from '../layout/AppShell'
import { LeftPanel } from '../layout/LeftPanel'
import { firePanelResize, panelApi, panelProps, resetPanelsDouble } from '@/test/panels-double'
import { createQueryWrapper } from '@/test/render-providers'
import { DEFAULT_LEFT_PANEL_WIDTH, MIN_LEFT_PANEL_WIDTH, useAppStore } from '@/stores/app.store'
import { useSettingsStore } from '@/stores/settings.store'
import { useTabsStore } from '@/stores/tabs.store'
import type { RunListItemDto } from '@/features/history/history-api'

beforeEach(() => {
  vi.clearAllMocks()
  resetPanelsDouble()
  vi.useFakeTimers()
  useAppStore.setState({
    leftView: 'apis',
    leftPanelVisible: true,
    leftPanelWidth: DEFAULT_LEFT_PANEL_WIDTH,
    responseCollapsed: false,
    settingsOpen: false,
  })
  useTabsStore.setState({ tabs: [], activeTabId: null })
  useSettingsStore.getState().hydrateFromBoot(null, null)
})

afterEach(() => {
  vi.useRealTimers()
})

/** 防抖窗口（300ms）走完，观察持久化写入 */
async function flushDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(300)
}

describe('左栏分栏接线（库管几何，store 管语义）', () => {
  it('启动 defaultSize 注入持久化宽度；未定制时用默认宽', () => {
    useSettingsStore.setState({ shell: { width: 340 } })
    const { unmount } = render(<AppShell />, { wrapper: createQueryWrapper() })
    expect(panelProps('left-panel')?.defaultSize).toBe('340px')
    unmount()

    resetPanelsDouble()
    useSettingsStore.setState({ shell: { width: null } })
    render(<AppShell />, { wrapper: createQueryWrapper() })
    expect(panelProps('left-panel')?.defaultSize).toBe(`${DEFAULT_LEFT_PANEL_WIDTH}px`)
  })

  it('约束契约：50% 上限、50px 自动收起阈值、可折叠、collapsedSize 0、窗口缩放保持像素宽', () => {
    render(<AppShell />, { wrapper: createQueryWrapper() })
    const props = panelProps('left-panel')
    expect(props?.maxSize).toBe('50%')
    expect(props?.minSize).toBe(MIN_LEFT_PANEL_WIDTH)
    expect(props?.collapsible).toBe(true)
    expect(props?.collapsedSize).toBe(0)
    // 窗口最大化 / 全屏不得按百分比放大左栏
    expect(props?.groupResizeBehavior).toBe('preserve-pixel-size')
  })

  it('onResize 上提镜像：展开态尺寸写宽度镜像并防抖持久化', async () => {
    render(<AppShell />, { wrapper: createQueryWrapper() })
    invokeMock.mockClear()
    firePanelResize('left-panel', 340)
    expect(useAppStore.getState().leftPanelWidth).toBe(340)
    expect(useAppStore.getState().leftPanelVisible).toBe(true)
    await flushDebounce()
    expect(invokeMock).toHaveBeenCalledWith('set_setting', {
      key: 'shell.leftPanelWidth',
      value: { width: 340 },
    })
  })

  it('低于最小宽度阈值：库自动收起，镜像翻转为不可见，宽度不持久化', async () => {
    render(<AppShell />, { wrapper: createQueryWrapper() })
    invokeMock.mockClear()
    firePanelResize('left-panel', MIN_LEFT_PANEL_WIDTH - 1)
    expect(useAppStore.getState().leftPanelVisible).toBe(false)
    expect(useAppStore.getState().leftPanelWidth).toBe(DEFAULT_LEFT_PANEL_WIDTH)
    await flushDebounce()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('语义开关下发：Ctrl+B 收起 resize 至折叠尺寸、展开一律回默认宽度（拖动宽不记忆）', () => {
    // 动画在 reduced-motion 下直达终值（测试确定性；动画步进本身不在此测）
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: true, addListener: vi.fn(), removeListener: vi.fn() }),
    )
    render(<AppShell />, { wrapper: createQueryWrapper() })
    const api = panelApi('left-panel')
    expect(api).toBeDefined()
    const collapseSpy = vi.spyOn(api!, 'collapse')
    const expandSpy = vi.spyOn(api!, 'expand')
    const resizeSpy = vi.spyOn(api!, 'resize')

    window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, key: 'b' }))
    // 收起＝分步 resize 至折叠尺寸（终态 isCollapsed 由尺寸判定，不走 collapse()）
    expect(resizeSpy).toHaveBeenCalledWith('0px')
    expect(collapseSpy).not.toHaveBeenCalled()

    // Ctrl+Shift+B / Ctrl+Alt+B 不吞（纯 Ctrl 组合判据）：已收起，展开会触发 resize
    resizeSpy.mockClear()
    window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, key: 'b' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, altKey: true, key: 'b' }))
    // 纯 Ctrl 的收展开关只有第一次 Ctrl+B 之后的那次不触发（这两次是修饰组合）
    expect(resizeSpy).not.toHaveBeenCalled()

    // 展开语义：一律回默认宽度（收起即重置，不走库的「上次尺寸」记忆）
    window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, key: 'b' }))
    expect(resizeSpy).toHaveBeenCalledWith(`${DEFAULT_LEFT_PANEL_WIDTH}px`)
    expect(expandSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('卸载时防抖剩余宽度补写落库（DebouncedWriter dispose 纪律：不丢最后一次拖动）', async () => {
    const { unmount } = render(<AppShell />, { wrapper: createQueryWrapper() })
    invokeMock.mockClear()
    firePanelResize('left-panel', 360)
    unmount()
    await flushDebounce()
    expect(invokeMock).toHaveBeenCalledWith('set_setting', {
      key: 'shell.leftPanelWidth',
      value: { width: 360 },
    })
  })
})

describe('主区上下分栏接线', () => {
  /** 会话恢复路径夹具：有当前工作空间且会话带一个常驻接口 Tab（真实启动链路） */
  function stubSessionWithEndpointTab(): void {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'workspace.list') {
        return Promise.resolve({
          items: [{ id: 'w1', name: '工作空间', baseUrl: null, isCurrent: true }],
          currentId: 'w1',
        })
      }
      if (cmd === 'session.get') {
        return Promise.resolve({
          tabs: JSON.stringify({
            tabs: [
              {
                id: 'endpoint:s1:k1',
                kind: 'endpoint',
                title: '接口',
                serviceId: 's1',
                key: 'k1',
                preview: false,
              },
            ],
            activeTabId: 'endpoint:s1:k1',
          }),
          treeExpanded: '[]',
        })
      }
      return Promise.resolve(undefined)
    })
  }

  it('标签栏在分栏结构外；请求区 minSize 保底', async () => {
    stubSessionWithEndpointTab()
    render(<AppShell />, { wrapper: createQueryWrapper() })
    // 会话恢复（workspace.list → session.get 两段微任务）完成后接口 Tab 在场
    await vi.waitFor(() => {
      expect(panelProps('response-panel')).toBeDefined()
    })
    expect(panelProps('tabbar-panel')).toBeUndefined()
    expect(screen.getByTestId('tabbar')).toBeInTheDocument()
    expect(panelProps('request-panel')?.minSize).toBe(80)
  })

  it('响应区只在接口 Tab 激活时挂载（工作空间设置页独占主区不混排）', () => {
    stubSessionWithEndpointTab()
    render(<AppShell />, { wrapper: createQueryWrapper() })
    // 无 Tab（欢迎屏）：响应区不渲染
    expect(panelProps('response-panel')).toBeUndefined()
    act(() => {
      useTabsStore
        .getState()
        .openEndpoint({ serviceId: 's1', key: 'k1', title: '接口' }, 'persistent')
    })
    expect(panelProps('response-panel')).toBeDefined()

    act(() => {
      useTabsStore
        .getState()
        .openWorkspaceSettings({ workspaceId: 'w1', name: '空间一', mode: 'persistent' })
    })
    expect(panelProps('response-panel')).toBeUndefined()
  })

  it('响应区契约：默认 45%、minSize 64px＞折叠带契约、可折叠为 36px 状态行、尺寸不持久化', async () => {
    // 条带展开走记忆高度动画：reduced-motion 下直达终值（测试确定性）
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: true, addListener: vi.fn(), removeListener: vi.fn() }),
    )
    stubSessionWithEndpointTab()
    render(<AppShell />, { wrapper: createQueryWrapper() })
    // 会话恢复（微任务）完成后接口 Tab 在场 → 响应区挂载
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const props = panelProps('response-panel')
    expect(props?.defaultSize).toBe('45%')
    // 拖拽折叠契约：minSize 必须大于 collapsedSize（折叠带＝两者之间）
    expect(props?.minSize).toBe(64)
    expect(props?.collapsible).toBe(true)
    expect(props?.collapsedSize).toBe('36px')

    // 折叠语义镜像：折叠态＝状态行条带，点击展开（imperative）
    invokeMock.mockClear()
    expect(screen.getByText('发送请求后，响应将在此显示')).toBeInTheDocument()
    act(() => {
      panelApi('response-panel')!.collapse()
    })
    expect(useAppStore.getState().responseCollapsed).toBe(true)
    expect(screen.getByRole('button', { name: '展开响应区' })).toBeInTheDocument()
    await flushDebounce()
    // 响应区尺寸无持久化通道（宽度走 set_setting、会话快照只含 tabs/树展开）
    const settingCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'set_setting')
    expect(settingCalls).toHaveLength(0)

    // 点击状态行 → 分步 resize 恢复记忆高（reduced-motion 直达终值），镜像翻回
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '展开响应区' }))
    })
    expect(useAppStore.getState().responseCollapsed).toBe(false)
    expect(screen.getByText('发送请求后，响应将在此显示')).toBeInTheDocument()
    vi.unstubAllGlobals()
  })
})

describe('左栏搜索防抖（输入停顿 ~150ms 才提交过滤）', () => {
  /** 历史视图样本三行（method / 路径各异，供过滤断言） */
  function sampleHistoryRows(): RunListItemDto[] {
    const at = (ageMs: number) => new Date(Date.now() - ageMs).toISOString()
    return [
      {
        runId: 'r-today',
        state: 'passed',
        method: 'GET',
        url: 'http://localhost:8080/api/orders?page=1',
        statusCode: 200,
        durationMs: 340,
        source: 'gui',
        createdAt: at(3_000),
        endpointName: null,
      },
      {
        runId: 'r-yesterday',
        state: 'passed',
        method: 'POST',
        url: 'http://localhost:8080/api/users/42',
        statusCode: 404,
        durationMs: 340,
        source: 'gui',
        createdAt: at(26 * 3_600_000),
        endpointName: null,
      },
      {
        runId: 'r-earlier',
        state: 'passed',
        method: 'GET',
        url: 'http://localhost:8080/api/items',
        statusCode: 200,
        durationMs: 340,
        source: 'cli',
        createdAt: at(5 * 86_400_000),
        endpointName: null,
      },
    ]
  }

  function stubHistoryList(rows: RunListItemDto[]): void {
    invokeMock.mockImplementation((cmd: string) => {
      // 历史查询以当前工作空间为作用域（workspaceId 入键、null 期间门控）：
      // 不桩 workspace.list 会让面板停在「加载中」而非列表态
      if (cmd === 'workspace.list') return Promise.resolve({ items: [], currentId: 'w1' })
      if (cmd === 'run.list') return Promise.resolve(rows)
      return Promise.resolve(undefined)
    })
  }

  it('输入即时回显；停顿 150ms 才提交（过滤分组延迟一拍重算）', async () => {
    useAppStore.setState({ leftView: 'history' })
    stubHistoryList(sampleHistoryRows())
    render(<LeftPanel />, { wrapper: createQueryWrapper() })
    // 历史行经 workspace.list → run.list 两段查询链（workspaceId 入键后串行两段）
    await vi.waitFor(() => {
      expect(screen.getAllByTestId('history-row')).toHaveLength(3)
    })

    const input = screen.getByLabelText('搜索请求历史')
    fireEvent.change(input, { target: { value: 'users' } })
    // 草稿即时回显；防抖窗口内列表未过滤
    expect(input).toHaveValue('users')
    expect(screen.getAllByTestId('history-row')).toHaveLength(3)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(screen.getAllByTestId('history-row')).toHaveLength(3)
    // 150ms 停顿到点：提交，过滤生效
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(screen.getAllByTestId('history-row')).toHaveLength(1)
    expect(screen.getAllByTestId('history-row')[0]!.dataset.runId).toBe('r-yesterday')
  })

  it('外部通道清空（过滤空态「清除搜索」直写已提交值）：草稿跟随，输入框与列表同口径', async () => {
    useAppStore.setState({ leftView: 'history' })
    stubHistoryList(sampleHistoryRows())
    render(<LeftPanel />, { wrapper: createQueryWrapper() })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    const input = screen.getByLabelText('搜索请求历史')
    fireEvent.change(input, { target: { value: 'zzz' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    // 无匹配空态 → 点「清除搜索」（直写 searchTerms，绕过防抖通道）
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }))
    expect(input).toHaveValue('')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getAllByTestId('history-row')).toHaveLength(3)
  })
})
