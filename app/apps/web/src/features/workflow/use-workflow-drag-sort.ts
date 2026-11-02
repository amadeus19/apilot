import * as React from 'react'

import type { TreeDropMode, TreeRowData } from '@workspace/ui/components'

import { computeWorkflowTreeDrop, type WorkflowDropAction } from './workflow-dnd'
import type { WorkflowNavIndex, WorkflowNavNode } from './workflow-nav-tree'

/**
 * 工作流树拖拽排序接线：源行与落点判定在事件链间共享（ref），落到
 * TreePrimitive 的拖拽回调形态。搜索过滤的树是子图，落点序号不可信，
 * 过滤中整树禁拖（与接口树同口径）。移动动作经调用方注入的 mutation
 * 通道下发（工作流移动失效 list、分组移动失效 groups，失效面归调用方）。
 */
export function useWorkflowDragSort(options: {
  index: WorkflowNavIndex
  /** 搜索过滤中＝整树禁拖 */
  searchActive: boolean
  onMoveWorkflow: (input: { id: string; groupId: string | null; index: number }) => void
  onMoveGroup: (input: { id: string; index: number }) => void
}): {
  isRowDraggable: (row: TreeRowData<WorkflowNavNode>) => boolean
  handleRowDragStart: (row: TreeRowData<WorkflowNavNode>, event: React.DragEvent) => void
  handleRowDragOver: (
    row: TreeRowData<WorkflowNavNode>,
    event: React.DragEvent,
  ) => TreeDropMode | null
  handleRowDrop: () => void
  handleRowDragEnd: () => void
} {
  const { index, searchActive, onMoveWorkflow, onMoveGroup } = options
  const dragSourceRef = React.useRef<WorkflowNavNode | null>(null)
  const dropActionRef = React.useRef<ReturnType<typeof computeWorkflowTreeDrop> | null>(null)

  // 拖拽开关只看搜索过滤态（整树同质，不分行判定）；签名与回调形态对齐
  const isRowDraggable = React.useCallback(() => !searchActive, [searchActive])

  const handleRowDragStart = (row: TreeRowData<WorkflowNavNode>, event: React.DragEvent): void => {
    dragSourceRef.current = row.data
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', row.data.name)
  }

  const handleRowDragOver = (
    row: TreeRowData<WorkflowNavNode>,
    event: React.DragEvent,
  ): TreeDropMode | null => {
    const source = dragSourceRef.current
    if (!source) return null
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5
    const result = computeWorkflowTreeDrop(source, row.data, ratio, index)
    dropActionRef.current = result
    return result?.indicator ?? null
  }

  const handleRowDrop = (): void => {
    const source = dragSourceRef.current
    const result: WorkflowDropAction | null = dropActionRef.current?.action ?? null
    dropActionRef.current = null
    dragSourceRef.current = null
    if (!source || !result) return
    if (result.kind === 'workflow') {
      onMoveWorkflow({ id: result.id, groupId: result.groupId, index: result.index })
    } else {
      onMoveGroup({ id: result.id, index: result.index })
    }
  }

  const handleRowDragEnd = (): void => {
    dragSourceRef.current = null
    dropActionRef.current = null
  }

  return {
    isRowDraggable,
    handleRowDragStart,
    handleRowDragOver,
    handleRowDrop,
    handleRowDragEnd,
  }
}
