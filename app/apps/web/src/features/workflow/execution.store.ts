import { create } from 'zustand'

import { reportError } from '@/services/error-center'

import {
  workflowCancel,
  type AssertionEntryDto,
  type NodeExecutionDto,
  type NodeExecutionStatus,
  type NodeRequestDetailDto,
  type NodeResponseDetailDto,
  type WorkflowExecutionEvent,
  type WorkflowExecutionDto,
  type WorkflowExecutionStatus,
  type WritebackEntryDto,
} from './workflow-api'

/**
 * 工作流执行态 store（Zustand，按工作流 id 一槽）：`workflow:event` 事件流
 * 到 UI 态的唯一归约点（React 只渲染不轮询，架构铁律）。
 *
 * 生命周期（资源四问）：
 * - 何时创建：编辑器打开播种最近一次执行记录（回看面）；点击运行乐观置
 *   running（workflow.started 事件随后对齐）；事件流按 executionId 归约进
 *   槽位（槽位键恒 workflowId，事件索引 executionIndex 反查归属）；
 * - 何时释放：Tab 关闭 / 会话对账清扫时 dispose——取消在途执行（幂等）并
 *   删除槽位；事件订阅是 AppShell 单点常驻（随应用生命周期），槽位释放
 *   即清理完成；
 * - 运行结束即停：终态事件把活跃边清空（边动画停止），后续事件不再进槽
 *   （终态后忽略迟到节点事件）。
 */

/** 节点执行 UI 态（事件流归约产物；状态词表单一事实源在 workflow-api） */
export interface NodeExecutionUiState {
  status: NodeExecutionStatus
  durationMs?: number
  errorCode?: string
  errorMessage?: string
  /** 节点产物摘要（提取 / 存变量落键；Rust 侧已按敏感口径掩码） */
  output?: string
  /** 断言逐规则结果（断言节点专用；期望 vs 实际，actual 已按敏感口径掩码） */
  assertions?: AssertionEntryDto[]
  /** 请求明细（方法＋URL，URL 已在 Rust 写时掩码）。事件不携带，只经
   * 终态记录播种进入——queued / running 过程态无明细 */
  request?: NodeRequestDetailDto
  /** 响应明细（状态码＋响应体掩码摘要）。同 request，只随终态记录到达 */
  response?: NodeResponseDetailDto
  /** 写回清单（存变量节点写回成功逐条；值已按条目敏感标记掩码）。
   * 同 request，只随终态记录到达 */
  writebacks?: WritebackEntryDto[]
}

/** 工作流执行 UI 态（最近一次执行；status 终态三向＋running 过程态） */
export interface WorkflowExecutionUiState {
  executionId: string
  workflowId: string
  status: WorkflowExecutionStatus
  /** 终态耗时（workflow.* 事件携带） */
  durationMs?: number
  errorCode?: string | null
  errorMessage?: string | null
  /** 节点执行态（nodeId → 态；含 queued / running 过程态） */
  nodes: Record<string, NodeExecutionUiState>
  /** 节点执行序（node.queued 到达序＝串行链执行序，面板展示序） */
  order: string[]
  /** 已激活边（运行中流动；终态清空即停动画） */
  activeEdgeIds: ReadonlySet<string>
}

interface WorkflowExecutionState {
  executions: Record<string, WorkflowExecutionUiState>
  /** executionId → workflowId（事件归属反查；workflow.started 登记） */
  executionIndex: Record<string, string>
  /** 事件流归约（AppShell 单点订阅转发；未知 executionId 静默忽略） */
  applyEvent: (event: WorkflowExecutionEvent) => void
  /** 编辑器打开播种最近一次执行记录（回看面；无记录＝null 不播种） */
  seedFromRecord: (dto: WorkflowExecutionDto) => void
  /** 运行点击乐观置 running（workflow.started 事件随后对齐 executionId） */
  startLocal: (workflowId: string) => void
  /**
   * 运行调用失败（并发拒绝 / 工作流不存在等）回滚乐观槽：仅当槽位仍是
   * 乐观态（executionId 未被事件对齐且在 running）时删除——事件流已接管
   * 的槽位不动。
   */
  failLocal: (workflowId: string) => void
  /** Tab 关闭 / 会话清扫联动：取消在途执行（幂等）并释放槽位 */
  dispose: (workflowId: string) => void
  /**
   * 对账清扫（编辑器挂载期兜底）：对不在存活 Tab 清单里的执行槽位逐个
   * dispose（取消在途＋释放）。与 dispose 的差异只在入口形态——存活清单
   * 由调用方给出，store 内求差。
   */
  pruneOrphans: (aliveWorkflowIds: readonly string[]) => void
}

/** 终态判定（终态后迟到的节点事件不再进槽） */
function isTerminal(status: WorkflowExecutionUiState['status']): boolean {
  return status !== 'running'
}

/** 节点已完成口径（进度计数的 N）：终态词集——passed / failed / cancelled /
 * skipped，queued / running 过程态不计 */
