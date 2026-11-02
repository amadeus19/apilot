import { toIpcError } from '@/services/ipc'
import { resolveBaseUrlOverride } from '@/stores/variable.store'

import { httpSend, type SendArgs } from './http-api'
import { useResponseStore } from './response.store'

/**
 * 发送草稿桥（imperative 句柄模式，沿 panel-bridge 先例）：编辑器挂载时
 * 登记当前草稿 getter（读最新防抖前值），卸载注销；响应面板的「流式」
 * 重放与空态「发送请求」经此取当前草稿组装 SendArgs。
 *
 * 为什么不经 IPC 读库：草稿真相在编辑器本地（编辑期间不回读、防抖约
 * 500ms 落库），库值可能滞后于当前编辑；为什么不上抛 store：草稿是编辑
 * 器私有状态，发送链只借读一次。句柄表以打开 Tab 为界（有界，卸载即摘）。
 */

/** 草稿五列 getter（编辑器登记；返回 null＝草稿尚未就绪） */
export type SendDraftGetter = () => Pick<
  SendArgs,
  'body' | 'params' | 'headers' | 'timeoutSeconds' | 'auth' | 'pathOverride' | 'methodOverride'
> | null

const getters = new Map<string, SendDraftGetter>()

/** 登记草稿 getter；返回注销函数（编辑器卸载时调用） */
export function registerSendDraft(tabId: string, getter: SendDraftGetter): () => void {
  getters.set(tabId, getter)
  return () => {
    if (getters.get(tabId) === getter) getters.delete(tabId)
  }
}

/**
 * 该 Tab 当前的 BaseUrl 覆写生效值（发送时一次性取值，不订阅——发送消费
 * 的是点击瞬间的会话态；null＝跟随工作空间生效值）。解析单点在
 * variable.store 的 resolveBaseUrlOverride（Tab 覆写 > 会话档）。
 */
export function currentBaseUrlOverride(tabId: string): string | null {
  return resolveBaseUrlOverride(tabId)
}

/** 组装该 Tab 的完整发送参数（编辑器未挂载或草稿未就绪＝null，调用方放弃发送） */
export function buildSendArgs(identity: {
  tabId: string
  serviceId: string
  key: string
}): SendArgs | null {
  const getter = getters.get(identity.tabId)
  if (!getter) return null
  const draft = getter()
  if (!draft) return null
  return {
    serviceId: identity.serviceId,
    key: identity.key,
    tabId: identity.tabId,
    baseUrlOverride: currentBaseUrlOverride(identity.tabId),
    ...draft,
  }
}

/**
 * 普通发送的统一编排（编辑器发送按钮与响应区空态 CTA 共用）：发送三态
 * （beginSend / finishSend / failSend）与历史失效都归 response.store，调用
 * 方只负责组装参数（经 buildSendArgs 取当前草稿）。
 *
 * SSE 升级预登记在 invoke 发起前完成：后端命中事件流响应（响应头
 * text/event-stream 到达）即经 `sse-upgrade://<tabId>` 告知，前端发送中
 * 立起流式视图（sse-panel 实时渲染），不等流结束。
 */
export async function runSend(args: SendArgs): Promise<void> {
  const store = useResponseStore.getState()
  store.beginSend(args.tabId)
  await store.armSseUpgrade(args.tabId)
  try {
    const result = await httpSend(args)
    useResponseStore.getState().finishSend(args.tabId, result)
  } catch (raw) {
    const err = toIpcError(raw)
    useResponseStore.getState().failSend(args.tabId, { code: err.code, message: err.message })
  }
}
