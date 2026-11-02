import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

/**
 * 测试渲染包裹器：每次调用建独立 QueryClient（测试间缓存隔离），
 * 供渲染含 IPC Query / Mutation 消费者的组件时作为 RTL wrapper 使用。
 *
 * gcTime 固定 Infinity：无观察者缓存条目的回收定时器会被 fake timers
 * 的「跑尽挂起定时器」提前触发，把预填/未挂载的缓存清掉（测试内缓存
 * 生存期与 client 一致，随测试结束整体丢弃，无需运行中回收）。
 *
 * seed 在挂载前同步预填缓存（依赖查询数据的组件渲染首帧即可命中）；
 * 经组件 effect 预填会晚于首帧且受上述定时器问题影响，勿再走那条路。
 */
export function createQueryWrapper(
  seed?: (queryClient: QueryClient) => void,
): (props: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  })
  seed?.(queryClient)
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}
