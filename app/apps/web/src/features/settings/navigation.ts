import type { DictKey } from '@/i18n'

/**
 * 设置面板 7 组信息架构：组 id、图标、名称与描述的
 * 字典键、搜索关键词。HTTP 承接 1.0「连接」语义；快捷键组随命令面板体系建立；
 * 备份组为两动作极简（手动导出 / 恢复，无备份目录与自动项设置键）。
 */
export interface SettingsNav {
  id: 'appearance' | 'language' | 'keybindings' | 'http' | 'backup' | 'developer' | 'about'
  /** lucide 图标名（组件内映射，避免本文件引入 JSX） */
  icon: 'palette' | 'languages' | 'keyboard' | 'network' | 'archive' | 'terminal' | 'info'
  labelKey: DictKey
  descriptionKey: DictKey
  /** 组内常驻设置行标签的字典键（搜索过滤域：组名 + 描述 + 这些标签 + keywords 别名） */
  itemKeys?: DictKey[]
  /** devMode 门控条目的标签键：仅 devMode 开启时并入过滤域（条件渲染同语义） */
  gatedItemKeys?: DictKey[]
  /** 搜索过滤用英文别名关键词 */
  keywords: string
  /** devMode 门控条目的别名关键词：仅 devMode 开启时并入过滤域 */
  gatedKeywords?: string
}

export const SETTINGS_NAVS: SettingsNav[] = [
  {
    id: 'appearance',
    icon: 'palette',
    labelKey: 'settings.navAppearance',
    descriptionKey: 'settings.navAppearanceDesc',
    itemKeys: ['settings.themeLabel', 'settings.accentLabel'],
    keywords: 'theme accent color appearance 主题 强调色 外观',
  },
  {
    id: 'language',
    icon: 'languages',
    labelKey: 'settings.navLanguage',
    descriptionKey: 'settings.navLanguageDesc',
    itemKeys: ['settings.languageLabel'],
    keywords: 'language locale 语言 界面',
  },
  {
    id: 'keybindings',
    icon: 'keyboard',
    labelKey: 'settings.navKeybindings',
    descriptionKey: 'settings.navKeybindingsDesc',
    itemKeys: [
      'keybindings.modify',
      'keybindings.clear',
      'keybindings.restoreDefault',
      'keybindings.restoreAllDefaults',
    ],
    keywords: 'keybinding shortcut hotkey command palette 快捷键 键位 命令面板',
  },
  {
    id: 'http',
    icon: 'network',
    labelKey: 'settings.navHttp',
    descriptionKey: 'settings.navHttpDesc',
    itemKeys: [
      'settings.httpTimeoutLabel',
      'settings.httpRedirectLabel',
      'settings.httpTlsLabel',
      'settings.httpProxyLabel',
    ],
    keywords:
      'http connection timeout redirect tls ssl certificate proxy 连接 超时 重定向 证书 代理',
  },
  {
    id: 'backup',
    icon: 'archive',
    labelKey: 'settings.navBackup',
    descriptionKey: 'settings.navBackupDesc',
    itemKeys: ['settings.backupExport', 'settings.backupRestore'],
    keywords: 'backup export restore 备份 导出 恢复',
  },
  {
    id: 'developer',
    icon: 'terminal',
    labelKey: 'settings.navDeveloper',
    descriptionKey: 'settings.navDeveloperDesc',
    // 组与 devMode 开关常驻（关掉后仍能再打开）；其余条目 devMode 门控
    itemKeys: ['settings.devModeLabel'],
    gatedItemKeys: [
      'settings.logLevelLabel',
      'settings.copyDiagnostics',
      'settings.openLogDir',
      'settings.logDirLabel',
      'settings.updateSourceLabel',
    ],
    keywords: 'developer devtools 开发者',
    gatedKeywords: 'log level diagnostics 日志级别 日志 诊断',
  },
  {
    id: 'about',
    icon: 'info',
    labelKey: 'settings.navAbout',
    descriptionKey: 'settings.navAboutDesc',
    itemKeys: ['settings.versionLabel', 'settings.checkUpdates', 'settings.changelogTitle'],
    keywords: 'about version license changelog 关于 版本 许可 更新日志',
  },
]
