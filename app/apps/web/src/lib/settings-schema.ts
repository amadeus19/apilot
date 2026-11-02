import { z } from 'zod'

/**
 * settings 各键 value 的 Zod 校验：boot 载荷与 set_setting 前端侧共用。
 * 脏数据（解析失败）由调用方回退默认值并上报（safeParse + fallback），不炸启动。
 * 注意：Rust 侧白名单只管键名；value 结构校验唯一在此。
 */

export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const
export const ACCENTS = ['indigo', 'teal', 'violet', 'orange', 'rose', 'graphite'] as const
export const LOCALES = ['system', 'zh-CN', 'en'] as const
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const
export const UPDATE_SOURCE_KINDS = ['folder', 'cloud'] as const
/** 存量配置的类型枚举（folder/cloud 两分前的 local/network/cloud 三分），
 * 仅作旧库 `type` 字段的兼容解析输入，不再对外写入 */
const UPDATE_SOURCE_LEGACY_TYPES = ['cloud', 'local', 'network'] as const
/** cloud 源默认仓库地址（baseUrl 落库 null = 使用该默认，用户可改可删） */
export const DEFAULT_CLOUD_BASE_URL = 'https://github.com/amadeus19/apilot'
/** 超时分段档位（不限制＝null 不入枚举，四档含默认由 UI 控件保证） */
export const HTTP_TIMEOUT_STEPS = [10, 30, 60] as const
export const HTTP_PROXY_MODES = ['none', 'custom'] as const

export type ThemePreference = (typeof THEME_PREFERENCES)[number]
export type AccentName = (typeof ACCENTS)[number]
export type LocalePreference = (typeof LOCALES)[number]
export type LogLevel = (typeof LOG_LEVELS)[number]
export type UpdateSourceKind = (typeof UPDATE_SOURCE_KINDS)[number]
export type HttpTimeoutStep = (typeof HTTP_TIMEOUT_STEPS)[number]
export type HttpProxyMode = (typeof HTTP_PROXY_MODES)[number]
export type ResolvedTheme = Exclude<ThemePreference, 'system'>
export type ResolvedLocale = Exclude<LocalePreference, 'system'>

/** settings 键 `theme`：{"preference":"system","accent":"indigo"} */
export type ThemeSetting = { preference: ThemePreference; accent: AccentName }
export type LocaleSetting = { preference: LocalePreference }
export type DevModeSetting = { enabled: boolean }
export type LogLevelSetting = { level: LogLevel }
/** settings 键 `logDir`：null = 默认目录（LocalAppData），重启生效 */
export type LogDirSetting = { path: string | null }
/** settings 键 `updateSource`：软件版本更新渠道，kind 为来源判别字段。
 * folder 源用 path（本机 / UNC 目录，保存前 Rust 校验可达）；
 * cloud 源用 baseUrl（null = 默认仓库地址）与 mirrorPrefix（'' = 直连）。
 * 两类字段同键共存：切换类型落库时只改本类字段，另一类配置原样保留，
 * 切回即恢复。与同步（Sync）域的「更新」无关。
 */
export type UpdateSourceSetting = {
  kind: UpdateSourceKind
  path: string | null
  baseUrl: string | null
  mirrorPrefix: string
}
/** settings 键 `autoCheckUpdates`：boot 后自动检查更新开关（关 = 仅手动检查） */
export type AutoCheckUpdatesSetting = { enabled: boolean }
/** settings 键 `shell.leftPanelWidth`：左栏宽度持久化（px；null = 未定制） */
export type ShellLeftPanelWidthSetting = { width: number | null }
/** settings 键 `keybindings`：命令键位覆盖表（仅存覆盖项；null = 显式清空） */
export type KeybindingsOverrides = Record<string, string | null>
/** settings 键 `workflowPins`：每工作空间至多一个的状态栏固定工作流
 * （workspaceId → workflowId；UI 偏好非业务数据，工作流被删后由消费方自愈隐藏） */
export type WorkflowPinsSetting = Record<string, string>
/** settings 键 `http` 的代理段：mode＝none（默认）| custom（url 必填，Rust 侧写前校验） */
export type HttpProxySetting = { mode: HttpProxyMode; url: string | null }
/** settings 键 `http`：全局 HTTP 行为（机器与网络语境，不随工作空间切换）。
 * timeoutSeconds：null＝不限制（默认）| 正整数秒（档位 10/30/60 由 UI 控件保证）；
 * redirect：跟随 3xx（上限固定 10）；tlsVerify：默认校验；
 * proxy：不使用（默认）/ 自定义（scheme 自动判别 http / https / socks5）。
 */
export type HttpSetting = {
  timeoutSeconds: number | null
  redirect: boolean
  tlsVerify: boolean
  proxy: HttpProxySetting
}

