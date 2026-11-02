import * as React from "react"

/**
 * 坐标右键菜单的公共接线：受控 ContextMenu + 虚拟坐标锚点。
 *
 * 浮层定位无触发元素可锚（右键 / 键盘 Menu 键给出的是视口坐标），
 * 以零宽高矩形充当锚点供 Positioner 定位；关闭退场动画期间
 * （open=false 之后）沿用最后坐标——否则锚点落 undefined，浮层
 * 退场时闪现到视口左上角。两段行为是坐标菜单的本体，收敛于此，
 * 消费方只声明 openAt / close。
 */

/** 虚拟锚点：以视口坐标为左上角的零宽高矩形 */
export interface PointAnchor {
  getBoundingClientRect: () => {
    x: number
    y: number
    top: number
    left: number
    right: number
    bottom: number
    width: number
    height: number
  }
}

/** 构造坐标锚点（浮层贴坐标展开；需要单独锚点对象的场景直用） */
export function makePointAnchor(x: number, y: number): PointAnchor {
  return {
    getBoundingClientRect: () => ({
      x,
      y,
      top: y,
      left: x,
      right: x,
      bottom: y,
      width: 0,
      height: 0,
    }),
  }
}

export function usePointContextMenu(): {
  open: boolean
  anchor: PointAnchor | undefined
  /** 在视口坐标处打开（已在开态则移动到新坐标） */
  openAt: (x: number, y: number) => void
  close: () => void
} {
  const [position, setPosition] = React.useState<{ x: number; y: number } | null>(null)
  // 退场动画期间保持最后坐标：渲染期调整模式记录最近一次非空坐标
  // （position 清空后锚点仍指向它，浮层退场不闪现到视口左上角）
  const [lastPosition, setLastPosition] = React.useState<{ x: number; y: number } | null>(null)
  if (position && position !== lastPosition) {
    setLastPosition(position)
  }

  const anchor = React.useMemo(() => {
    const point = position ?? lastPosition
    return point ? makePointAnchor(point.x, point.y) : undefined
  }, [position, lastPosition])

  const openAt = React.useCallback((x: number, y: number) => setPosition({ x, y }), [])
  const close = React.useCallback(() => setPosition(null), [])

  return { open: position !== null, anchor, openAt, close }
}
