/**
 * 节点选择面板的锚点几何：把「打开意图坐标」换算成画布容器本地坐标下的
 * 面板左上角（含可视区收口）与面板最大高度（底缘让位线兜底）。纯几何
 * 计算，供编辑器的两处挂载点（画布右键 / 悬浮工具栏「添加节点」）共用。
 */

/** 面板估宽 / 估高：宽＝w-72（288px），高按搜索框＋列表上限（26rem）＋
 * 动作行留保守余量。估高只用于锚点收口，真实高度可更矮——超出底缘让位线
 * 的部分由 maxHeight 压缩列表吸收，面板底缘恒不越线 */
export const NODE_PICKER_SIZE = { width: 288, height: 520 } as const

/** 面板与画布可视区边缘的最小间距 */
export const NODE_PICKER_MARGIN = 8

/** 悬浮工具栏让位空间：工具栏自身占位（bottom-3 ＋ p-1 ＋ h-8 按钮行＋
 * 边框 ≈ 54px）＋间隙。工具栏打开面板时面板底缘不得越过「画布高 − 让位
 * 空间」这条线，操作栏（含运行按钮）全程可见可点 */
export const NODE_PICKER_TOOLBAR_CLEARANCE = 64

/** 画布容器的可视尺寸（本地坐标口径） */
export interface CanvasLocalSize {
  width: number
  height: number
}

/** 面板在画布容器本地坐标下的摆放：左上角与最大高度（底缘让位线兜底） */
export interface PickerPanelPosition {
  left: number
  top: number
  maxHeight: number
}

/** 任意挂载点的面板锚点：localX / localY 为意图左上角（画布本地坐标），
 * bottomLine 为面板底缘让位线（画布本地 y）。top 按估高向让位线收口；
 * maxHeight ＝ 让位线 − top，真实高度超出时由列表滚动吸收，底缘不越线 */
export function pickerAnchorLocal(
  localX: number,
  localY: number,
  canvas: CanvasLocalSize,
  bottomLine: number,
): PickerPanelPosition {
  const left = Math.min(
    Math.max(localX, NODE_PICKER_MARGIN),
    Math.max(NODE_PICKER_MARGIN, canvas.width - NODE_PICKER_SIZE.width - NODE_PICKER_MARGIN),
  )
  const top = Math.min(
    Math.max(localY, NODE_PICKER_MARGIN),
    Math.max(NODE_PICKER_MARGIN, bottomLine - NODE_PICKER_SIZE.height),
  )
  return { left, top, maxHeight: bottomLine - top }
}

/** 悬浮工具栏挂载点的面板锚点：水平取画布中线为左上角，底缘让出工具栏
 * 占位（不遮挡操作栏），画布过矮时回落顶部 margin 并压缩面板高度 */
export function toolbarPickerAnchorLocal(canvas: CanvasLocalSize): PickerPanelPosition {
  return pickerAnchorLocal(
    canvas.width / 2,
    canvas.height - NODE_PICKER_TOOLBAR_CLEARANCE - NODE_PICKER_SIZE.height,
    canvas,
    canvas.height - NODE_PICKER_TOOLBAR_CLEARANCE,
  )
}