// schema 校验「存在但损坏」：字段 optional（缺失=默认），非法枚举/类型才会失败
const themeSettingSchema: z.ZodType<Partial<ThemeSetting>> = z.object({
  preference: z.enum(THEME_PREFERENCES).optional(),
  accent: z.enum(ACCENTS).optional(),
})

const localeSettingSchema: z.ZodType<Partial<LocaleSetting>> = z.object({
  preference: z.enum(LOCALES).optional(),
})

const devModeSettingSchema: z.ZodType<Partial<DevModeSetting>> = z.object({
  enabled: z.boolean().optional(),
})

const logLevelSettingSchema: z.ZodType<Partial<LogLevelSetting>> = z.object({
  level: z.enum(LOG_LEVELS).optional(),
})

const logDirSettingSchema: z.ZodType<Partial<LogDirSetting>> = z.object({
  path: z.string().nullable().optional(),
})

/**
 * updateSource 载荷宽容形态：kind 判别（现行）+ type 存量兼容 + 两类专属字段。
 * 解析与规范化在 parseUpdateSource（输出类型含判别推导，泛型 parseOne 不适配）。
 */
const updateSourceCompatSchema = z.object({
  kind: z.enum(UPDATE_SOURCE_KINDS).optional(),
  type: z.enum(UPDATE_SOURCE_LEGACY_TYPES).optional(),
  path: z.string().nullable().optional(),
  baseUrl: z.string().nullable().optional(),
  mirrorPrefix: z.string().optional(),
})

const autoCheckUpdatesSettingSchema: z.ZodType<Partial<AutoCheckUpdatesSetting>> = z.object({
  enabled: z.boolean().optional(),
})

const shellLeftPanelWidthSettingSchema: z.ZodType<Partial<ShellLeftPanelWidthSetting>> = z.object({
  width: z.number().int().min(0).max(8192).nullable().optional(),
})

const keybindingsSchema: z.ZodType<Partial<KeybindingsOverrides>> = z.record(
  z.string(),
  z.string().nullable(),
)

// 键与值都要求非空字符串：空串 id 无业务语义，出现即整键判脏回退默认
const workflowPinsSchema: z.ZodType<Partial<WorkflowPinsSetting>> = z.record(
  z.string().min(1),
  z.string().min(1),
)

/** 代理段解析：字段齐全才合法（custom 缺 url 与 Rust 写前校验同口径——
 * 缺 url 的半成品整体判脏，回退默认并登记，避免半对象经浅合并破坏类型完备） */
const httpProxySettingSchema: z.ZodType<HttpProxySetting> = z.object({
  mode: z.enum(HTTP_PROXY_MODES),
  url: z.string().nullable(),
})

const httpSettingSchema: z.ZodType<Partial<HttpSetting>> = z.object({
  // 超时宽松解析（null | 正整数）；档位约束由 UI 分段控件保证，与 Rust 侧
  // 上限护栏（1..=86400）各自为政：库内超档值不至于炸启动
  timeoutSeconds: z.number().int().positive().nullable().optional(),
  redirect: z.boolean().optional(),
  tlsVerify: z.boolean().optional(),
  proxy: httpProxySettingSchema.optional(),
})

export const SETTINGS_DEFAULTS = {
  theme: { preference: 'system', accent: 'indigo' },
  locale: { preference: 'system' },
  devMode: { enabled: false },
  logLevel: { level: 'info' },
  logDir: { path: null },
  updateSource: { kind: 'folder', path: null, baseUrl: null, mirrorPrefix: '' },
  autoCheckUpdates: { enabled: true },
  shell: { width: null },
  keybindings: {},
  workflowPins: {},
  http: {
    timeoutSeconds: null,
    redirect: true,
    tlsVerify: true,
    proxy: { mode: 'none', url: null },
  },
} as const satisfies Record<string, object>

export type ParsedSettings = {
  theme: ThemeSetting
  locale: LocaleSetting
  devMode: DevModeSetting
  logLevel: LogLevelSetting
  logDir: LogDirSetting
  updateSource: UpdateSourceSetting
  autoCheckUpdates: AutoCheckUpdatesSetting
  shell: ShellLeftPanelWidthSetting
  keybindings: KeybindingsOverrides
  workflowPins: WorkflowPinsSetting
  http: HttpSetting
  /** 解析失败的键（脏数据已回退默认，交由调用方上报） */
  invalidKeys: string[]
}

/** 单键解析：缺失=默认；损坏=默认并登记键名；部分合法字段与默认合并 */
function parseOne<T extends object>(
  schema: z.ZodType<Partial<T>>,
  value: unknown,
  key: string,
  defaults: T,
  invalidKeys: string[],
): T {
  if (value === undefined) return { ...defaults }
  const result = schema.safeParse(value)
  if (!result.success) {
    invalidKeys.push(key)
    return { ...defaults }
  }
  return { ...defaults, ...result.data }
}

