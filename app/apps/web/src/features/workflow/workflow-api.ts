/**
 * 工作流域 IPC 薄封装：workflow.* 命令的参数与 DTO 类型镜像（与 Rust
 * commands/workflow.rs 签名一一对应，camelCase，沿 variable-api.ts 惯例）。
 *
 * query key 约定（单一事实源，组件不自拼键）：
 * - ['workflow', 'list', workspaceId]：工作空间内工作流清单
 * - ['workflow', 'groups', workspaceId]：工作空间内分组清单
 *
 * 缓存协议：mutation 一律失效 list / groups 键重拉（清单量级小，不直写）。
 */

import { invoke, IpcError } from '@/services/ipc'

import type { WorkflowGraph } from './workflow-model'

// —— DTO 类型（Rust 序列化形态镜像，camelCase） ——

/** 工作流分组行（第五视图分组树行） */
export interface WorkflowGroupDto {
  id: string
  name: string
  createdAt: string
}

export interface WorkflowGroupListDto {
  items: WorkflowGroupDto[]
}

/**
 * 执行终态词（清单元数据）：与 WorkflowExecutionStatus 终态三向一致；
 * null＝尚无执行记录。running 过程态不入清单——在途态由执行事件流驱动。
 */
export type WorkflowLastStatus = 'passed' | 'failed' | 'cancelled'

export interface WorkflowSummaryDto {
  id: string
  name: string
  /** 所属分组（null＝未分组；树内未分组尾置） */
  groupId: string | null
  /** 最近一次执行终态（null＝未运行；清单行不呈现，随清单下发的元数据） */
  lastStatus: WorkflowLastStatus | null
  /** 图内任一存变量节点开启分类写回（图配置判定非执行态，Rust 侧损坏图回落
   * false；清单行不呈现，随清单下发的元数据） */
  hasWriteback: boolean
  updatedAt: string
}

export interface WorkflowListDto {
  items: WorkflowSummaryDto[]
}

export interface WorkflowDto {
  id: string
  workspaceId: string
  name: string
  graph: WorkflowGraph
  groupId: string | null
  createdAt: string
  updatedAt: string
}

/** 节点执行状态词（Rust STATUS_* 词表镜像：过程 queued/running＋终态与 skipped） */
export type NodeExecutionStatus =
  'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'skipped'

/** 工作流执行状态词（Rust STATUS_* 词表镜像：running 过程态＋终态三向） */
export type WorkflowExecutionStatus = 'running' | 'passed' | 'failed' | 'cancelled'

/** 写回清单条目（Rust WritebackEntry 镜像；value 已按条目敏感标记掩码） */
export interface WritebackEntryDto {
  key: string
  categoryName: string
  secret: boolean
  value: string
}

/** 断言结果条目（Rust AssertionEntry 镜像；actual 已按敏感口径掩码——
 * 字符串取值掩码占位、布尔 / 数字标量原样保留） */
export interface AssertionEntryDto {
  /** 规则类型词：statusCode / jsonPath / exists / contains */
  ruleKind: string
  path: string | null
  expected: string | null
  actual: string
  passed: boolean
}

/** 请求节点的请求明细（Rust NodeRequestDetail 镜像；URL 已在 Rust 写时
 * 掩码，前端纯呈现不做新掩码） */
export interface NodeRequestDetailDto {
  method: string
  url: string
}

/** 请求节点的响应明细（Rust NodeResponseDetail 镜像；body 已为掩码摘要
 * ——合法 JSON 保留结构与标量、字符串值一律掩码，非 JSON 为体量说明） */
export interface NodeResponseDetailDto {
  status: number
  body: string
}

