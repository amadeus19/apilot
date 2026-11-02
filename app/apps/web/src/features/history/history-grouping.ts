/**
 * 历史列表纯函数：URL 路径提取 / 子串过滤。
 * 过滤不接语言、不接 t；边界用例注入数据直测。
 */

import type { RunListItemDto } from './history-api'

/**
 * URL 的 path 段（含 query）：列表行路径列与搜索过滤的匹配口径。
 * 解析失败（非绝对 URL 等脏数据）回退原串——路径列宁可显示原文也不空白。
 */
export function urlPathOf(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}` || '/'
  } catch {
    return url
  }
}

/**
 * 次行「接口名」列的回落口径：path 段（不含 query）。接口名由 run.list
 * 联查 endpoints.title 带回（endpointName），仅接口已删（联查落空）时
 * 以 path 段充当。
 */
export function urlPathNameOf(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.pathname || '/'
  } catch {
    return url
  }
}

/**
 * 搜索过滤：本地子串匹配（大小写不敏感），命中口径＝路径（含 query 段）/
 * method / 状态码三者并列（任一命中即保留）；状态码按数字串子串比较
 * （如「40」命中 404）。
 */
export function filterHistoryItems(items: RunListItemDto[], query: string): RunListItemDto[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return items
  return items.filter(
    (item) =>
      urlPathOf(item.url).toLowerCase().includes(needle) ||
      item.method.toLowerCase().includes(needle) ||
      (item.statusCode !== null && String(item.statusCode).includes(needle)),
  )
}
