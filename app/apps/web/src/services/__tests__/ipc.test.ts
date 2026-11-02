import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke as tauriInvoke } from '@tauri-apps/api/core'

import { getBootSettings, invoke, isBlockingCode, setSetting, toIpcError } from '../ipc'

// Tauri IPC 原语替换为可编排的 mock（ipc.ts 仅做包装，转发行为不属于被测面）
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

const invokeMock = vi.mocked(tauriInvoke)

beforeEach(() => {
  invokeMock.mockReset()
})

describe('toIpcError', () => {
  it('AppError 序列化形态解包为 IpcError（code / message / details 透传）', () => {
    const raw = {
      kind: 'apilot_error',
      code: 'SETTINGS_VALUE_TOO_LARGE',
      message: 'setting value exceeds 4096 bytes',
      details: { limit: 4096, actual: 5000 },
    }
    const error = toIpcError(raw)
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('SETTINGS_VALUE_TOO_LARGE')
    expect(error.message).toBe('setting value exceeds 4096 bytes')
    expect(error.details).toEqual({ limit: 4096, actual: 5000 })
    expect(error.fromAppError).toBe(true)
  })

  it('非 AppError 未知异常归一为 INTERNAL 并保留原始信息', () => {
    const error = toIpcError(new Error('boom'))
    expect(error.code).toBe('INTERNAL')
    expect(error.message).toBe('boom')
    expect(error.fromAppError).toBe(false)
  })

  it('非 Error 值（字符串等）同样归一', () => {
    expect(toIpcError('weird').message).toBe('weird')
  })
})

describe('invoke', () => {
  it('成功值原样返回', async () => {
    invokeMock.mockResolvedValue({ settings: {}, systemLocale: 'zh-CN' })
    await expect(invoke('get_boot_settings')).resolves.toEqual({
      settings: {},
      systemLocale: 'zh-CN',
    })
    // 无参调用不透传 undefined（与 Rust 侧命令签名形态一致）
    expect(invokeMock).toHaveBeenCalledWith('get_boot_settings')
  })

  it('AppError 拒绝值解包为 IpcError 抛出', async () => {
    invokeMock.mockRejectedValue({ kind: 'apilot_error', code: 'DB_CORRUPTED', message: 'bad db' })
    await expect(invoke('get_boot_settings')).rejects.toMatchObject({
      code: 'DB_CORRUPTED',
      fromAppError: true,
    })
  })
})

describe('命令薄封装', () => {
  it('setSetting 以 (key, value) 形参调用 set_setting', async () => {
    invokeMock.mockResolvedValue(undefined)
    await setSetting('devMode', { enabled: true })
    expect(invokeMock).toHaveBeenCalledWith('set_setting', {
      key: 'devMode',
      value: { enabled: true },
    })
  })

  it('getBootSettings 返回启动载荷', async () => {
    invokeMock.mockResolvedValue({
      settings: { theme: '{"preference":"dark"}' },
      systemLocale: null,
    })
    await expect(getBootSettings()).resolves.toEqual({
      settings: { theme: '{"preference":"dark"}' },
      systemLocale: null,
    })
  })
})

describe('isBlockingCode', () => {
  it('DB_CORRUPTED 为阻断性错误', () => {
    expect(isBlockingCode('DB_CORRUPTED')).toBe(true)
  })

  it('瞬态错误码不走阻断通道', () => {
    expect(isBlockingCode('SETTINGS_UNKNOWN_KEY')).toBe(false)
    expect(isBlockingCode('INTERNAL')).toBe(false)
  })
})
