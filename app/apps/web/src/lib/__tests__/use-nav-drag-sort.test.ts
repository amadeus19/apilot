import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useNavDragSort } from '@/lib/use-nav-drag-sort'

/**
 * 导航拖拽排序协议 hook 测试：jsdom 无真实 HTML5 DnD，直调回调 handler。
 * 重点钉 hint 守卫单点——drop 只认「最后悬停判定可落且目标行一致」，
 * dragOver 与 drop 目标错位时丢弃陈旧判定、判定不可落时清待下发动作。
 */

interface FakeNode {
  id: string
  name: string
}

const node = (id: string): FakeNode => ({ id, name: id })

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

/** 判定桩：bad 行不可落，其余上下半分 before/after，动作记作「源->目标」 */
function setup() {
  const onAction = vi.fn()
  const { result } = renderHook(() =>
    useNavDragSort<FakeNode, FakeNode, string>({
      getNode: (item) => item,
      computeDrop: (source, target, ratio) =>
        target.id === 'bad'
          ? null
          : {
              indicator: ratio < 0.5 ? 'before' : 'after',
              action: `${source.id}->${target.id}`,
            },
      onAction,
    }),
  )
  return { result, onAction }
}

describe('useNavDragSort', () => {
  it('dragStart 记录源行并设置拖拽数据（效果 move、文本＝行名）', () => {
    const { result } = setup()
    const event = dragStartEvent()
    result.current.handleDragStart(node('a'), event)
    expect(event.dataTransfer.effectAllowed).toBe('move')
    expect(event.dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'a')
  })

  it('dragOver 判定可落：记录待下发动作并返回指示器（上下半分）', () => {
    const { result } = setup()
    result.current.handleDragStart(node('a'), dragStartEvent())
    expect(result.current.handleDragOver(node('b'), dragOverEvent(10))).toBe('before')
    expect(result.current.handleDragOver(node('b'), dragOverEvent(90))).toBe('after')
  })

  it('drop 目标与最后悬停判定一致才下发', () => {
    const { result, onAction } = setup()
    result.current.handleDragStart(node('a'), dragStartEvent())
    result.current.handleDragOver(node('b'), dragOverEvent(10))
    result.current.handleDrop(node('b'))
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith('a->b')
  })

  it('判定不可落清待下发动作：此后 drop 不下发（含换回可落行）', () => {
    const { result, onAction } = setup()
    result.current.handleDragStart(node('a'), dragStartEvent())
    expect(result.current.handleDragOver(node('bad'), dragOverEvent(10))).toBeNull()
    result.current.handleDrop(node('bad'))
    result.current.handleDrop(node('b'))
    expect(onAction).not.toHaveBeenCalled()
  })

  it('drop 目标错位丢弃陈旧判定（hint 守卫）：错位落下不下发，状态随落下清空', () => {
    const { result, onAction } = setup()
    result.current.handleDragStart(node('a'), dragStartEvent())
    result.current.handleDragOver(node('b'), dragOverEvent(10))
    result.current.handleDrop(node('c'))
    expect(onAction).not.toHaveBeenCalled()
    // 守卫未通过同样按「已落下」清状态：换回判定行补 drop 不二次下发
    result.current.handleDrop(node('b'))
    expect(onAction).not.toHaveBeenCalled()
  })

  it('drop 前无悬停判定（未 dragOver）不下发', () => {
    const { result, onAction } = setup()
    result.current.handleDragStart(node('a'), dragStartEvent())
    result.current.handleDrop(node('b'))
    expect(onAction).not.toHaveBeenCalled()
  })

  it('dragEnd 清事件链状态：此后 drop 不下发', () => {
    const { result, onAction } = setup()
    result.current.handleDragStart(node('a'), dragStartEvent())
    expect(result.current.handleDragOver(node('b'), dragOverEvent(90))).toBe('after')
    result.current.handleDragEnd()
    result.current.handleDrop(node('b'))
    expect(onAction).not.toHaveBeenCalled()
  })

  it('getNode 取不到节点的行不参与协议（起拖与悬停均忽略）', () => {
    const onAction = vi.fn()
    const { result } = renderHook(() =>
      useNavDragSort<FakeNode, FakeNode, string>({
        getNode: (item) => (item.id === 'ghost' ? null : item),
        computeDrop: (source, target) => ({
          indicator: 'before',
          action: `${source.id}->${target.id}`,
        }),
        onAction,
      }),
    )
    result.current.handleDragStart(node('ghost'), dragStartEvent())
    expect(result.current.handleDragOver(node('b'), dragOverEvent(10))).toBeNull()
    result.current.handleDrop(node('b'))
    expect(onAction).not.toHaveBeenCalled()
  })
})
