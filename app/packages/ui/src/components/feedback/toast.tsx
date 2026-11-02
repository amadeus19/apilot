"use client"

import * as React from "react"
import { CircleCheckIcon, CircleAlertIcon, InfoIcon, XIcon } from "lucide-react"
import { cn } from "cn"
import { useUiText } from "../ui-text"

/**
 * 通用 Toast（F7 瞬态通知）。
 *
 * 设计约束（AGENTS 资源所有权纪律）：
 * - 缓冲有界：最多同时 MAX_TOASTS 条，超出丢最旧；单条有 TTL 自动过期；
 * - 生命周期自持：定时器随条目创建/销毁，组件卸载不影响 store 内条目过期；
 * - 视觉仅用全局令牌（bg-popover / border / text-*），明暗两套自动生效。
 */

export type ToastKind = "error" | "success" | "info"

/** 短窗口动作（撤销类）：呈现在条目行尾，点击即执行并收起本条 */
export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastOptions {
  kind?: ToastKind
  /** 主文案（本地化后的消息） */
  message: string
  /** 次级说明（如 devMode 下的错误码、details 插值） */
  description?: string
  /** 展示时长 ms；默认 DEFAULT_DURATION_MS */
  duration?: number
  /** 短窗口动作（撤销等）；缺省无 */
  action?: ToastAction
}

interface ToastItem extends Required<Pick<ToastOptions, "kind" | "message">> {
  id: number
  description?: string
  duration: number
  action?: ToastAction
}

/** 同屏上限：超出丢最旧（一切缓冲有界） */
const MAX_TOASTS = 5
const DEFAULT_DURATION_MS = 5000

let toasts: ToastItem[] = []
let nextId = 1
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function push(options: ToastOptions): number {
  const item: ToastItem = {
    id: nextId++,
    kind: options.kind ?? "info",
    message: options.message,
    description: options.description,
    duration: options.duration ?? DEFAULT_DURATION_MS,
    action: options.action,
  }
  toasts = [...toasts, item].slice(-MAX_TOASTS)
  emit()
  return item.id
}

function dismiss(id: number) {
  const before = toasts.length
  toasts = toasts.filter((t) => t.id !== id)
  if (toasts.length !== before) emit()
}

/** 命令式入口：非组件代码（ipc 错误上报等）直接调用 */
export const toast = {
  show: push,
  error: (message: string, options?: Omit<ToastOptions, "kind" | "message">) =>
    push({ ...options, kind: "error", message }),
  success: (message: string, options?: Omit<ToastOptions, "kind" | "message">) =>
    push({ ...options, kind: "success", message }),
  info: (message: string, options?: Omit<ToastOptions, "kind" | "message">) =>
    push({ ...options, kind: "info", message }),
  dismiss,
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// getSnapshot 必须返回稳定引用：数组只在增删时整体替换
function getSnapshot(): ToastItem[] {
  return toasts
}

/** store 视图：供自定义宿主订阅或测试断言（Toaster 内部同样走此订阅） */
export const toastStore = { subscribe, getSnapshot }

/** 单条目的 TTL 定时器：挂载即计时，卸载即清理；鼠标悬浮暂停，
 * 移出后重新计满时长——「正在阅读时不消失」 */
function ToastEntry({ item }: { item: ToastItem }) {
  const uiText = useUiText()
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const armTimer = React.useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(dismiss, item.duration, item.id)
  }, [item.id, item.duration])

  React.useEffect(() => {
    armTimer()
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [armTimer])

  return (
    <div
      data-slot="toast"
      data-kind={item.kind}
      role={item.kind === "error" ? "alert" : "status"}
      onMouseEnter={() => timerRef.current && clearTimeout(timerRef.current)}
      onMouseLeave={armTimer}
      className={cn(
        "pointer-events-auto flex w-80 items-start gap-2 rounded-lg border bg-popover p-3 text-popover-foreground shadow-md",
        "animate-in duration-150 fade-in slide-in-from-bottom-2",
      )}
    >
      <KindIcon kind={item.kind} />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-5">{item.message}</p>
        {item.description && (
          <p className="mt-0.5 text-xs break-words text-muted-foreground">{item.description}</p>
        )}
      </div>
      {item.action && (
        <button
          type="button"
          onClick={() => {
            item.action?.onClick()
            dismiss(item.id)
          }}
          className="mt-0.5 shrink-0 self-start rounded-sm px-1 py-0.5 text-xs font-medium text-primary outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {item.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={() => dismiss(item.id)}
        aria-label={uiText.closeLabel}
        className="rounded-sm p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  )
}

function KindIcon({ kind }: { kind: ToastKind }) {
  const className = "mt-0.5 size-4 shrink-0"
  switch (kind) {
    case "error":
      return <CircleAlertIcon className={cn(className, "text-destructive")} />
    case "success":
      return <CircleCheckIcon className={cn(className, "text-success")} />
    case "info":
      return <InfoIcon className={cn(className, "text-muted-foreground")} />
  }
}

/** Toast 渲染宿主：应用根挂载一次即可（固定右下角，非模态不抢焦点） */
export function Toaster() {
  const items = React.useSyncExternalStore(subscribe, getSnapshot)
  if (items.length === 0) return null
  return (
    <div
      // 高于 Dialog 的 z-50，保证模态之上仍可呈现
      className="pointer-events-none fixed right-3 bottom-3 z-100 flex flex-col items-end gap-2 outline-none"
    >
      {items.map((item) => (
        <ToastEntry key={item.id} item={item} />
      ))}
    </div>
  )
}
