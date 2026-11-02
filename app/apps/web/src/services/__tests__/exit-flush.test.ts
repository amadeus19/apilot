import { describe, expect, it, vi } from 'vitest'

import { flushAllForExit, registerExitFlusher } from '../exit-flush'

describe('退出收尾注册表（资源四问闭环）', () => {
  it('注册 → flush 依次执行；注销后不再执行', async () => {
    const calls: string[] = []
    const unregisterA = registerExitFlusher('a', () => {
      calls.push('a')
    })
    const unregisterB = registerExitFlusher('b', () => {
      calls.push('b')
    })

    await flushAllForExit()
    expect(calls).toEqual(['a', 'b'])

    unregisterA()
    calls.length = 0
    await flushAllForExit()
    expect(calls).toEqual(['b'])

    unregisterB()
  })

  it('同 id 重复注册：幂等覆盖（不增长注册表）', async () => {
    const calls: string[] = []
    const unregisterFirst = registerExitFlusher('same', () => {
      calls.push('first')
    })
    registerExitFlusher('same', () => {
      calls.push('second')
    })
    unregisterFirst() // 旧项注销不误摘新项（幂等注销语义）
    await flushAllForExit()
    expect(calls).toEqual(['second'])
  })

  it('单项失败不阻断其余收尾（逐项容错）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const calls: string[] = []
    registerExitFlusher('boom', () => {
      throw new Error('flush failed')
    })
    registerExitFlusher('after', () => {
      calls.push('after')
    })
    await flushAllForExit()
    expect(calls).toEqual(['after'])
    expect(errSpy).toHaveBeenCalledOnce()
    errSpy.mockRestore()
  })

  it('异步收尾按注册顺序 await（会话保存先于放行）', async () => {
    const order: string[] = []
    registerExitFlusher('slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      order.push('slow-done')
    })
    registerExitFlusher('fast', () => {
      order.push('fast-started')
    })
    await flushAllForExit()
    expect(order).toEqual(['slow-done', 'fast-started'])
  })
})
