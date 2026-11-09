import * as React from 'react'

import { save as saveFileDialog } from '@tauri-apps/plugin-dialog'
import { SaveIcon, WrapTextIcon } from 'lucide-react'

import {
  Badge,
  Button,
  CopySurface,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsList,
  TabsTrigger,
  toast,
} from '@workspace/ui/components'

import { formatBytes, useI18n } from '@/i18n'
import { reportError } from '@/services/error-center'
import { toIpcError } from '@/services/ipc'
import { selectResolvedTheme, useSettingsStore } from '@/stores/settings.store'
import { useXmlFormat } from '@/features/workbench/use-xml-format'
import {
  HTTP_BODY_EDITOR_MAX_CHARS,
  HTTP_MAX_RESPONSE_BYTES,
  RESPONSE_CHARSETS,
  RESPONSE_FORMATS,
  charsetFromContentType,
  defaultSaveFileName,
  formatIdFromContentType,
  formatLanguage,
  isLikelyTextBytes,
  previewKindFromContentType,
  type ResponseCharset,
  type ResponseFormatId,
  type ResponseBytes,
} from './constants'
import { httpReadRange, httpSaveResponse, type RunResultDto } from './http-api'
import { tryFormatJson } from './json-format'
import { MonacoLoading } from './monaco-loading'
import { useResponseStore } from './response.store'
import { ResponsePreview } from './response-preview'

/** Monaco 共享底座懒加载入口：仅 Pretty 态首次出现才拉 chunk */
const MonacoTextEditor = React.lazy(() =>
  import('./monaco-text-editor').then((m) => ({ default: m.MonacoTextEditor })),
)

/**
 * Body 视图：Pretty / Raw / Preview 三态切换＋格式 / 编码选择器＋大响应
 * 分级——文件档（responseId 非 null）「加载全量」经 range-read 分段拼接
 * （1MB/段，进度可见）；>50MB 只读 Preview＋大小限制提示。
 *
 * 呈现分级（Pretty / Raw / Preview 同一工具栏；Pretty / Raw 同一复制口径）：
 * - Pretty：Monaco 只读编辑器（高亮 / 折叠 / 行号，懒加载 chunk）。高亮
 *   语言与格式化口径由格式选择器决定（json 解析格式化；xml 经共享 worker
 *   缩进规整（与请求侧同一格式化入口）；html 原文高亮；text 恒等宽 pre）；
 * - Raw：等宽 pre 呈现原文（大文本建编辑器 model 的开销远超 pre 渲染）；
 * - Preview：按 Content-Type 判定渲染通道（html / 图片 / pdf / 文本——
 *   text/* 直出可读排版，未知类型按首块嗅探判定，真二进制回落提示）。
 *
 * 展示文本的编码口径：响应头声明（或用户选择）的 charset 经 TextDecoder
 * 对原始字节重解码——内存档字节来自 rawBase64，文件档经 range-read 分段
 * 拉全量（≤50MB 有界，与加载全量共用同一字节缓存）；解码失败回落 utf-8
 * 并提示。utf-8 口径沿用后端 excerpt（同一解码），不做二次解码。
 *
 * 生命周期纪律：同 Tab 切视图不重建编辑器（Monaco 层留挂载、hidden 切
 * 换）；编辑器实例跨请求复用（value 更新不换实例）；组件树卸载（关 Tab /
 * 折叠 / 切走）即 dispose。Pretty / Raw / Preview 偏好是 per-tab 字段
 * （response.store），跨请求保留、随 Tab 关闭清理；格式 / 编码选择器的
 * 当前项随响应 Content-Type 推导，用户新响应到达时重新推导。
 */

/** range-read 单段大小（后端单段上限 1MB） */
const READ_RANGE_CHUNK_BYTES = 1024 * 1024

/** 展示口径（选中文本还是截断段；加载中的进度与失败信息由字节态承载） */
type FullBodyState = { state: 'idle' } | { state: 'loaded'; text: string }

/** 原始字节通道：内存档恒 loaded（rawBase64 就地解码）；文件档惰性分段拉取 */
type BytesState =
  | { state: 'idle' }
  | { state: 'loading'; loadedBytes: number }
  | { state: 'loaded'; bytes: ResponseBytes }
  | { state: 'failed'; message: string }

