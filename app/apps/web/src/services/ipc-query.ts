import {
  useMutation,
  useQuery,
  type QueryKey,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query'

import { toIpcError, type IpcError } from './ipc'

/**
 * IPC 查询 / 变更薄适配层：invoke 封装的异步调用 → TanStack Query。
 *
 * 职责只有两条——
 * 1. 错误归一：queryFn / mutationFn 抛出的任意异常统一经 toIpcError 归为
 *    IpcError（AppError 解包已在 services/ipc 完成，此处兜底 JS 侧未知异常），
 *    组件侧 error 恒为 IpcError，按统一错误协议呈现；
 * 2. 类型收窄：把 TanStack Query 的泛型签名收敛为（data, error = IpcError）
 *    的固定形态，业务组件不再各自声明错误类型。
 *
 * 缓存键约定：queryKey 首位 = IPC 命令名，后续位 = 参数（可机械排查缓存域）。
 */

/** IPC 读取适配：包装 useQuery，错误恒为 IpcError */
export function useIpcQuery<T>(
  options: UseQueryOptions<T, IpcError, T, QueryKey> & { queryFn: () => Promise<T> },
): UseQueryResult<T, IpcError> {
  const { queryFn, ...rest } = options
  return useQuery<T, IpcError, T, QueryKey>({
    ...rest,
    queryFn: async () => {
      try {
        return await queryFn()
      } catch (raw) {
        throw toIpcError(raw)
      }
    },
  })
}

/** IPC 变更适配：包装 useMutation，错误恒为 IpcError */
export function useIpcMutation<TData, TVars = void>(
  options: UseMutationOptions<TData, IpcError, TVars> & {
    mutationFn: (vars: TVars) => Promise<TData>
  },
): UseMutationResult<TData, IpcError, TVars> {
  const { mutationFn, ...rest } = options
  return useMutation<TData, IpcError, TVars>({
    ...rest,
    mutationFn: async (vars) => {
      try {
        return await mutationFn(vars)
      } catch (raw) {
        throw toIpcError(raw)
      }
    },
  })
}
