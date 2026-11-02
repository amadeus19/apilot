import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Tauri 窗口 API 替换：稳定引用（组件 useMemo 与测试断言须指向同一组 mock）
const winMocks = vi.hoisted(() => {
  const unlisten = vi.fn()
  return {
    unlisten,
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    onResized: vi.fn().mockResolvedValue(unlisten),
  }
})
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => winMocks,
}))

import { TitleBar } from '../layout/TitleBar'
import { toggleLeftPanelGeometry } from '../layout/panel-bridge'
import { createQueryWrapper } from '@/test/render-providers'
import { useAppStore } from '@/stores/app.store'
import { useSettingsStore } from '@/stores/settings.store'

vi.mock('../layout/panel-bridge', () => ({
  setLeftPanelApi: vi.fn(),
  setResponsePanelApi: vi.fn(),
  toggleLeftPanelGeometry: vi.fn(),
  expandLeftPanel: vi.fn(),
  expandResponsePanel: vi.fn(),
}))

const invokeMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const settingsPayloads: unknown[] = []
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const win = winMocks

beforeEach(() => {
  vi.clearAllMocks()
  winMocks.onResized.mockResolvedValue(winMocks.unlisten)
  // 切换器默认清单（其余测试不做下拉交互，兜底非 undefined 数据防 Query 告警）
  invokeMock.mockImplementation((cmd) =>
    cmd === 'workspace.list'
      ? Promise.resolve({ items: [], currentId: null })
      : Promise.resolve(undefined),
  )
  useAppStore.setState({ leftPanelVisible: true, leftPanelWidth: 288 })
  useSettingsStore.getState().hydrateFromBoot(null, null)
  document.documentElement.className = ''
})

describe('TitleBar', () => {
  it('窗口控制三键分别调用 minimize / toggleMaximize / close', async () => {
    const user = userEvent.setup()
    render(<TitleBar />, { wrapper: createQueryWrapper() })

    await user.click(screen.getByRole('button', { name: '最小化' }))
    expect(win.minimize).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: '最大化' }))
    expect(win.toggleMaximize).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(win.close).toHaveBeenCalledOnce()
  })

  it('悬浮替换的收展钮：点击经 imperative 桥下发（几何事实源在分栏库）', async () => {
    const user = userEvent.setup()
    render(<TitleBar />, { wrapper: createQueryWrapper() })
    await user.click(screen.getByRole('button', { name: '收展左栏面板' }))
    expect(toggleLeftPanelGeometry).toHaveBeenCalledOnce()
  })

  it('收展钮按下态与收起对齐：收起时 aria-pressed=true（非默认态提示），展开常态不亮', () => {
    render(<TitleBar />, { wrapper: createQueryWrapper() })
    const toggle = screen.getByRole('button', { name: '收展左栏面板' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    act(() => {
      useAppStore.setState({ leftPanelVisible: false })
    })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
  })

  it('明暗快捷钮：light ↔ dark 切换写偏好（settings store 落库协议）', async () => {
    const user = userEvent.setup()
    render(<TitleBar />, { wrapper: createQueryWrapper() })
    // 默认 system 偏好 + light 系统真值 → 显示「切换到深色」
    useSettingsStore.setState({ systemTheme: 'light' })
    expect(screen.getByRole('button', { name: '切换到深色' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '切换到深色' }))
    // 偏好改为 dark（显式两态），下次快捷钮切回 light
    expect(useSettingsStore.getState().theme.preference).toBe('dark')
    expect(screen.getByRole('button', { name: '切换到浅色' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '切换到浅色' }))
    expect(useSettingsStore.getState().theme.preference).toBe('light')
  })

  it('system 态（系统深色）下首击落 light：以 resolved 为基准，首击即达意', async () => {
    const user = userEvent.setup()
    useSettingsStore.setState({
      theme: { preference: 'system', accent: 'indigo' },
      systemTheme: 'dark',
    })
    render(<TitleBar />, { wrapper: createQueryWrapper() })
    // 呈现为深色 → 按钮语义「切换到浅色」
    expect(screen.getByRole('button', { name: '切换到浅色' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '切换到浅色' }))
    expect(useSettingsStore.getState().theme.preference).toBe('light')
  })

  it('语言偏好切换即时更新标题栏文案（i18n 订阅 store，无重启）', () => {
    render(<TitleBar />, { wrapper: createQueryWrapper() })
    expect(screen.getByRole('button', { name: '最小化' })).toBeInTheDocument()

    // preference='en' 直用（解析链第一分支），store 更新 → 组件 re-render
    act(() => {
      useSettingsStore.setState({ locale: { preference: 'en' } })
    })
    expect(screen.getByRole('button', { name: 'Minimize' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '最小化' })).not.toBeInTheDocument()
  })

  it('工作空间切换器：只列只切换，标记当前空间；附设置入口', async () => {
    const user = userEvent.setup()
    invokeMock.mockImplementation((cmd, args) => {
      if (cmd === 'workspace.list') {
        return Promise.resolve({
          items: [
            { id: 'w1', name: '默认工作空间', baseUrl: null, isCurrent: true },
            { id: 'w2', name: '第二空间', baseUrl: null, isCurrent: false },
          ],
          currentId: 'w1',
        })
      }
      if (cmd === 'set_setting') {
        settingsPayloads.push(args)
      }
      return Promise.resolve(undefined)
    })
    render(<TitleBar />, { wrapper: createQueryWrapper() })

    await user.click(await screen.findByRole('button', { name: /工作空间: 默认工作空间/ }))
    const menu = await screen.findByRole('menu')
    expect(menu).toHaveTextContent('第二空间')
    // 设置 Tab 入口在场（打开动作，非切换语义）
    expect(screen.getByRole('menuitem', { name: '工作空间设置' })).toBeInTheDocument()

    await user.click(screen.getByRole('menuitem', { name: '第二空间' }))
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('workspace.set_current', { id: 'w2' })
    })
    void settingsPayloads
  })

  it('卸载时清理窗口 resize 监听（资源所有权四问）', async () => {
    const { unmount } = render(<TitleBar />, { wrapper: createQueryWrapper() })
    unmount()
    // onResized 为异步解析：无论先卸载还是先解析，unlisten 恰好执行一次
    await vi.waitFor(() => expect(winMocks.unlisten).toHaveBeenCalledOnce())
  })
})
