"use client"

import * as React from "react"

/**
 * ui 包用户可见文案的注入接缝：包内组件（toast / dialog 的关闭按钮等）
 * 不硬编码任何语言，统一从本接缝取词。app 侧在根部经 UiTextProvider
 * 从 i18n 字典注入生效语言的值；包内默认值仅作脱离 app 单测时的兜底
 * （基准语言 zh-CN）。
 */
export interface UiText {
  /** 关闭类按钮的可见文字与无障碍标签 */
  closeLabel: string
  /** 命令面板对话框标题（CommandDialog 的无障碍标题） */
  commandTitle: string
  /** 命令面板对话框描述（CommandDialog 的无障碍描述） */
  commandDescription: string
  /** 搜索输入清除钮的无障碍标签 */
  searchClearLabel: string
  /** CopyButton 纯图标态的无障碍标签 */
  copyLabel: string
  /** CopyButton 复制成功的 toast 文案 */
  copySuccess: string
  /** CopyButton 复制失败（剪贴板拒绝 / 口径求值失败）的 toast 文案 */
  copyFailed: string
}

const DEFAULT_UI_TEXT: UiText = {
  closeLabel: "关闭",
  commandTitle: "命令面板",
  commandDescription: "搜索要运行的命令…",
  searchClearLabel: "清空搜索",
  copyLabel: "复制",
  copySuccess: "已复制",
  copyFailed: "复制失败，请手动复制",
}

const UiTextContext = React.createContext<UiText>(DEFAULT_UI_TEXT)

export function UiTextProvider({
  value,
  children,
}: {
  value: Partial<UiText>
  children: React.ReactNode
}) {
  const merged = React.useMemo(() => ({ ...DEFAULT_UI_TEXT, ...value }), [value])
  return <UiTextContext.Provider value={merged}>{children}</UiTextContext.Provider>
}

export function useUiText(): UiText {
  return React.useContext(UiTextContext)
}
