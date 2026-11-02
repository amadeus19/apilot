import { formatXml } from './xml-format'

/**
 * XML 格式化专有线程：只承载计算（大文档不卡主线程），无状态、无消息
 * 顺序假设——每条请求独立回投。DOM lib 类型下 self 是 Window，此处收窄
 * 到专有 worker 的全局契约（onmessage / postMessage(string)）。
 */
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; text: string }>) => void) | null
  postMessage: (message: { id: number; text: string }) => void
}

ctx.onmessage = (event) => {
  // 格式化器畸形输入原样返回、不抛错，无需错误通道
  ctx.postMessage({ id: event.data.id, text: formatXml(event.data.text) })
}
