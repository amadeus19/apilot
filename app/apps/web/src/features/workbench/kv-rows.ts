/**
 * 键值行域模型与纯函数（查询参数 / 请求头 / form 系 Body 行的行数据层）：
 * 行 JSON ⇄ 键值行的解析/序列化（与 Rust 引擎 `parse_kv_json` 双端契约，
 * 由 kv-contract 夹具钉住）与批量编辑文本 ⇄ 行集。不含 React，供编辑器
 * 组件、cURL / URL 组装镜像与测试共用。
 */

/** 行类型标注值域（协议语义名恒英文原样）：合法域约束在 UI 层，宿主面按
 *  allowedTypes 收敛子集（query/path 与 x-www-form-urlencoded 不承载文件，
 *  form-data 多 file，Headers 无类型语义不出选择器） */
export type KvRowType = 'string' | 'integer' | 'boolean' | 'number' | 'array' | 'object' | 'file'

/** 键值行（查询参数 / 请求头 / form 系 Body 行的行模型）。type / description
 *  为可选标注，随行持久化，供接口文档同步使用（form-data 行的 type=file 由
 *  发送面分流为文件 part——value 即文件完整路径；其余标注不进发送语义，
 *  值恒字符串）；enabled 为行级启停（缺省启用，禁用行不参与发送）。三者
 *  都按存在性携带——缺失字段不写出，旧行零回归 */
export interface KvRow {
  name: string
  value: string
  type?: string
  description?: string
  /** 行级启停：缺失＝启用；禁用行发送面全链路过滤（不进 query / 头 / 表单体） */
  enabled?: boolean
}

/** 解析草稿 JSON 列为键值行：非法形态返回 null（调用方退回原文保真模式）。
 *  type / description / enabled 读侧容忍与 Rust 引擎同一口径——缺失或形态
 *  不符不携带（不报错、不改写其余字段），type 任意字符串保留（合法域约束
 *  在 UI 层），enabled 仅认布尔形态 */
export function parseKvRows(json: string): KvRow[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const rows: KvRow[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) return null
    const record = item as Record<string, unknown>
    if (typeof record.name !== 'string' || typeof record.value !== 'string') return null
    const row: KvRow = { name: record.name, value: record.value }
    if (typeof record.type === 'string') row.type = record.type
    if (typeof record.description === 'string') row.description = record.description
    if (typeof record.enabled === 'boolean') row.enabled = record.enabled
    rows.push(row)
  }
  return rows
}

/** 序列化键值行为草稿 JSON（往返一致：parse(serialize(rows)) 恒等还原）。
 *  逐行规范化构造：可选字段按存在性携带（缺失不写出），键序恒为
 *  name/value/type/description/enabled——与共享契约夹具的存储形态一致 */
export function serializeKvRows(rows: KvRow[]): string {
  return JSON.stringify(
    rows.map((row) => {
      const normalized: KvRow = { name: row.name, value: row.value }
      if (row.type !== undefined) normalized.type = row.type
      if (row.description !== undefined) normalized.description = row.description
      if (row.enabled !== undefined) normalized.enabled = row.enabled
      return normalized
    }),
  )
}

// —— 批量编辑纯函数（`名称: 值` 文本 ⇄ 行集）——

/** 批量文本 → 键值对：每行一对，首个冒号分隔（值内冒号保留）；空行与无冒号
 *  / 冒号前无名称的行跳过；同名行后值胜、按首次出现位置定序 */
export function parseBulkKvText(text: string): { name: string; value: string }[] {
  const latest = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const colon = trimmed.indexOf(':')
    if (colon <= 0) continue
    const name = trimmed.slice(0, colon).trim()
    if (name === '') continue
    latest.set(name, trimmed.slice(colon + 1).trim())
  }
  return [...latest].map(([name, value]) => ({ name, value }))
}

/** 行集 → 批量文本（每行 `名称: 值`；空名行原样占位，写回时被合并语义跳过） */
export function formatBulkKvText(rows: readonly KvRow[]): string {
  return rows.map((row) => `${row.name}: ${row.value}`).join('\n')
}

/** 批量键值对并入行集：同名行仅覆盖值（type / description / enabled 保留），
 *  新名按文本序追加缺省行；未命中的现有行原样保留 */
export function mergeBulkIntoRows(
  rows: readonly KvRow[],
  pairs: readonly { name: string; value: string }[],
): KvRow[] {
  const merged = rows.map((row) => {
    const hit = pairs.find((pair) => pair.name === row.name)
    return hit ? { ...row, value: hit.value } : { ...row }
  })
  const existingNames = new Set(rows.map((row) => row.name))
  for (const pair of pairs) {
    if (!existingNames.has(pair.name)) merged.push({ name: pair.name, value: pair.value })
  }
  return merged
}
