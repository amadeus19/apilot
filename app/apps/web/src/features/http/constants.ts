/**
 * HTTP 展示层常量（单一事实源）：状态码语义色、敏感头名单、URL query
 * 掩码、SSE 前端缓冲上限。所有「如何着色 / 如何脱敏 / 缓冲多大」的判定
 * 都从此取值，不散落组件。
 */

/**
 * 状态行状态码着色：2xx 成功绿 / 4xx 客户端琥珀 / 5xx 服务端红，
 * 其余（1xx / 3xx / 无响应）中性灰。
 */
export function statusCodeClass(statusCode: number | null): string {
  if (statusCode === null) return 'text-muted-foreground'
  if (statusCode >= 200 && statusCode < 300) return 'text-success'
  if (statusCode >= 400 && statusCode < 500) return 'text-warning'
  if (statusCode >= 500) return 'text-destructive'
  return 'text-muted-foreground'
}

/**
 * 终态语义档（状态芯片等派生形态的分档事实源）：cancelled＝中性灰、
 * failed 与 5xx＝红、4xx＝琥珀、2xx＝绿，其余（1xx / 3xx / 无响应）中性灰。
 * 与 statusCodeClass 同口径但带终态入参——失败终态的 statusCode 恒为
 * null，以 destructive 档表达（与详情页错误卡同语义）。
 */
export type StatusOutcome = 'success' | 'warning' | 'destructive' | 'muted'

export function runStatusOutcome(state: string, statusCode: number | null): StatusOutcome {
  if (state === 'cancelled') return 'muted'
  if (state === 'failed' || statusCode === null) return 'destructive'
  if (statusCode >= 500) return 'destructive'
  if (statusCode >= 400) return 'warning'
  if (statusCode >= 200 && statusCode < 300) return 'success'
  return 'muted'
}

/**
 * 标准敏感头名单（小写匹配，展示层默认脱敏）：认证凭据与常见令牌头。
 * 与后端认证注入名单对齐，另叠加每次请求 redactions 提示的自定义头名。
 */
export const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
])

/** 头名是否敏感：标准名单或本次请求 redactions 提示的自定义头名（比较不区分大小写） */
export function isSensitiveHeader(name: string, extraNames: readonly string[]): boolean {
  const lower = name.toLowerCase()
  if (SENSITIVE_HEADER_NAMES.has(lower)) return true
  return extraNames.some((extra) => extra.toLowerCase() === lower)
}

/** URL query 掩码：命中 redactions 键的参数值替换为 ***（键匹配不区分大小写） */
export function maskUrlQuery(url: string, keys: readonly string[]): string {
  if (keys.length === 0) return url
  const pattern = keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return url.replace(new RegExp(`([?&](${pattern})=)[^&#]*`, 'gi'), '$1***')
}

/**
 * Secret 变量消费值的全文替换（请求镜像掩码口径）：变量解析处在后端产出
 * 「本次消费的 Secret 值清单」（redactions.secretValues），展示与复制面对
 * 镜像文本全文替换掩码；「显示敏感值」由调用方控制（传 true 跳过替换）。
 * 空值跳过——空串 split 会在每个字符边界误命中。
 */
export function maskSecretValues(text: string, values: readonly string[], reveal: boolean): string {
  if (reveal || values.length === 0) return text
  let out = text
  for (const value of values) {
    if (value !== '') out = out.split(value).join('***')
  }
  return out
}

/** SSE 前端缓冲上限（尾部保留字符数）：一切缓冲有界，超出丢弃头部 */
export const SSE_BUFFER_MAX_CHARS = 256 * 1024

/** 全量查看的大小上限（与后端 50MB 双线一致）：超此线只读 Preview */
export const HTTP_MAX_RESPONSE_BYTES = 50 * 1024 * 1024

/**
 * Body 视图进 Monaco 编辑器的文本上限（字符数）：Pretty 态只对不超过此值
 * 的文本做格式化＋编辑器呈现，超过则回落等宽 pre＋复制（大文本建编辑器
 * model 的内存与 tokenize 开销远超 pre 渲染，与响应内存分级精神一致）。
 * 重评条件：Monaco 分块渲染 / 虚拟化能力落地，或实测大 JSON 的首帧与
 * 内存数据推翻 1MB 假设时调整。
 */
export const HTTP_BODY_EDITOR_MAX_CHARS = 1024 * 1024

// —— 响应保存：默认文件名（URL 尾段优先，扩展名按 Content-Type 推断补齐） ——

/** 文件名长度上限（Windows 文件名 255 上限内预留扩展名与对话框余量） */
const SAVE_NAME_MAX_CHARS = 80

