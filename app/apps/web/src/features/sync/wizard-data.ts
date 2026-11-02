/**
 * 同步向导的数据装配面（非组件文件：hook 与纯函数，直测面）。
 * 与组件文件分离是 `react/only-export-components` 零警告基线的要求
 * （08 号 `endpoint-doc-logic.ts` 先例）。
 */

import { useIpcQuery } from '@/services/ipc-query'
import { useCurrentWorkspaceTreeQuery } from '@/features/workspaces/api'

import { syncKeys, syncLastSyncedAt } from './sync-api'

/** 当前工作空间的服务选择面（同步输入子集；无文档地址者不可选） */
export function useSyncServiceOptions(): { id: string; name: string; docUrl: string | null }[] {
  const treeQuery = useCurrentWorkspaceTreeQuery()
  return (treeQuery.data?.services ?? []).map((s) => ({ id: s.id, name: s.name, docUrl: s.docUrl }))
}

/** 工作空间最近一次同步应用时刻（ISO；加载中 / 从未同步＝null）。
 *  只读短查询（错误经 useIpcQuery 归一为 IpcError）：按工作空间缓存，
 *  应用完成后经前缀失效重取。 */
export function useLastSyncedAt(): string | null {
  const { workspaceId } = useCurrentWorkspaceTreeQuery()
  const query = useIpcQuery({
    queryKey: syncKeys.lastSynced(workspaceId ?? ''),
    queryFn: () => syncLastSyncedAt(workspaceId ?? ''),
    enabled: workspaceId !== null,
  })
  return query.data ?? null
}

/** ISO 时刻 → 头部时钟文本（本地时区 MM-DD HH:mm；非法输入原样返回） */
export function formatSyncClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
