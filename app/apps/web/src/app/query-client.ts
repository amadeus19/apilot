import { QueryClient } from '@tanstack/react-query'

/**
 * QueryClient 单例：三类状态分治中「异步 / 服务端状态」档的宿主。
 * 桌面 IPC 默认值——
 * - retry: false：invoke 失败多为确定性（配置缺失 / 清单损坏 / 权限），
 *   指数退避重试只推迟错误呈现；瞬态场景由调用方显式 refetch。
 * - refetchOnWindowFocus: false：Tauri 单窗口无「切回浏览器」语义，
 *   聚焦重取只会打断静态信息（版本、目录路径）的展示。
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
})
