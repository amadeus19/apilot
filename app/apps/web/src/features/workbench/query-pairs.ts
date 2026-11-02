/**
 * query 串 → 键值行的共享拆行原语：「URL → 草稿 Tab」族（历史快照恢复 /
 * 粘贴拆分 / cURL 导入）三处消费。差异点显式成选项、不统一口径——这是
 * 镜像口径的一部分：粘贴＝表单语义（外部 URL 的 `+` 与 `%20` 都视为空格，
 * 与发送侧 percent_encode 互为逆运算），快照与 cURL＝RFC 语义（`+` 字面
 * 保留：GUI 快照的 query 由后端 percent_encode 生成，解码→再编码逐字节
 * 一致才保 round-trip）。
 */

/** 拆行选项（均缺省 false＝RFC 3986 保守口径） */
export interface ParseQueryPairsOptions {
  /**
   * `+` 处理口径：true＝application/x-www-form-urlencoded 语义，`+` 归一为
   * `%20` 后统一百分号解码（空格两形态收敛为真实空格值）；false＝RFC 3986
   * 语义，`+` 字面保留。
   */
  plusAsSpace?: boolean
  /** 解码后名为空的段丢弃（不产生垃圾行）；false＝空名段原样保留 */
  dropEmptyName?: boolean
}

/**
 * 解析 `k=v&k2=v2` 形态的 query 串为键值行：`&` 分段、首个 `=` 分键值
 * （无 `=` 的裸段值为空串）、空段丢弃、键值容错解码；串内同名键保留为
 * 多行（同名收敛是调用方的合并语义，此处不做）。
 *
 * 手动分段而不走 URLSearchParams：它把字面 `+` 无条件解码为空格，两口径
 * 不可选，会破坏快照的 round-trip。
 */
export function parseQueryPairs(
  text: string,
  options: ParseQueryPairsOptions = {},
): { name: string; value: string }[] {
  const plusAsSpace = options.plusAsSpace === true
  const dropEmptyName = options.dropEmptyName === true
  const pairs: { name: string; value: string }[] = []
  for (const pair of text.split('&')) {
    if (pair === '') continue
    const eq = pair.indexOf('=')
    const rawName = eq < 0 ? pair : pair.slice(0, eq)
    const rawValue = eq < 0 ? '' : pair.slice(eq + 1)
    const name = tolerantDecode(rawName, plusAsSpace)
    if (name === '' && dropEmptyName) continue
    pairs.push({ name, value: tolerantDecode(rawValue, plusAsSpace) })
  }
  return pairs
}

/**
 * 容错解码：plusAsSpace 时 `+` 先归一 `%20` 再统一百分号解码；非法百分号
 * 序列（如孤立的 `%`）保留原文不改写——catch 分支返回原始输入（含 `+`
 * 字面量原样），不是归一后的串。
 */
function tolerantDecode(text: string, plusAsSpace: boolean): string {
  try {
    return decodeURIComponent(plusAsSpace ? text.replaceAll('+', '%20') : text)
  } catch {
    return text
  }
}
