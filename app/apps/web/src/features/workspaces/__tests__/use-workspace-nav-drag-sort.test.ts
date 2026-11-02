import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { TreeRowData } from '@workspace/ui/components'

import { useWorkspaceNavDragSort } from '../use-workspace-nav-drag-sort'
import type { WorkspaceNavIndex, WorkspaceNavNode } from '../workspace-nav-dnd'

/**
 * 树拖拽排序 hook 测试：jsdom 无法真实 HTML5 DnD，按接口树口径直调
 * 回调 handler，断言 mutation 调用与入参（工作空间整批有序 id 表 /
 * 服务摘除自身插入位）、不可落与 drop 目标错位（hint 守卫）时不下发。
 */

const ws = (id: string): WorkspaceNavNode => ({ kind: 'workspace', id, name: id, isCurrent: false })
const svc = (id: string, workspaceId: string): WorkspaceNavNode => ({
  kind: 'service',
  id,
  workspaceId,
  name: id,
  docUrl: null,
})

/** 根层 [w1, w2]；w1 服务 [s1, s2] */
const index: WorkspaceNavIndex = {
  nodes: new Map([
    ['w1', ws('w1')],
    ['w2', ws('w2')],
    ['s1', svc('s1', 'w1')],
    ['s2', svc('s2', 'w1')],
  ]),
  rootChildren: ['w1', 'w2'],
  childrenOf: new Map([['w1', ['s1', 's2']]]),
}

const row = (node: WorkspaceNavNode): TreeRowData<WorkspaceNavNode> => ({
  id: node.id,
  name: node.name,
  data: node,
  depth: 0,
  indentPx: 0,
  isFolder: node.kind === 'workspace',
  isExpanded: false,
  isSelected: false,
  isFocused: false,
})

/** 伪造 DragEvent：dataTransfer 可记录 setData，纵向比例经 clientY/rect 控制 */
const dragStartEvent = () =>
  ({
    dataTransfer: { effectAllowed: '', setData: vi.fn() },
  }) as unknown as React.DragEvent

const dragOverEvent = (clientY: number) =>
  ({
    clientY,
    currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 100 }) },
    dataTransfer: { dropEffect: '' },
    preventDefault: vi.fn(),
  }) as unknown as React.DragEvent

function setup() {
  const reorderMutate = vi.fn()
  const moveToMutate = vi.fn()
  const onError = vi.fn()
  const { result } = renderHook(() =>
    useWorkspaceNavDragSort({
      index,
      mutations: {
        reorderMutation: { mutate: reorderMutate },
        serviceMoveToMutation: { mutate: moveToMutate },
      },
      onError,
    }),
  )
  return { result, reorderMutate, moveToMutate, onError }
}

describe('useWorkspaceNavDragSort', () => {
  it('两类行均开放拖拽（手柄武装制在树原语内判定）', () => {
    const { result } = setup()
    expect(result.current.isRowDraggable(row(ws('w1')))).toBe(true)
    expect(result.current.isRowDraggable(row(svc('s1', 'w1')))).toBe(true)
  })

  it('工作空间行落下＝reorder 携整批有序 id 表', () => {
    const { result, reorderMutate, moveToMutate } = setup()
    result.current.handleRowDragStart(row(ws('w2')), dragStartEvent())
    expect(result.current.handleRowDragOver(row(ws('w1')), dragOverEvent(10))).toBe('before')
    result.current.handleRowDrop(row(ws('w1')))
    expect(reorderMutate).toHaveBeenCalledTimes(1)
    expect(reorderMutate).toHaveBeenCalledWith(['w2', 'w1'], { onError: expect.any(Function) })
    expect(moveToMutate).not.toHaveBeenCalled()
  })

  it('服务行落下＝move_to 携摘除自身后的插入位', () => {
    const { result, reorderMutate, moveToMutate } = setup()
    result.current.handleRowDragStart(row(svc('s2', 'w1')), dragStartEvent())
    expect(result.current.handleRowDragOver(row(svc('s1', 'w1')), dragOverEvent(10))).toBe('before')
    result.current.handleRowDrop(row(svc('s1', 'w1')))
    expect(moveToMutate).toHaveBeenCalledWith(
      { id: 's2', index: 0 },
      {
        onError: expect.any(Function),
      },
    )
    expect(reorderMutate).not.toHaveBeenCalled()
  })

  it('不可落（跨空间）不显示指示且落下不下发', () => {
    const { result, reorderMutate, moveToMutate } = setup()
    result.current.handleRowDragStart(row(svc('s1', 'w1')), dragStartEvent())
    expect(result.current.handleRowDragOver(row(ws('w2')), dragOverEvent(50))).toBeNull()
    result.current.handleRowDrop(row(ws('w2')))
    expect(reorderMutate).not.toHaveBeenCalled()
    expect(moveToMutate).not.toHaveBeenCalled()
  })

  it('drop 目标与悬停判定行错位不下发（hint 守卫）', () => {
    const { result, reorderMutate, moveToMutate } = setup()
    result.current.handleRowDragStart(row(svc('s2', 'w1')), dragStartEvent())
    expect(result.current.handleRowDragOver(row(svc('s1', 'w1')), dragOverEvent(10))).toBe('before')
    // 落到非判定行：丢弃陈旧判定；换回判定行补 drop 同样不下发（已清）
    result.current.handleRowDrop(row(svc('s2', 'w1')))
    result.current.handleRowDrop(row(svc('s1', 'w1')))
    expect(moveToMutate).not.toHaveBeenCalled()
    expect(reorderMutate).not.toHaveBeenCalled()
  })

  it('拖拽结束清空事件链状态：此后落下不下发', () => {
    const { result, moveToMutate } = setup()
    result.current.handleRowDragStart(row(svc('s1', 'w1')), dragStartEvent())
    expect(result.current.handleRowDragOver(row(svc('s2', 'w1')), dragOverEvent(90))).toBe('after')
    result.current.handleRowDragEnd()
    result.current.handleRowDrop(row(svc('s2', 'w1')))
    expect(moveToMutate).not.toHaveBeenCalled()
  })
})