/**
 * updateSource 专用解析（规范化输出）：判别字段 kind 缺失时由存量 type 推导
 * （cloud→cloud，local/network→folder）——旧库 `{type,path}` 形态升级后 folder
 * 配置零丢失；非法 kind / type / 字段类型整体判脏回退默认。baseUrl 非字符串
 * 视为未配置（null = 默认仓库地址），mirrorPrefix 缺失视为直连（''）。
 */
function parseUpdateSource(value: unknown, invalidKeys: string[]): UpdateSourceSetting {
  const defaults = SETTINGS_DEFAULTS.updateSource
  if (value === undefined) return { ...defaults }
  const result = updateSourceCompatSchema.safeParse(value)
  if (!result.success) {
    invalidKeys.push('updateSource')
    return { ...defaults }
  }
  const raw = result.data
  const kind: UpdateSourceKind = raw.kind ?? (raw.type === 'cloud' ? 'cloud' : 'folder')
  return {
    kind,
    path: raw.path ?? null,
    baseUrl: raw.baseUrl ?? null,
    mirrorPrefix: raw.mirrorPrefix ?? '',
  }
}

/**
 * cloud 源地址形态校验（保存闸门与表单禁用态共用）：空值放行（baseUrl 空 =
 * 默认仓库地址、mirrorPrefix 空 = 直连），非空须为 http(s) 绝对地址。
 */
export function isValidCloudSourceUrl(value: string): boolean {
  if (value === '') return true
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * 解析 boot 载荷中的 settings 全量：逐键 safeParse，失败键回退默认并登记。
 * 「整体脏」与「单键脏」都只影响对应键（部分损坏不放大为整体回退）。
 */
export function parseSettings(raw: Record<string, unknown> | null | undefined): ParsedSettings {
  const invalidKeys: string[] = []
  if (!raw) return { ...structuredClone(SETTINGS_DEFAULTS), invalidKeys: [] }

  // 缺失键 = 新库首启动形态，直接用默认且不算脏；仅「存在但损坏」才回退并登记
  return {
    theme: parseOne(themeSettingSchema, raw.theme, 'theme', SETTINGS_DEFAULTS.theme, invalidKeys),
    locale: parseOne(
      localeSettingSchema,
      raw.locale,
      'locale',
      SETTINGS_DEFAULTS.locale,
      invalidKeys,
    ),
    devMode: parseOne(
      devModeSettingSchema,
      raw.devMode,
      'devMode',
      SETTINGS_DEFAULTS.devMode,
      invalidKeys,
    ),
    logLevel: parseOne(
      logLevelSettingSchema,
      raw.logLevel,
      'logLevel',
      SETTINGS_DEFAULTS.logLevel,
      invalidKeys,
    ),
    logDir: parseOne(
      logDirSettingSchema,
      raw.logDir,
      'logDir',
      SETTINGS_DEFAULTS.logDir,
      invalidKeys,
    ),
    updateSource: parseUpdateSource(raw.updateSource, invalidKeys),
    http: parseOne(httpSettingSchema, raw.http, 'http', SETTINGS_DEFAULTS.http, invalidKeys),
    autoCheckUpdates: parseOne(
      autoCheckUpdatesSettingSchema,
      raw.autoCheckUpdates,
      'autoCheckUpdates',
      SETTINGS_DEFAULTS.autoCheckUpdates,
      invalidKeys,
    ),
    shell: parseOne(
      shellLeftPanelWidthSettingSchema,
      raw['shell.leftPanelWidth'],
      'shell.leftPanelWidth',
      SETTINGS_DEFAULTS.shell,
      invalidKeys,
    ),
    keybindings: parseOne(
      keybindingsSchema,
      raw.keybindings,
      'keybindings',
      SETTINGS_DEFAULTS.keybindings,
      invalidKeys,
    ),
    workflowPins: parseOne(
      workflowPinsSchema,
      raw.workflowPins,
      'workflowPins',
      SETTINGS_DEFAULTS.workflowPins,
      invalidKeys,
    ),
    invalidKeys,
  }
}

/**
 * 语言解析链（启动与切换共用）：
 * preference ≠ system 直用；system 态按 os locale 前缀归档，其余回退 zh-CN。
 */
export function resolveLocale(
  preference: LocalePreference,
  systemLocale: string | null | undefined,
): ResolvedLocale {
  if (preference !== 'system') return preference
  const normalized = systemLocale?.toLowerCase() ?? ''
  if (normalized.startsWith('zh')) return 'zh-CN'
  if (normalized.startsWith('en')) return 'en'
  return 'zh-CN'
}

/** 主题解析：system 态真值只走 Tauri（onThemeChanged / theme()），禁用 prefers-color-scheme */
export function resolveTheme(
  preference: ThemePreference,
  systemTheme: ResolvedTheme | null | undefined,
): ResolvedTheme {
  if (preference !== 'system') return preference
  return systemTheme ?? 'light'
}
