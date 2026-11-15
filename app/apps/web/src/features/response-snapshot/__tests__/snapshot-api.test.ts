import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getResponseSnapshot, openResponseSnapshot, SNAPSHOT_WINDOW_LABEL } from '../snapshot-api'

// —— IPC 替换：命令封装只做透传，桩记录命令名与参数形态 ——
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue(undefined)
})

describe('response-snapshot 命令契约（与建窗侧写死契约对齐）', () => {
  it('窗口 label 契约值', () => {
    expect(SNAPSHOT_WINDOW_LABEL).toBe('response-snapshot')
  })

  it('openResponseSnapshot：命令名与载荷经 payload 键包裹透传（命令签名按参数名取键）', async () => {
    await openResponseSnapshot({ title: '接口', content: '{}', contentType: 'json' })
    expect(invokeMock).toHaveBeenCalledWith('open_response_snapshot', {
      payload: { title: '接口', content: '{}', contentType: 'json' },
    })
  })

  it('getResponseSnapshot：无参调用，返回载荷或 null', async () => {
    invokeMock.mockResolvedValue(null)
    await expect(getResponseSnapshot()).resolves.toBeNull()
    expect(invokeMock).toHaveBeenCalledWith('get_response_snapshot')
  })
})