const NODE_DONE_STATUSES: ReadonlySet<NodeExecutionStatus> = new Set([
  'passed',
  'failed',
  'cancelled',
  'skipped',
])

/**
 * 执行进度计数（清单行 running 徽标面，纯派生）：total＝order 长度
 * （node.queued 到达序），done＝nodes 中已达终态的节点数（nodes 与 order
 * 同源增长——queued 事件同时落两侧）。order 为空（乐观态、事件未达）返回
 * null——徽标只显示「执行中」不带计数；终态槽位语义不变，是否展示由
 * 消费方按 running 态决定。
 */
export function executionProgress(
  slot: Pick<WorkflowExecutionUiState, 'nodes' | 'order'>,
): { done: number; total: number } | null {
  if (slot.order.length === 0) return null
  let done = 0
  for (const node of Object.values(slot.nodes)) {
    if (NODE_DONE_STATUSES.has(node.status)) done += 1
  }
  return { done, total: slot.order.length }
}

/** 事件归属反查（executionId → 槽位；未知 executionId 返回 undefined） */
function resolveSlot(
  state: Pick<WorkflowExecutionState, 'executions' | 'executionIndex'>,
  executionId: string,
): WorkflowExecutionUiState | undefined {
  const workflowId = state.executionIndex[executionId]
  return workflowId ? state.executions[workflowId] : undefined
}

/** 单事件归约（不可变更新；未知 executionId 返回原 state） */
export function reduceExecutionEvent(
  state: Pick<WorkflowExecutionState, 'executions' | 'executionIndex'>,
  event: WorkflowExecutionEvent,
): Pick<WorkflowExecutionState, 'executions' | 'executionIndex'> {
  switch (event.event) {
    case 'workflow.started': {
      const previous = state.executions[event.workflowId]
      const merged: WorkflowExecutionUiState = {
        executionId: event.executionId,
        workflowId: event.workflowId,
        // 乐观槽（startLocal 置 running）与 started 事件对齐时保留 running
        status: 'running',
        nodes: previous?.status === 'running' ? previous.nodes : {},
        order: previous?.status === 'running' ? previous.order : [],
        activeEdgeIds: new Set(),
      }
      return {
        executions: { ...state.executions, [event.workflowId]: merged },
        executionIndex: { ...state.executionIndex, [event.executionId]: event.workflowId },
      }
    }
    case 'node.queued':
    case 'node.started':
    case 'node.completed':
    case 'node.failed':
    case 'node.cancelled':
    case 'node.skipped':
    case 'edge.activated': {
      const current = resolveSlot(state, event.executionId)
      if (!current || isTerminal(current.status)) return state
      return {
        ...state,
        executions: {
          ...state.executions,
          [current.workflowId]: applyNodeOrEdgeEvent(current, event),
        },
      }
    }
    case 'workflow.completed':
    case 'workflow.failed':
    case 'workflow.cancelled': {
      const current = resolveSlot(state, event.executionId)
      if (!current || isTerminal(current.status)) return state
      const workflowId = current.workflowId
      // 终态即摘除事件索引（执行已结束，索引无后续用途；防长会话累积）
      const executionIndex = { ...state.executionIndex }
      delete executionIndex[event.executionId]
      return {
        executions: {
          ...state.executions,
          [workflowId]: {
            ...current,
            status:
              event.event === 'workflow.completed'
                ? 'passed'
                : event.event === 'workflow.failed'
                  ? 'failed'
                  : 'cancelled',
            durationMs: event.durationMs,
            errorCode: event.event === 'workflow.failed' ? event.errorCode : null,
            errorMessage: event.event === 'workflow.failed' ? event.errorMessage : null,
            // 结束即停：清空活跃边（动画停止）
            activeEdgeIds: new Set(),
          },
        },
        executionIndex,
      }
    }
  }
}

/** 节点 / 边事件归约到单槽（前置条件：槽位存在且未终态） */
function applyNodeOrEdgeEvent(
  current: WorkflowExecutionUiState,
  event: Extract<WorkflowExecutionEvent, { event: `node.${string}` | 'edge.activated' }>,
): WorkflowExecutionUiState {
  if (event.event === 'edge.activated') {
    if (current.activeEdgeIds.has(event.edgeId)) return current
    const nextEdges = new Set(current.activeEdgeIds)
    nextEdges.add(event.edgeId)
    return { ...current, activeEdgeIds: nextEdges }
  }
  const nodeId = event.nodeId
  const previous = current.nodes[nodeId]
  switch (event.event) {
    case 'node.queued': {
      if (previous) return current
      const order = current.order.includes(nodeId) ? current.order : [...current.order, nodeId]
      return { ...current, order, nodes: { ...current.nodes, [nodeId]: { status: 'queued' } } }
    }
    case 'node.started':
      if (previous?.status !== 'queued') return current
      return {
        ...current,
        nodes: { ...current.nodes, [nodeId]: { ...previous, status: 'running' } },
      }
    case 'node.completed':
      return {
        ...current,
        nodes: {
          ...current.nodes,
          [nodeId]: {
            ...previous,
            status: 'passed',
            durationMs: event.durationMs,
            output: event.output,
            assertions: event.assertions,
          },
        },
      }
    case 'node.failed':
      return {
        ...current,
        nodes: {
          ...current.nodes,
          [nodeId]: {
            ...previous,
            status: 'failed',
            errorCode: event.errorCode,
            errorMessage: event.errorMessage,
            assertions: event.assertions,
          },
        },
      }
    case 'node.cancelled':
      return {
        ...current,
        nodes: { ...current.nodes, [nodeId]: { ...previous, status: 'cancelled' } },
      }
    case 'node.skipped':
      return {
        ...current,
        nodes: { ...current.nodes, [nodeId]: { ...previous, status: 'skipped' } },
      }
  }
}

