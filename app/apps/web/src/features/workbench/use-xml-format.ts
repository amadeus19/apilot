import * as React from 'react'

import { formatXml } from './xml-format'

/**
 * XML 格式化的共享 Web Worker 入口：请求体编辑与响应体 Pretty 两侧同一
 * 格式化通道，计算全部在专有线程执行，主线程只收发消息。
 *
 * 生命周期纪律：
 * - 惰性创建：hook 挂载不建线程，首次实际调用才起；
 * - 引用计数：多消费组件同屏共享同一实例；消费组件全数卸载即 terminate
 *   （关 Tab / 切走视图不残留线程）；
 * - 回收回落：terminate 时在途请求按「格式化回落原文」兑现（与畸形输入
 *   同口径的取消语义，不是错误），调用方无需 catch。
 *
 * 受限环境回落：Worker 构造面不可用（如 jsdom 测试环境）或构造失败时，
 * 回落主线程同步计算——格式化器是纯函数，回落只失去线程隔离，产物与
 * 行为（畸形原样返回、不 reject）完全一致。
 */

/** 在途请求记录（回收时以原文兑现） */
interface PendingRequest {
  text: string
  resolve: (value: string) => void
}

let consumers = 0
let worker: Worker | null = null
let workerUnavailable = false
let seq = 0
const pending = new Map<number, PendingRequest>()

/** 惰性创建共享线程并登记回投分派（首用才起，创建后跨消费者复用） */
function ensureWorker(): Worker | null {
  if (worker !== null) return worker
  if (workerUnavailable || typeof Worker === 'undefined') return null
  let instance: Worker
  try {
    instance = new Worker(new URL('./xml-format.worker.ts', import.meta.url), {
      type: 'module',
    })
  } catch {
    workerUnavailable = true
    return null
  }
  instance.onmessage = (event: MessageEvent<{ id: number; text: string }>) => {
    const request = pending.get(event.data.id)
    if (request !== undefined) {
      pending.delete(event.data.id)
      request.resolve(event.data.text)
    }
  }
  worker = instance
  return instance
}

/** 引用归零：终止线程并让在途请求回落原文 */
function releaseWorkerIfUnused(): void {
  if (consumers > 0 || worker === null) return
  worker.terminate()
  worker = null
  for (const request of pending.values()) request.resolve(request.text)
  pending.clear()
}

/** 消费 XML 格式化（经共享线程；畸形输入由格式化器原样返回，不 reject） */
export function useXmlFormat(): (text: string) => Promise<string> {
  React.useEffect(() => {
    consumers++
    return () => {
      consumers--
      releaseWorkerIfUnused()
    }
  }, [])
  return React.useCallback(
    (text: string) =>
      new Promise<string>((resolve) => {
        const instance = ensureWorker()
        if (instance === null) {
          resolve(formatXml(text))
          return
        }
        const id = ++seq
        pending.set(id, { text, resolve })
        instance.postMessage({ id, text })
      }),
    [],
  )
}
