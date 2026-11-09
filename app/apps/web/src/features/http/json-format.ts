/**
 * JSON 格式化共享纯函数（http 域）：响应面板 Pretty、历史详情请求 / 响应
 * 体共用。纯函数无 React 依赖，直测面（组件文件只导出组件的约定不破）。
 */

import { formatIdFromContentType } from './constants'

/**
 * JSON 格式化尝试：parse 成功且结果为 object / array 才返回两空格缩进的
 * 格式化文本；标量（纯数字 / 字符串 / 布尔 / null）与解析失败一律返回
 * null（回落原文——避免一段碰巧能 parse 成标量的普通文本被误当 JSON 重排）。
 */
export function tryFormatJson(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return null
    return JSON.stringify(parsed, null, 2)
  } catch {
    return null
  }
}

/** 头列表取 content-type（名字大小写不敏感；缺失返回 null） */
export function contentTypeFromHeaders(headers: readonly [string, string][]): string | null {
  for (const [name, value] of headers) {
    if (name.toLowerCase() === 'content-type') return value
  }
  return null
}

/**
 * 快照体（历史详情请求 / 响应正文）的格式化判定：截断段不格式化（摘录只
 * 展示原样）；JSON 判定优先看 content-type（formatIdFromContentType 覆盖
 * application/json 与 `+json` 后缀族），声明缺失时按「parse 得动且是
 * object / array」兜底，声明为非 JSON 媒型则维持原文。返回格式化文本，
 * 不满足口径返回 null——调用方回落原文展示，显示与复制同源。
 */
export function formatSnapshotBodyJson(
  text: string,
  truncated: boolean,
  contentType: string | null | undefined,
): string | null {
  if (truncated) return null
  if (contentType != null && formatIdFromContentType(contentType) !== 'json') return null
  return tryFormatJson(text)
}
