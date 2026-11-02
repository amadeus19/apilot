import { cn } from 'cn'

import {
  useExecutionStatusLabel,
  EXECUTION_STATUS_VISUALS,
  useNodeExecutionState,
} from './execution-state'

/**
 * 节点执行态视觉：卡片右上角状态徽标（图标与配色取执行状态单一映射源）。
 * running 克制脉冲（图标旋转，无边框大面积高亮）。无执行态（未运行 /
 * 已清理）＝无徽标，纯编辑态。整卡着色与弱化 class 见 execution-state。
 */

/** 卡片右上角状态徽标（编辑态不渲染） */
export function NodeExecutionBadge({ nodeId }: { nodeId: string }) {
  const labelOf = useExecutionStatusLabel()
  const state = useNodeExecutionState(nodeId)
  if (!state) return null
  const visual = EXECUTION_STATUS_VISUALS[state.status]
  const Icon = visual.icon
  return (
    <span
      className={cn(
        'absolute -top-1 -right-1 flex size-3.5 items-center justify-center rounded-full',
        visual.badgeClassName,
        state.status === 'running' && 'animate-pulse',
      )}
      data-testid="workflow-node-execution-badge"
      data-status={state.status}
      title={labelOf(state.status)}
    >
      <Icon aria-hidden className={cn('size-2.5', state.status === 'running' && 'animate-spin')} />
    </span>
  )
}
