/**
 * 错误呈现中心。
 *
 * 统一入口 `reportError`：任何 IPC 异常经此路由——
 * - 阻断性错误（isBlockingCode）→ 对话框宿主 ErrorDialogHost（F8）；
 * - 瞬态错误 → Toast（F7）。
 * AppError 按稳定 code 映射 `errors.<code>` 字典键显示本地化文案（details 作插值参数），
 * 无映射兜底显示原英文 message；devMode 开启时在呈现中附带稳定 code。
 */

import { isBlockingCode, isDevMode, toIpcError, type IpcError } from './ipc'
import { translateError, type TranslateParams } from '@/i18n/core'
import type { ResolvedLocale } from '@/lib/settings-schema'
import { toast } from '@workspace/ui/components'

// —— 阻断错误对话框的模块级 store（ErrorDialogHost 经 useSyncExternalStore 订阅）——

export interface BlockingErrorState {
  error: IpcError
}

let blockingError: BlockingErrorState | null = null
const listeners = new Set<() => void>()

export const blockingErrorStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  getSnapshot(): BlockingErrorState | null {
    return blockingError
  },
  /** 供测试与宿主关闭使用 */
  dismiss(): void {
    if (blockingError === null) return
    blockingError = null
    for (const listener of listeners) listener()
  },
}

function openBlockingError(error: IpcError): void {
  blockingError = { error }
  for (const listener of listeners) listener()
}

// —— 生效语言源注入：settings store 反向 import 本模块会成环（store 依赖 reportError），
// 与 ipc.ts 的 setDevMode 同款注入模式。注册前默认 zh-CN（基准语言）。
// 同理翻译函数直取 `@/i18n/core` 纯翻译层——`@/i18n` barrel 的 useI18n 引
// settings.store，与本模块互为环。 ——

let localeSource: () => ResolvedLocale = () => 'zh-CN'

/** settings store 就绪后注册（settings.store.ts 模块装配时调用一次） */
export function setErrorLocaleSource(getter: () => ResolvedLocale): void {
  localeSource = getter
}

/** details 结构化值 → 插值参数：普通对象直接展开，其余形态无可插值字段 */
function paramsFromDetails(details: unknown): TranslateParams {
  if (typeof details === 'object' && details !== null && !Array.isArray(details)) {
    return details as TranslateParams
  }
  return {}
}

/**
 * AppError 本地化：按 `errors.<code>` 映射字典文案（details 插值），
 * 无映射兜底原英文 message；JS 侧未知异常（fromAppError=false）message 原样直出。
 */
export function localizeIpcError(error: IpcError): string {
  if (!error.fromAppError) return error.message
  return (
    translateError(localeSource(), error.code, paramsFromDetails(error.details)) ?? error.message
  )
}

/** 统一错误上报入口：未知异常也先归一为 IpcError 再路由 */
export function reportError(raw: unknown): void {
  const error = toIpcError(raw)
  if (isBlockingCode(error.code)) {
    openBlockingError(error)
  } else {
    toast.error(localizeIpcError(error), { description: describe(error) })
  }
}

/** devMode 下附加稳定 code；未开启则无次级描述 */
function describe(error: IpcError): string | undefined {
  return isDevMode() ? error.code : undefined
}
