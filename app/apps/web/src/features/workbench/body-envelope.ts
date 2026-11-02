/**
 * Body 草稿信封：user_data body 列的读写形态，与后端 request.rs 的
 * parse_body_envelope / sniff_legacy_kind 同构（双端同一契约）。
 *
 * 信封＝紧凑 JSON `{"kind":"none"|"json"|"xml"|"text"|"urlencoded"|"form-data",
 * "text"?:string,"rows"?:[{name,value,type?,description?,enabled?}]}`——urlencoded /
 * form-data 消费 rows，其余消费 text（none 允许两字段皆无）。行 enabled 与
 * params/headers 同一口径（缺失＝启用，禁用行不进表单体）。
 *
 * 读侧容忍（迁移口径）：读到非信封旧纯文本时按内容嗅探回填分类，原文绝不
 * 改写——发送行为与信封化之前完全一致；「再读不二次嗅探」由「合法信封直读」
 * 保证（信封形态不再走嗅探分支）。
 *
 * 内容保真：类型切换只改 kind，text / rows 两载体各自保留——切到 none /
 * form 系不丢文本，切回文本系不丢行；两载体仅在各自的编辑路径写回。
 */

/** 信封 kind 六值（无 auto：嗅探只作旧数据的读侧迁移口径，不进 UI 类型集） */
export type BodyKind = 'none' | 'json' | 'xml' | 'text' | 'urlencoded' | 'form-data'

/** form 系行（与 KvEditor 的键值行契约同构）。type / description 为可选
 *  标注，随行持久化，供接口文档同步使用（form-data 行的 type=file 由发送
 *  面分流为文件 part——value 即文件完整路径；其余标注不进发送语义，值恒
 *  字符串）；enabled 为行级启停（缺省启用，禁用行不进表单体）。读侧容忍
 *  与 Rust 引擎同一口径——缺失或形态不符不携带（不报错、不回落） */
export interface BodyRow {
  name: string
  value: string
  type?: string
  description?: string
  enabled?: boolean
}

/** body 草稿的编辑视图（从草稿 body 列派生，渲染期纯函数） */
export interface BodyDraftView {
  kind: BodyKind
  /** 文本系载体（json/xml/text）；none 与 form 系为空串 */
  text: string
  /** form 系载体（urlencoded/form-data）；其余为空数组 */
  rows: BodyRow[]
  /** 原文是否已是信封形态（false＝legacy 纯文本，kind 来自嗅探回填） */
  fromEnvelope: boolean
}

const ENVELOPE_KINDS: readonly BodyKind[] = [
  'none',
  'json',
  'xml',
  'text',
  'urlencoded',
  'form-data',
]

/** 文本系 kind：Monaco 文本编辑面与格式化 / 自动换行工具组仅这些类型显示 */
export function isTextBodyKind(kind: BodyKind): boolean {
  return kind === 'json' || kind === 'xml' || kind === 'text'
}

/** form 系 kind：走 KvEditor 行编辑形态 */
export function isFormBodyKind(kind: BodyKind): boolean {
  return kind === 'urlencoded' || kind === 'form-data'
}

/** legacy 纯文本读侧嗅探（迁移口径，与后端 sniff_legacy_kind 同构）：
 *  空→none；合法 JSON→json；XML 形态（trim 后以 < 开头）→xml；其余→text */
export function sniffLegacyBodyKind(text: string): BodyKind {
  if (text.trim() === '') return 'none'
  if (parsesJson(text)) return 'json'
  if (text.trimStart().startsWith('<')) return 'xml'
  return 'text'
}

/** JSON 解析判定（嗅探与格式化可用性共用；空串视为不合法） */
export function parsesJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** 解析 body 草稿列为编辑视图：合法信封直读（不嗅探），否则嗅探回填类型 */
export function parseBodyDraft(raw: string | null): BodyDraftView {
  if (raw === null || raw === '') {
    return { kind: 'none', text: '', rows: [], fromEnvelope: true }
  }
  const envelope = parseEnvelope(raw)
  if (envelope) return envelope
  return { kind: sniffLegacyBodyKind(raw), text: raw, rows: [], fromEnvelope: false }
}

/** 信封识别：合法 JSON 对象且 kind 为已知六值之一。容忍面与后端一致——
 *  text / rows 缺失或 null 按空处理；rows 非数组、行非对象或行 name/value
 *  非字符串时整体回落 legacy（原文照发，不报错不丢数据）；行内 type /
 *  description / enabled 缺失或形态不符不携带（不报错、不回落） */
function parseEnvelope(raw: string): BodyDraftView | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const kindValue = record.kind
  if (typeof kindValue !== 'string' || !ENVELOPE_KINDS.some((item) => item === kindValue)) {
    return null
  }
  const text = typeof record.text === 'string' ? record.text : ''
  const rows: BodyRow[] = []
  if (record.rows !== undefined && record.rows !== null) {
    if (!Array.isArray(record.rows)) return null
    for (const item of record.rows) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
      const entry = item as Record<string, unknown>
      if (typeof entry.name !== 'string' || typeof entry.value !== 'string') return null
      const row: BodyRow = { name: entry.name, value: entry.value }
      if (typeof entry.type === 'string') row.type = entry.type
      if (typeof entry.description === 'string') row.description = entry.description
      if (typeof entry.enabled === 'boolean') row.enabled = entry.enabled
      rows.push(row)
    }
  }
  return { kind: kindValue as BodyKind, text, rows, fromEnvelope: true }
}

/** 序列化编辑视图为信封（紧凑 JSON）：内容载体按非空携带——类型切换不改写
 *  内容，两载体各自保留；none 两字段皆无即最简形态 */
export function serializeBodyDraft(view: {
  kind: BodyKind
  text: string
  rows: BodyRow[]
}): string {
  const envelope: { kind: BodyKind; text?: string; rows?: BodyRow[] } = { kind: view.kind }
  if (view.text !== '') envelope.text = view.text
  if (view.rows.length > 0) envelope.rows = view.rows
  return JSON.stringify(envelope)
}
