import * as React from 'react'

import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'

import { invoke } from './ipc'
import { useCloseConfirmStore } from '@/stores/close-confirm.store'
import { useSettingsStore } from '@/stores/settings.store'

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
 * 退出收尾监听（App 根挂载单点），双监听并存（Tauri 的 CloseRequested 会同时
 * 派发给 Rust handler 与 JS 监听者，Rust 分支决定各自该做什么）：
 *
 * - `onCloseRequested`：一律拦截默认关闭（决策权在 Rust）。仅 exit 分支闸门
 *   （Rust 已 arm）需要 flush 后 `app.ready_to_exit` ack；ask / tray 分支闸门
 *   未 arm，ack 无意义——ask 等弹窗决策、tray 窗口已被 Rust 隐藏。ask 弹窗
 *   等待决策期间（close-confirm pending）再次触发则短路返回，不重复收尾。
 * - `app://close-requested`（仅 ask 分支由 Rust 发出，语义＝询问用户）：只弹
 *   确认弹窗，不 flush 不 ack——该分支闸门未 arm，放行走用户决策后的
 *   `app.confirm_exit`（含 flush）。
 */
export function useExitFlush(): void {
  React.useEffect(() => {
    let disposed = false
    const unlisteners: Array<() => void> = []
    void getCurrentWindow()
      .onCloseRequested((event) => {
        // 拦截默认关闭：分支决策与放行全在 Rust 侧
        event.preventDefault()
        // ask 弹窗正在等用户决策：短路（不 flush 不 ack，弹窗动作负责收尾）
        if (useCloseConfirmStore.getState().pending) return
        // 仅 exit 分支闸门在等 ack；ask / tray 分支闸门未 arm，不做收尾放行
        if (useSettingsStore.getState().closeBehavior.action !== 'exit') return
        void (async () => {
          await flushAllForExit()
          await invoke('app.ready_to_exit')
        })()
      })
      .then((fn) => {
        if (disposed) fn()
        else unlisteners.push(fn)
      })
    void listen('app://close-requested', () => {
      // ask 分支询问事件：只弹窗，不 flush 不 ack
      useCloseConfirmStore.getState().show()
    }).then((fn) => {
      if (disposed) fn()
      else unlisteners.push(fn)
    })
    return () => {
      disposed = true
      for (const unlisten of unlisteners) unlisten()
    }
  }, [])
}
