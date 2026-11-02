import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useDraftField } from '../use-draft-field'

/** 渲染 seam 并提供换真值工具（外部改名＝换 serverValue 重渲染） */
function setupField(initial: string) {
  let serverValue = initial
  const commit = vi.fn()
  const rendered = renderHook(() => useDraftField(serverValue))
  return {
    rendered,
    /** 模拟外部真值变化（缓存直写后的下一次渲染） */
    setServerValue(next: string) {
      serverValue = next
      rendered.rerender()
    },
    field: () => rendered.result.current,
    commit,
  }
}

describe('useDraftField：跟随真值直到用户触碰', () => {
  it('未触碰时显示值跟随 server 真值（外部改名即跟上，无播种失同步）', () => {
    const { field, setServerValue } = setupField('A')
    expect(field().value).toBe('A')
    expect(field().hasDraft).toBe(false)

    setServerValue('B')
    expect(field().value).toBe('B')
  })

  it('begin 建立草稿并记录基线；focus 后无输入、blur 落盘不上抛（封死脏写回滚）', () => {
    const { field, setServerValue, commit } = setupField('A')
    act(() => field().begin())
    expect(field().hasDraft).toBe(true)
    expect(field().value).toBe('A')

    // 草稿在场期间外部改名（页面开着、他处 F2 改名直写缓存）
    setServerValue('B')
    // 用户点进点出输入框（无输入）→ 落盘判定：相对基线无改动，不上抛
    act(() => {
      const changed = field().commitIfChanged(commit)
      expect(changed).toBe(false)
    })
    expect(commit).not.toHaveBeenCalled()
    // 回跟随：呈现外部新值
    expect(field().hasDraft).toBe(false)
    expect(field().value).toBe('B')
  })

  it('用户实际改动才上抛：commit 收到草稿值，随后回跟随', () => {
    const { field, setServerValue, commit } = setupField('A')
    act(() => field().begin())
    setServerValue('B')
    act(() => field().set('C'))
    act(() => {
      const changed = field().commitIfChanged(commit)
      expect(changed).toBe(true)
    })
    expect(commit).toHaveBeenCalledWith('C')
    expect(field().hasDraft).toBe(false)
  })

  it('首键路径（不经 begin）：set 直接建立草稿，基线＝当时的真值', () => {
    const { field, commit } = setupField('A')
    act(() => field().set('A2'))
    expect(field().value).toBe('A2')
    // 键入又删回原值：相对基线无改动，落盘不上抛
    act(() => field().set('A'))
    act(() => field().commitIfChanged(commit))
    expect(commit).not.toHaveBeenCalled()
  })

  it('reset 撤销草稿回跟随（Esc 语义）：呈现真值且此后落盘无草稿可上抛', () => {
    const { field, commit } = setupField('A')
    act(() => field().set('草稿'))
    act(() => field().reset())
    expect(field().hasDraft).toBe(false)
    expect(field().value).toBe('A')
    act(() => field().commitIfChanged(commit))
    expect(commit).not.toHaveBeenCalled()
  })

  it('equals 注入判变（对象草稿按结构比较的扩展点）', () => {
    let serverValue = { name: 'a' }
    const commit = vi.fn()
    const rendered = renderHook(() => useDraftField(serverValue, (a, b) => a.name === b.name))
    const field = () => rendered.result.current
    act(() => field().set({ name: 'a' }))
    act(() => field().commitIfChanged(commit))
    expect(commit).not.toHaveBeenCalled()

    serverValue = { name: 'b' }
    rendered.rerender()
    act(() => field().set({ name: 'c' }))
    act(() => field().commitIfChanged(commit))
    expect(commit).toHaveBeenCalledWith({ name: 'c' })
  })
})
