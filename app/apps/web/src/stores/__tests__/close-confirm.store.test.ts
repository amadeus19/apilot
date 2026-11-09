import { beforeEach, describe, expect, it } from 'vitest'

import { useCloseConfirmStore } from '../close-confirm.store'

beforeEach(() => {
  useCloseConfirmStore.getState().clear()
})

describe('close-confirm store（关闭确认弹窗请求通道）', () => {
  it('初始态无待决策请求', () => {
    expect(useCloseConfirmStore.getState().pending).toBe(false)
  })

  it('show 置待决策态（弹窗在场），clear 复位（弹窗退场）', () => {
    useCloseConfirmStore.getState().show()
    expect(useCloseConfirmStore.getState().pending).toBe(true)

    useCloseConfirmStore.getState().clear()
    expect(useCloseConfirmStore.getState().pending).toBe(false)
  })

  it('show 幂等：重复 show 不改变在场语义', () => {
    useCloseConfirmStore.getState().show()
    useCloseConfirmStore.getState().show()
    expect(useCloseConfirmStore.getState().pending).toBe(true)
  })
})