const NODE_RECORD_STATUSES = [
  'queued',
  'running',
  'passed',
  'failed',
  'cancelled',
  'skipped',
] as const

/** 节点状态词运行时防护（Rust 词表演进快于前端镜像时不冒充已知态，回落 skipped） */
function isNodeStatus(value: string): value is (typeof NODE_RECORD_STATUSES)[number] {
  return (NODE_RECORD_STATUSES as readonly string[]).includes(value)
}

/** 记录态限终态三向（回看面只承载已结束的执行；非终态与未知词回落 cancelled——中性弱化，不冒充成功） */
const TERMINAL_RECORD_STATUSES = ['passed', 'failed', 'cancelled'] as const

function isTerminalRecordStatus(value: string): value is (typeof TERMINAL_RECORD_STATUSES)[number] {
  return (TERMINAL_RECORD_STATUSES as readonly string[]).includes(value)
}

/** 终态记录 → UI 态（执行面板回看播种；库序＝执行序＋skipped 尾部） */
function fromRecord(dto: WorkflowExecutionDto): WorkflowExecutionUiState {
  const nodes: Record<string, NodeExecutionUiState> = {}
  for (const record of dto.nodes) {
    nodes[record.nodeId] = fromRecordNode(record)
  }
  return {
    executionId: dto.id,
    workflowId: dto.workflowId,
    status: isTerminalRecordStatus(dto.status) ? dto.status : 'cancelled',
    durationMs: dto.durationMs ?? undefined,
    errorCode: dto.errorCode,
    errorMessage: dto.errorMessage,
    nodes,
    order: dto.nodes.map((record) => record.nodeId),
    activeEdgeIds: new Set(),
  }
}

function fromRecordNode(record: NodeExecutionDto): NodeExecutionUiState {
  return {
    status: isNodeStatus(record.status) ? record.status : 'skipped',
    durationMs: record.durationMs ?? undefined,
    errorCode: record.errorCode ?? undefined,
    errorMessage: record.errorMessage ?? undefined,
    output: record.output ?? undefined,
    assertions: record.assertions,
    request: record.request ?? undefined,
    response: record.response ?? undefined,
    writebacks: record.writebacks,
  }
}

export const useWorkflowExecutionStore = create<WorkflowExecutionState>((set, get) => ({
  executions: {},
  executionIndex: {},

  applyEvent: (event) => {
    set((state) => reduceExecutionEvent(state, event))
  },

  seedFromRecord: (dto) => {
    set((state) => {
      // 在途执行优先于历史记录（事件流已推进的面不被旧记录回滚）
      const current = state.executions[dto.workflowId]
      if (current && current.status === 'running') return state
      return {
        ...state,
        executions: { ...state.executions, [dto.workflowId]: fromRecord(dto) },
        executionIndex: { ...state.executionIndex, [dto.id]: dto.workflowId },
      }
    })
  },

  startLocal: (workflowId) => {
    set((state) => {
      if (state.executions[workflowId]?.status === 'running') return state
      return {
        ...state,
        executions: {
          ...state.executions,
          [workflowId]: {
            executionId: '',
            workflowId,
            status: 'running',
            nodes: {},
            order: [],
            activeEdgeIds: new Set(),
          },
        },
      }
    })
  },

  failLocal: (workflowId) => {
    set((state) => {
      const slot = state.executions[workflowId]
      if (!slot || slot.executionId !== '' || slot.status !== 'running') return state
      const executions = { ...state.executions }
      delete executions[workflowId]
      return { ...state, executions }
    })
  },

  pruneOrphans: (aliveWorkflowIds) => {
    const alive = new Set(aliveWorkflowIds)
    for (const workflowId of Object.keys(get().executions)) {
      if (!alive.has(workflowId)) get().dispose(workflowId)
    }
  },

  dispose: (workflowId) => {
    const current = get().executions[workflowId]
    if (!current) return
    // 取消在途执行（幂等；无在途任务时 no-op）。取消失败只影响本次执行
    // 的中止时效（后端执行照常收尾落库），不阻塞 Tab 关闭
    void workflowCancel(workflowId).catch((error) => reportError(error))
    set((state) => {
      const executions = { ...state.executions }
      const executionIndex = { ...state.executionIndex }
      delete executions[workflowId]
      if (current.executionId !== '') delete executionIndex[current.executionId]
      return { executions, executionIndex }
    })
  },
}))
