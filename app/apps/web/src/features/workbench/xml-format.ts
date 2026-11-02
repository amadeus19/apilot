/**
 * XML 缩进规整格式化器（vkbeautify 式）：单遍扫描字符流识别词法结构
 * （声明 / 注释 / CDATA / DOCTYPE / 标签 / 文本），按嵌套深度重建缩进——
 * 结构节点独占一行，叶子元素（空元素或短文本）内联为一行。不做结构
 * 改写——标签、属性、注释、CDATA、声明一律原文切片保留，文本节点只
 * 裁剪边缘空白。
 *
 * 容错语义：畸形输入（结构未闭合、`<` 后非法起始字符、标签深度不平、
 * 根外非空白文本）整体原样返回，不抛错不改写——XML 无「解析失败」的
 * 用户反馈面，格式化失败即呈现原文。输出是确定性的（同输入恒同输出），
 * 已格式化文本再格式化无任何变化（幂等） */

/** 缩进单位：两空格（与 JSON.stringify(…, 2) 同档） */
const INDENT = '  '

/** 标签名起始字符（XML NameStartChar 的常用子集：字母 / 下划线 / 冒号） */
const NAME_START = /[A-Za-z_:]/

/** 词法 token：structural＝声明 / PI / 注释 / CDATA / DOCTYPE（原样独立行） */
type Token =
  | { kind: 'structural'; raw: string }
  | { kind: 'open'; raw: string }
  | { kind: 'close'; raw: string }
  | { kind: 'selfclose'; raw: string }
  | { kind: 'text'; raw: string }

/**
 * 开标签 / 自闭合标签的 `>` 定位：属性值引号内的 `<` `>` 不算结构字符；
 * 引号外遇 `<`、引号未闭合到末尾、无 `>` 均判畸形。
 */
function scanTagEnd(text: string, from: number): number {
  let quote: string | null = null
  for (let j = from; j < text.length; j++) {
    const ch = text[j]
    if (quote !== null) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '<') return -1
    if (ch === '>') return j
  }
  return -1
}

/** 闭标签的 `>` 定位：闭标签内出现 `<` 或到末尾无 `>` 均判畸形 */
function scanCloseTagEnd(text: string, from: number): number {
  for (let j = from; j < text.length; j++) {
    const ch = text[j]
    if (ch === '<') return -1
    if (ch === '>') return j
  }
  return -1
}

/**
 * `<!` 结构（DOCTYPE 等）的 `>` 定位：跳过引号内容与内部子集
 * （`[…]` 深度，子集内可含 `<!ENTITY …>` 一类嵌套声明）。
 */
function scanDeclarationEnd(text: string, from: number): number {
  let quote: string | null = null
  let subsetDepth = 0
  for (let j = from; j < text.length; j++) {
    const ch = text[j]
    if (quote !== null) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '[') subsetDepth++
    else if (ch === ']') subsetDepth = Math.max(0, subsetDepth - 1)
    else if (ch === '>' && subsetDepth === 0) return j
  }
  return -1
}

/** 扫描为 token 流并跟踪标签深度；畸形返回 null（调用方原样返回原文） */
function scanXml(text: string): Token[] | null {
  const tokens: Token[] = []
  let depth = 0
  let i = 0
  while (i < text.length) {
    const lt = text.indexOf('<', i)
    if (lt === -1) {
      // 根外尾部文本只允许纯空白
      if (text.slice(i).trim() !== '') return null
      break
    }
    if (lt > i) {
      const raw = text.slice(i, lt)
      // 文档根之外不允许非空白裸文本（含 BOM 之外的任何内容）
      if (depth === 0 && raw.trim() !== '') return null
      tokens.push({ kind: 'text', raw })
    }
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4)
      if (end === -1) return null
      tokens.push({ kind: 'structural', raw: text.slice(lt, end + 3) })
      i = end + 3
      continue
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9)
      if (end === -1) return null
      tokens.push({ kind: 'structural', raw: text.slice(lt, end + 3) })
      i = end + 3
      continue
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2)
      if (end === -1) return null
      tokens.push({ kind: 'structural', raw: text.slice(lt, end + 2) })
      i = end + 2
      continue
    }
    if (text.startsWith('<!', lt)) {
      const end = scanDeclarationEnd(text, lt + 2)
      if (end === -1) return null
      tokens.push({ kind: 'structural', raw: text.slice(lt, end + 1) })
      i = end + 1
      continue
    }
    if (text.startsWith('</', lt)) {
      const end = scanCloseTagEnd(text, lt + 2)
      if (end === -1) return null
      depth--
      if (depth < 0) return null
      tokens.push({ kind: 'close', raw: text.slice(lt, end + 1) })
      i = end + 1
      continue
    }
    if (NAME_START.test(text[lt + 1] ?? '')) {
      const end = scanTagEnd(text, lt + 1)
      if (end === -1) return null
      const raw = text.slice(lt, end + 1)
      if (raw.endsWith('/>')) {
        tokens.push({ kind: 'selfclose', raw })
      } else {
        depth++
        tokens.push({ kind: 'open', raw })
      }
      i = end + 1
      continue
    }
    // 其余形态（数字开头标签名、孤立 `<`、`<>` 等）：畸形
    return null
  }
  if (depth !== 0) return null
  return tokens
}

/**
 * 开标签的内联体判定（叶子元素合一行的主流量化器口径）：
 * 紧跟闭标签（空元素）、或「至多一段文本＋闭标签」（短文本叶子）时
 * 返回内联末位下标，否则 -1。
 */
function findInlineEnd(tokens: readonly Token[], openIndex: number): number {
  const next = tokens[openIndex + 1]
  if (next === undefined) return -1
  if (next.kind === 'close') return openIndex + 1
  if (next.kind === 'text') {
    const afterText = tokens[openIndex + 2]
    return afterText !== undefined && afterText.kind === 'close' ? openIndex + 2 : -1
  }
  return -1
}

/** XML 缩进规整（两空格缩进）：畸形输入原样返回 */
export function formatXml(text: string): string {
  const tokens = scanXml(text)
  if (tokens === null) return text
  const lines: string[] = []
  let depth = 0
  for (let ix = 0; ix < tokens.length; ix++) {
    const token = tokens[ix]
    if (token.kind === 'text') {
      const trimmed = token.raw.trim()
      if (trimmed !== '') lines.push(INDENT.repeat(depth) + trimmed)
      continue
    }
    if (token.kind === 'open') {
      const inlineEnd = findInlineEnd(tokens, ix)
      if (inlineEnd !== -1) {
        // 叶子元素一行承载（标签原文切片＋文本裁剪边缘空白；纯空白文本
        // 不入行——空元素合为 <a></a>）
        const middle = tokens[ix + 1]
        const content =
          middle !== undefined && middle.kind === 'text' && middle.raw.trim() !== ''
            ? middle.raw.trim()
            : ''
        lines.push(INDENT.repeat(depth) + token.raw + content + tokens[inlineEnd].raw)
        ix = inlineEnd
        continue
      }
      lines.push(INDENT.repeat(depth) + token.raw)
      depth++
      continue
    }
    if (token.kind === 'close') {
      depth--
      lines.push(INDENT.repeat(depth) + token.raw)
      continue
    }
    lines.push(INDENT.repeat(depth) + token.raw)
  }
  return lines.join('\n')
}
