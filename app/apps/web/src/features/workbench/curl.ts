/**
 * cURL 互操作纯函数层：草稿 → bash cURL 序列化（复制出口）与
 * cURL 命令 → 草稿解析（导入入口）。无 React / IPC 依赖。
 *
 * 等价口径（与发送侧逐点对齐，任一偏差都破坏「对靶机请求等价」）：
 * - URL＝最终组合口径（composeFinalUrl 产物由调用方传入）；
 * - 认证按后端 auth.rs 的注入规则镜像（两级继承合成、同名头替换、
 *   Cookie 分号合并、query 追加），字面量编入，`{{变量}}` 原样保留；
 * - body 按信封 kind：json / xml / text 走 `--data-raw` 原文（无显式
 *   Content-Type 头时按引擎默认补 application/json 等值），urlencoded
 *   走 `-d`（百分号编码与 serialize_urlencoded 同语义：空格 `%20`），
 *   form-data 行走 `-F`（文本字段 `name=value`、file 行 `name=@路径`，
 *   路径原样＝行 value）；
 * - 空 name 与禁用行不参与（引擎侧同一过滤）；Basic 凭据整体 base64 编码
 *   （协议要求，字段含 `{{变量}}` 引用时变量形态无法在 Basic 头内保留）。
 *
 * 解析侧宁缺毋滥：只收窄常见形态（单/双引号、续行 `\`、-X/-H/-d 系/
 * --data-urlencode/-F（含 name=@文件路径）/裸 URL），未识别参数与以
 * `@文件` 充当 -d 系请求数据源的形态显式拒绝（错误位＋原因），不猜测。
 */

import { HTTP_METHODS } from '@/lib/http-methods'

import type { AuthDraft } from './auth-config'
import type { BodyDraftView } from './body-envelope'
import { serializeBodyDraft, sniffLegacyBodyKind } from './body-envelope'
import type { EndpointDraftData } from './draft.store'
import { draftTabTitle, splitSnapshotUrl } from './history-draft'
import type { KvRow } from './kv-rows'
import { serializeKvRows } from './kv-rows'
import { parseQueryPairs } from './query-pairs'
import { percentEncode } from './url-draft'

// —— 序列化：草稿 → bash cURL ——

/** 序列化输入（调用方从当前编辑中的草稿组装） */
export interface CurlExportInput {
  /** HTTP 方法（七选；恒显式编为 -X） */
  method: string
  /** 最终 URL（composeFinalUrl 的产物，含 query 拼接） */
  url: string
  /** 用户数据 headers 行（解析产物；空 name 与禁用行由序列化过滤） */
  headers: readonly KvRow[]
  /** body 信封的编辑视图（parseBodyDraft 产物） */
  body: BodyDraftView
  /** 请求级认证（parseAuthDraft 产物，inherit＝继承工作空间级） */
  requestAuth: AuthDraft
  /** 工作空间级认证（null＝未配置＝链根无认证） */
  workspaceAuth: AuthDraft | null
}