/** base64（仅内存档 DTO 携带）→ 原始字节 */
function base64ToBytes(base64: string): ResponseBytes {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 拼接分段字节（顺序合并为一份，供解码 / Blob 单次持有） */
function concatBytes(parts: ResponseBytes[]): ResponseBytes {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    merged.set(part, offset)
    offset += part.byteLength
  }
  return merged
}

/** 分段读取大响应原始字节（循环 read_range 1MB 段；文件缺失空段即止） */
async function readFullBodyBytes(
  responseId: string,
  totalSize: number,
  onProgress: (loadedBytes: number) => void,
): Promise<ResponseBytes> {
  const parts: ResponseBytes[] = []
  let offset = 0
  while (offset < totalSize) {
    const len = Math.min(READ_RANGE_CHUNK_BYTES, totalSize - offset)
    const chunk = await httpReadRange(responseId, offset, len)
    if (chunk.byteLength === 0) break // 文件已被替换删除：以已读部分收场
    parts.push(new Uint8Array(chunk))
    offset += chunk.byteLength
    onProgress(offset)
  }
  return concatBytes(parts)
}

/**
 * 按选定 charset 重解码：fatal 解码失败（字节与编码不符）回落 utf-8
 * lossy 并标记，提示文案由展示层转换。
 */
function decodeWithCharset(
  bytes: ResponseBytes,
  charset: ResponseCharset,
): { text: string; decodeFailed: boolean } {
  if (charset !== 'utf-8') {
    try {
      return { text: new TextDecoder(charset, { fatal: true }).decode(bytes), decodeFailed: false }
    } catch {
      return {
        text: new TextDecoder('utf-8', { fatal: false }).decode(bytes),
        decodeFailed: true,
      }
    }
  }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(bytes), decodeFailed: false }
}

