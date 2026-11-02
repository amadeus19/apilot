import { isDevMode } from '@/services/ipc'
import type { ResolvedLocale } from '@/lib/settings-schema'

import { en } from './locales/en'
import { zhCN, type DictKey } from './locales/zh-CN'

/**
 * i18n 运行时核心：纯函数层，不依赖 React 与 store——
 * 供 useI18n hook（index.ts）与命令式场景（error-center 错误本地化）共同复用。
 * 复数仅 one/other（英文 count===1 走 one，中文恒 other）；插值仅 {var} 纯替换；
 * 兜底链：当前语言 → zh-CN 基准 → 键名（devMode 下 console.warn）。
 */

type PluralMessages = { readonly one?: string; readonly other: string }
type LookupResult = string | PluralMessages

const DICTS: Record<ResolvedLocale, unknown> = { 'zh-CN': zhCN, en }

/** 字典按点号路径下钻：命中 string（普通键）或复数节点（含 other 键的叶对象） */
function lookup(dict: unknown, key: string): LookupResult | undefined {
  let node: unknown = dict
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  if (typeof node === 'string') return node
  if (typeof node === 'object' && node !== null) {
    const record = node as Record<string, unknown>
    if (typeof record.other === 'string') return node as PluralMessages
  }
  return undefined
}

/**
 * {var} 纯字符串替换：无对应参数的占位符原样保留（不炸渲染）。
 * lookbehind 排除 `{{var}}` 形态——那是工作流变量引用语法（如词典占位符
 * 「如 {{status}} == 200」），必须原样呈现、不得当作插值占位符吞掉。
 */
function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/(?<!\{)\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  )
}

/** 三级链终端（键名兜底）时开发期暴露；生产静默（用户至少看到有意义标识） */
function warnMissing(key: string): void {
  if (isDevMode()) console.warn(`[i18n] missing key, fell back to the key itself: ${key}`)
}

export type TranslateParams = Record<string, string | number>

/**
 * 字典翻译：三级兜底链——当前语言 → zh-CN → 键名本身。
 * 复数键（值为 { one?, other } 对象）按 count 自动分支：英文 count===1 用 one
 * （en 未写 one 时回 other），其余恒 other；中文无复数变形，恒走 other。
 */
export function translate(locale: ResolvedLocale, key: string, params?: TranslateParams): string {
  const raw = lookup(DICTS[locale], key) ?? lookup(zhCN, key)
  if (raw === undefined) {
    warnMissing(key)
    return key
  }
  if (typeof raw === 'string') return params ? interpolate(raw, params) : raw
  const template = locale === 'en' && params?.count === 1 ? (raw.one ?? raw.other) : raw.other
  return params ? interpolate(template, params) : template
}

/**
 * AppError 稳定 code 本地化：errors.<code> 域映射，details 展开为插值参数。
 * code 是运行时值，此处是有意为之的动态查键（禁令只针对业务代码的无类型拼键）。
 * 返回 undefined = 两级字典均无该 code 映射，调用方兜底显示原英文 message。
 */
export function translateError(
  locale: ResolvedLocale,
  code: string,
  params?: TranslateParams,
): string | undefined {
  const key = `errors.${code}`
  const raw = lookup(DICTS[locale], key) ?? lookup(zhCN, key)
  return typeof raw === 'string' ? interpolate(raw, params ?? {}) : undefined
}

// —— 本地化格式化器：日期/数字走 Intl 按生效语言；耗时/字节恒符号 ——

/** Intl 实例按语言缓存：生效语言只有枚举两值，缓存天然有界（资源四问） */
const intlCache = new Map<
  ResolvedLocale,
  { dateTime: Intl.DateTimeFormat; number: Intl.NumberFormat }
>()

function intlOf(locale: ResolvedLocale): {
  dateTime: Intl.DateTimeFormat
  number: Intl.NumberFormat
} {
  let entry = intlCache.get(locale)
  if (!entry) {
    entry = {
      dateTime: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }),
      number: new Intl.NumberFormat(locale),
    }
    intlCache.set(locale, entry)
  }
  return entry
}

/** 日期时间：本地时区（时区恒本地，不做设置项） */
export function formatDateTime(value: Date | number, locale: ResolvedLocale): string {
  return intlOf(locale).dateTime.format(value)
}

/** 数字：千分位、小数位按生效语言 */
export function formatNumber(value: number, locale: ResolvedLocale): string {
  return intlOf(locale).number.format(value)
}

/**
 * 耗时恒符号（禁 Intl.DurationFormat——chrome105 target 不支持）：
 * `340ms / 1.2s / 2min 05s`。
 */
export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`
  const totalSeconds = Math.floor(milliseconds / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  return `${minutes}min ${String(totalSeconds % 60).padStart(2, '0')}s`
}

/**
 * 字节恒符号：`123 B / 1.0 KB / 1.5 MB / 2.3 GB`。
 * 符号清单为 KB/MB/GB，B 档为本工具场景补充（亚 KB 响应显示 0.1 KB 有碍读）；
 * GB 封顶（超大响应走文件落盘 Preview，不出现 TB 级数值）。
 */
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'] as const

export function formatBytes(bytes: number): string {
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const text = unitIndex === 0 ? String(Math.round(value)) : value.toFixed(1)
  return `${text} ${BYTE_UNITS[unitIndex]}`
}

export type { DictKey }
