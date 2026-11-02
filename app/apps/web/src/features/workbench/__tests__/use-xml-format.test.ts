import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useXmlFormat } from '../use-xml-format'

/** 伪 Worker：echo 协议（回投 `fmt:` 前缀标记，区分 worker 通路与主线程回落） */
class FakeWorker {
  static instances: FakeWorker[] = []
  terminated = false
  onmessage: ((event: { data: { id: number; text: string } }) => void) | null = null
  constructor() {
    FakeWorker.instances.push(this)
  }
  postMessage(message: { id: number; text: string }) {
    queueMicrotask(() => {
      this.onmessage?.({ data: { id: message.id, text: `fmt:${message.text}` } })
    })
  }
  terminate() {
    this.terminated = true
  }
}

beforeEach(() => {
  FakeWorker.instances = []
  vi.stubGlobal('Worker', FakeWorker)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useXmlFormat 生命周期', () => {
  it('惰性创建：挂载不建线程，首次调用才起；结果经回投分派兑现', async () => {
    const { result } = renderHook(() => useXmlFormat())
    expect(FakeWorker.instances).toHaveLength(0)
    let output = ''
    await act(async () => {
      output = await result.current('<a/>')
    })
    expect(FakeWorker.instances).toHaveLength(1)
    expect(output).toBe('fmt:<a/>')
  })

  it('共享与引用计数：多消费者同一线程，全数卸载才 terminate', async () => {
    const first = renderHook(() => useXmlFormat())
    const second = renderHook(() => useXmlFormat())
    await act(async () => {
      await first.result.current('<a/>')
    })
    expect(FakeWorker.instances).toHaveLength(1)
    first.unmount()
    expect(FakeWorker.instances[0]?.terminated).toBe(false)
    second.unmount()
    expect(FakeWorker.instances[0]?.terminated).toBe(true)
  })

  it('受限环境回落：Worker 构造面不可用时主线程同步计算（产物同口径）', async () => {
    vi.unstubAllGlobals()
    const { result } = renderHook(() => useXmlFormat())
    let output = ''
    await act(async () => {
      output = await result.current('<root><a>1</a></root>')
    })
    expect(output).toBe('<root>\n  <a>1</a>\n</root>')
  })
})
