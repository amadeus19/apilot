import * as React from 'react'
import { ArrowDownIcon, CircleStopIcon } from 'lucide-react'

import { Button, CopySurface } from '@workspace/ui/components'

import { formatBytes, useI18n } from '@/i18n'
import { statusCodeClass } from './constants'
import { useResponseStore, type SseStreamState } from './response.store'

/** 距底阈值（px）：滚动位置距底小于该值视为「在底」，新文本跟随贴底 */
const NEAR_BOTTOM_PX = 40

/**
 * SSE 渐进渲染面板：等宽 pre 渲染尾部缓冲文本；头部＝终态标记（done /
 * cancelled 中性、error 错误卡）＋已接收量＋进行中停止按钮（＝http.cancel）。
 * 进行中的状态指示归响应区头行（发送中＋计时），此处不重复。流状态与监听
 * 器归 response.store（资源四问见该文件头注），本组件纯渲染＋停止发起。
 *
 * 滚动跟随＝条件贴底：用户位于底部（距底 < 阈值）时新文本到达跟随贴底；
 * 上翻离开底部即停止跟随（阅读位置不被增量拽走），右下角浮出「回到最新」
 * 按钮（opacity 过渡，prefers-reduced-motion 下直达）。按钮保留到用户
 * 点击回底或自行滚回底部（流终态后同样保留——终点回看仍需一键回尾）。
 */
export function SsePanel({ tabId, stream }: { tabId: string; stream: SseStreamState }) {
  const { t } = useI18n()
  const preRef = React.useRef<HTMLPreElement | null>(null)
  // 是否跟随贴底（滚动事件驱动；渲染输出只消费「按钮可见」这一呈现态）
  const [follow, setFollow] = React.useState(true)

  // 滚动位置判定与贴底同步（与 DOM 同步，全在事件 / effect 中做，不参与
  // 渲染输出）：程序化贴底同样触发 scroll 事件并落回「在底」判定，自洽
  React.useEffect(() => {
    const el = preRef.current
    if (!el) return
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
      setFollow((prev) => (prev === nearBottom ? prev : nearBottom))
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // 增量到达：仅跟随态贴底（上翻阅读位置不动）；跟随态恢复（滚回底）时
  // 立即追平一次
  React.useEffect(() => {
    if (!follow) return
    const el = preRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [stream.text, follow])

  // 「回到最新」：贴底并恢复跟随（scroll 事件在部分环境不随程序化赋值
  // 触发，显式 setState 收敛）
  const backToLatest = () => {
    const el = preRef.current
    if (el) el.scrollTop = el.scrollHeight
    setFollow(true)
  }

  const streaming = stream.phase === 'streaming'

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="sse-panel">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3">
        {stream.meta && (
          <span
            className={`font-mono text-xs font-medium tabular-nums ${statusCodeClass(stream.meta.status)}`}
            data-testid="sse-status"
          >
            {stream.meta.status}
          </span>
        )}
        {stream.phase === 'done' && (
          <span className="text-xs text-muted-foreground">{t('response.streamDone')}</span>
        )}
        {stream.phase === 'cancelled' && (
          <span className="text-xs text-muted-foreground">{t('response.streamCancelled')}</span>
        )}
        <span className="text-micro text-muted-foreground" data-testid="sse-received">
          {t('response.streamReceived', { size: formatBytes(stream.receivedChars) })}
        </span>
        {streaming && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-6 px-2 text-xs"
            onClick={() => useResponseStore.getState().stopStream(tabId)}
          >
            <CircleStopIcon aria-hidden className="size-3.5" />
            {t('response.streamStop')}
          </Button>
        )}
      </div>
      {stream.phase === 'error' && stream.error && (
        <div
          className="m-3 rounded-md border border-destructive/40 bg-destructive/5 p-3"
          role="alert"
          data-testid="sse-error"
        >
          <p className="text-sm font-medium text-destructive">{t('response.streamErrorTitle')}</p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {stream.error.code} · {stream.error.message}
          </p>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <CopySurface getText={() => stream.text} className="h-full">
          <pre
            ref={preRef}
            className="h-full overflow-auto p-3 font-mono text-xs whitespace-pre-wrap"
            data-testid="sse-text"
          >
            {stream.text}
          </pre>
        </CopySurface>
        {/* 回到最新：停止跟随时浮出（常驻挂载走 opacity 过渡；隐藏态摘除
            停靠与语义，键盘不可达）。motion-safe 前缀让 prefers-reduced-motion
            下直达终值 */}
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t('response.streamBackToLatest')}
          data-testid="sse-back-to-latest"
          tabIndex={follow ? -1 : 0}
          aria-hidden={follow}
          onClick={backToLatest}
          className={`absolute right-3 bottom-3 size-6 rounded-full shadow-sm transition-opacity motion-safe:duration-200 ${
            follow ? 'pointer-events-none opacity-0' : 'opacity-100'
          }`}
        >
          <ArrowDownIcon aria-hidden className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}
