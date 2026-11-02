/**
 * `{{` 变量片段检测纯函数（独立模块：与组件分文件导出，测试表驱动
 * 钉住边界——闭合、连击、字面量）：联想的未闭合片段检测与 hover 解析的
 * 闭合引用提取共用一域。
 */

/** 光标前未闭合 `{{` 片段检测：命中返回片段起点与已输查询词，未命中 null。
 *  闭合的 `}}` 之后不再命中（`{{a}}b` 光标在末尾不弹）；`{{{` 连击不命中
 *  （片段前的字符是 `{` 视作字面量输入）。 */
export function matchVariableFragment(textBeforeCursor: string): {
  start: number
  query: string
} | null {
  const match = /\{\{([^{}]*)$/.exec(textBeforeCursor)
  if (!match) return null
  const start = match.index
  if (start > 0 && textBeforeCursor[start - 1] === '{') return null
  return { start, query: match[1] ?? '' }
}

/** 文本中闭合 `{{key}}` 引用（hover 解析的扫描单位；start/end 为整段模板的偏移） */
export interface VariableReference {
  start: number
  end: number
  key: string
}

/** 闭合 `{{key}}` 引用提取：扫描口径与后端 Resolver 的 resolve_value 逐分支
 *  镜像——首个 `{{` 起就近取 `}}`，键 trim 后匹配；空名与未闭合余段视字面量
 *  不产引用（`{{{a}}` 的键含花括号，后端同样按未命中消费）。 */
export function findVariableReferences(text: string): VariableReference[] {
  const refs: VariableReference[] = []
  let rest = text
  let base = 0
  for (;;) {
    const at = rest.indexOf('{{')
    if (at < 0) break
    const after = rest.slice(at + 2)
    const close = after.indexOf('}}')
    if (close < 0) break
    const key = after.slice(0, close).trim()
    const end = base + at + 2 + close + 2
    if (key !== '') refs.push({ start: base + at, end, key })
    // 空名 / 病态段不产引用但扫描越过整段（与后端消费位置一致）
    rest = after.slice(close + 2)
    base = end
  }
  return refs
}