/** 单节点执行记录（Rust NodeExecutionRecord 镜像；output 为掩码后产物摘要） */
export interface NodeExecutionDto {
  nodeId: string
  status: NodeExecutionStatus
  startedAt: string | null
  completedAt: string | null
  durationMs: number | null
  errorCode: string | null
  errorMessage: string | null
  output?: string | null
  /** 请求节点的请求明细（方法＋URL；旧记录缺省为 null） */
  request?: NodeRequestDetailDto | null
  /** 请求节点的响应明细（状态码＋响应体掩码摘要；旧记录缺省为 null） */
  response?: NodeResponseDetailDto | null
  /** 写回清单（存变量节点写回成功时逐条；值按条目敏感标记掩码） */
  writebacks?: WritebackEntryDto[]
  /** 断言结果（断言节点逐规则判定；期望 vs 实际） */
  assertions?: AssertionEntryDto[]
}

/** 工作流执行记录（Rust WorkflowExecutionDto 镜像；每工作流仅最近一次） */
export interface WorkflowExecutionDto {
  id: string
  workflowId: string
  status: WorkflowExecutionStatus
  startedAt: string
  completedAt: string | null
  durationMs: number | null
  errorCode: string | null
  errorMessage: string | null
  nodes: NodeExecutionDto[]
}

/** 执行前校验问题条目（Rust WorkflowIssue 镜像；nodeId 缺省＝图级问题） */
export interface WorkflowIssueDto {
  code: string
  nodeId?: string
  message: string
}

/** 工作流引用留痕（Rust WorkflowRefUsage 镜像；引用反查行） */
export interface WorkflowRefUsageDto {
  workflowId: string
  workflowName: string
}

/** 粘贴未命中条目（Rust WorkflowPasteMiss 镜像；定位单元＝引用节点） */
export interface WorkflowPasteMissDto {
  nodeId: string
  endpointKey: string
  /** notFound（目标空间无此键）| ambiguous（多服务撞车） */
  reason: string
}

/** 跨空间粘贴报告（Rust WorkflowPasteReport 镜像；落地实体＋解析统计） */
export interface WorkflowPasteReportDto {
  workflow: WorkflowDto
  hitCount: number
  misses: WorkflowPasteMissDto[]
}

/** 导出结果 DTO（Rust WorkflowExportResultDto 镜像）：落盘路径回显 */
export interface WorkflowExportResultDto {
  path: string
}

/**
 * 事件词全集（单一来源；Rust `WorkflowEvent` serde tag 的手写镜像锚点）。
 * `satisfies` 钉住每个词都是 WorkflowExecutionEvent 的合法判别值（数组多词
 * 编译即红）；反向（联合多词而数组漏登）的类型级对账与夹具
 * `workflow-event-contract.json` 的运行期集合对账由契约测试钉住。
 */
export const WORKFLOW_EXECUTION_EVENT_KINDS = [
  'workflow.started',
  'node.queued',
  'node.started',
  'node.completed',
  'node.failed',
  'node.cancelled',
  'node.skipped',
  'edge.activated',
  'workflow.completed',
  'workflow.failed',
  'workflow.cancelled',
] as const satisfies readonly WorkflowExecutionEvent['event'][]

/** 事件词（WORKFLOW_EXECUTION_EVENT_KINDS 元素联合） */
export type WorkflowExecutionEventKind = (typeof WORKFLOW_EXECUTION_EVENT_KINDS)[number]

/**
 * `workflow:event` 事件（Rust WorkflowEvent serde 形态镜像，tag＝event；判别
 * 值全集与 WORKFLOW_EXECUTION_EVENT_KINDS 双向相等）。
 * node.completed / node.failed 的 output / assertions 缺省即无产物
 * （skip_serializing_if 对齐；assertions 仅断言节点携带——执行结束后
 * 面板不重播种，断言结果必须随事件实时到达，失败判定走 node.failed）。
 * workflow.failed 的 errorCode / errorMessage 恒存在（无 skip，缺省为 null）。
 */
