import { describe, expect, it } from 'vitest'

import {
  beginSendPhase,
  finishSendPhase,
  isTerminalPhase,
  isTimeoutFailure,
  type SendPhase,
} from '../send-state'

describe('发送状态机转移', () => {
  it('idle 与任意终态可发起 sending', () => {
    for (const phase of ['idle', 'done', 'failed', 'cancelled'] as SendPhase[]) {
      expect(beginSendPhase(phase)).toBe('sending')
    }
  })

  it('sending 拒绝再次发起（并发由取消链裁决，UI 只允许取消）', () => {
    expect(beginSendPhase('sending')).toBeNull()
  })

  it('结果落定：passed → done；failed / cancelled 同名终态', () => {
    expect(finishSendPhase('passed')).toBe('done')
    expect(finishSendPhase('failed')).toBe('failed')
    expect(finishSendPhase('cancelled')).toBe('cancelled')
  })

  it('终态判定：idle 与 sending 非终态，其余终态', () => {
    expect(isTerminalPhase('idle')).toBe(false)
    expect(isTerminalPhase('sending')).toBe(false)
    expect(isTerminalPhase('done')).toBe(true)
    expect(isTerminalPhase('failed')).toBe(true)
    expect(isTerminalPhase('cancelled')).toBe(true)
  })
})

describe('错误三分判定（超时）', () => {
  it('failed 且 errorCode=TIMEOUT 命中超时卡片', () => {
    expect(isTimeoutFailure('failed', 'TIMEOUT')).toBe(true)
  })

  it('非 failed 或非 TIMEOUT 不命中（走普通错误卡 / 中性提示）', () => {
    expect(isTimeoutFailure('failed', 'HTTP_REQUEST_FAILED')).toBe(false)
    expect(isTimeoutFailure('cancelled', 'TIMEOUT')).toBe(false)
    expect(isTimeoutFailure('done', 'TIMEOUT')).toBe(false)
    expect(isTimeoutFailure('failed', null)).toBe(false)
  })
})
