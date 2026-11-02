/**
 * URL 草稿纯函数层：路径框粘贴拆分（query 串 → 参数行）与最终 URL 组合
 * 预览。无 React 依赖，口径双端钉住：
 * - 组合规则是后端 `services/http/request.rs` build_url 的逐分支前端镜像
 *   （共享契约夹具 `src/test/fixtures/url-compose-contract.json` 双端跑表，
 *   任一端改口径另一端立红）；
 * - 粘贴解析按 application/x-www-form-urlencoded 语义（`+` 与 `%XX` 均解），
 *   与发送侧 percent_encode（空格 `%20`、结构字符编码）互为逆运算：
 *   外部 URL 的两种空格形态（`+` / `%20`）粘贴后收敛为参数行的真实空格值，
 *   发送时统一以 `%20` 编码上线。
 */

import type { KvRow } from './kv-rows'
import { parseQueryPairs } from './query-pairs'

/** 粘贴拆分产物：path 段进路径模板，query 段解析为参数行 */
export interface ParsedUrlPaste {
  pathTemplate: string
  queryParams: { name: string; value: string }[]
}

/**
 * 粘贴文本拆分：按第一个 `?` 分离 path 段与 query 串。query 串走共享原语
 * 的表单语义拆行，`#` 后的 fragment 不进参数行；空段与空名段丢弃（不产生
 * 垃圾行）。串内同名键保留为多行（收敛后值胜发生在合并阶段）。
 */
export function parsePastedUrl(text: string): ParsedUrlPaste {
  const trimmed = text.trim()
  const queryStart = trimmed.indexOf('?')
  if (queryStart < 0) {
    return { pathTemplate: trimmed, queryParams: [] }
  }
  const pathTemplate = trimmed.slice(0, queryStart)
  const queryText = trimmed.slice(queryStart + 1).split('#', 1)[0] ?? ''
  // 粘贴＝表单语义（plusAsSpace）：外部 URL 的空格两形态（`+` / `%20`）
  // 解析后收敛为参数行的真实空格值，发送时统一以 %20 编码上线（与发送侧
  // percent_encode 互为逆运算）；空名段丢弃不产垃圾行
  const queryParams = parseQueryPairs(queryText, { plusAsSpace: true, dropEmptyName: true })
  return { pathTemplate, queryParams }
}

/**
 * 粘贴解析出的 query 行并入现有参数行：串内同名后值胜；现有行同名只覆盖
 * 值（type / description 标注保留），新名按解析序追加；未命中的现有行原样保留。
 */
export function mergeQueryIntoRows(
  rows: readonly KvRow[],
  queryParams: readonly { name: string; value: string }[],
): KvRow[] {
  const latest = new Map<string, string>()
  for (const { name, value } of queryParams) {
    latest.set(name, value)
  }
  const merged = rows.map((row) =>
    latest.has(row.name) ? { ...row, value: latest.get(row.name) as string } : row,
  )
  const existingNames = new Set(rows.map((row) => row.name))
  for (const [name, value] of latest) {
    if (!existingNames.has(name)) merged.push({ name, value })
  }
  return merged
}

/**
 * 百分号编码（后端 percent_encode 的镜像）：RFC 3986 非保留字符直通，
 * 其余按 UTF-8 字节百分号编码，空格为 `%20`（URL 语义，非表单 `+`）。
 */
export function percentEncode(text: string): string {
  let out = ''
  for (const byte of new TextEncoder().encode(text)) {
    const unreserved =
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d ||
      byte === 0x5f ||
      byte === 0x2e ||
      byte === 0x7e
    out += unreserved
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

/**
 * 提取路径模板的占位符名（`{id}` → `id`；`{{变量}}` 双括号是变量引用，跳过）。
 * 与后端 template_placeholders 同扫描口径。
 */
export function templatePlaceholders(template: string): string[] {
  const names: string[] = []
  let rest = template
  for (;;) {
    const start = rest.indexOf('{')
    if (start < 0) break
    const after = rest.slice(start + 1)
    const end = after.indexOf('}')
    if (end < 0) break
    const inner = after.slice(0, end)
    if (!inner.startsWith('{')) names.push(inner)
    rest = after.slice(end + 1)
  }
  return names
}

/** 组合失败形态：BaseUrl 未配置 / BaseUrl 非 http(s) scheme（均只发生在相对模板） */
export type UrlComposeOutcome = { url: string } | { error: 'no-base-url' | 'invalid-base-url' }

/**
 * 最终 URL 组合（后端 build_url 的前端镜像，只读预览的唯一口径）：
 * BaseUrl ＋ 路径模板占位替换 ＋ query 拼接。
 * - 禁用行（enabled === false）不参与（占位填充与 query 均过滤，与发送侧
 *   同口径——预览所见即所发）；
 * - 占位符按参数行名匹配，值非空才消费（替换值经百分号编码）；
 *   未命中的占位符原样保留（透传语义）；
 * - query＝未被 path 消费且 name 非空的行按行序拼接（同名多值全保留）；
 * - 模板为绝对 URL 形态（`http://` / `https://` 开头）时完全绕过 BaseUrl
 *   （未配置 / 非法配置均不参与），跨主机请求与无 BaseUrl 工作空间可发送；
 * - 相对模板要求 BaseUrl 已配置且为 http(s) scheme，否则返回错误形态。
 */
export function composeFinalUrl(
  baseUrl: string | null,
  pathTemplate: string,
  params: readonly KvRow[],
): UrlComposeOutcome {
  const consumed: string[] = []
  let path = pathTemplate
  for (const name of templatePlaceholders(pathTemplate)) {
    const row = params.find(
      (candidate) =>
        candidate.name === name && candidate.value !== '' && candidate.enabled !== false,
    )
    if (row) {
      path = path.split(`{${name}}`).join(percentEncode(row.value))
      consumed.push(name)
    }
  }

  let query = ''
  for (const row of params) {
    if (row.enabled === false || row.name === '' || consumed.includes(row.name)) continue
    if (query !== '') query += '&'
    query += `${percentEncode(row.name)}=${percentEncode(row.value)}`
  }

  const isAbsoluteUrl = pathTemplate.startsWith('http://') || pathTemplate.startsWith('https://')
  let url: string
  if (isAbsoluteUrl) {
    url = path
  } else {
    const trimmed = baseUrl?.trim()
    if (!trimmed) return { error: 'no-base-url' }
    const base = trimmed.replace(/\/+$/, '')
    if (!base.startsWith('http://') && !base.startsWith('https://')) {
      return { error: 'invalid-base-url' }
    }
    url = base + path
  }
  if (query !== '') url += `?${query}`
  return { url }
}