/**
 * 保存扩展名判定（Content-Type → 扩展名，与 formatIdFromContentType 的
 * 高亮格式判定分用途）：子类型即扩展名（json / html / png / pdf / xml），
 * 常用特例改写（plain→txt、jpeg→jpg），连字符子类型只认 octet-stream /
 * event-stream 两个常见值，其余形态（x- 前缀、超长、含点）不补——宁缺毋错。
 */
function saveExtensionFromContentType(contentType: string | null | undefined): string | null {
  const mime = contentType?.split(';')[0]?.trim().toLowerCase() ?? ''
  const base = mime.split('/')[1]?.split('+')[0] ?? ''
  if (base === 'octet-stream') return 'bin'
  if (base === 'event-stream') return 'txt'
  if (!/^[a-z0-9]{1,12}$/.test(base)) return null
  if (base === 'plain') return 'txt'
  if (base === 'jpeg') return 'jpg'
  return base
}

/**
 * 保存响应的默认文件名：URL 路径尾段优先（去 query/hash 与 scheme://authority，
 * 根路径无尾段），清洗文件系统不安全字符并限长；尾段无扩展名时按
 * Content-Type 补齐，两者都推不出回落 response。仅作对话框初值，最终路径
 * 以用户选择为准。
 */
export function defaultSaveFileName(url: string, contentType: string | null | undefined): string {
  const extension = saveExtensionFromContentType(contentType)
  const withoutQuery = url.split(/[?#]/)[0] ?? url
  const pathOnly = withoutQuery.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '')
  const segment = pathOnly.split('/').filter(Boolean).pop() ?? ''
  // 清洗 Windows 文件名禁用字符；空段与全清洗段视同无尾段
  const safe = segment.replace(/[\\:*?"<>|]/g, '_').slice(0, SAVE_NAME_MAX_CHARS)
  if (safe !== '' && safe !== '_') {
    if (/\.[A-Za-z0-9]{1,8}$/.test(safe) || extension === null) return safe
    return `${safe}.${extension}`
  }
  return extension === null ? 'response' : `response.${extension}`
}

// —— Body 视图：格式 / 编码 / Preview（口径收敛，组件不散落判定） ——

/**
 * 响应原始字节（固定 ArrayBuffer 底）：字节链路（重解码 / Blob URL 渲染）
 * 全程用此类型——BlobPart 要求 ArrayBuffer 视图，默认的 ArrayBufferLike 底
 * 会把 SharedArrayBuffer 兜进兼容面。
 */
export type ResponseBytes = Uint8Array<ArrayBuffer>

/**
 * Body 视图格式候选（选择器展示名恒英文协议名，不入字典）：monaco 为
 * 对应高亮语言标识。改动只影响视图层（高亮、格式化可用性），不改原始文本。
 */
export const RESPONSE_FORMATS = [
  { id: 'json', label: 'JSON', language: 'json' },
  { id: 'xml', label: 'XML', language: 'xml' },
  { id: 'html', label: 'HTML', language: 'html' },
  { id: 'text', label: 'Text', language: 'plaintext' },
] as const

export type ResponseFormatId = (typeof RESPONSE_FORMATS)[number]['id']

/** 格式候选对应的 Monaco 高亮语言标识（text 恒 plaintext） */
export function formatLanguage(id: ResponseFormatId): string {
  return RESPONSE_FORMATS.find((item) => item.id === id)?.language ?? 'plaintext'
}

/**
 * 编码选择器候选：TextDecoder 支持集的常用子集（标签为 WHATWG 编码名，
 * 恒英文原样展示）。当前项随响应 charset 推导，用户可改后按原始字节重解码。
 */
export const RESPONSE_CHARSETS = [
  'utf-8',
  'gbk',
  'gb18030',
  'big5',
  'shift_jis',
  'iso-8859-1',
] as const

export type ResponseCharset = (typeof RESPONSE_CHARSETS)[number]

/** 从 Content-Type 推导 Body 视图格式初始项（+json / +xml 后缀族一并覆盖） */
export function formatIdFromContentType(contentType: string | null | undefined): ResponseFormatId {
  if (!contentType) return 'text'
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (mime === 'application/json' || mime.endsWith('+json')) return 'json'
  if (mime === 'application/xml' || mime === 'text/xml' || mime.endsWith('+xml')) return 'xml'
  if (mime === 'text/html') return 'html'
  return 'text'
}

/** 从 Content-Type 推导响应 charset（候选表内才采纳；缺省 utf-8） */
export function charsetFromContentType(contentType: string | null | undefined): ResponseCharset {
  const found = /charset=([\w-]+)/i.exec(contentType ?? '')?.[1]?.toLowerCase()
  if (found !== undefined && (RESPONSE_CHARSETS as readonly string[]).includes(found)) {
    return found as ResponseCharset
  }
  return 'utf-8'
}

/**
 * Preview 可渲染类型：html / 图片系 / pdf / 文本（text/* 家族与嗅探判定为
 * 文本的未知类型）；其余返回 null——未知类型由调用方结合原始字节嗅探
 * （isLikelyTextBytes）决定进文本预览还是不可渲染回落。
 */
export type PreviewKind = 'html' | 'image' | 'pdf' | 'text'

export function previewKindFromContentType(
  contentType: string | null | undefined,
): PreviewKind | null {
  if (!contentType) return null
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (mime === 'text/html') return 'html'
  // text/* 家族（plain / csv / xml / markdown / event-stream 等）一律可读
  // 排版；JSON 无专属档（Pretty 已是主形态，Preview 走未知类型嗅探原文）
  if (mime.startsWith('text/')) return 'text'
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'application/pdf') return 'pdf'
  return null
}

/** 文本嗅探的首块字节数（魔数与可打印率都只看开头，全量扫描不划算） */
const TEXT_SNIFF_BYTES = 4096

/** 首块内控制字节的可疑率上限：随机二进制的控制字节率约 13%，留足余量 */
const TEXT_CONTROL_RATIO_MAX = 0.05

/**
 * 常见二进制格式的魔数前缀（Content-Type 缺失或谎报时的快速否决）：
 * 只收正文几乎不可能撞上的签名——纯可打印双字母开头（BMP 的 BM、EXE 的
 * MZ）易误杀正常文本，不收。
 */
const BINARY_MAGIC_PREFIXES: readonly (readonly number[])[] = [
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0x25, 0x50, 0x44, 0x46], // %PDF
  [0x50, 0x4b, 0x03, 0x04], // ZIP（docx / xlsx / jar 同头）
  [0x1f, 0x8b], // GZIP
  [0x52, 0x61, 0x72, 0x21], // RAR
  [0x37, 0x7a, 0xbc, 0xaf], // 7Z
  [0x52, 0x49, 0x46, 0x46], // RIFF（webp / wav / avi）
  [0x7f, 0x45, 0x4c, 0x46], // ELF
]

/**
 * 字节流是否判定为文本（未知 Content-Type 的 Preview 嗅探口径）：
 * 1. 空字节＝空文本；
 * 2. UTF-8 BOM 是文本的强证据；
 * 3. 二进制魔数前缀命中即否决；
 * 4. 首块内出现 NUL（0x00）即否决——文本几乎不含 NUL，UTF-16 由此一并
 *    否决（编码候选表不含 utf-16，渲染必乱码，不如回落提示）；
 * 5. 首块控制字节可疑率超上限即否决（控制＝0x00-0x08 / 0x0B / 0x0E-0x1F /
 *    0x7F，排除 \t \n \r）；高位字节（≥0x80）宽容——GBK / Big5 / UTF-8
 *    多字节序列的主流形态，按文本放行。
 */
export function isLikelyTextBytes(bytes: ResponseBytes): boolean {
  if (bytes.byteLength === 0) return true
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return true
  const sniffLen = Math.min(bytes.byteLength, TEXT_SNIFF_BYTES)
  for (const prefix of BINARY_MAGIC_PREFIXES) {
    if (bytes.byteLength < prefix.length) continue
    let matched = true
    for (let i = 0; i < prefix.length; i++) {
      if (bytes[i] !== prefix[i]) {
        matched = false
        break
      }
    }
    if (matched) return false
  }
  let controlCount = 0
  for (let i = 0; i < sniffLen; i++) {
    const byte = bytes[i]
    if (byte === 0x00) return false
    const isControl =
      (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f
    if (isControl) controlCount++
  }
  return controlCount / sniffLen <= TEXT_CONTROL_RATIO_MAX
}

/** PDF 文件头魔数（`%PDF-`，PDF 规范要求置于文件起始） */
const PDF_MAGIC_PREFIX = [0x25, 0x50, 0x44, 0x46, 0x2d] as const

/** PDF 头部容差字节数（规范容忍头部前夹杂少量垃圾字节，读取器按前 1KB 寻头） */
const PDF_MAGIC_SCAN_BYTES = 1024

/**
 * 字节流是否判定为 PDF（Preview pdf 通道的准入门槛）：前 1KB 内寻找
 * `%PDF-` 魔数。Content-Type 谎报为 PDF 的非 PDF 字节（典型＝HTML）不得
 * 进入去沙箱的插件渲染通道，在此拦下回落提示。
 */
export function isPdfBytes(bytes: ResponseBytes): boolean {
  const limit = Math.min(bytes.byteLength, PDF_MAGIC_SCAN_BYTES)
  for (let i = 0; i + PDF_MAGIC_PREFIX.length <= limit; i++) {
    let matched = true
    for (let j = 0; j < PDF_MAGIC_PREFIX.length; j++) {
      if (bytes[i + j] !== PDF_MAGIC_PREFIX[j]) {
        matched = false
        break
      }
    }
    if (matched) return true
  }
  return false
}
