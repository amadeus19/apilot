import * as React from 'react'

import { getCurrentWindow } from '@tauri-apps/api/window'

import { invoke } from './ipc'

/**
 * 退出收尾注册表：CloseRequested 后、放行退出前依次执行的 flush 动作。
 *
 * 资源四问闭环：拥有者＝App 根（监听器挂载单点）；创建＝注册（挂载）；
 * 释放＝注销（卸载）；泄漏防护＝注册键幂等覆盖 + flush 逐项容错
 * （单项失败不阻断其余收尾，错误统一上报，退出照常放行）。
 * 消费方：Tab 会话保存（workbench 会话钩子）、草稿 flush（接口编辑器）。
 */

export type ExitFlusher = () => Promise<void> | void

const flushers = new Map<string, ExitFlusher>()

/** 注册 / 覆盖收尾动作，返回注销函数（useEffect 清理通道） */
export function registerExitFlusher(id: string, flusher: ExitFlusher): () => void {
  flushers.set(id, flusher)
  return () => {
    const current = flushers.get(id)
    // 幂等注销：只摘自己的注册项（防误摘后挂的同名项）
    if (current === flusher) flushers.delete(id)
  }
}

/** 依次执行全部收尾动作（注册顺序；逐项容错） */
export async function flushAllForExit(): Promise<void> {
  for (const [id, flusher] of flushers) {
    try {
      await flusher()
    } catch (error) {
      console.error(`[exit-flush] flusher "${id}" failed`, error)
    }
  }
}

/**
 * 退出收尾监听（App 根挂载单点）：CloseRequested → 拦截默认关闭 →
 * 全量 flush → `app.ready_to_exit` 放行（Rust 侧闸门，超时兜底）。
 */
export function useExitFlush(): void {
  React.useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null
    void getCurrentWindow()
      .onCloseRequested((event) => {
        // 拦截默认关闭：Rust 侧同样接管（闸门等待本收尾完成或超时）
        event.preventDefault()
        void (async () => {
          await flushAllForExit()
          await invoke('app.ready_to_exit')
        })()
      })
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])
}