/** bash 单引号包裹：值内单引号以 `'\''` 收尾重开（唯一需要转义的字符） */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** UTF-8 语义 base64（btoa 只吃 latin1，中文凭据经字节链路编码） */
function base64Utf8(text: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** 两级继承合成（后端 resolve_effective_auth 的镜像）：请求级 none 阻断、
 *  inherit / 未配置回落工作空间级、具名类型请求级胜 */
function effectiveAuth(request: AuthDraft, workspace: AuthDraft | null): AuthDraft | null {
  if (request.type === 'none') return null
  if (request.type !== 'inherit') return request
  if (workspace === null || workspace.type === 'none' || workspace.type === 'inherit') return null
  return workspace
}

/** 同名头替换（认证优先于用户头，后端 set_header 语义）；无同名则尾部追加 */
function setHeader(rows: KvRow[], name: string, value: string): void {
  const existing = rows.find((row) => row.name.toLowerCase() === name.toLowerCase())
  if (existing) existing.value = value
  else rows.push({ name, value })
}

/** Cookie 头合并（后端 merge_cookie 语义）：已有非空值分号拼接，否则整对写入 */
function mergeCookie(rows: KvRow[], key: string, value: string): void {
  const pair = `${key}=${value}`
  const existing = rows.find((row) => row.name.toLowerCase() === 'cookie')
  if (existing) {
    existing.value = existing.value.trim() === '' ? pair : `${existing.value}; ${pair}`
  } else {
    rows.push({ name: 'Cookie', value: pair })
  }
}

/** URL 追加 query 参数（后端 append_query 语义：分隔符按既有 query 定，键值百分号编码） */
function appendQuery(url: string, key: string, value: string): string {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}${percentEncode(key)}=${percentEncode(value)}`
}

/**
 * 草稿 → bash cURL（多行续行形态，可直接在终端执行）：
 * `curl -X {method} {url} \` ＋ 逐行 `-H` ＋ body 参数（`--data-raw` / `-d` / `-F`）；
 * form-data 的 file 行编 `-F 'name=@路径'`（路径原样＝行 value）。
 */
export function serializeCurl(input: CurlExportInput): string {
  // 认证注入在用户头镜像之上（同名替换 / Cookie 合并 / query 追加）；
  // 空 name 与禁用行不参与（引擎 build_request 的同一过滤）
  const auth = effectiveAuth(input.requestAuth, input.workspaceAuth)
  const headers = input.headers
    .filter((row) => row.name !== '' && row.enabled !== false)
    .map((row) => ({ ...row }))
  let url = input.url
  if (auth?.type === 'bearer') {
    setHeader(headers, 'Authorization', `Bearer ${auth.token}`)
  } else if (auth?.type === 'basic') {
    setHeader(headers, 'Authorization', `Basic ${base64Utf8(`${auth.username}:${auth.password}`)}`)
  } else if (auth?.type === 'apiKey') {
    if (auth.position === 'header') {
      setHeader(headers, auth.key, auth.value)
    } else if (auth.position === 'query') {
      url = appendQuery(url, auth.key, auth.value)
    } else {
      mergeCookie(headers, auth.key, auth.value)
    }
  }

  const hasExplicitContentType = headers.some((row) => row.name.toLowerCase() === 'content-type')
  // 补默认 Content-Type 的 -H 行与数据参数行分离（默认头行排在用户头之前，
  // 数据参数收尾）；Content-Type 只在「文本系 / urlencoded 且无显式头」时补
  // （与引擎默认头同一取值）；form-data 的 boundary 归 -F 自管，显式
  // Content-Type 头跳过（编入会剥夺 curl 自动生成的 boundary）
  const contentTypeArgs: string[] = []
  const bodyArgs: string[] = []
  const { body } = input
  if (body.kind === 'json' || body.kind === 'xml' || body.kind === 'text') {
    if (body.text.trim() !== '') {
      if (!hasExplicitContentType) {
        const preset =
          body.kind === 'json'
            ? 'application/json'
            : body.kind === 'xml'
              ? 'application/xml'
              : 'text/plain'
        contentTypeArgs.push(`-H ${shellQuote(`Content-Type: ${preset}`)}`)
      }
      bodyArgs.push(`--data-raw ${shellQuote(body.text)}`)
    }
  } else if (body.kind === 'urlencoded') {
    const encoded = body.rows
      .filter((row) => row.name !== '' && row.enabled !== false)
      .map((row) => `${percentEncode(row.name)}=${percentEncode(row.value)}`)
      .join('&')
    if (!hasExplicitContentType) {
      contentTypeArgs.push(`-H ${shellQuote('Content-Type: application/x-www-form-urlencoded')}`)
    }
    bodyArgs.push(`-d ${shellQuote(encoded)}`)
  } else if (body.kind === 'form-data') {
    // file 行编 `name=@路径`（路径原样＝行 value，与发送侧文件 part 同源）；
    // 空 name 与禁用行不参与（与引擎 multipart 映射同一过滤）
    for (const row of body.rows) {
      if (row.name === '' || row.enabled === false) continue
      const pair = row.type === 'file' ? `${row.name}=@${row.value}` : `${row.name}=${row.value}`
      bodyArgs.push(`-F ${shellQuote(pair)}`)
    }
  }

  const headerArgs = headers
    .filter((row) => body.kind !== 'form-data' || row.name.toLowerCase() !== 'content-type')
    .map((row) => `-H ${shellQuote(`${row.name}: ${row.value}`)}`)

  return [
    `curl -X ${input.method} ${shellQuote(url)}`,
    ...contentTypeArgs,
    ...headerArgs,
    ...bodyArgs,
  ].join(' \\\n  ')
}

// —— 解析：cURL 命令 → 草稿 ——

/** 拒绝原因（UI 层经 i18n 映射文案；词位由 position 携带） */
export type CurlImportErrorReason =
  | 'not-curl' // 首词不是 curl
  | 'unterminated-quote' // 引号未闭合
  | 'bad-syntax' // 尾部孤立反斜杠等无法解析的形态
  | 'missing-url' // 无 URL 参数
  | 'multiple-url' // 多个裸 URL 参数
  | 'invalid-url' // URL 非 http(s) 形态
  | 'unsupported-flag' // 不在收窄集内的参数
  | 'missing-value' // 值型参数缺值（如行尾 -X）
  | 'bad-method' // -X 值不在七选
  | 'bad-header' // -H 非 `Name: Value` 形态（或 `Name;` 删除语法）
  | 'file-source' // -d 系 / --data-urlencode 以 `@文件` 充当请求数据源
  | 'bad-form' // -F 非 `name=value` / `name=@路径` 字段形态
  | 'bad-urlencoded' // --data-urlencode 非 `name=value` 形态
  | 'mixed-body' // -d 系与 -F 混用

export interface CurlImportError {
  /** 词位（归一化参数表 1 起序号；curl 自身＝1，其参数从 2 起；0＝整体形态无词位） */
  position: number
  reason: CurlImportErrorReason
}

export type CurlImportResult =
  { ok: true; draft: EndpointDraftData; title: string } | { ok: false; error: CurlImportError }

/** 值型参数（取值后序号推进）与可安全忽略的开关型参数（收窄集） */
const VALUE_FLAGS = new Set([
  '-X',
  '--request',
  '-H',
  '--header',
  '-d',
  '--data',
  '--data-ascii',
  '--data-raw',
  '--data-binary',
  '--data-urlencode',
  '-F',
  '--form',
])
const IGNORED_FLAGS = new Set([
  '-k',
  '--insecure',
  '-s',
  '--silent',
  '-S',
  '--show-error',
  '-L',
  '--location',
  '-i',
  '--include',
  '-v',
  '--verbose',
  '-f',
  '--fail',
  '--compressed',
])

/** shell 词法（收窄常见形态）：单引号字面、双引号内 `\"` / `\\` / 续行、
 *  引号外 `\x` 转义与行尾 `\` 续行；未闭合引号与尾部孤立反斜杠报错 */
function shellTokenize(
  source: string,
): { tokens: string[] } | { error: 'unterminated-quote' | 'bad-syntax' } {
  const tokens: string[] = []
  let current = ''
  let hasToken = false
  const push = () => {
    if (hasToken) tokens.push(current)
    current = ''
    hasToken = false
  }
  let i = 0
  while (i < source.length) {
    const char = source[i]!
    if (char === "'") {
      const end = source.indexOf("'", i + 1)
      if (end < 0) return { error: 'unterminated-quote' }
      current += source.slice(i + 1, end)
      hasToken = true
      i = end + 1
      continue
    }
    if (char === '"') {
      hasToken = true
      i += 1
      for (;;) {
        const inner = source[i]
        if (inner === undefined) return { error: 'unterminated-quote' }
        if (inner === '"') {
          i += 1
          break
        }
        if (inner === '\\') {
          const next = source[i + 1]
          if (next === '"' || next === '\\') {
            current += next
            i += 2
            continue
          }
          if (next === '\n') {
            i += 2
            continue
          }
          // 其余 `\x` 保持字面两字符（不模拟 shell 的全转义语义）
          current += inner
          i += 1
          continue
        }
        current += inner
        i += 1
      }
      continue
    }
    if (char === '\\') {
      const next = source[i + 1]
      if (next === undefined) return { error: 'bad-syntax' }
      if (next === '\n') {
        i += 2
        continue
      }
      current += next
      hasToken = true
      i += 2
      continue
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      push()
      i += 1
      continue
    }
    current += char
    hasToken = true
    i += 1
  }
  push()
  return { tokens }
}

/** `-H` 值解析：`Name: Value`（冒号前后空白容忍，value 可空）；`Name;` 删除语法拒绝 */
function parseHeaderValue(raw: string): { name: string; value: string } | null {
  const trimmed = raw.trim()
  if (trimmed.endsWith(';')) return null
  const colon = trimmed.indexOf(':')
  if (colon <= 0) return null
  const name = trimmed.slice(0, colon).trim()
  if (name === '') return null
  return { name, value: trimmed.slice(colon + 1).trim() }
}

/**
 * cURL 命令 → 草稿数据（EndpointDraftData 形态，直接可 seed 草稿 Tab）。
 * URL 拆分与历史恢复同口径：BaseUrl 命中拆相对模板＋query 行，未命中存
 * 完整 URL；认证头按普通头行回填（导入以显式形态存在，不反推 Auth 配置）。
 * body 按 Content-Type 与数据形态归信封：urlencoded / multipart 归行编辑，
 * 其余嗅探（合法 JSON→json、`<` 起头→xml、其余→text，原文不改写）。
 */
export function parseCurlCommand(source: string, baseUrl: string | null): CurlImportResult {
  const tokenized = shellTokenize(source)
  if ('error' in tokenized) return { ok: false, error: { position: 0, reason: tokenized.error } }
  const tokens = tokenized.tokens
  if (tokens.length === 0 || tokens[0]!.toLowerCase() !== 'curl') {
    return { ok: false, error: { position: 1, reason: 'not-curl' } }
  }

  let url: string | null = null
  let method: string | null = null
  const headerRows: { name: string; value: string }[] = []
  const dataParts: string[] = []
  const urlencodedRows: { name: string; value: string }[] = []
  const formRows: { name: string; value: string; type?: string }[] = []

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]!
    if (!token.startsWith('-')) {
      if (url !== null) return { ok: false, error: { position: i + 1, reason: 'multiple-url' } }
      url = token
      continue
    }
    if (IGNORED_FLAGS.has(token)) continue
    if (!VALUE_FLAGS.has(token)) {
      return { ok: false, error: { position: i + 1, reason: 'unsupported-flag' } }
    }
    const value = tokens[i + 1]
    if (value === undefined)
      return { ok: false, error: { position: i + 1, reason: 'missing-value' } }
    i += 1
    if (token === '-X' || token === '--request') {
      if (!(HTTP_METHODS as readonly string[]).includes(value.toUpperCase())) {
        return { ok: false, error: { position: i + 1, reason: 'bad-method' } }
      }
      method = value.toUpperCase()
      continue
    }
    if (token === '-H' || token === '--header') {
      const parsed = parseHeaderValue(value)
      if (parsed === null) return { ok: false, error: { position: i + 1, reason: 'bad-header' } }
      headerRows.push(parsed)
      continue
    }
    if (
      token === '-d' ||
      token === '--data' ||
      token === '--data-ascii' ||
      token === '--data-raw' ||
      token === '--data-binary'
    ) {
      // `@文件` 充当请求体数据源（文件内容作原始 body）不在导入能力面，
      // 显式拒绝不猜测（-F 的 name=@路径 文件字段是另一种语义，见下方）
      if (value.startsWith('@')) {
        return { ok: false, error: { position: i + 1, reason: 'file-source' } }
      }
      dataParts.push(value)
      continue
    }
    if (token === '--data-urlencode') {
      // curl 形态 name=value / name@file / @file / 裸 content；只收 name=value，
      // name 部分出现 @ 即文件数据源形态；值字面入行（curl 发送时整体编码，
      // 值内的 % 属字面，解码会破坏再编码 round-trip）
      const eq = value.indexOf('=')
      const isFile = value.startsWith('@') || (eq > 0 && value.slice(0, eq).includes('@'))
      if (isFile) return { ok: false, error: { position: i + 1, reason: 'file-source' } }
      if (eq <= 0) return { ok: false, error: { position: i + 1, reason: 'bad-urlencoded' } }
      urlencodedRows.push({ name: value.slice(0, eq), value: value.slice(eq + 1) })
      continue
    }
    // -F / --form：`name=value` 文本字段与 `name=@路径` 文件字段（路径入
    // value、行标 type=file；curl 的 `;type=` 可选后缀容忍并剥离，其余
    // 分号指令形态拒绝不猜测）
    const formEq = value.indexOf('=')
    if (formEq <= 0) {
      return { ok: false, error: { position: i + 1, reason: 'bad-form' } }
    }
    const formName = value.slice(0, formEq)
    const formValue = value.slice(formEq + 1)
    if (formValue.startsWith('@')) {
      const rest = formValue.slice(1)
      const semi = rest.indexOf(';')
      const path = semi < 0 ? rest : rest.slice(0, semi)
      if (semi >= 0 && !rest.slice(semi).startsWith(';type=')) {
        return { ok: false, error: { position: i + 1, reason: 'bad-form' } }
      }
      if (path === '') return { ok: false, error: { position: i + 1, reason: 'bad-form' } }
      formRows.push({ name: formName, value: path, type: 'file' })
    } else {
      formRows.push({ name: formName, value: formValue })
    }
  }

  if (url === null) return { ok: false, error: { position: 0, reason: 'missing-url' } }
  if (!/^https?:\/\//i.test(url))
    return { ok: false, error: { position: 0, reason: 'invalid-url' } }
  if (dataParts.length > 0 && formRows.length > 0) {
    return { ok: false, error: { position: 0, reason: 'mixed-body' } }
  }
  if (method === null)
    method =
      dataParts.length > 0 || urlencodedRows.length > 0 || formRows.length > 0 ? 'POST' : 'GET'

  // body 归信封：multipart 优先（-F），其次 urlencoded（Content-Type 或 --data-urlencode 线索），
  // 其余 -d 拼接体按 Content-Type / 内容嗅探归文本系
  const contentType =
    headerRows.find((row) => row.name.toLowerCase() === 'content-type')?.value ?? null
  const mime = contentType?.split(';')[0]?.trim().toLowerCase() ?? ''
  let body: string | null = null
  if (formRows.length > 0) {
    body = serializeBodyDraft({ kind: 'form-data', text: '', rows: formRows })
  } else if (mime === 'application/x-www-form-urlencoded' || urlencodedRows.length > 0) {
    // -d 体拆行与历史恢复同一口径（RFC 语义，`+` 字面保留，键值容错解码）；
    // 空名段丢弃（不产生垃圾行）
    const rows = [
      ...urlencodedRows,
      ...dataParts.flatMap((part) => parseQueryPairs(part, { dropEmptyName: true })),
    ]
    body = serializeBodyDraft({ kind: 'urlencoded', text: '', rows })
  } else if (dataParts.length > 0) {
    const text = dataParts.join('')
    body = serializeBodyDraft({ kind: sniffLegacyBodyKind(text), text, rows: [] })
  }

  const { pathTemplate, queryParams } = splitSnapshotUrl(url, baseUrl)
  const draft: EndpointDraftData = {
    method,
    pathTemplate,
    paramsJson: serializeKvRows(queryParams),
    headersJson: serializeKvRows(headerRows),
    body,
    bodyTruncated: false,
    // 导入以显式形态回填（无快照 redactions 素材）；标准敏感名单由展示层自动掩码
    sensitiveHeaderNames: [],
    // 转正落点：树首个服务（导入不预设来源服务）
    sourceServiceId: null,
  }
  return { ok: true, draft, title: draftTabTitle(method, pathTemplate) }
}
