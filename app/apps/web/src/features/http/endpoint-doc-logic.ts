/**
 * 接口文档抽屉的逻辑面与数据形态：类型镜像（`endpoint.doc` IPC 载荷）、
 * 入口显隐与抽屉互斥判定、分区数据装配（参数分组 / schema 展平 / 示例
 * 生成 / JSON 着色分词）。纯函数无 React 依赖，直测面。
 *
 * 从组件文件拆出（react/only-export-components：组件文件只导出组件）。
 */

// —— 数据形态（`EndpointDoc` 的 TS 镜像；serde camelCase 声明序）——

export interface DocParameter {
  name: string
  location: 'query' | 'path' | 'header' | 'formData' | 'cookie'
  required: boolean
  description?: string
  paramType: string
  format?: string
  example?: unknown
}

export interface DocSchema {
  schemaType: string
  format?: string
  refName?: string
  truncated: boolean
  description?: string
  required: string[]
  example?: unknown
  enumValues: string[]
  properties: [string, DocSchema][]
  items?: DocSchema
}

export interface DocRequestBody {
  contentType: string
  required: boolean
  description?: string
  schema: DocSchema
  example?: unknown
}

export interface DocResponse {
  status: string
  description?: string
  contentType?: string
  schema?: DocSchema
  example?: unknown
}

export interface EndpointDoc {
  title: string
  category?: string
  description?: string
  parameters: DocParameter[]
  requestBody?: DocRequestBody
  responses: DocResponse[]
}

// —— 纯函数（装配与判定，直测面）——

/** 入口显隐：仅同步接口（稳定键身份）渲染文档入口；手工 / 副本隐藏而非禁用 */
export function shouldShowDocEntry(isManual: boolean): boolean {
  return !isManual
}

/**
 * 抽屉互斥切换：两抽屉按钮并存、同时至多一开；点已开抽屉的按钮＝收起。
 * 返回 [settingsOpen, docOpen] 下一态。
 */
export function nextExclusiveDrawerState(
  settingsOpen: boolean,
  docOpen: boolean,
  clicked: 'settings' | 'doc',
): [boolean, boolean] {
  if (clicked === 'settings') return [!settingsOpen, false]
  return [false, !docOpen]
}

/** 文档抽屉呈现的参数三小节（formData / cookie 归请求体形态，不在文档面展开） */
export function groupParamsByLocation(params: readonly DocParameter[]): {
  path: DocParameter[]
  query: DocParameter[]
  header: DocParameter[]
} {
  const groups = { path: [], query: [], header: [] } as {
    path: DocParameter[]
    query: DocParameter[]
    header: DocParameter[]
  }
  for (const param of params) {
    if (param.location === 'path' || param.location === 'query' || param.location === 'header') {
      groups[param.location].push(param)
    }
  }
  return groups
}

/** 字段行（请求体 / 响应结构共用的点路径缩进树） */
export interface DocFieldRow {
  keyPath: string
  depth: number
  schemaType: string
  required: boolean
  description?: string
  enumValues: string[]
}

/** 展平 schema 为缩进行序列（array 元素以 `[]` 后缀下钻；保声明序） */
export function flattenDocSchema(schema: DocSchema, prefix = '', depth = 0): DocFieldRow[] {
  const rows: DocFieldRow[] = []
  for (const [name, child] of schema.properties) {
    const keyPath = prefix ? `${prefix}.${name}` : name
    rows.push({
      keyPath,
      depth,
      schemaType: child.schemaType,
      required: schema.required.includes(name),
      description: child.description,
      enumValues: child.enumValues,
    })
    rows.push(...flattenDocSchema(child, keyPath, depth + 1))
  }
  if (schema.items) {
    const keyPath = `${prefix}[]`
    rows.push({
      keyPath,
      depth,
      schemaType: schema.items.schemaType,
      required: false,
      description: schema.items.description,
      enumValues: schema.items.enumValues,
    })
    rows.push(...flattenDocSchema(schema.items, keyPath, depth + 1))
  }
  return rows
}

/** 由 schema 生成只读示例（响应「示例」双轨的无 example 回退） */
export function generateSample(schema: DocSchema): unknown {
  switch (schema.schemaType) {
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const [name, child] of schema.properties) out[name] = generateSample(child)
      return out
    }
    case 'array':
      return schema.items ? [generateSample(schema.items)] : []
    case 'string':
      return (
        schema.enumValues[0] ?? (schema.format === 'date-time' ? '2026-01-01T00:00:00Z' : 'string')
      )
    case 'integer':
    case 'number':
      return 0
    case 'boolean':
      return true
    default:
      return null
  }
}

// —— 请求体媒型呈现 ——

/** JSON 家族媒型判定：精确 application/json、`+json` 后缀变体、text/json（媒型大小写不敏感） */
function isJsonMediaType(contentType: string): boolean {
  const lowered = contentType.toLowerCase()
  return lowered === 'application/json' || lowered === 'text/json' || lowered.endsWith('+json')
}

/**
 * 媒型的抽屉展示标签：JSON 家族归一为友好标签「JSON」，multipart 等其他
 * 媒型原样。definition 只在同步应用时全量替换，不会回刷存量；已落库的
 * `application/*+json` 类 JSON 家族变体串经此归一，不再以原串示人。
 */
export function contentTypeLabel(contentType: string): string {
  return isJsonMediaType(contentType) ? 'JSON' : contentType
}

/**
 * form 系媒型判定（multipart/* 与 application/x-www-form-urlencoded）：
 * 请求体字段区空缺时区分占位文案——表单体字段随发送填写，非无结构可陈。
 */
export function isFormContentType(contentType: string): boolean {
  const lowered = contentType.toLowerCase()
  return lowered.startsWith('multipart/') || lowered === 'application/x-www-form-urlencoded'
}

/** 着色 token（JSON 轻量着色，不引 Monaco） */
export interface JsonToken {
  text: string
  kind: 'key' | 'string' | 'number' | 'literal' | 'punct'
}

const JSON_TOKEN_RE =
  /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])/g

/** 把 JSON 文本切成着色 token 流（key/string/number/literal/punct） */
export function colorizeJsonTokens(text: string): JsonToken[] {
  const tokens: JsonToken[] = []
  let last = 0
  for (const match of text.matchAll(JSON_TOKEN_RE)) {
    const index = match.index ?? 0
    if (index > last) tokens.push({ text: text.slice(last, index), kind: 'punct' })
    if (match[1] !== undefined) {
      tokens.push({ text: match[1], kind: match[2] !== undefined ? 'key' : 'string' })
      if (match[2] !== undefined) tokens.push({ text: match[2], kind: 'punct' })
    } else if (match[3] !== undefined) tokens.push({ text: match[3], kind: 'number' })
    else if (match[4] !== undefined) tokens.push({ text: match[4], kind: 'literal' })
    else if (match[5] !== undefined) tokens.push({ text: match[5], kind: 'punct' })
    last = index + match[0].length
  }
  if (last < text.length) tokens.push({ text: text.slice(last), kind: 'punct' })
  return tokens
}