export type WorkflowExecutionEvent =
  | { event: 'workflow.started'; executionId: string; workflowId: string }
  | { event: 'node.queued'; executionId: string; nodeId: string }
  | { event: 'node.started'; executionId: string; nodeId: string }
  | {
      event: 'node.completed'
      executionId: string
      nodeId: string
      durationMs: number
      output?: string
      assertions?: AssertionEntryDto[]
    }
  | {
      event: 'node.failed'
      executionId: string
      nodeId: string
      errorCode: string
      errorMessage: string
      assertions?: AssertionEntryDto[]
    }
  | { event: 'node.cancelled'; executionId: string; nodeId: string }
  | { event: 'node.skipped'; executionId: string; nodeId: string }
  | { event: 'edge.activated'; executionId: string; edgeId: string }
  | {
      event: 'workflow.completed'
      executionId: string
      workflowId: string
      durationMs: number
    }
  | {
      event: 'workflow.failed'
      executionId: string
      workflowId: string
      durationMs: number
      errorCode: string | null
      errorMessage: string | null
    }
  | {
      event: 'workflow.cancelled'
      executionId: string
      workflowId: string
      durationMs: number
    }

// —— query key 工厂（单一事实源，组件不自拼键） ——

export const workflowKeys = {
  /** list 键前缀（跨空间失效面：执行终态后徽标刷新，不点名空间） */
  listPrefix: ['workflow', 'list'] as const,
  list: (workspaceId: string) => [...workflowKeys.listPrefix, workspaceId] as const,
  /** groups 键前缀（分组名变更的跨点失效面） */
  groupsPrefix: ['workflow', 'groups'] as const,
  groups: (workspaceId: string) => [...workflowKeys.groupsPrefix, workspaceId] as const,
  load: (id: string) => ['workflow', 'load', id] as const,
  lastExecution: (id: string) => ['workflow', 'lastExecution', id] as const,
  /** 引用反查（键集合字符串化为 key 部分；提示面查询，不做增量失效） */
  endpointUsage: (workspaceId: string, keys: readonly string[]) =>
    ['workflow', 'endpointUsage', workspaceId, [...keys].sort().join('\n')] as const,
}

// —— workflow.* 编辑模型 CRUD 与分组 ——

export function workflowList(workspaceId: string): Promise<WorkflowListDto> {
  return invoke<WorkflowListDto>('workflow.list', { workspaceId })
}

// —— workflow.group_*（分组树；组删连带成员回落未分组） ——

export function workflowGroupList(workspaceId: string): Promise<WorkflowGroupListDto> {
  return invoke<WorkflowGroupListDto>('workflow.group_list', { workspaceId })
}

export function workflowGroupCreate(workspaceId: string, name: string): Promise<WorkflowGroupDto> {
  return invoke<WorkflowGroupDto>('workflow.group_create', { workspaceId, name })
}

export function workflowGroupRename(id: string, name: string): Promise<WorkflowGroupDto> {
  return invoke<WorkflowGroupDto>('workflow.group_rename', { id, name })
}

/** 删除分组（组内工作流回落未分组，本体不动） */
export function workflowGroupDelete(id: string): Promise<void> {
  return invoke<void>('workflow.group_delete', { id })
}

/** 设置工作流所属分组（groupId null＝移出分组） */
export function workflowSetGroup(id: string, groupId: string | null): Promise<WorkflowDto> {
  return invoke<WorkflowDto>('workflow.set_group', { id, groupId })
}

/** 移动工作流到目标分组（groupId null＝未分组）的目标位置（树拖拽排序通道；
 * 同组内重排与跨组移动共用；index 越界钳制归后端） */
export function workflowMove(id: string, groupId: string | null, index: number): Promise<void> {
  return invoke<void>('workflow.move', { id, groupId, index })
}

/** 移动分组到空间内分组序列的目标位置（树拖拽排序通道） */
export function workflowGroupMove(id: string, index: number): Promise<void> {
  return invoke<void>('workflow.group_move', { id, index })
}

export function workflowLoad(id: string): Promise<WorkflowDto> {
  return invoke<WorkflowDto>('workflow.load', { id })
}

export function workflowCreate(workspaceId: string, name: string): Promise<WorkflowDto> {
  return invoke<WorkflowDto>('workflow.create', { workspaceId, name })
}

