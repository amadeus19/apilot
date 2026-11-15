import * as React from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { AlignLeftIcon, AppWindowIcon, PinIcon, PinOffIcon, XIcon } from 'lucide-react'

import { MonacoLoading } from '@/features/http/monaco-loading'
import { useI18n } from '@/i18n'
import { reportError } from '@/services/error-center'
import { selectResolvedTheme, useSettingsStore } from '@/stores/settings.store'
import { getResponseSnapshot, type ResponseSnapshotPayload } from './snapshot-api'

// 与响应区 Pretty 同源装配：懒加载共享底座（行号＋层级折叠＋划选复制，
// 受控可编辑——粘贴外部内容改稿；chunk 与主窗共用，不新增首屏负担）
const MonacoTextEditor = React.lazy(() =>
  import('@/features/http/monaco-text-editor').then((m) => ({
    default: m.MonacoTextEditor,
  })),
)

/**
 * 响应快照小窗根组件（独立 Tauri 窗口，与主窗共用入口、boot 分流挂载）。
 *
 * 职责：mount 拉取定格载荷并渲染（Monaco 编辑器：json 着色 / text 纯文
 * 本，行号＋层级折叠＋划选复制，可编辑以粘贴外部内容改稿——编辑只动本
 * 地展示态，不回写 Rust 暂存）；首帧显示由本组件收口（拉取完成才 show，
 * 窗口隐藏创建的防闪协议闭合点）；置顶开关（窗口 API 即时生效＋记忆
 * 落库）；移动 / 缩放后防抖把位置尺寸与置顶整体写回 settings（与建窗侧
 * 同口径的逻辑像素）。
 *
 * 资源所有权：onMoved / onResized / onFocusChanged 监听与防抖定时器均随
 * 组件卸载释放（unlisten + clearTimeout），不留跨窗口生命周期的悬挂回调。
 */

/** 移动 / 缩放后的记忆写回防抖窗口 */
const SNAPSHOT_PERSIST_DEBOUNCE_MS = 500
/** 格式化失败的短提示时长（自动消退，不打断编辑流） */
const SNAPSHOT_FORMAT_INVALID_MS = 2000

/** 当前窗口几何（innerPosition / innerSize 为物理像素，÷ scaleFactor 换算
 * 逻辑像素——与建窗侧记忆消费同口径；scale 异常为 0 时按原值兜底） */
async function readSnapshotRect(): Promise<{
  x: number
  y: number
  width: number
  height: number
}> {
  const win = getCurrentWindow()
  const [position, size, scale] = await Promise.all([
    win.innerPosition(),
    win.innerSize(),
    win.scaleFactor(),
  ])
  const toLogical = (value: number): number => Math.round(scale > 0 ? value / scale : value)
  return {
    x: toLogical(position.x),
    y: toLogical(position.y),
    width: toLogical(size.width),
    height: toLogical(size.height),
  }
}

/** 无记忆时的置顶回退：与建窗侧默认一致（默认置顶是产品决策），
 * 防止显示态与写回口径各自漂移 */
const DEFAULT_ALWAYS_ON_TOP = true

/** 把实测几何与当前置顶偏好整体写入记忆键（fire-and-forget 落库协议） */
async function persistSnapshotRect(): Promise<void> {
  try {
    const rect = await readSnapshotRect()
    const alwaysOnTop =
      useSettingsStore.getState().responseSnapshotWindow?.alwaysOnTop ?? DEFAULT_ALWAYS_ON_TOP
    useSettingsStore.getState().setResponseSnapshotWindow({ ...rect, alwaysOnTop })
  } catch (err) {
    reportError(err)
  }
}

