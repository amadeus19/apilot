import { describe, expect, it, vi } from 'vitest'

import { TimeoutError, withTimeout } from '../async'

describe('withTimeout', () => {
  it('按时完成则透传结果并清理定时器', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42)
  })

  it('超时以 TimeoutError 拒绝', async () => {
    vi.useFakeTimers()
    try {
      const pending = new Promise<string>(() => {})
      const guarded = withTimeout(pending, 50, 'boot')
      const assertion = expect(guarded).rejects.toBeInstanceOf(TimeoutError)
      vi.advanceTimersByTime(60)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('原 Promise 先拒绝时透传原始原因（不被超时掩盖）', async () => {
    const failure = Promise.reject(new Error('original failure'))
    await expect(withTimeout(failure, 1000)).rejects.toThrow('original failure')
  })
})
