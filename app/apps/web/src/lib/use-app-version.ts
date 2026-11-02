import { getVersion } from '@tauri-apps/api/app'

import { useIpcQuery } from '@/services/ipc-query'

/**
 * 应用版本（静态应用信息）：Query 一次取值多处共享——
 * 关于组 / 欢迎页 / 状态栏消费同一份缓存，不再各自独立异步取值；
 * 读取失败回退占位，不阻断渲染。
 */
export function useAppVersion(fallback = '0.0.0'): string {
  const { data } = useIpcQuery({
    queryKey: ['get_version'],
    queryFn: () => getVersion(),
    staleTime: Number.POSITIVE_INFINITY,
  })
  return data ?? fallback
}
