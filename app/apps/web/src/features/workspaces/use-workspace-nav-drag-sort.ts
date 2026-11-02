import * as React from 'react'

import type { TreeDropMode, TreeRowData } from '@workspace/ui/components'

import { useNavDragSort } from '@/lib/use-nav-drag-sort'
import {
  computeNavDrop,
  type WorkspaceNavDropAction,
  type WorkspaceNavIndex,
  type WorkspaceNavNode,
} from './workspace-nav-dnd'

/** 拖拽消费的 mutation 最小面（结构形态，真实 hook 结果与测试桩均可赋值） */
export interface WorkspaceNavDragMutations {
  reorderMutation: {
    mutate: (orderedIds: string[], options?: { onError: (error: unknown) => void }) => void
  }
  serviceMoveToMutation: {
    mutate: (
      input: { id: string; index: number },
      options?: { onError: (error: unknown) => void },
    ) => void
  }
}

/**
 * 左栏工作空间树拖拽排序接线：拖拽协议（源行共享、hint 守卫、指示器）
 * 归 useNavDragSort 单点，本层只把两级树的两类排序动作（工作空间整批
 * reorder / 服务 move_to）接到共享 mutation 组。两级树无排序落点分支，
 * 全部行可拖——搜索过滤模式不设本层分支：过滤子图的手柄在视图侧隐藏，
 * 行拖拽必须经手柄武装，不可武装即不可拖。可落性与插入位由 computeNavDrop
 * 判定，落库失败由缓存失效重拉回真值，本层不写回滚。
 */
export function useWorkspaceNavDragSort(options: {
  index: WorkspaceNavIndex
  mutations: WorkspaceNavDragMutations
  onError: (error: unknown) => void
}): {
  isRowDraggable: (row: TreeRowData<WorkspaceNavNode>) => boolean
  handleRowDragStart: (row: TreeRowData<WorkspaceNavNode>, event: React.DragEvent) => void
  handleRowDragOver: (
    row: TreeRowData<WorkspaceNavNode>,
    event: React.DragEvent,
  ) => TreeDropMode | null
  handleRowDrop: (row: TreeRowData<WorkspaceNavNode>) => void
  handleRowDragEnd: () => void
} {
  const { index, mutations, onError } = options

  // 手柄武装制由 TreePrimitive 承担，两类行（工作空间 / 服务）都开放拖拽
  const isRowDraggable = React.useCallback((): boolean => true, [])

  const drag = useNavDragSort<
    WorkspaceNavNode,
    TreeRowData<WorkspaceNavNode>,
    WorkspaceNavDropAction
  >({
    getNode: (row) => row.data,
    computeDrop: (source, target, ratio) => computeNavDrop(source, target, ratio, index),
    onAction: (action) => {
      if (action.kind === 'workspace') {
        mutations.reorderMutation.mutate(action.orderedIds, { onError })
      } else {
        mutations.serviceMoveToMutation.mutate({ id: action.id, index: action.index }, { onError })
      }
    },
  })

  return {
    isRowDraggable,
    handleRowDragStart: drag.handleDragStart,
    handleRowDragOver: drag.handleDragOver,
    handleRowDrop: drag.handleDrop,
    handleRowDragEnd: drag.handleDragEnd,
  }
}
