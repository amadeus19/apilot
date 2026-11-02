import { renderHook, waitFor } from '@testing-library/react'
import { focusManager } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// —— 窗口 API 替换：捕获 onFocusChanged 注册的处理器，unlisten 走桩 ——
const bridge = vi.hoisted(() => ({
  unlisten: vi.fn(),
  handler: null as ((event: { payload: boolean }) => void) | null,
}))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onFocusChanged: vi.fn(async (handler: (event: { payload: boolean }) => void) => {
      bridge.handler = handler
      return bridge.unlisten
    }),
  }),
}))

import { useWindowFocusBridge } from '../focus-bridge'

beforeEach(() => {
  bridge.unlisten.mockClear()
  bridge.handler = null
})

describe('窗口焦点 → focusManager 桥接', () => {
  it('焦点事件转发 focusManager.setFocused（true / false 均透传）', async () => {
    const spy = vi.spyOn(focusManager, 'setFocused')
    const { unmount } = renderHook(() => useWindowFocusBridge())
    await waitFor(() => {
      expect(bridge.handler).not.toBeNull()
    })

    bridge.handler!({ payload: true })
    expect(spy).toHaveBeenLastCalledWith(true)
    bridge.handler!({ payload: false })
    expect(spy).toHaveBeenLastCalledWith(false)

    unmount()
    expect(bridge.unlisten).toHaveBeenCalledTimes(1) /* 卸载注销（资源所有权四问） */
    spy.mockRestore()
  })

  it('挂载期间未卸载不注销；卸载时注销恰好一次', async () => {
    const { unmount } = renderHook(() => useWindowFocusBridge())
    await waitFor(() => {
      expect(bridge.handler).not.toBeNull()
    })
    expect(bridge.unlisten).not.toHaveBeenCalled()
    unmount()
    expect(bridge.unlisten).toHaveBeenCalledTimes(1)
  })

  it('注册完成前卸载（竞速）：完成侧立即注销', async () => {
    const { unmount } = renderHook(() => useWindowFocusBridge())
    // 未等注册 Promise 落定即卸载：disposed 标志使 then 分支直接注销
    unmount()
    await waitFor(() => {
      expect(bridge.unlisten).toHaveBeenCalledTimes(1)
    })
  })
})
