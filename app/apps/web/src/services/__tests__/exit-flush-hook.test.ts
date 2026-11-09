import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSettingsStore } from '@/stores/settings.store'
import { useCloseConfirmStore } from '@/stores/close-confirm.store'

import { registerExitFlusher, useExitFlush } from '../exit-flush'

// CloseRequested 派发替身：捕获 handler 供测试按目标行为表触发
const winMocks = vi.hoisted(() => ({
  closeHandlers: [] as Array<(event: { preventDefault: () => void }) => void>,
  onCloseRequested: vi.fn((handler: (event: { preventDefault: () => void }) => void) => {
    winMocks.closeHandlers.push(handler)
    return Promise.resolve(() => {})
  }),
}))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onCloseRequested: winMocks.onCloseRequested }),
}))

// app://close-requested 事件订阅替身：同样捕获 handler
const eventMocks = vi.hoisted(() => ({
  closeRequestedHandlers: [] as Array<() => void>,
  listen: vi.fn((event: string, handler: () => void) => {
    if (event === 'app://close-requested') eventMocks.closeRequestedHandlers.push(handler)
    return Promise.resolve(() => {})
  }),
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: eventMocks.listen }))

// app.ready_to_exit ack 替身
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const flushSpy = vi.fn()
let unregister: (() => void) | null = null

/** 挂载 hook 并等订阅 promise 落地 */
async function mountHook() {
  renderHook(() => useExitFlush())
  await act(async () => {})
}

/** 触发一次窗口关闭请求（Tauri CloseRequested 的 JS 派发形态） */
function fireCloseRequested(): { preventDefault: () => void } {
  const event = { preventDefault: vi.fn() }
  for (const handler of winMocks.closeHandlers) handler(event)
  return event
}

beforeEach(() => {
  vi.clearAllMocks()
  winMocks.closeHandlers.length = 0
  eventMocks.closeRequestedHandlers.length = 0
  flushSpy.mockReset()
  useSettingsStore.getState().hydrateFromBoot(null, null)
  useCloseConfirmStore.getState().clear()
  unregister = registerExitFlusher('hook-test', flushSpy)
})

afterEach(() => {
  unregister?.()
})

describe('useExitFlush 双监听（目标行为表）', () => {
  it('exit 分支：preventDefault + 全量 flush + app.ready_to_exit ack（现状不变）', async () => {
    useSettingsStore.setState({ closeBehavior: { action: 'exit' } })
    await mountHook()

    const event = fireCloseRequested()
    await act(async () => {})
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(flushSpy).toHaveBeenCalledOnce()
    expect(invokeMock).toHaveBeenCalledWith('app.ready_to_exit')
  })

  it('ask 分支·询问事件先到：只弹窗（show），随后 CloseRequested 短路——不 flush 不 ack', async () => {
    useSettingsStore.setState({ closeBehavior: { action: 'ask' } })
    await mountHook()

    // Rust ask 分支 emit 的询问事件 → 弹窗 pending
    await act(async () => {
      for (const handler of eventMocks.closeRequestedHandlers) handler()
    })
    expect(useCloseConfirmStore.getState().pending).toBe(true)

    // 同一次关闭请求的 JS CloseRequested 派发：preventDefault 后短路
    const event = fireCloseRequested()
    await act(async () => {})
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(flushSpy).not.toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalledWith('app.ready_to_exit')
  })

  it('ask 分支·弹窗 pending 期间再次关闭请求：短路返回（不 flush 不 ack，不重复弹窗动作）', async () => {
    useSettingsStore.setState({ closeBehavior: { action: 'ask' } })
    await mountHook()

    await act(async () => {
      for (const handler of eventMocks.closeRequestedHandlers) handler()
    })
    // 弹窗在场期间用户再点关闭
    const event = fireCloseRequested()
    await act(async () => {})
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(flushSpy).not.toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalledWith('app.ready_to_exit')
    expect(useCloseConfirmStore.getState().pending).toBe(true)
  })

  it('ask 分支·弹窗关闭后恢复正常处理路径：preventDefault，闸门未 arm 故仍不 flush 不 ack', async () => {
    useSettingsStore.setState({ closeBehavior: { action: 'ask' } })
    await mountHook()

    await act(async () => {
      for (const handler of eventMocks.closeRequestedHandlers) handler()
    })
    useCloseConfirmStore.getState().clear()

    const event = fireCloseRequested()
    await act(async () => {})
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(flushSpy).not.toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalledWith('app.ready_to_exit')
  })

  it('tray 分支：窗口已由 Rust 隐藏；若 JS 仍收到派发则仅 preventDefault（不 flush 不 ack）', async () => {
    useSettingsStore.setState({ closeBehavior: { action: 'tray' } })
    await mountHook()

    const event = fireCloseRequested()
    await act(async () => {})
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(flushSpy).not.toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalledWith('app.ready_to_exit')
  })

  it('卸载注销双监听（资源四问：释放路径）', async () => {
    useSettingsStore.setState({ closeBehavior: { action: 'exit' } })
    const { unmount } = renderHook(() => useExitFlush())
    await act(async () => {})

    // 订阅 promise 落地前卸载：disposed 守卫直接注销 promise 结果
    unmount()
    await act(async () => {})
    expect(eventMocks.listen).toHaveBeenCalledWith('app://close-requested', expect.any(Function))
  })
})