export function SnapshotWindowApp() {
  const { t } = useI18n()
  // 置顶显示态来自记忆键（建窗侧已按记忆值建窗、无记忆时默认置顶，
  // 此处只呈现，不重复下发；回退与建窗口径同源）
  const alwaysOnTop = useSettingsStore(
    (s) => s.responseSnapshotWindow?.alwaysOnTop ?? DEFAULT_ALWAYS_ON_TOP,
  )
  const [payload, setPayload] = React.useState<ResponseSnapshotPayload | null>(null)
  const [content, setContent] = React.useState('')
  // 格式化失败的短提示态（2s 自动消退，timer 归卸载清理）
  const [formatInvalid, setFormatInvalid] = React.useState(false)
  const formatInvalidTimer = React.useRef(0)
  const resolvedTheme = useSettingsStore(selectResolvedTheme)

  // 定格载荷拉取：mount 一次＋窗口聚焦重拉（复用语义的闭合点——主窗重复
  // 点「悬浮」时 Rust 侧只替换暂存并聚焦本窗，本窗凭聚焦感知注入新快照，
  // 单例替换窗口内容）。重拉按「暂存与最近注入不同」判变更：暂存未变
  // （如用户在主窗与快照窗间来回切换）不动展示态——本地编辑稿（粘贴 /
  // 格式化结果）不因聚焦被覆写丢失。失败与 null 同为空态（小窗不放大
  // 错误呈现，主窗侧有统一上报链路）。首拉落定（含失败与空载荷）后才
  // show——窗口隐藏创建（防闪协议），首帧即完整渲染，加载期闪烁不可见
  const lastInjected = React.useRef<ResponseSnapshotPayload | null>(null)
  const applyPayload = React.useCallback((data: ResponseSnapshotPayload | null): void => {
    lastInjected.current = data
    setPayload(data)
    setContent(data?.content ?? '')
  }, [])
  /** 拉取暂存：失败返回 undefined（与合法的 null 暂存区分——聚焦重拉
   * 失败时不动展示态，mount 首拉失败按空态呈现） */
  const fetchPayload = React.useCallback(async (): Promise<
    ResponseSnapshotPayload | null | undefined
  > => {
    try {
      return await getResponseSnapshot()
    } catch {
      return undefined
    }
  }, [])
  React.useEffect(() => {
    let cancelled = false
    void fetchPayload().then((data) => {
      if (cancelled) return
      applyPayload(data ?? null)
      void getCurrentWindow().show()
    })
    return () => {
      cancelled = true
    }
  }, [fetchPayload, applyPayload])
  React.useEffect(() => {
    let disposed = false
    let unlistenFocus: (() => void) | null = null
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        // 复用注入：主窗重新触发后聚焦本窗——暂存较最近注入有变更
        // （title 或 content 任一不同）时替换展示内容；拉取失败或未
        // 变更不动（保本地编辑稿：粘贴 / 格式化结果不因聚焦被覆写）
        if (!focused || disposed) return
        void fetchPayload().then((data) => {
          const prev = lastInjected.current
          if (
            disposed ||
            data === undefined ||
            (data?.title === prev?.title && data?.content === prev?.content)
          )
            return
          applyPayload(data)
        })
      })
      .then((unlisten) => {
        if (disposed) unlisten()
        else unlistenFocus = unlisten
      })
    return () => {
      disposed = true
      unlistenFocus?.()
    }
  }, [fetchPayload, applyPayload])

  // 位置尺寸记忆：onMoved / onResized 各自注册（unlisten 归本 effect 清理），
  // 事件只负责触发防抖；写回时现取窗口几何（moved / resized 事件载荷各缺
  // 一半，实测一次拿全量更简单也始终新鲜）。回调读置顶偏好经 getState
  // 取最新值（闭包值不参与渲染输出）
  React.useEffect(() => {
    const win = getCurrentWindow()
    let timer = 0
    let disposed = false
    let unlistenMoved: (() => void) | null = null
    let unlistenResized: (() => void) | null = null
    const schedulePersist = (): void => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = 0
        void persistSnapshotRect()
      }, SNAPSHOT_PERSIST_DEBOUNCE_MS)
    }
    void win.onMoved(schedulePersist).then((unlisten) => {
      if (disposed) unlisten()
      else unlistenMoved = unlisten
    })
    void win.onResized(schedulePersist).then((unlisten) => {
      if (disposed) unlisten()
      else unlistenResized = unlisten
    })
    return () => {
      disposed = true
      window.clearTimeout(timer)
      unlistenMoved?.()
      unlistenResized?.()
    }
  }, [])

  // 格式化失败提示的短计时器：卸载时清理（不留悬挂 setState 源）
  React.useEffect(() => {
    return () => window.clearTimeout(formatInvalidTimer.current)
  }, [])
  const clearFormatInvalid = (): void => {
    window.clearTimeout(formatInvalidTimer.current)
    formatInvalidTimer.current = 0
    setFormatInvalid(false)
  }

  /** 置顶切换：窗口 API 先生效，再把实测几何与新的置顶值整体写入记忆；
   * 失败不上报后置状态（设置写失败不回滚 UI 的既有协议），仅经统一上报 */
  const handleTogglePin = async () => {
    const next = !alwaysOnTop
    try {
      await getCurrentWindow().setAlwaysOnTop(next)
      const rect = await readSnapshotRect()
      useSettingsStore.getState().setResponseSnapshotWindow({ ...rect, alwaysOnTop: next })
    } catch (err) {
      reportError(err)
    }
  }

  /** 格式化当前内容（json 档按钮）：缩进重排展示文本，仅本地展示态，
   * 不回写 Rust 暂存（快照定格语义保持）；非法 JSON 短提示后自动消退 */
  const handleFormat = () => {
    try {
      setContent(JSON.stringify(JSON.parse(content), null, 2))
      clearFormatInvalid()
    } catch {
      window.clearTimeout(formatInvalidTimer.current)
      setFormatInvalid(true)
      formatInvalidTimer.current = window.setTimeout(() => {
        formatInvalidTimer.current = 0
        setFormatInvalid(false)
      }, SNAPSHOT_FORMAT_INVALID_MS)
    }
  }

  // 宽松判空：payload 通道的 null（拉取失败 / 未注入）与空内容同为空态
  const hasContent = payload != null && content !== ''

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground select-none"
      data-testid="snapshot-window"
    >
      {/* 自绘标题栏（与主窗同款观感：deep 全子树拖拽、可交互元素自动豁免，
          窗口控制键 Windows 惯例全高扁平）。左＝窗口图标＋定格内容标题，
          右＝格式化（json 档）＋置顶开关＋关闭。置顶图标双态：钉住＝当前
          置顶、斜钉＝已取消 */}
      <header
        data-tauri-drag-region="deep"
        className="flex h-8 shrink-0 items-stretch border-b border-border bg-card"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 pl-2">
          <AppWindowIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          {payload?.title ? (
            <span
              className="min-w-0 truncate text-xs font-medium text-foreground"
              title={payload.title}
              data-testid="snapshot-title"
            >
              {payload.title}
            </span>
          ) : null}
          {formatInvalid ? (
            <span
              className="ml-1 shrink-0 text-xs text-destructive"
              data-testid="snapshot-format-invalid"
            >
              {t('response.snapshotFormatInvalid')}
            </span>
          ) : null}
        </div>
        <div className="flex items-stretch" data-tauri-drag-region="false">
          {payload?.contentType === 'json' ? (
            <button
              type="button"
              aria-label={t('response.snapshotFormat')}
              title={t('response.snapshotFormat')}
              onClick={handleFormat}
              data-testid="snapshot-format"
              className="grid h-full w-9 place-items-center text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
            >
              <AlignLeftIcon aria-hidden className="size-3.5" />
            </button>
          ) : null}
          <button
            type="button"
            aria-label={t('response.snapshotAlwaysOnTop')}
            aria-pressed={alwaysOnTop}
            onClick={() => void handleTogglePin()}
            data-testid="snapshot-always-on-top"
            className="grid h-full w-9 place-items-center text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
          >
            {alwaysOnTop ? (
              <PinIcon aria-hidden className="size-3.5" />
            ) : (
              <PinOffIcon aria-hidden className="size-3.5" />
            )}
          </button>
          <button
            type="button"
            aria-label={t('shell.close')}
            onClick={() => void getCurrentWindow().close()}
            data-testid="snapshot-close"
            className="grid h-full w-9 place-items-center text-muted-foreground transition-colors outline-none hover:bg-destructive hover:text-destructive-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
          >
            <XIcon aria-hidden className="size-3.5" />
          </button>
        </div>
      </header>
      {hasContent && payload ? (
        // 与响应区 Pretty 同款装配：Monaco 只读底座打开受控编辑（行号＋
        // 层级折叠＋划选复制内建）——可编辑以粘贴外部内容格式化，复用
        // 同一悬浮窗；编辑只动本地展示态，不回写 Rust 暂存
        <div
          className="relative min-h-0 flex-1"
          data-testid={payload.contentType === 'json' ? 'snapshot-json' : 'snapshot-text'}
        >
          <React.Suspense fallback={<MonacoLoading />}>
            <MonacoTextEditor
              value={content}
              language={payload.contentType === 'json' ? 'json' : 'plaintext'}
              theme={resolvedTheme}
              wordWrap
              onChange={setContent}
            />
          </React.Suspense>
        </div>
      ) : (
        <p
          className="grid flex-1 place-items-center p-6 text-center text-xs text-muted-foreground"
          data-testid="snapshot-empty"
        >
          {t('response.snapshotEmpty')}
        </p>
      )}
    </div>
  )
}
