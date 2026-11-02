/**
 * 历史快照 → 草稿副本的构造（纯函数）：恢复＝「以历史为模板的新草稿」，
 * 不是重发——历史记录与用户数据零改动，只读快照在内存里复制为可编辑草稿。
 * splitSnapshotUrl / draftTabTitle 是「URL → 草稿 Tab」族的共享口径，
 * cURL 导入（curl.ts）同源消费。
 *
 * URL 拆分口径（与后端 request.rs 的 build_url 组合规则互为镜像）：
 * 快照 url＝最终 URL（重定向后，含 host＋query）。host 与工作空间 BaseUrl
 * 同源（origin＋path 前缀命中）→ path＋query 进草稿（相对模板＋参数行）；
 * 否则 pathTemplate 存完整 URL（绝对形态）——build_url 对绝对模板完全
 * 绕过 BaseUrl，恢复后发送的最终 URL 与快照一致。
 *
 * query 拆行进参数面板（模板校验两端口均禁 `?`）：键值经 decodeURIComponent
 * 还原（容错：非法百分号序列保留原文）；GUI 快照的 query 由后端
 * percent_encode 生成，解码→再编码逐字节一致（round-trip 钉住在测试）。
 */

import { sniffLegacyBodyKind, serializeBodyDraft } from './body-envelope'
import { serializeKvRows, type KvRow } from './kv-rows'
import { parseQueryPairs } from './query-pairs'

/** 草稿 Tab 标题长度上限（`方法 + 模板` 形态的视觉收敛） */
const DRAFT_TITLE_MAX_CHARS = 60

/** 草稿 Tab 标题构造（`方法 + 模板` 形态，超限截断）：历史恢复与 cURL
 *  导入同为「URL → 草稿 Tab」族，标题口径单点收敛 */
export function draftTabTitle(method: string, pathTemplate: string): string {
  return `${method} ${pathTemplate}`.slice(0, DRAFT_TITLE_MAX_CHARS)
}

/**
 * 路径模板的本地基本形态校验（明显非法值不发起写，与后端
 * validate_path_template 的前端镜像）：`/` 开头或绝对 URL 形态、无空白、
 * 无查询串（query 归参数面板拆行）。
 */
export function isPathTemplateShapeValid(pathTemplate: string): boolean {
  return (
    (pathTemplate.startsWith('/') || /^https?:\/\//.test(pathTemplate)) &&
    !/\s/.test(pathTemplate) &&
    !pathTemplate.includes('?')
  )
}

/** 构造输入（历史详情快照的只读素材＋当前工作空间 BaseUrl） */
export interface DraftSeedInput {
  method: string
  /** 快照最终 URL（含 host＋query） */
  url: string
  /** 快照请求头（用户头＋认证注入头；值保留、显示按名单掩码） */
  headers: [string, string][]
  /** 快照请求体 excerpt（null＝无体） */
  bodyExcerpt: string | null
  /** 快照 body 是否超出保留范围（仅回填前缀） */
  bodyTruncated: boolean
  /** 快照 redactions 提示的自定义敏感头名 */
  sensitiveHeaderNames: string[]
  /** 来源服务（转正落点的优先依据） */
  sourceServiceId: string | null
  /** 当前工作空间 BaseUrl（null／空／形态非法＝不匹配） */
  baseUrl: string | null
}

/** URL 拆分产物：pathTemplate（相对或绝对）＋ query 行 */
export function splitSnapshotUrl(
  url: string,
  baseUrl: string | null,
): { pathTemplate: string; queryParams: KvRow[] } {
  // 历史恢复与 cURL 导入共用的 URL → 草稿拆分口径（入参是含 host＋query
  // 的完整 URL：历史快照的最终 URL，或 cURL 命令的裸 URL 参数）
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // 形态异常的快照兜底：原文进模板（用户手改后转正；转正前的本地形态
    // 校验与后端校验都会拦截明显非法值），query 不强行拆
    return { pathTemplate: url, queryParams: [] }
  }
  // query 拆行走共享原语的 RFC 口径（plusAsSpace 缺省 false，`+` 字面保留）：
  // GUI 快照的 query 由后端 percent_encode 生成，字面 + 解码为空格会破坏
  // round-trip（同理不走 searchParams），解码→再编码逐字节一致；非法百分号
  // 序列容错保留原文，空名段保留（快照形态宽容，交用户裁决）。URL.search
  // 非空时恒以 ? 开头，slice(1) 即 query 本体（空串拆出空行集）
  const queryParams = parseQueryPairs(parsed.search.slice(1))
  // BaseUrl 前缀匹配：两侧都经 URL 规范化（host 大小写归一）后按
  // origin＋pathname 整体前缀比较；命中 → 余下 path 进模板，否则绝对形态
  const baseFull = normalizeBaseUrl(baseUrl)
  if (baseFull !== null) {
    const full = parsed.origin + parsed.pathname
    if (full === baseFull) {
      return { pathTemplate: '/', queryParams }
    }
    if (full.startsWith(`${baseFull}/`)) {
      return { pathTemplate: full.slice(baseFull.length), queryParams }
    }
  }
  return { pathTemplate: parsed.origin + parsed.pathname, queryParams }
}

/** BaseUrl 规范化为 origin＋pathname（去尾斜杠）；空 / 非法形态＝null（不匹配） */
function normalizeBaseUrl(baseUrl: string | null): string | null {
  const trimmed = baseUrl?.trim()
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed)
    const full = parsed.origin + parsed.pathname
    return full.length > 0 ? full.replace(/\/+$/, '') : null
  } catch {
    return null
  }
}

/**
 * 从快照构造草稿数据：method / URL 拆分 / headers 回填 / body 信封嗅探
 * （读侧口径复用——空→none，合法 JSON→json，`<` 起头→xml，其余→text；
 * 嗅探只定信封 kind，excerpt 原文进 text 载体，绝不改写）。
 */
export function draftSeedFromSnapshot(input: DraftSeedInput): {
  method: string
  pathTemplate: string
  paramsJson: string
  headersJson: string
  body: string | null
  bodyTruncated: boolean
  sensitiveHeaderNames: string[]
  sourceServiceId: string | null
  title: string
} {
  const { pathTemplate, queryParams } = splitSnapshotUrl(input.url, input.baseUrl)
  const headers: KvRow[] = input.headers.map(([name, value]) => ({ name, value }))
  const body =
    input.bodyExcerpt !== null && input.bodyExcerpt.trim() !== ''
      ? serializeBodyDraft({
          kind: sniffLegacyBodyKind(input.bodyExcerpt),
          text: input.bodyExcerpt,
          rows: [],
        })
      : null
  const title = draftTabTitle(input.method, pathTemplate)
  return {
    method: input.method,
    pathTemplate,
    paramsJson: serializeKvRows(queryParams),
    headersJson: serializeKvRows(headers),
    body,
    bodyTruncated: input.bodyTruncated,
    sensitiveHeaderNames: input.sensitiveHeaderNames,
    sourceServiceId: input.sourceServiceId,
    title,
  }
}
