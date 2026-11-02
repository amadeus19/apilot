import * as React from 'react'

import { useSettingsStore } from '@/stores/settings.store'

import { useCommandsStore } from './commands.store'
import { eventMatchesShortcut } from './types'

/**
 * 主窗口 keydown 统一分发器（AppShell 挂载单点）：按命令注册表的生效键位
 * （用户覆盖＞默认值）查找命中命令 → run()。命令键位的唯一分发点——
 * 业务组件不得自挂命令键位监听（组件交互原语如树导航除外，非命令域）。
 * 「输入焦点让键」声明项（yieldsToTextInput）在此单点执行：焦点在文本
 * 输入控件时命令键位让位原生文本编辑。
 */

/** 焦点是否在文本输入控件（输入焦点让键守卫的单点实现：input / textarea /
 * contenteditable 命中即让位；Monaco 的隐藏 textarea 也在 closest 命中面内） */
export function isTextInputFocused(): boolean {
  const target = document.activeElement
  return (
    target instanceof HTMLElement &&
    target.closest('input, textarea, [contenteditable="true"], [contenteditable=""]') !== null
  )
}

export function useCommandDispatcher(): void {
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      const { commands } = useCommandsStore.getState()
      if (commands.length === 0) return
      const overrides = useSettingsStore.getState().keybindings
      for (const cmd of commands) {
        if (cmd.yieldsToTextInput && isTextInputFocused()) continue
        if (cmd.when && !cmd.when()) continue
        const { matched, arg } = eventMatchesShortcut(cmd, overrides, event)
        if (matched) {
          event.preventDefault()
          cmd.run(arg)
          return
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
