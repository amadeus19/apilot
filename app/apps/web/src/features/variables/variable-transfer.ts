/**
 * 变量批量进出纯函数层（导入导出 JSON＋新增对话框批量页签共用）。
 *
 * 脱敏纪律：导出值默认掩码（`***`，不泄露长度），显式勾选才含真值——
 * 剪贴板内容可能被粘贴到日志 / 工单，与复制口径恒掩码同一纪律；导入与
 * 批量解析只管结构与行级定位，落库走既有 CRUD 命令（撞车稳定报错）。
 */

import type { VariableDto } from './variable-api'

/** 导出 JSON 的行形态（value 已按脱敏开关折算，此处不再判别） */
export interface ExportedVariable {
  key: string
  value: string
  secret: boolean
}

/** Secret 值导出掩码（固定短掩码，与联想 / 预览面板同款） */
export const EXPORT_SECRET_MASK = '***'

/** 分类清单 → 导出 JSON 文本（version 字段留演进位；category 供人读） */
export function exportCategoryJson(
  categoryName: string,
  variables: readonly VariableDto[],
  includeSecretValues: boolean,
): string {
  return JSON.stringify(
    {
      version: 1,
      category: categoryName,
      variables: variables.map((variable) => ({
        key: variable.key,
        value: variable.secret && !includeSecretValues ? EXPORT_SECRET_MASK : variable.value,
        secret: variable.secret,
      })),
    },
    null,
    2,
  )
}

/** 导入解析失败（带可选定位）：invalid-json＝语法层；invalid-shape＝形态层。
 *  line＝文本行号（1 起算，V8 message 带 position 时才有）；index＝变量
 *  数组内条目下标（0 起算，顶层形态不对时为 null＝整单粒度） */
export type ImportParseError =
  { error: 'invalid-json'; line: number | null } | { error: 'invalid-shape'; index: number | null }

export interface ImportedVariable {
  key: string
  value: string
  secret: boolean
}

/** 导入解析跳过的行：secret 值恰为导出掩码字面量——回灌防御（宁可不导入
 *  也不落假值，跳过行出行级警示交由调用方呈现） */
export interface ImportSkippedRow {
  index: number
  key: string
  reason: 'secret-mask'
}

/**
 * 从 V8 SyntaxError message 提取 position 并换算行号（1 起算，行界＝`\n`）。
 * 旧版 V8 message 形如 "…at position N"；2023 起新版 V8 改带上下文片段、
 * 不再携带 position——提取不到时返回 null，调用方保留整单粒度。
 */
function jsonErrorLine(text: string, error: unknown): number | null {
  if (!(error instanceof SyntaxError)) return null
  const match = /position (\d+)/.exec(error.message)
  if (match === null) return null
  const position = Number(match[1])
  if (!Number.isInteger(position) || position < 0 || position > text.length) return null
  let line = 1
  for (let cursor = 0; cursor < position; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1
  }
  return line
}

/** 导入文本 → 变量行＋跳过行：接受 `{ "variables": [...] }` 包裹形态与裸
 *  数组；key 必须非空字符串，value 缺省空串、secret 缺省 false，多余字段
 *  忽略。行级校验失败携带条目 index 返回；secret 行值恰为 EXPORT_SECRET_MASK
 *  的行不进 rows（跨分类迁移的掩码回灌＝落库假值，防御在此截断） */
export function parseImportedVariables(
  text: string,
): { rows: ImportedVariable[]; skipped: ImportSkippedRow[] } | ImportParseError {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { error: 'invalid-json', line: jsonErrorLine(text, error) }
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed !== null &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as { variables?: unknown }).variables)
      ? (parsed as { variables: unknown[] }).variables
      : null
  if (list === null) return { error: 'invalid-shape', index: null }
  const rows: ImportedVariable[] = []
  const skipped: ImportSkippedRow[] = []
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index]
    if (entry === null || typeof entry !== 'object') return { error: 'invalid-shape', index }
    const key = (entry as { key?: unknown }).key
    if (typeof key !== 'string' || key.trim() === '') return { error: 'invalid-shape', index }
    const rawValue = (entry as { value?: unknown }).value
    if (rawValue !== undefined && typeof rawValue !== 'string') {
      return { error: 'invalid-shape', index }
    }
    const secret = (entry as { secret?: unknown }).secret
    if (secret !== undefined && typeof secret !== 'boolean') {
      return { error: 'invalid-shape', index }
    }
    const value = rawValue === undefined ? '' : rawValue
    // 掩码回灌防御：secret 行且值恰为掩码字面量 → 跳过出行级警示。非
    // secret 行的真值 `***` 是合法数据，不拦
    if (secret === true && value === EXPORT_SECRET_MASK) {
      skipped.push({ index, key: key.trim(), reason: 'secret-mask' })
      continue
    }
    rows.push({ key: key.trim(), value, secret: secret === true })
  }
  return { rows, skipped }
}

/** 批量文本行解析错误（行号 1 起算；missing-colon＝无 `key: 值` 分隔） */
export interface BulkVariableParseError {
  line: number
  reason: 'missing-colon' | 'empty-key' | 'duplicate'
}

export interface BulkVariableRow {
  line: number
  key: string
  value: string
}

/**
 * 批量文本（`key: 值` 每行一对）→ 变量行＋行级错误：首个冒号分隔（值内
 * 冒号保留）、两端 trim；空行跳过；无冒号 / 冒号前无名的行按行号报错，
 * 重复键保留首次出现、后续行按行号报错——逐行定位是批量通道的完成标准。
 */
export function parseBulkVariableLines(text: string): {
  rows: BulkVariableRow[]
  errors: BulkVariableParseError[]
} {
  const rows: BulkVariableRow[] = []
  const errors: BulkVariableParseError[] = []
  const seen = new Set<string>()
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim()
    if (trimmed === '') continue
    const line = index + 1
    const colon = trimmed.indexOf(':')
    if (colon < 0) {
      errors.push({ line, reason: 'missing-colon' })
      continue
    }
    const key = trimmed.slice(0, colon).trim()
    if (key === '') {
      errors.push({ line, reason: 'empty-key' })
      continue
    }
    if (seen.has(key)) {
      errors.push({ line, reason: 'duplicate' })
      continue
    }
    seen.add(key)
    rows.push({ line, key, value: trimmed.slice(colon + 1).trim() })
  }
  return { rows, errors }
}
