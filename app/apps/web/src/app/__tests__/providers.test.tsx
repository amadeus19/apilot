import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DevtoolsHotkeyGuard, ThemeProvider } from '../providers'
import { useSettingsStore } from '@/stores/settings.store'

// Tauri 窗口 API 替换：onThemeChanged 订阅 / setTheme 原生标题栏联动
const winMocks = vi.hoisted(() => {
  const unlisten = vi.fn()
  return {
    unlisten,
    onThemeChanged: vi.fn().mockResolvedValue(unlisten),
    setTheme: vi.fn().mockResolvedValue(undefined),
  }
})
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => winMocks,
}))

beforeEach(() => {
  vi.clearAllMocks()
  winMocks.onThemeChanged.mockResolvedValue(winMocks.unlisten)
  useSettingsStore.getState().hydrateFromBoot(null, null)
  document.documentElement.className = ''
  delete document.documentElement.dataset.accent
})

describe('ThemeProvider（双动作线）', () => {
  it('resolved=dark 时挂 .dark 与 data-accent，原生标题栏 setTheme(dark)', () => {
    useSettingsStore.setState({ theme: { preference: 'dark', accent: 'teal' } })
    render(
      <ThemeProvider>
        <div>child</div>
      </ThemeProvider>,
    )

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.dataset.accent).toBe('teal')
    expect(winMocks.setTheme).toHaveBeenCalledWith('dark')
    expect(screen.getByText('child')).toBeInTheDocument()
  })

  it('system 态：按系统真值挂 class，原生标题栏 setTheme(null) 恢复跟随', () => {
    useSettingsStore.setState({
      theme: { preference: 'system', accent: 'indigo' },
      systemTheme: 'dark',
    })
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    )

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(winMocks.setTheme).toHaveBeenCalledWith(null)
  })

  it('dark → system（resolved 不变）仍须 setTheme(null)：双动作线不因 resolved 未变而失联', () => {
    useSettingsStore.setState({
      theme: { preference: 'dark', accent: 'indigo' },
      systemTheme: 'dark',
    })
    const { rerender } = render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    )
    expect(winMocks.setTheme).toHaveBeenLastCalledWith('dark')

    // 偏好改 system：resolved 仍 dark（系统恰为深色），但原生标题栏应恢复跟随
    useSettingsStore.setState({ theme: { preference: 'system', accent: 'indigo' } })
    rerender(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    )
    expect(winMocks.setTheme).toHaveBeenLastCalledWith(null)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('html lang 随生效语言（解析链）', () => {
    useSettingsStore.setState({ locale: { preference: 'system' }, systemLocale: 'en-US' })
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    )
    expect(document.documentElement.lang).toBe('en')
  })

  it('onThemeChanged 订阅灌 store，卸载时 unlisten 清理（资源所有权四问）', async () => {
    const { unmount } = render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    )
    // 模拟系统主题切换事件
    const handler = winMocks.onThemeChanged.mock.calls[0]?.[0] as (e: {
      payload: 'light' | 'dark'
    }) => void
    handler({ payload: 'light' })
    expect(useSettingsStore.getState().systemTheme).toBe('light')

    unmount()
    await vi.waitFor(() => expect(winMocks.unlisten).toHaveBeenCalledOnce())
  })
})

describe('DevtoolsHotkeyGuard（Ctrl+Shift+I 泄漏拦截）', () => {
  /** 模拟 tauri debug 注入：挂在 document 冒泡层的切换监听 */
  function harness() {
    const leaked = vi.fn()
    document.addEventListener('keydown', leaked)
    return leaked
  }

  it('devMode 关闭：Ctrl+Shift+I 在捕获层被截断，document 监听不触发', () => {
    useSettingsStore.setState({ devMode: { enabled: false } })
    render(<DevtoolsHotkeyGuard />)
    const leaked = harness()

    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, code: 'KeyI', bubbles: true }),
    )
    expect(leaked).not.toHaveBeenCalled()
    document.removeEventListener('keydown', leaked)
  })

  it('devMode 开启：放行（tauri debug 调试通道可用）', () => {
    useSettingsStore.setState({ devMode: { enabled: true } })
    render(<DevtoolsHotkeyGuard />)
    const leaked = harness()

    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, code: 'KeyI', bubbles: true }),
    )
    expect(leaked).toHaveBeenCalledTimes(1)
    document.removeEventListener('keydown', leaked)
  })
})
