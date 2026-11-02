import type { AccentName, ResolvedLocale, ResolvedTheme } from '@/lib/settings-schema'

/**
 * html 文档主题 / 语言的唯一挂载点：
 * - `.dark` 只挂 documentElement（S2：保证 Portal 弹层继承变量）；
 * - `data-accent` 属性通道选强调色预设；
 * - `html lang` 随生效语言（读屏发音正确）。
 * boot 流程 render 前与 ThemeProvider 运行时共用，双调用幂等。
 */

export function applyDocumentTheme(theme: ResolvedTheme, accent: AccentName): void {
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.dataset.accent = accent
}

export function applyDocumentLocale(locale: ResolvedLocale): void {
  document.documentElement.lang = locale
}