/** 跨空间粘贴（应用内剪贴板的图落到目标空间为全新工作流；报告含命中统计） */
export function workflowPaste(
  workspaceId: string,
  name: string,
  graph: WorkflowGraph,
): Promise<WorkflowPasteReportDto> {
  return invoke<WorkflowPasteReportDto>('workflow.paste', { workspaceId, name, graph })
}

/**
 * 导出工作流为 `.json` 文件（path 由系统保存对话框选定后传入）；空间
 * 作用域读取（跨空间 id 视同不存在），落盘前图经 Rust 侧读时脱敏投影，
 * 敏感覆写字面量不进文件。
 */
export function workflowExport(
  workspaceId: string,
  id: string,
  path: string,
): Promise<WorkflowExportResultDto> {
  return invoke<WorkflowExportResultDto>('workflow.export', { workspaceId, id, path })
}

/**
 * 从导出文件导入为全新工作流（path 由系统打开对话框选定后传入）；封皮
 * 版本闸后复用粘贴解析链，报告与 workflowPaste 同形态。
 */
export function workflowImport(workspaceId: string, path: string): Promise<WorkflowPasteReportDto> {
  return invoke<WorkflowPasteReportDto>('workflow.import', { workspaceId, path })
}

export function workflowRename(id: string, name: string): Promise<WorkflowDto> {
  return invoke<WorkflowDto>('workflow.rename', { id, name })
}

export function workflowSave(id: string, graph: WorkflowGraph): Promise<WorkflowDto> {
  return invoke<WorkflowDto>('workflow.save', { id, graph })
}

export function workflowDelete(id: string): Promise<void> {
  return invoke<void>('workflow.delete', { id })
}

// —— workflow.* 执行面（3） ——

/** 执行至终态（阻塞语义同 http.send；过程状态经 workflow:event 事件流推送） */
export function workflowExecute(id: string): Promise<WorkflowExecutionDto> {
  return invoke<WorkflowExecutionDto>('workflow.execute', { id })
}

/** 取消在途执行（无在途任务时静默幂等） */
export function workflowCancel(id: string): Promise<boolean> {
  return invoke<boolean>('workflow.cancel', { id })
}

/** 取最近一次执行记录（无记录＝null；执行面板回看面） */
export function workflowLastExecution(id: string): Promise<WorkflowExecutionDto | null> {
  return invoke<WorkflowExecutionDto | null>('workflow.last_execution', { id })
}

// —— workflow.* 校验与反查面 ——

/**
 * 执行前校验（graph 传编辑会话当前图＝校验未保存编辑态，缺省校验落库图）。
 * 返回全部问题（空表＝通过）；保存不被校验拦截，本面只在执行前与错误
 * 定位消费。
 */
export function workflowValidate(id: string, graph?: WorkflowGraph): Promise<WorkflowIssueDto[]> {
  return invoke<WorkflowIssueDto[]>('workflow.validate', { id, graph })
}

/** 稳定键 → 引用工作流清单（删除确认与同步向导计数的反查面；键无引用＝缺表） */
export function workflowEndpointUsage(
  workspaceId: string,
  keys: readonly string[],
): Promise<Record<string, WorkflowRefUsageDto[]>> {
  return invoke<Record<string, WorkflowRefUsageDto[]>>('workflow.endpoint_usage', {
    workspaceId,
    keys,
  })
}

/**
 * 执行拒绝（引擎按落库图校验拦截）错误中的问题清单：编辑态图已修复未
 * 保存时前端校验放行、引擎按落库图拒绝——两道闸的结论由此收敛到同一
 * 呈现面（非该类错误返回 null）。
 */
export function issuesFromRejection(error: unknown): WorkflowIssueDto[] | null {
  if (!(error instanceof IpcError) || error.code !== 'WORKFLOW_NOT_EXECUTABLE') return null
  const issues = (error.details as { issues?: unknown } | undefined)?.issues
  return Array.isArray(issues) ? (issues as WorkflowIssueDto[]) : null
}
