import * as React from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { UiTextProvider } from '@workspace/ui/components'

import { applyDocumentLocale, applyDocumentTheme } from '@/lib/document-theme'
import { useI18n } from '@/i18n'
import { isDevtoolsNative } from '@/services/devtools-flag'
import {
  selectResolvedLocale,
  selectResolvedTheme,
  useSettingsStore,
} from '@/stores/settings.store'

/**
 * 应用 Provider 收口：ThemeProvider 双动作线——html class / data-accent
 * 与原生标题栏 setTheme()（system → null 恢复跟随）；onThemeChanged 订阅的
 * unlisten 归本 Provider 清理（资源所有权四问）。Monaco 联动 Phase 4 预留。
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const resolvedTheme = useSettingsStore(selectResolvedTheme)
  const themePreference = useSettingsStore((s) => s.theme.preference)
  const accent = useSettingsStore((s) => s.theme.accent)
  const resolvedLocale = useSettingsStore(selectResolvedLocale)

  // system 态实时跟随 Windows：订阅 onThemeChanged 灌 store（真值单通道）
  React.useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null
    void getCurrentWindow()
      .onThemeChanged(({ payload }) => {
        useSettingsStore.setState({ systemTheme: payload })
      })
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  // 双动作线收口：html class + data-accent + 原生标题栏
  // 依赖含 preference：dark → system（resolved 不变）时仍须 setTheme(null) 恢复跟随
  React.useEffect(() => {
    applyDocumentTheme(resolvedTheme, accent)
    void getCurrentWindow()
      .setTheme(themePreference === 'system' ? null : themePreference)
      .catch(() => {
        // setTheme 失败仅影响原生标题栏配色，应用内主题不受影响
      })
  }, [resolvedTheme, themePreference, accent])

  // html lang 随生效语言同步
  React.useEffect(() => {
    applyDocumentLocale(resolvedLocale)
  }, [resolvedLocale])

  return <>{children}</>
}

/**
 * ui 包文案注入桥：把字典通用文案交给 @workspace/ui 的注入接缝，
 * 包内组件（toast / dialog 的关闭按钮、命令面板标题等）随生效语言切换、
 * 零硬编码文案。
 */
export function UiTextBridge({ children }: { children: React.ReactNode }) {
  const { t } = useI18n()
  const value = React.useMemo(
    () => ({
      closeLabel: t('common.close'),
      commandTitle: t('common.commandPaletteTitle'),
      commandDescription: t('common.commandPaletteDescription'),
      searchClearLabel: t('shell.searchClearInput'),
      copyLabel: t('contextmenu.copy'),
      copySuccess: t('common.copyDone'),
      copyFailed: t('common.copyFailed'),
    }),
    [t],
  )
  return <UiTextProvider value={value}>{children}</UiTextProvider>
}

/**
 * Ctrl+Shift+I 泄漏拦截：tauri 在 debug 构建
 * 注入的 toggle-devtools.js 挂在 document 冒泡层，调 internal_toggle_devtools →
 * OpenDevToolsWindow——该 COM 调用**无视** AreDevToolsEnabled，会绕过 Rust 侧
 * 的 devtools 门控。devMode 关闭时在 window 捕获阶段 stopPropagation（先于
 * document 冒泡监听执行），切断这条通道；开启时放行（debug 构建的合法调试
 * 通道）。F12 本体由 WebView2 加速键承担，门控在 services/devtools.rs。
 */
export function DevtoolsHotkeyGuard() {
  const devModeEnabled = useSettingsStore((s) => s.devMode.enabled)

  React.useEffect(() => {
    if (devModeEnabled) return
    const onKeyDown = (event: KeyboardEvent): void => {
      // 与 tauri toggle-devtools.js 同判据（Ctrl+Shift+I，code 判定不受布局影响）
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyI') {
        event.stopPropagation()
      }
    }
    // 捕获阶段注册：window 捕获先于 document 冒泡，stopPropagation 即可截断
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [devModeEnabled])

  return null
}

/**
 * 非原生会话的 F12 通道：主窗口创建时 devtools
 * 为关（devtoolsNative === false）则 WebView2 加速键不在场，devMode 开启后
 * 由前端 F12 → internal_toggle_devtools 打开（OpenDevToolsWindow 无视
 * AreDevToolsEnabled；关闭走 DevTools 窗口自身）。原生会话（创建即开）不
 * 绑定，让位给 WebView2 完整的开/关切换。
 */
export function DevtoolsF12() {
  const devModeEnabled = useSettingsStore((s) => s.devMode.enabled)

  React.useEffect(() => {
    if (!devModeEnabled || isDevtoolsNative()) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'F12') return
      event.preventDefault()
      void invoke('plugin:webview|internal_toggle_devtools').catch((err) => {
        // DevTools 打开失败只影响调试通道，不打断应用
        console.error('toggle devtools failed', err)
      })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [devModeEnabled])

  return null
}
