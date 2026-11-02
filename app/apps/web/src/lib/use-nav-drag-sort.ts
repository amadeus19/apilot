import * as React from 'react'

import type { TreeDropMode } from '@workspace/ui/components'

/**
 * 导航行拖拽排序协议（树行与表格行共用）：源行与落点判定在事件链间共享
 * （ref），dragOver 判定可落时记录待下发动作并返回指示器形态；drop 只认
 * 「最后悬停判定可落且目标行一致」——两事件目标错位时丢弃陈旧判定
 * （hint 守卫单点，与树原语的行级 drop 分发同语义）。落点判定函数与
 * 动作下发归调用方注入，本 hook 只持协议状态；指示器呈现（树原语自绘 /
 * 表格行自持 state）不在此层。
 */

/** 悬停位置 → 落点意图：无容器落点的导航树一律上下半分（两域 nav-dnd 共用单点） */
export function navDropModeAt(ratio: number): TreeDropMode {
  return ratio < 0.5 ? 'before' : 'after'
}

export function useNavDragSort<N extends { id: string; name: string }, T, A>(options: {
  /** 业务行 → 导航节点（占位行等取不到节点的行不参与协议） */
  getNode: (item: T) => N | null
  /** 落点判定（ratio＝悬停点在行内纵向比例，0 顶 1 底）；null＝不可落 */
  computeDrop: (
    source: N,
    target: N,
    ratio: number,
  ) => { indicator: TreeDropMode; action: A } | null
  /** 守卫通过后下发（mutation 与错误处理归调用方） */
  onAction: (action: A) => void
}): {
  handleDragStart: (item: T, event: React.DragEvent) => void
  /** 返回指示器形态（null＝此处不可落）；可落时的 preventDefault 归调用方 */
  handleDragOver: (item: T, event: React.DragEvent) => TreeDropMode | null
  /** 落下：仅最后悬停判定可落且目标行一致时下发 */
  handleDrop: (item: T) => void
  /** 拖拽结束（落下与否都触发）：清事件链状态 */
  handleDragEnd: () => void
} {
  const { getNode, computeDrop, onAction } = options
  const sourceRef = React.useRef<N | null>(null)
  // 拖拽事件链间共享的待下发动作（targetId＝指示器所在行；null＝当前不可落）
  const pendingRef = React.useRef<{ targetId: string; action: A } | null>(null)

  const handleDragStart = (item: T, event: React.DragEvent): void => {
    const node = getNode(item)
    if (!node) return
    sourceRef.current = node
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', node.name)
  }

  const handleDragOver = (item: T, event: React.DragEvent): TreeDropMode | null => {
    const source = sourceRef.current
    const target = getNode(item)
    if (!source || !target) return null
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5
    const result = computeDrop(source, target, ratio)
    pendingRef.current = result ? { targetId: target.id, action: result.action } : null
    return result?.indicator ?? null
  }

  const handleDrop = (item: T): void => {
    const pending = pendingRef.current
    const node = getNode(item)
    const action =
      pending !== null && node !== null && pending.targetId === node.id ? pending.action : null
    sourceRef.current = null
    pendingRef.current = null
    if (!action) return
    onAction(action)
  }

  const handleDragEnd = (): void => {
    sourceRef.current = null
    pendingRef.current = null
  }

  return { handleDragStart, handleDragOver, handleDrop, handleDragEnd }
}
