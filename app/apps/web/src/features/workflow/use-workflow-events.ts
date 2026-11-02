import * as React from 'react'

import { listen } from '@tauri-apps/api/event'

import { useWorkflowExecutionStore } from './execution.store'
import type { WorkflowExecutionEvent } from './workflow-api'

/**
 * `workflow:event` 事件流订阅（AppShell 挂载单点，随应用生命周期常驻）：
 * 事件原样转发执行态 store 归约。订阅常驻而非随编辑 Tab 建拆——执行不随
 * Tab 切走而中断，切回 Tab 时面板状态无缝续推；Tab 关闭路径走执行槽位
 * dispose（取消在途＋清状态），不依赖本 hook 摘除。
 */
export function useWorkflowEvents(): void {
  React.useEffect(() => {
    let unlisten: (() => void) | undefined
    let disposed = false
    // 非 Tauri 环境（组件测试）无事件通道：建立失败静默，不影响挂载
    try {
      void listen<WorkflowExecutionEvent>('workflow:event', (event) => {
        if (!disposed) useWorkflowExecutionStore.getState().applyEvent(event.payload)
      })
        .then((fn) => {
          if (disposed) {
            fn()
          } else {
            unlisten = fn
          }
        })
        .catch(() => {})
    } catch {
      // 非 Tauri 环境同步抛错：静默
    }
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])
}
