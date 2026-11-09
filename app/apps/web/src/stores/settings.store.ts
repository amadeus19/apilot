import { create } from 'zustand'

import { reportError, setErrorLocaleSource } from '@/services/error-center'
import { setDevMode as setIpcDevMode, setSetting } from '@/services/ipc'
import {
  parseSettings,
  resolveLocale,
  resolveTheme,
  SETTINGS_DEFAULTS,
  type AccentName,
  type CloseBehaviorAction,
  type HttpSetting,
  type LocalePreference,
  type LogLevel,
  type ParsedSettings,
  type ResolvedLocale,
  type ResolvedTheme,
  type ThemePreference,
  type UpdateSourceSetting,
} from '@/lib/settings-schema'
/**
 * 偏好设置 store。
 *
 * 协议：动作改本地（即时生效）+ fire-and-forget set_setting 落库；
 * **写失败不回滚 UI**（本次会话已生效），AppError 走统一上报，下次启动回退旧值。
 * system 态真值只走 Tauri（boot 载荷 / theme() / onThemeChanged），禁用 prefers-color-scheme。
 */

interface SystemTruth {
  systemTheme: ResolvedTheme | null
  systemLocale: string | null
}

interface SettingsState extends ParsedSettings, SystemTruth {
  /** boot 载荷灌入（含 os 真值）；脏键回退默认并上报 */
  hydrateFromBoot: (
    payload: { settings: Record<string, unknown>; systemLocale: string | null } | null,
    systemTheme: ResolvedTheme | null,
  ) => void
  setThemePreference: (preference: ThemePreference) => void
  setAccent: (accent: AccentName) => void
  setLocalePreference: (preference: LocalePreference) => void
  setDevMode: (enabled: boolean) => void
  setLogLevel: (level: LogLevel) => void
  /** path 传 null = 恢复默认目录（重启生效语义，落库即 UI 态更新） */
  setLogDir: (path: string | null) => void
  /** 更新源整键落库（类型 + 路径原子保存，保存前可达性校验在组件侧） */
  setUpdateSource: (setting: UpdateSourceSetting) => void
  /** 自动检查更新开关（boot 静默检查的闸门；关 = 仅手动检查） */
  setAutoCheckUpdates: (enabled: boolean) => void
  /** 关闭按钮行为（弹窗「记住我的选择」与设置面板三选一共用写入口） */
  setCloseBehavior: (action: CloseBehaviorAction) => void
  /** 左栏宽度持久化（分栏库 onResize 防抖后调用；null = 清除定制恢复默认） */
  setShellLeftPanelWidth: (width: number | null) => void
  /** 命令键位覆盖写入（null = 显式清空；仅覆盖项落库） */
  setKeybinding: (commandId: string, accelerator: string | null) => void
  /** 状态栏固定工作流（每工作空间至多一个；workflowId null = 取消固定） */
  setWorkflowPin: (workspaceId: string, workflowId: string | null) => void
  /** HTTP 设置组局部补丁：整键写穿（Rust 写前校验＋EffectHost 重建 Client） */
  setHttp: (patch: Partial<HttpSetting>) => void
  /** 删除覆盖恢复默认（行级传单 id、组级传组内全部 id） */
  resetKeybindings: (commandIds: string[]) => void
}

/** fire-and-forget 落库：写失败不回滚 UI，统一上报 */
function persist(key: string, value: unknown): void {
  void setSetting(key, value).catch((err) => reportError(err))
}

/** devMode 诊断挂载单点：开启挂 settings store，关闭摘除（boot 挂载职责收口） */
function syncDebugHandle(enabled: boolean): void {
  const host = window as unknown as Record<string, unknown>
  if (enabled) {
    host.__APPILOT_DEBUG__ = { settingsStore: useSettingsStore }
  } else {
    delete host.__APPILOT_DEBUG__
  }
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...structuredClone(SETTINGS_DEFAULTS),
  invalidKeys: [],
  systemTheme: null,
  systemLocale: null,

  hydrateFromBoot: (payload, systemTheme) => {
    const parsed = parseSettings(payload?.settings)
    const systemLocale = payload?.systemLocale ?? null
    // 脏键上报（回退默认已发生，boot 不被阻塞）
    for (const key of parsed.invalidKeys) {
      reportError(new Error(`settings key "${key}" is invalid, fallback applied`))
    }
    // devMode 同步给 ipc 错误呈现层（门控协议）与诊断挂载（单点）
    setIpcDevMode(parsed.devMode.enabled)
    syncDebugHandle(parsed.devMode.enabled)
    set({ ...parsed, systemTheme, systemLocale })
  },

  setThemePreference: (preference) => {
    const theme = { ...get().theme, preference }
    set({ theme })
    persist('theme', theme)
  },

  setAccent: (accent) => {
    const theme = { ...get().theme, accent }
    set({ theme })
    persist('theme', theme)
  },

  setLocalePreference: (preference) => {
    const locale = { ...get().locale, preference }
    set({ locale })
    persist('locale', locale)
  },

  setDevMode: (enabled) => {
    const devMode = { ...get().devMode, enabled }
    set({ devMode })
    setIpcDevMode(enabled)
    syncDebugHandle(enabled)
    persist('devMode', devMode)
  },

  setLogLevel: (level) => {
    const logLevel = { ...get().logLevel, level }
    set({ logLevel })
    persist('logLevel', logLevel)
  },

  setLogDir: (path) => {
    const logDir = { ...get().logDir, path }
    set({ logDir })
    persist('logDir', logDir)
  },

  setUpdateSource: (setting) => {
    set({ updateSource: setting })
    persist('updateSource', setting)
  },

  setAutoCheckUpdates: (enabled) => {
    const autoCheckUpdates = { ...get().autoCheckUpdates, enabled }
    set({ autoCheckUpdates })
    persist('autoCheckUpdates', autoCheckUpdates)
  },

  setCloseBehavior: (action) => {
    const closeBehavior = { ...get().closeBehavior, action }
    set({ closeBehavior })
    persist('closeBehavior', closeBehavior)
  },

  setHttp: (patch) => {
    const http = { ...get().http, ...patch }
    set({ http })
    persist('http', http)
  },

  setShellLeftPanelWidth: (width) => {
    const shell = { ...get().shell, width }
    set({ shell })
    persist('shell.leftPanelWidth', shell)
  },

  setKeybinding: (commandId, accelerator) => {
    const keybindings = { ...get().keybindings, [commandId]: accelerator }
    set({ keybindings })
    persist('keybindings', keybindings)
  },

  setWorkflowPin: (workspaceId, workflowId) => {
    const workflowPins = { ...get().workflowPins }
    if (workflowId === null) delete workflowPins[workspaceId]
    else workflowPins[workspaceId] = workflowId
    set({ workflowPins })
    persist('workflowPins', workflowPins)
  },

  resetKeybindings: (commandIds) => {
    const keybindings = { ...get().keybindings }
    for (const id of commandIds) delete keybindings[id]
    set({ keybindings })
    persist('keybindings', keybindings)
  },
}))

// —— 派生选择器（resolve 逻辑单点在 settings-schema.ts）——

export const selectResolvedTheme = (s: SettingsState): ResolvedTheme =>
  resolveTheme(s.theme.preference, s.systemTheme)

export const selectResolvedLocale = (s: SettingsState): ResolvedLocale =>
  resolveLocale(s.locale.preference, s.systemLocale)

// 错误呈现层语言源注入（error-center 反向依赖本模块会成环，此处单向注册；
// 闭包每次取当下状态，语言切换后即时生效）
setErrorLocaleSource(() => selectResolvedLocale(useSettingsStore.getState()))