export function ResponseBodyPane({ result, tabId }: { result: RunResultDto; tabId: string }) {
  const { t } = useI18n()
  const resolvedTheme = useSettingsStore(selectResolvedTheme)
  const mode = useResponseStore((s) => s.bodyModes[tabId] ?? 'pretty')
  const setBodyMode = useResponseStore((s) => s.setBodyMode)

  // 换行开关（视图偏好，跨请求保持）：默认关——与请求区 Body 编辑同一
  // 默认口径；Monaco wordWrap 与 pre 态 whitespace-pre-wrap /
  // overflow-x-auto 双侧同步
  const [wrap, setWrap] = React.useState(false)
  // 全量加载与选择器状态随新结果重置（渲染期调整模式：runId 变化＝新响应
  // 到达）；视图模式偏好已上移 response.store（per-tab 字段），新 runId 不重置
  const [seededRunId, setSeededRunId] = React.useState(result.runId)
  const [full, setFull] = React.useState<FullBodyState>({ state: 'idle' })
  // 格式选择器：随 Content-Type 推导当前项，用户可改——只影响高亮语言与
  // 格式化可用性，不改原始文本
  const [format, setFormat] = React.useState<ResponseFormatId>(() =>
    formatIdFromContentType(result.response?.contentType),
  )
  // 编码选择器：随响应 charset 推导当前项，用户改后按原始字节重解码
  const [charset, setCharset] = React.useState<ResponseCharset>(() =>
    charsetFromContentType(result.response?.contentType),
  )
  // 文件档原始字节缓存（惰性拉取）：编码重解码 / Preview / 加载全量共用，
  // 内存档不经此态（rawBase64 就地可得）
  const [fileBytes, setFileBytes] = React.useState<BytesState>({ state: 'idle' })
  if (seededRunId !== result.runId) {
    setSeededRunId(result.runId)
    setFull({ state: 'idle' })
    setFormat(formatIdFromContentType(result.response?.contentType))
    setCharset(charsetFromContentType(result.response?.contentType))
    setFileBytes({ state: 'idle' })
  }

  const response = result.response
  const excerpt = response?.body.excerpt ?? ''
  const totalSize = response?.body.totalSize ?? 0
  const isFileTier = result.responseId !== null
  // >50MB：后端不给 responseId，只读 Preview＋限制提示
  const sizeLimited =
    (response?.body.truncated ?? false) && !isFileTier && totalSize > HTTP_MAX_RESPONSE_BYTES
  // 保存入口只对持有全量字节的分级出现：文件档（凭据在手）/ 内存档（字节
  // 在手）；超限预览档既无凭据也无字节，不渲染
  const saveable = isFileTier || response?.body.rawBase64 !== undefined

  // 内存档原始字节：rawBase64 解码为只读快照（useMemo 随 DTO 引用缓存）
  const memoryBytes = React.useMemo<ResponseBytes | null>(() => {
    const raw = response?.body.rawBase64
    return raw !== undefined ? base64ToBytes(raw) : null
  }, [response?.body.rawBase64])

  const bytes: BytesState = React.useMemo(
    () => (memoryBytes !== null ? { state: 'loaded', bytes: memoryBytes } : fileBytes),
    [memoryBytes, fileBytes],
  )

  /**
   * 拉取文件档全量原始字节（分段循环；已在手 / 拉取中 / 内存档不重复拉）。
   * setState 全部发生在 await / 进度回调之后（effect 与事件处理器共用的
   * 入口，不得有同步 setState 路径）。
   */
  const ensureFileBytes = React.useCallback(async (): Promise<ResponseBytes | null> => {
    const responseId = result.responseId
    if (!responseId || memoryBytes !== null) return null
    if (fileBytes.state === 'loading') return null
    if (fileBytes.state === 'loaded') return fileBytes.bytes
    try {
      const loaded = await readFullBodyBytes(responseId, totalSize, (loadedBytes) => {
        setFileBytes({ state: 'loading', loadedBytes })
      })
      setFileBytes({ state: 'loaded', bytes: loaded })
      return loaded
    } catch (raw) {
      const err = toIpcError(raw)
      reportError(err)
      setFileBytes({ state: 'failed', message: err.message })
      return null
    }
  }, [result.responseId, memoryBytes, fileBytes, totalSize])

  const loadFull = async () => {
    const loaded = await ensureFileBytes()
    if (loaded !== null) {
      setFull({ state: 'loaded', text: new TextDecoder('utf-8', { fatal: false }).decode(loaded) })
    }
  }

  /**
   * 保存响应体原始字节：系统 save 对话框选定目标路径（路径不落库）→
   * http.save_response 写盘——文件档 Rust 按凭据分段拼装临时文件（50MB
   * 上限护栏），内存档回传 DTO 持有的 rawBase64 解码写盘。对话框取消为
   * 正常路径（中性反馈、无任何写盘副作用）；写盘失败经统一错误协议以
   * 瞬态 toast 呈现。
   */
  const handleSaveBody = async () => {
    if (!response) return
    // 默认文件名：URL 尾段优先，扩展名按 Content-Type 推断补齐（仅初值）
    const target = await saveFileDialog({
      defaultPath: defaultSaveFileName(result.request.url, response.contentType),
    })
    if (target === null) {
      toast.info(t('response.saveCancelled'))
      return
    }
    try {
      const saved = await httpSaveResponse({
        responseId: result.responseId,
        contentBase64: response.body.rawBase64 ?? null,
        targetPath: target,
      })
      toast.success(t('response.savedBody', { size: formatBytes(saved.savedBytes) }))
    } catch (raw) {
      reportError(raw)
    }
  }

  // 编码重解码（选定 charset ≠ utf-8 且字节在手时的纯派生；失败回落 utf-8）
  const decoded = React.useMemo(() => {
    if (charset === 'utf-8' || bytes.state !== 'loaded') return null
    return decodeWithCharset(bytes.bytes, charset)
  }, [bytes, charset])

  // 展示文本（选定编码口径）：重解码结果优先；否则 utf-8 口径（全量加载
  // 文本或后端截断段——同一解码基准，不做二次解码）
  const rawText = decoded !== null ? decoded.text : full.state === 'loaded' ? full.text : excerpt

  // 文本预览口径：字节在手按选定编码解码全文（与编码选择器同链路，切换
  // 编码即跟随重解码）；无字节源（超限内存档）退回展示文本（截断段）
  const previewText = React.useMemo(() => {
    if (bytes.state !== 'loaded') return rawText
    if (decoded !== null) return decoded.text
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes.bytes)
  }, [bytes, decoded, rawText])

  // Pretty 候选：未超上限的文本才进编辑器（全量后超限的文本直接等宽 pre）
  const prettyCandidate = rawText.length <= HTTP_BODY_EDITOR_MAX_CHARS ? rawText : null
  const formattedJson = React.useMemo(
    () => (format === 'json' && prettyCandidate !== null ? tryFormatJson(prettyCandidate) : null),
    [format, prettyCandidate],
  )

  // —— xml Pretty：经共享 worker 缩进规整（请求 / 响应两侧同一格式化入口；
  //    线程随本组件挂卸，惰性创建、卸载即回收）——异步派生以「输入 → 输出」
  // 缓存对承载：渲染期调整（缓存不再对应当前候选即失效，回落原文展示），
  // effect 只负责发起计算与落地结果
  const formatXmlText = useXmlFormat()
  const xmlSource = format === 'xml' && prettyCandidate !== null ? prettyCandidate : null
  const [xmlFormatted, setXmlFormatted] = React.useState<{ input: string; output: string } | null>(
    null,
  )
  if (xmlFormatted !== null && xmlFormatted.input !== xmlSource) {
    setXmlFormatted(null)
  }
  React.useEffect(() => {
    if (xmlSource === null) return
    let cancelled = false
    void formatXmlText(xmlSource).then((output) => {
      if (!cancelled) setXmlFormatted({ input: xmlSource, output })
    })
    return () => {
      cancelled = true
    }
  }, [xmlSource, formatXmlText])
  const formattedXml =
    xmlSource !== null && xmlFormatted?.input === xmlSource ? xmlFormatted.output : null

  // Preview 需要原始字节（html / 图片 / pdf 都按字节渲染）
  const previewKind = previewKindFromContentType(response?.contentType)

  // 字节需求：Preview 态恒需原始字节（html / 图片 / pdf 按字节渲染、
  // 文本档与未知档按字节解码全文 / 嗅探判定），或编码重解码（charset ≠
  // utf-8）——文件档未拉取时沿此链授权拉取（内存档字节恒在手不走此链；
  // 超限内存档无 responseId 自然空转不重试）。与外部系统（IPC）同步的取数
  // 回填形态：setState 全在 await / 进度回调之后，cleanup 竞速守卫防旧响应
  // 落地（事件链的加载全量走 ensureFileBytes，二者共享分段读函数）。
  const needsBytes = mode === 'preview' || charset !== 'utf-8'
  React.useEffect(() => {
    const responseId = result.responseId
    if (!needsBytes || bytes.state !== 'idle' || !responseId || memoryBytes !== null) return
    let cancelled = false
    void (async () => {
      try {
        const loaded = await readFullBodyBytes(responseId, totalSize, (loadedBytes) => {
          if (!cancelled) setFileBytes({ state: 'loading', loadedBytes })
        })
        if (!cancelled) setFileBytes({ state: 'loaded', bytes: loaded })
      } catch (raw) {
        if (!cancelled) {
          const err = toIpcError(raw)
          reportError(err)
          setFileBytes({ state: 'failed', message: err.message })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [needsBytes, bytes.state, result.responseId, memoryBytes, totalSize])

  if (!response) return null

  const truncated = response.body.truncated
  const isFull = full.state === 'loaded'

  /** 视图切换（字节拉取由下方需求 effect 统一授权） */
  const handleModeChange = (next: string) => {
    setBodyMode(tabId, next === 'raw' ? 'raw' : next === 'preview' ? 'preview' : 'pretty')
  }

  const handleCharsetChange = (next: ResponseCharset | null) => {
    if (next === null) return
    setCharset(next)
  }

  const handleFormatChange = (next: ResponseFormatId | null) => {
    if (next !== null) setFormat(next)
  }

  // 展示与复制共用的口径（所见即所得）：Pretty＝格式化文本（json 解析成功
  // 或 xml 规整完成；在途回落原文）、Raw＝原文；编码选择影响两者。
  // prettyText 与视图 mode 无关——Monaco 层 Raw 态隐藏不卸载，value 保持
  // Pretty 口径不闪烁
  const prettyText =
    formattedJson !== null ? formattedJson : formattedXml !== null ? formattedXml : rawText
  const displayText = mode === 'pretty' ? prettyText : rawText

  // Monaco 挂载条件（与当前 mode 无关：切 Raw 只隐藏层不卸载组件）：
  // json＝解析成功；xml（格式化在途先原文呈现，结果到达经 setValue 顶替）/
  // html＝未超上限；text＝恒等宽 pre
  const monacoWanted =
    format === 'json' ? formattedJson !== null : format !== 'text' && prettyCandidate !== null
  const monacoVisible = monacoWanted && mode === 'pretty'

  const loading =
    fileBytes.state === 'loading'
      ? Math.min(100, Math.round((fileBytes.loadedBytes / totalSize) * 100))
      : null

  // 文本预览：与 Raw 态 pre 同档的等宽排版（14px / 19px），无行号无高亮，
  // 恒自动换行的可读阅读态
  const textPreviewPane = (
    <pre
      className="h-full overflow-auto p-3 font-mono text-[14px] leading-[19px] whitespace-pre-wrap"
      data-testid="response-body-preview-text"
    >
      {previewText}
    </pre>
  )

  // 字节未就绪的承载提示（仅在 bytes.state !== 'loaded' 的分支渲染，三态
  // 穷尽恒有元素）：idle＝无字节源的限制提示（超限内存档）、loading＝进度、
  // failed＝错误
  const bytesPendingHint: React.ReactNode =
    bytes.state === 'idle' ? (
      <p className="grid h-full place-items-center px-6 text-center text-xs text-muted-foreground">
        {t('response.sizeLimited')}
      </p>
    ) : bytes.state === 'loading' ? (
      <p className="grid h-full place-items-center text-xs text-muted-foreground">
        {t('response.loadingFull', {
          percent: Math.min(100, Math.round((bytes.loadedBytes / totalSize) * 100)),
        })}
      </p>
    ) : bytes.state === 'failed' ? (
      <p className="grid h-full place-items-center text-xs text-destructive">{bytes.message}</p>
    ) : null

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="response-body">
      {/* 视图行不画底边线（上方页签带已有线）；视图切换用灰底容器款，与
          线型页签拉开形态差。pl-3 与上方页签带 px-3 同左基准——分段控件
          起点与 Body / Headers 页签起点对齐 */}
      <div
        className="mt-2 flex h-9 shrink-0 items-center gap-2 pr-3 pl-3"
        data-testid="response-body-toolbar"
      >
        <Tabs value={mode} onValueChange={handleModeChange}>
          <TabsList className="group-data-horizontal/tabs:h-7">
            <TabsTrigger value="pretty" className="px-2 text-xs">
              Pretty
            </TabsTrigger>
            <TabsTrigger value="raw" className="px-2 text-xs">
              Raw
            </TabsTrigger>
            <TabsTrigger value="preview" className="px-2 text-xs">
              Preview
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {mode === 'pretty' && (
          <>
            <Select value={format} onValueChange={handleFormatChange}>
              <SelectTrigger
                size="sm"
                aria-label={t('response.formatSelectorLabel')}
                title={t('response.formatSelectorHint')}
                className="h-6 border-none bg-transparent px-1.5 py-0 text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-foreground dark:bg-transparent dark:hover:bg-accent"
                data-testid="response-format-selector"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RESPONSE_FORMATS.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={charset} onValueChange={handleCharsetChange}>
              <SelectTrigger
                size="sm"
                aria-label={t('response.charsetSelectorLabel')}
                title={t('response.charsetSelectorHint')}
                className="h-6 border-none bg-transparent px-1.5 py-0 text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-foreground dark:bg-transparent dark:hover:bg-accent"
                data-testid="response-charset-selector"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RESPONSE_CHARSETS.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}
        {/* 自动换行＝纯图标开关（与请求区 Body 编辑同款）：选中不带背景
            （图标取常规工具色），未选中把图标置灰即可——不要提亮，也不要
            底色填充 */}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-pressed={wrap}
          aria-label={t('response.toggleWrap')}
          title={t('response.toggleWrap')}
          data-testid="response-body-wrap-toggle"
          onClick={() => setWrap((prev) => !prev)}
          className={
            wrap ? 'text-muted-foreground' : 'text-muted-foreground/40 hover:text-muted-foreground'
          }
        >
          <WrapTextIcon aria-hidden />
        </Button>
        <div className="ml-auto flex items-center gap-1.5">
          {saveable && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('response.saveBody')}
              title={t('response.saveBody')}
              onClick={() => void handleSaveBody()}
              data-testid="response-body-save"
            >
              <SaveIcon aria-hidden />
            </Button>
          )}
          {isFull && <Badge variant="secondary">{formatBytes(totalSize)}</Badge>}
          {!isFull && truncated && <Badge variant="secondary">{t('response.truncated')}</Badge>}
          {loading !== null && (
            <span className="text-micro text-muted-foreground" data-testid="response-body-loading">
              {t('response.loadingFull', { percent: loading })}
            </span>
          )}
          {isFileTier && fileBytes.state === 'idle' && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => void loadFull()}
            >
              {t('response.loadFull')}
            </Button>
          )}
          {decoded?.decodeFailed && (
            <span className="text-micro text-destructive" data-testid="response-charset-fallback">
              {t('response.charsetDecodeFailed', { charset })}
            </span>
          )}
          {fileBytes.state === 'failed' && (
            <span className="text-micro text-destructive">{fileBytes.message}</span>
          )}
          {sizeLimited && (
            <span className="text-micro text-muted-foreground">{t('response.sizeLimited')}</span>
          )}
          {isFull && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => setFull({ state: 'idle' })}
            >
              {t('response.backToPreview')}
            </Button>
          )}
        </div>
      </div>
      {/* Preview 走独立渲染通道（二进制 / 沙箱标记，不进可复制文本表面）；
          Pretty / Raw 共用复制表面：Pretty 复制格式化文本（解析失败或超限
          回落原文）、Raw 复制原文。Preview 分流：text 档直出可读排版、
          未知档先嗅探后分流、html / 图片 / pdf 维持字节通道 */}
      {mode === 'preview' ? (
        <div className="min-h-0 flex-1" data-testid="response-body-preview">
          {previewKind === 'text' ? (
            textPreviewPane
          ) : previewKind === null ? (
            // 未知类型（含无 Content-Type）：字节到手后按首块嗅探——文本
            // 进可读排版，真二进制回落不可渲染提示
            bytes.state !== 'loaded' ? (
              bytesPendingHint
            ) : isLikelyTextBytes(bytes.bytes) ? (
              textPreviewPane
            ) : (
              <p className="grid h-full place-items-center px-6 text-center text-xs text-muted-foreground">
                {t('response.previewUnavailable', {
                  contentType: response.contentType ?? t('response.contentTypeNone'),
                })}
              </p>
            )
          ) : bytes.state !== 'loaded' ? (
            bytesPendingHint
          ) : (
            <ResponsePreview
              kind={previewKind}
              bytes={bytes.bytes}
              contentType={response.contentType}
            />
          )}
        </div>
      ) : (
        <CopySurface
          getText={() => displayText}
          className="relative min-h-0 flex-1"
          data-testid="response-body-surface"
        >
          {monacoWanted && (
            <div
              data-testid="response-body-monaco"
              className={monacoVisible ? 'absolute inset-0' : 'hidden'}
            >
              <React.Suspense fallback={<MonacoLoading />}>
                {/* chunk 就绪后的状态转换级淡入：编辑器在此层 mount 时播放一次
                    （Raw 态外层 hidden 切换不卸载，不重播） */}
                <div className="absolute inset-0 animate-in duration-150 fade-in">
                  <MonacoTextEditor
                    value={prettyText}
                    language={formatLanguage(format)}
                    theme={resolvedTheme}
                    wordWrap={wrap}
                  />
                </div>
              </React.Suspense>
            </div>
          )}
          {!monacoVisible && (
            <pre
              className={`h-full overflow-auto p-3 font-mono text-[14px] leading-[19px] ${
                wrap ? 'whitespace-pre-wrap' : 'overflow-x-auto whitespace-pre'
              }`}
              data-testid="response-body-pre"
            >
              {displayText}
            </pre>
          )}
        </CopySurface>
      )}
    </div>
  )
}
