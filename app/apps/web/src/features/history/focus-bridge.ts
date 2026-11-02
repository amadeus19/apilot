import * as React from 'react'
import { focusManager } from '@tanstack/react-query'
import { getCurrentWindow } from '@tauri-apps/api/window'

/**
 * 窗口焦点 → TanStack Query focusManager 桥接（历史刷新双保险的 A 通道，
 * 应用根组件一次性安装）：WebView2 下 visibilitychange 完全不触发
 * （Tauri#10592），原生窗口焦点是唯一可靠信号。焦点事件转发
 * focusManager.setFocused，触发启用了 refetchOnWindowFocus 的查询（当前
 * 仅历史域）重取——全局默认 false 不动，其余查询不受影响。
 *
 * 资源所有权：effect 安装、卸载 unlisten；注册 Promise 与卸载竞速时以
 * disposed 标志在完成侧立即注销（沿 ThemeProvider onThemeChanged 惯例）。
 */
export function useWindowFocusBridge(): void {
  React.useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        focusManager.setFocused(focused)
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
}
