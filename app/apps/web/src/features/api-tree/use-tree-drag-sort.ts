import * as React from 'react'

import type { TreeDropMode, TreeRowData } from '@workspace/ui/components'

import { ENDPOINT_DRAG_MIME, encodeEndpointDragPayload } from '@/features/workflow/endpoint-dnd'

import { computeTreeDrop } from './tree-dnd'
import { PINNED_GROUP_ID, type ApiTreeIndex, type ApiTreeNode } from './selector'
import type { TreeMutations } from './use-tree-mutations'

/**
 * 树拖拽排序接线：源行与落点判定在事件链间共享（ref），落到
 * TreePrimitive 的五个回调形态。过滤模式的树是子图，落点序号不可信，
 * 整树禁拖；置顶组行与其内接口不参与排序（组内位置由置顶决定）。
 * 接口行拖出同时携带工作流载荷（拖到工作流画布＝创建已绑定请求节点，
 * 绑定唯一入口），effectAllowed 放开 copy——树内排序仍走 move。
 */
export function useTreeDragSort(options: {
  activeIndex: ApiTreeIndex | null
  filterActive: boolean
  mutations: TreeMutations
  onError: (error: unknown) => void
}): {
  isRowDraggable: (row: TreeRowData<ApiTreeNode>) => boolean
  handleRowDragStart: (row: TreeRowData<ApiTreeNode>, event: React.DragEvent) => void
  handleRowDragOver: (row: TreeRowData<ApiTreeNode>, event: React.DragEvent) => TreeDropMode | null
  handleRowDrop: () => void
  handleRowDragEnd: () => void
} {
  const { activeIndex, filterActive, mutations, onError } = options
  const dragSourceRef = React.useRef<ApiTreeNode | null>(null)
  const dropActionRef = React.useRef<ReturnType<typeof computeTreeDrop> | null>(null)

  const isRowDraggable = React.useCallback(
    (row: TreeRowData<ApiTreeNode>): boolean => {
      if (filterActive) return false
      const node = row.data
      if (node.kind === 'pinnedGroup') return false
      return !node.parentIds.includes(PINNED_GROUP_ID)
    },
    [filterActive],
  )

  const handleRowDragStart = (row: TreeRowData<ApiTreeNode>, event: React.DragEvent): void => {
    dragSourceRef.current = row.data
    // 接口行＝双通道载荷：排序（树内 move）＋工作流绑定（画布 copy）
    if (row.data.kind === 'endpoint' && row.data.key && row.data.serviceId) {
      event.dataTransfer.effectAllowed = 'copyMove'
      event.dataTransfer.setData(
        ENDPOINT_DRAG_MIME,
        encodeEndpointDragPayload({
          serviceId: row.data.serviceId,
          key: row.data.key,
          method: row.data.method ?? '',
          pathTemplate: row.data.pathTemplate ?? '',
          name: row.data.name,
        }),
      )
    } else {
      event.dataTransfer.effectAllowed = 'move'
    }
    event.dataTransfer.setData('text/plain', row.data.name)
  }

  const handleRowDragOver = (
    row: TreeRowData<ApiTreeNode>,
    event: React.DragEvent,
  ): TreeDropMode | null => {
    const source = dragSourceRef.current
    if (!source || !activeIndex) return null
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5
    const result = computeTreeDrop(source, row.data, ratio, activeIndex)
    dropActionRef.current = result
    return result?.indicator ?? null
  }

  const handleRowDrop = (): void => {
    const source = dragSourceRef.current
    const result = dropActionRef.current
    dropActionRef.current = null
    dragSourceRef.current = null
    if (!source || !result) return
    const action = result.action
    if (action.kind === 'endpoint' && source.key) {
      mutations.endpointMoveMutation.mutate(
        {
          serviceId: action.serviceId,
          key: source.key,
          categoryId: action.categoryId,
          index: action.index,
        },
        { onError },
      )
    } else if (action.kind === 'category') {
      mutations.categoryMoveToMutation.mutate(
        { id: action.id, targetServiceId: action.targetServiceId, index: action.index },
        { onError },
      )
    } else if (action.kind === 'service') {
      mutations.serviceMoveToMutation.mutate({ id: action.id, index: action.index }, { onError })
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
