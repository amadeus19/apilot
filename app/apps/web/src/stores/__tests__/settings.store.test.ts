import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSettingsStore, selectResolvedTheme, selectResolvedLocale } from '../settings.store'

// set_setting 替换：断言 fire-and-forget 落库协议
const setSettingMock = vi.hoisted(() => vi.fn<(key: string, value: unknown) => Promise<void>>())
vi.mock('@/services/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ipc')>()
  return { ...actual, setSetting: setSettingMock }
})

// toast 呈现替换为 spy（reportError 路由断言）
vi.mock('@workspace/ui/components', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

import { toast } from '@workspace/ui/components'

beforeEach(() => {
  setSettingMock.mockReset().mockResolvedValue(undefined)
  vi.mocked(toast.error).mockClear()
  useSettingsStore.getState().hydrateFromBoot(null, null)
})

describe('hydrateFromBoot', () => {
  it('灌入合法载荷与系统真值，devMode 同步 ipc 门控', () => {
    // setDevMode 的 ipc 门控：store 不直接 import mock，经 setDevMode 副作用验证
    useSettingsStore.getState().hydrateFromBoot(
      {
        settings: {
          theme: { preference: 'dark', accent: 'rose' },
          locale: { preference: 'en' },
          devMode: { enabled: true },
          closeBehavior: { action: 'tray' },
        },
        systemLocale: 'en-US',
      },
      'dark',
    )
    const state = useSettingsStore.getState()
    expect(state.theme).toEqual({ preference: 'dark', accent: 'rose' })
    expect(state.locale).toEqual({ preference: 'en' })
    expect(state.devMode.enabled).toBe(true)
    expect(state.closeBehavior).toEqual({ action: 'tray' })
    expect(state.systemTheme).toBe('dark')
    expect(state.systemLocale).toBe('en-US')
  })

  it('脏键回退默认并经统一错误协议上报', () => {
    useSettingsStore.getState().hydrateFromBoot(
      {
        settings: { theme: { preference: 'bogus' }, locale: { preference: 'en' } },
        systemLocale: null,
      },
      null,
    )
    const state = useSettingsStore.getState()
    expect(state.theme).toEqual({ preference: 'system', accent: 'indigo' })
    expect(state.locale).toEqual({ preference: 'en' })
    expect(toast.error).toHaveBeenCalledOnce()
  })
})

describe('偏好动作（即时生效 + fire-and-forget 落库）', () => {
  it('setThemePreference 更新本地并写穿 theme 键', () => {
    useSettingsStore.getState().setThemePreference('dark')
    expect(useSettingsStore.getState().theme.preference).toBe('dark')
    expect(setSettingMock).toHaveBeenCalledExactlyOnceWith('theme', {
      preference: 'dark',
      accent: 'indigo',
    })
  })

  it('setAccent 与 preference 同键合并写穿', () => {
    useSettingsStore.getState().setAccent('teal')
    expect(useSettingsStore.getState().theme).toEqual({ preference: 'system', accent: 'teal' })
    expect(setSettingMock).toHaveBeenCalledWith('theme', { preference: 'system', accent: 'teal' })
  })

  it('setDevMode 同步 ipc 呈现门控并落库', () => {
    useSettingsStore.getState().setDevMode(true)
    expect(useSettingsStore.getState().devMode).toEqual({ enabled: true })
    expect(setSettingMock).toHaveBeenCalledWith('devMode', { enabled: true })
  })

  it('写失败不回滚 UI（本次会话已生效），经统一协议上报', async () => {
    setSettingMock.mockRejectedValue({
      kind: 'apilot_error',
      code: 'DB_WRITE_FAILED',
      message: 'write failed',
    })
    useSettingsStore.getState().setThemePreference('dark')
    // 本地已即时生效
    expect(useSettingsStore.getState().theme.preference).toBe('dark')
    // 异步落库失败 → 上报（微任务排空后断言）
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledOnce())
    expect(useSettingsStore.getState().theme.preference).toBe('dark')
  })

  it('setCloseBehavior 更新本地并写穿 closeBehavior 键（弹窗记住选择与设置面板共用）', () => {
    useSettingsStore.getState().setCloseBehavior('tray')
    expect(useSettingsStore.getState().closeBehavior).toEqual({ action: 'tray' })
    expect(setSettingMock).toHaveBeenCalledWith('closeBehavior', { action: 'tray' })

    useSettingsStore.getState().setCloseBehavior('exit')
    expect(useSettingsStore.getState().closeBehavior).toEqual({ action: 'exit' })
    expect(setSettingMock).toHaveBeenLastCalledWith('closeBehavior', { action: 'exit' })
  })

  it('setWorkflowPin 写穿映射键，null 取消固定且其余空间固定保留', () => {
    useSettingsStore.getState().setWorkflowPin('ws1', 'wf1')
    expect(useSettingsStore.getState().workflowPins).toEqual({ ws1: 'wf1' })
    expect(setSettingMock).toHaveBeenCalledWith('workflowPins', { ws1: 'wf1' })

    useSettingsStore.getState().setWorkflowPin('ws2', 'wf2')
    expect(useSettingsStore.getState().workflowPins).toEqual({ ws1: 'wf1', ws2: 'wf2' })

    useSettingsStore.getState().setWorkflowPin('ws1', null)
    expect(useSettingsStore.getState().workflowPins).toEqual({ ws2: 'wf2' })
    expect(setSettingMock).toHaveBeenLastCalledWith('workflowPins', { ws2: 'wf2' })
  })
})

describe('派生选择器', () => {
  it('resolvedTheme：显式偏好直用，system 跟随系统真值', () => {
    useSettingsStore.setState({
      theme: { preference: 'light', accent: 'indigo' },
      systemTheme: 'dark',
    })
    expect(selectResolvedTheme(useSettingsStore.getState())).toBe('light')
    useSettingsStore.setState({ theme: { preference: 'system', accent: 'indigo' } })
    expect(selectResolvedTheme(useSettingsStore.getState())).toBe('dark')
    useSettingsStore.setState({ systemTheme: null })
    expect(selectResolvedTheme(useSettingsStore.getState())).toBe('light')
  })

  it('resolvedLocale：system 态走解析链（os locale 前缀归档）', () => {
    useSettingsStore.setState({ locale: { preference: 'system' }, systemLocale: 'en-US' })
    expect(selectResolvedLocale(useSettingsStore.getState())).toBe('en')
    useSettingsStore.setState({ locale: { preference: 'zh-CN' } })
    expect(selectResolvedLocale(useSettingsStore.getState())).toBe('zh-CN')
  })
})
