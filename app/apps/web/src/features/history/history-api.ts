/**
 * 历史域 IPC 薄封装：run.list / run.get 命令的参数与 DTO 类型镜像
 * （与 Rust commands/run.rs 签名一一对应，camelCase，沿 http-api.ts 惯例）。
 *
 * query key 约定：列表分页键沿用 httpKeys.history(workspaceId, page)（workspaceId
 * 入键使缓存域随空间隔离，切空间即重取；发送完成经 invalidateHistory 失效
 * 前缀）；详情键挂同一前缀下（'detail' 段与数字页码不同形，不冲突），手动
 * 刷新与发送失效时一并重取。
 */

import { invoke } from '@/services/ipc'
import type { RunOutcome } from '@/features/http/send-state'
import { httpKeys } from '@/features/http/http-api'
import type { RequestSnapshotDto, ResponseSnapshotDto } from '@/features/http/http-api'

/** 列表页容量（后端上限 200；50/页＋「加载更多」见 history-panel 的分页裁定注） */
export const HISTORY_PAGE_SIZE = 50

/** 历史行 DTO（run.list 行字段；created_at 倒序，GUI 与 CLI 来源同现） */
export interface RunListItemDto {
  runId: string
  state: RunOutcome
  method: string
  url: string
  statusCode: number | null
  durationMs: number | null
  source: 'gui' | 'cli'
  createdAt: string
  /** 接口名（endpoints.title 联查；接口已删时 null，行内回落 URL 路径段） */
  endpointName: string | null
}

/**
 * 历史详情 DTO（run.get；只读全量留痕）。快照本体存明文，展示脱敏由前端
 * 执行（复用 http 域掩码工具）；request 在后端 JSON 解析失败时可能是
 * null / 空对象，消费方渲染前需形态收窄。
 */
export interface RunDetailDto {
  runId: string
  workspaceId: string
  serviceId: string
  endpointKey: string
  method: string
  url: string
  statusCode: number | null
  durationMs: number | null
  state: RunOutcome
  errorCode: string | null
  errorMessage: string | null
  source: 'gui' | 'cli'
  createdAt: string
  request: RequestSnapshotDto | null
  response: ResponseSnapshotDto | null
}

/** 拉取一页历史（当前工作空间；后端按 created_at 倒序返回） */
export function runListPage(page: number): Promise<RunListItemDto[]> {
  return invoke<RunListItemDto[]>('run.list', { page, pageSize: HISTORY_PAGE_SIZE })
}

/** 按 id 批量删除历史（返回实际删除数；不存在的 id 静默跳过） */
export function runDelete(ids: string[]): Promise<number> {
  return invoke<number>('run.delete', { ids })
}

/** 拉取单条历史详情（记录不存在或已被修剪时返回 null） */
export function runGetDetail(runId: string): Promise<RunDetailDto | null> {
  return invoke<RunDetailDto | null>('run.get', { args: { runId } })
}

/** 详情查询键（挂历史前缀下：手动刷新 / 发送完成失效时一并重取） */
export const historyDetailKey = (runId: string) =>
  [...httpKeys.historyRoot(), 'detail', runId] as const
