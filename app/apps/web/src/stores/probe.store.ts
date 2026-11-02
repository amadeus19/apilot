import { create } from 'zustand'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { invoke } from '@/services/ipc'

/**
 * 服务可达性探测状态（四态：reachable / unreachable / unknown / probing）。
 *
 * 生命周期：
 * - 何时创建：`ensureProbeInit()` 由接口树面板挂载时调用一次（幂等守卫）——
 *   `probe.list` 拉初始快照＋`probe://status` 事件常驻订阅（切走视图不撤，
 *   状态面与视图生命周期解耦）；
 * - 何时释放：应用退出（桌面单进程，无显式 unlisten 面）；
 * - 数据来源：Rust 侧主动事件推送（UI 不轮询）；手动全量刷新走
 *   `probe.refresh_all`（接口树底计数行入口），状态更新同样经事件回流。
 */

export type ProbeStatusKind = 'reachable' | 'unreachable' | 'unknown' | 'probing'

interface ProbeStatusDto {
  serviceId: string
  status: ProbeStatusKind
  checkedAt?: string
}

interface ProbeStoreState {
  /** serviceId → 四态（缺 record ＝未知） */
  statuses: Record<string, ProbeStatusKind>
  /**
   * 「可达」宣告已消费的服务集（可达徽标完整展示并退场后标记）：树行虚拟
   * 滚动卸载重挂载不重现徽标；状态离开可达（新一轮探测 probing 在前）时
   * 由 applyEvent 清除——新一轮探测结果需要重新宣告一次
   */
  reachShown: Record<string, true>
  /** 事件回流更新（`probe://status` 载荷） */
  applyEvent: (payload: ProbeStatusDto) => void
  /** 初始快照播种 */
  seedSnapshot: (states: ProbeStatusDto[]) => void
  /** 可达徽标退场完成（树行芯片调用；仅可达态有意义） */
  markReachShown: (serviceId: string) => void
  /** 手动全量刷新（接口树计数行入口；fire-and-forget，状态经事件回流） */
  refreshAll: () => Promise<void>
}

export const useProbeStore = create<ProbeStoreState>((set) => ({
  statuses: {},
  reachShown: {},
  applyEvent: (payload) =>
    set((state) => {
      const statuses = { ...state.statuses, [payload.serviceId]: payload.status }
      // 离开可达即清宣告标记：新一轮探测（probing 必在前）的结果重新展示
      if (payload.status !== 'reachable' && state.reachShown[payload.serviceId]) {
        const reachShown = { ...state.reachShown }
        delete reachShown[payload.serviceId]
        return { statuses, reachShown }
      }
      return { statuses }
    }),
  seedSnapshot: (states) =>
    set(() => ({
      statuses: Object.fromEntries(states.map((state) => [state.serviceId, state.status])),
      reachShown: {},
    })),
  markReachShown: (serviceId) =>
    set((state) => ({ reachShown: { ...state.reachShown, [serviceId]: true } })),
  refreshAll: async () => {
    await invoke('probe.refresh_all')
  },
}))

/** 单例初始化守卫（重复调用无害） */
let probeInitialized = false

/**
 * 探测状态面初始化：初始快照＋事件常驻订阅。由接口树面板挂载时调用；
 * IPC / 事件通道不可用（测试环境）时静默跳过，状态面保持空（全「未知」）。
 */
export async function ensureProbeInit(): Promise<void> {
  if (probeInitialized) return
  probeInitialized = true
  try {
    const snapshot = await invoke<ProbeStatusDto[]>('probe.list')
    useProbeStore.getState().seedSnapshot(snapshot)
    const unlisten: UnlistenFn = await listen<ProbeStatusDto>('probe://status', (event) => {
      useProbeStore.getState().applyEvent(event.payload)
    })
    // 应用会话级订阅：不做 unlisten（桌面单进程，进程退出即释放）
    void unlisten
  } catch {
    // 环境无 IPC（测试）：保持空状态面
  }
}

/** 取服务可达态（缺 record 归一为「未知」） */
export function probeStatusOf(
  statuses: Record<string, ProbeStatusKind>,
  serviceId: string,
): ProbeStatusKind {
  return statuses[serviceId] ?? 'unknown'
}
