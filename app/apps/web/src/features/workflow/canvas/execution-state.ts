import * as React from 'react'

import {
  CheckCircleIcon,
  CircleDashedIcon,
  LoaderCircleIcon,
  MinusCircleIcon,
  SkipForwardIcon,
  XCircleIcon,
  type LucideIcon,
} from 'lucide-react'

import { useI18n, type DictKey } from '@/i18n'

import {
  useWorkflowExecutionStore,
  type NodeExecutionUiState,
  type WorkflowExecutionUiState,
} from '../execution.store'
import type { WorkflowFlowEdge } from '../canvas-converter'
import { WorkflowIdContext } from './workflow-id-context'

/**
 * 节点执行态 hooks 与状态视觉单一映射源（与组件文件分离导出，fast-refresh
 * 只容忍组件文件导出组件）。执行状态 → 图标 / 配色 / 文案的映射只有这一份：
 * 节点卡片徽标与执行面板行共用，防语义漂移（一个语义一个图标）。
 * 无执行态（未运行 / 已清理）返回 null，消费方回落编辑态呈现。
 */

/** 工作流级状态 → 文案键（控制台执行 tab 徽标共用；running 过程态同表） */
export const FLOW_STATUS_KEYS: Record<WorkflowExecutionUiState['status'], DictKey> = {
  running: 'workflows.executionStatusRunning',
  passed: 'workflows.executionStatusPassed',
  failed: 'workflows.executionStatusFailed',
  cancelled: 'workflows.executionStatusCancelled',
}

/** 执行状态视觉（徽标与面板行共用的单源映射；muted＝弱化族） */
export const EXECUTION_STATUS_VISUALS: Record<
  NodeExecutionUiState['status'],
  {
    icon: LucideIcon
    /** 卡片徽标配色（圆形底） */
    badgeClassName: string
    /** 面板行图标配色 */
    rowClassName: string
    muted: boolean
    labelKey: DictKey
  }
> = {
  passed: {
    icon: CheckCircleIcon,
    badgeClassName: 'bg-success text-success-foreground',
    rowClassName: 'text-success',
    muted: false,
    labelKey: 'workflows.executionStatusPassed',
  },
  running: {
    icon: LoaderCircleIcon,
    badgeClassName: 'bg-primary/90 text-primary-foreground',
    rowClassName: 'text-primary animate-spin',
    muted: false,
    labelKey: 'workflows.executionStatusRunning',
  },
  failed: {
    icon: XCircleIcon,
    badgeClassName: 'bg-destructive text-destructive-foreground',
    rowClassName: 'text-destructive',
    muted: false,
    labelKey: 'workflows.executionStatusFailed',
  },
  queued: {
    icon: CircleDashedIcon,
    badgeClassName: 'bg-muted-foreground/60 text-background',
    rowClassName: 'text-muted-foreground',
    muted: true,
    labelKey: 'workflows.executionStatusQueued',
  },
  skipped: {
    icon: SkipForwardIcon,
    badgeClassName: 'bg-muted-foreground/40 text-background',
    rowClassName: 'text-muted-foreground/60',
    muted: true,
    labelKey: 'workflows.executionStatusSkipped',
  },
  cancelled: {
    icon: MinusCircleIcon,
    badgeClassName: 'bg-muted-foreground/50 text-background',
    rowClassName: 'text-muted-foreground/70',
    muted: true,
    labelKey: 'workflows.executionStatusCancelled',
  },
}

/**
 * 运行中边执行视觉（animated 判定单源，与节点侧 EXECUTION_STATUS_VISUALS
 * 对称——边执行视觉只有这一份投影）：活跃边集非空时命中边加流动动画；
 * 执行结束（活跃集清空）或无执行（槽位不存在）原样返回静态边集。
 */
export function withEdgeExecutionAnimation(
  edges: WorkflowFlowEdge[],
  activeEdgeIds: ReadonlySet<string> | undefined,
): WorkflowFlowEdge[] {
  if (activeEdgeIds == null || activeEdgeIds.size === 0) return edges
  return edges.map((edge) => (activeEdgeIds.has(edge.id) ? { ...edge, animated: true } : edge))
}

/** 节点卡片执行态消费点：读执行态槽位中本节点的状态（无态返回 null） */
export function useNodeExecutionState(nodeId: string): NodeExecutionUiState | null {
  const workflowId = React.useContext(WorkflowIdContext)
  return useWorkflowExecutionStore((s) =>
    workflowId ? (s.executions[workflowId]?.nodes[nodeId] ?? null) : null,
  )
}

/** HTTP 2xx 判定（状态码配色单源：2xx 走成功色、其余走警示色；节点卡与
 * 执行面板共用，防「接口成功」配色语义漂移） */
export function isHttpSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300
}

/** 卡片执行态着色与弱化 class（编辑态恒空串；running 克制脉冲只着边框） */
export function useNodeExecutionClasses(nodeId: string): string {
  const state = useNodeExecutionState(nodeId)
  if (!state) return ''
  if (state.status === 'failed') return 'border-destructive/60'
  if (state.status === 'running') return 'border-primary/70 animate-pulse'
  if (EXECUTION_STATUS_VISUALS[state.status].muted) return 'opacity-55'
  return ''
}

/** 状态 → 本地化文案（徽标 title 与面板行共用） */
export function useExecutionStatusLabel(): (status: NodeExecutionUiState['status']) => string {
  const { t } = useI18n()
  return (status) => t(EXECUTION_STATUS_VISUALS[status].labelKey)
}
