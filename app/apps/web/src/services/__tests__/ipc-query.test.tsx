import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createQueryWrapper } from '@/test/render-providers'
import { useIpcMutation, useIpcQuery } from '../ipc-query'

/**
 * IPC 查询 / 变更薄适配层：职责 = 错误归一（IpcError）与类型收窄。
 * 缓存行为（staleTime / retry 等）属 TanStack Query 本体，不在被测面。
 */

describe('useIpcQuery', () => {
  it('成功值原样透出（data 为 queryFn 返回值）', async () => {
    const { result } = renderHook(
      () => useIpcQuery({ queryKey: ['test', 'ok'], queryFn: () => Promise.resolve({ v: 1 }) }),
      { wrapper: createQueryWrapper() },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual({ v: 1 })
  })

  it('AppError 序列化形态拒绝值归一为 IpcError', async () => {
    const { result } = renderHook(
      () =>
        useIpcQuery({
          queryKey: ['test', 'app-error'],
          queryFn: () =>
            Promise.reject({ kind: 'apilot_error', code: 'SETTINGS_UNKNOWN_KEY', message: 'boom' }),
        }),
      { wrapper: createQueryWrapper() },
    )
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.code).toBe('SETTINGS_UNKNOWN_KEY')
    expect(result.current.error?.fromAppError).toBe(true)
  })

  it('JS 侧未知异常同样归一（code = INTERNAL）', async () => {
    const { result } = renderHook(
      () =>
        useIpcQuery({
          queryKey: ['test', 'js-error'],
          queryFn: () => Promise.reject(new Error('plain js error')),
        }),
      { wrapper: createQueryWrapper() },
    )
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.code).toBe('INTERNAL')
    expect(result.current.error?.fromAppError).toBe(false)
  })
})

describe('useIpcMutation', () => {
  it('成功与失败结果归一：pending 状态可观测，错误恒为 IpcError', async () => {
    const mutationFn = vi
      .fn<(vars: number) => Promise<number>>()
      .mockResolvedValueOnce(42)
      .mockRejectedValueOnce({ kind: 'apilot_error', code: 'DB_QUERY_FAILED', message: 'bad db' })

    const { result } = renderHook(() => useIpcMutation({ mutationFn }), {
      wrapper: createQueryWrapper(),
    })

    result.current.mutate(1)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toBe(42)

    result.current.mutate(2)
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.code).toBe('DB_QUERY_FAILED')
  })

  it('onSuccess / onError 回调按结果触发（组件级 toast 分支挂点）', async () => {
    const onSuccess = vi.fn()
    const onError = vi.fn()
    const mutationFn = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('plain'))

    const { result } = renderHook(() => useIpcMutation({ mutationFn, onSuccess, onError }), {
      wrapper: createQueryWrapper(),
    })

    act(() => result.current.mutate())
    await waitFor(() => expect(onSuccess).toHaveBeenCalled())

    act(() => result.current.mutate())
    await waitFor(() => expect(onError).toHaveBeenCalled())
    expect(onError.mock.calls[0][0].code).toBe('INTERNAL')
  })
})
