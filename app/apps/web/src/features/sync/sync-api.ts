/**
 * 同步域 IPC 包装（sync.* 命令薄封装）：拉取 / 取消 / 对比 / 应用。
 * 类型镜像以 Rust 侧为事实源（camelCase 序列化）。
 */

import { invoke } from '@/services/ipc'

import type { DiffOutcome } from './diff-contract'

/** 应用事务结果（向导完成段摘要；参数/请求体在应用内静默对齐，无计数面） */
export interface ApplyOutcomeDto {
  added: number
  changed: number
  removed: number
  unchanged: number
}

/** 拉取产物：待应用拉取元信息（定义面不跨 IPC，diff/apply 从暂存与
 *  已应用代快照重归一） */
export interface FetchOutcomeDto {
  serviceId: string
  /** 待转正代次（当前已应用最大代 + 1；全量应用时写入） */
  generation: number
  sha256: string
  sizeBytes: number
  elapsedMs: number
}

/** 拉取单服务（长期任务；完成只写待应用暂存，不推进快照代——快照随
 *  全量应用转正） */
export function syncFetch(serviceId: string): Promise<FetchOutcomeDto> {
  return invoke('sync.fetch', { serviceId })
}

/** 取消进行中的拉取（幂等：无进行中任务返回 false） */
export function syncFetchCancel(serviceId: string): Promise<boolean> {
  return invoke('sync.fetch_cancel', { serviceId })
}

/** 对单服务执行结构化对比（只读短任务；前置＝已有快照） */
export function syncDiff(serviceId: string): Promise<DiffOutcome> {
  return invoke('sync.diff', { serviceId })
}

/** 应用事务（单事务落库；参数与请求体由应用事务静默对齐，无需裁决载荷）。
 *  `keys`＝接口粒度勾选集（稳定键，缺省全量）：只落勾选行 */
export function syncApply(serviceId: string, keys?: string[]): Promise<ApplyOutcomeDto> {
  return invoke('sync.apply', { serviceId, keys: keys ?? null })
}

/** 工作空间最近一次同步应用时刻（ISO；无已应用快照＝null）。
 *  向导头部「上次同步」数据源：快照盖戳时点＝全量应用。 */
export function syncLastSyncedAt(workspaceId: string): Promise<string | null> {
  return invoke('sync.last_synced', { workspaceId })
}

/** 同步域查询键（缓存键约定：首位＝IPC 命令名；前缀失效覆盖单工作空间条目） */
export const syncKeys = {
  lastSynced: (workspaceId: string) => ['sync.last_synced', workspaceId] as const,
  lastSyncedPrefix: ['sync.last_synced'] as const,
}
