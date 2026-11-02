import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DebouncedWriter } from '../debounced-writer'

/**
 * 防抖写核心：窗口合并、立即 flush、在途排队、卸载与失败语义。
 * 定时器用 fake timers 控制；write 以受控 promise 模拟在途写。
 */

interface Payload {
  value: string
}

function makeWriter(overrides?: {
  write?: (payload: Payload) => Promise<void>
  onError?: (error: unknown) => void
  debounceMs?: number
}) {
  const writes: Payload[] = []
  const write =
    overrides?.write ??
    ((payload: Payload) => {
      writes.push(payload)
      return Promise.resolve()
    })
  const onError = overrides?.onError ?? vi.fn()
  const writer = new DebouncedWriter<Payload>({
    write,
    onError,
    debounceMs: overrides?.debounceMs,
  })
  return { writer, writes, onError }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('防抖窗口合并', () => {
  it('窗口内多次编辑合并为一次落库，落库值为最后一次编辑', () => {
    const { writer, writes } = makeWriter()
    writer.schedule({ value: 'a' })
    writer.schedule({ value: 'b' })
    writer.schedule({ value: 'c' })
    vi.advanceTimersByTime(500)
    expect(writes).toEqual([{ value: 'c' }])
  })

  it('编辑重置窗口：临近到期再次编辑后需等满新窗口', () => {
    const { writer, writes } = makeWriter()
    writer.schedule({ value: 'a' })
    vi.advanceTimersByTime(400)
    writer.schedule({ value: 'b' })
    vi.advanceTimersByTime(400)
    expect(writes).toEqual([])
    vi.advanceTimersByTime(100)
    expect(writes).toEqual([{ value: 'b' }])
  })
})

describe('立即落库', () => {
  it('无未写值时 flushNow 立即兑现且不写', async () => {
    const { writer, writes } = makeWriter()
    await writer.flushNow()
    expect(writes).toEqual([])
  })

  it('flushNow 绕过窗口立即写出并清除定时器', async () => {
    const { writer, writes } = makeWriter()
    writer.schedule({ value: 'a' })
    const flushed = writer.flushNow()
    expect(writes).toEqual([{ value: 'a' }])
    await flushed
    vi.advanceTimersByTime(1000)
    expect(writes).toEqual([{ value: 'a' }])
  })

  it('在途写未完成时 flushNow 排队补写，返回全部完成信号', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { writer, writes } = makeWriter({
      write: (payload) => {
        writes.push(payload)
        return gate
      },
    })
    writer.schedule({ value: 'a' })
    vi.advanceTimersByTime(500)
    expect(writes).toEqual([{ value: 'a' }])
    writer.schedule({ value: 'b' })
    const flushed = writer.flushNow()
    expect(writes).toEqual([{ value: 'a' }])
    release!()
    await flushed
    expect(writes).toEqual([{ value: 'a' }, { value: 'b' }])
  })
})

describe('卸载收尾', () => {
  it('dispose 立即写出剩余值并使后续编辑失效', () => {
    const { writer, writes } = makeWriter()
    writer.schedule({ value: 'a' })
    writer.dispose()
    expect(writes).toEqual([{ value: 'a' }])
    writer.schedule({ value: 'b' })
    vi.advanceTimersByTime(1000)
    expect(writes).toEqual([{ value: 'a' }])
  })

  it('dispose 清除挂起定时器：窗口到期不再触发写', () => {
    const { writer, writes } = makeWriter()
    writer.schedule({ value: 'a' })
    // 先 flush 清空剩余值，再挂新编辑后 dispose：定时器被清、无剩余值
    writer.flushNow()
    writer.schedule({ value: 'b' })
    writer.dispose()
    vi.advanceTimersByTime(1000)
    expect(writes).toEqual([{ value: 'a' }])
  })

  it('在途写期间 dispose：在途完成后补写剩余值', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { writer, writes } = makeWriter({
      write: (payload) => {
        writes.push(payload)
        return gate
      },
    })
    writer.schedule({ value: 'a' })
    vi.advanceTimersByTime(500)
    writer.schedule({ value: 'b' })
    writer.dispose()
    expect(writes).toEqual([{ value: 'a' }])
    release!()
    await vi.waitFor(() => {
      expect(writes).toEqual([{ value: 'a' }, { value: 'b' }])
    })
  })
})

describe('失败语义', () => {
  it('单次写失败经 onError 上报且不阻断后续编辑', async () => {
    let calls = 0
    const { writer, writes, onError } = makeWriter({
      write: () => {
        calls += 1
        if (calls === 1) return Promise.reject(new Error('boom'))
        writes.push({ value: 'ok' })
        return Promise.resolve()
      },
    })
    writer.schedule({ value: 'a' })
    vi.advanceTimersByTime(500)
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1)
    })
    writer.schedule({ value: 'b' })
    vi.advanceTimersByTime(500)
    await vi.waitFor(() => {
      expect(writes).toEqual([{ value: 'ok' }])
    })
  })

  it('flushNow 对失败的写同样只上报并兑现', async () => {
    const { writer, onError } = makeWriter({
      write: () => Promise.reject(new Error('boom')),
    })
    writer.schedule({ value: 'a' })
    await writer.flushNow()
    expect(onError).toHaveBeenCalledTimes(1)
  })
})
