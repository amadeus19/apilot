/**
 * hover 变量解析的几何纯层：单行输入框内 `{{key}}` 片段的指针命中与提示
 * 定位。量宽走 canvas 2d（字体与输入框计算样式一致，量得即所见）；命中
 * 与钳制为纯函数（测试表驱动），组件只做事件接线。
 */

/** 文本量宽函数形态（组件侧 canvas 实现；测试注入桩） */
export type TextMeasurer = (text: string) => number

/** 量宽上下文：文本起点横坐标所需的内边距与量宽函数一并产出 */
export interface InputMeasureContext {
  measure: TextMeasurer
  paddingLeft: number
}

/** 输入框量宽上下文构建：字体取自计算样式（与输入框渲染一致），
 *  canvas 不可用（无 2d 上下文）返回 null——宿主侧不启用 hover */
export function createInputTextMeasurer(el: HTMLInputElement): InputMeasureContext | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const style = window.getComputedStyle(el)
  ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  // letterSpacing 为 Chromium 系扩展属性：支持则随输入框（WebView2 命中）
  const spacing = ctx as CanvasRenderingContext2D & { letterSpacing?: string }
  if (typeof spacing.letterSpacing === 'string') spacing.letterSpacing = style.letterSpacing
  return {
    measure: (text) => ctx.measureText(text).width,
    paddingLeft: parseFloat(style.paddingLeft) || 0,
  }
}

/**
 * 指针命中测试：x（视口坐标）落在哪个引用片段的水平区间内。originX＝文本
 * 起点横坐标（已含输入框左内边距与横向滚动修正）；命中返回片段下标与片段
 * 中心横坐标（提示水平锚点），无命中 null。单行输入框无纵向回绕，只比 x。
 */
export function pickReferenceAtX(
  text: string,
  refs: readonly { start: number; end: number }[],
  measure: TextMeasurer,
  originX: number,
  x: number,
): { index: number; anchorX: number } | null {
  let widthBefore = 0
  let cursor = 0
  for (let index = 0; index < refs.length; index += 1) {
    const ref = refs[index]!
    widthBefore += measure(text.slice(cursor, ref.start))
    cursor = ref.start
    const startX = originX + widthBefore
    const tokenWidth = measure(text.slice(ref.start, ref.end))
    if (x >= startX && x < startX + tokenWidth) {
      return { index, anchorX: startX + tokenWidth / 2 }
    }
    widthBefore += tokenWidth
    cursor = ref.end
  }
  return null
}

/** 提示框半宽估计（钳制用；实际宽度 min(max-content, 360)） */
export const TOOLTIP_HALF_WIDTH = 180

/** 提示框水平钳制：锚点居中放置，越出视口时收边（两侧留 8px） */
export function clampTooltipLeft(anchorX: number, viewportWidth: number): number {
  const min = TOOLTIP_HALF_WIDTH + 8
  const max = Math.max(viewportWidth - TOOLTIP_HALF_WIDTH - 8, min)
  return Math.min(Math.max(anchorX, min), max)
}

/** 联想浮层视口边距（左右同值） */
export const SUGGEST_OVERLAY_MARGIN = 8

/**
 * 联想浮层左缘钳制：浮层实际宽度内容自适应（无上界），按最小宽度保守
 * 估计右缘，贴近视口右缘的输入框不再溢出（与 clampTooltipLeft 同思路，
 * 锚定方式不同——浮层左对齐输入框而非中心锚点）。视口容不下最小宽时
 * 贴左边距（保持左对齐常态，不追右缘）。
 */
export function clampSuggestLeft(left: number, viewportWidth: number, minWidth: number): number {
  const min = SUGGEST_OVERLAY_MARGIN
  const max = viewportWidth - minWidth - SUGGEST_OVERLAY_MARGIN
  if (max <= min) return min
  return Math.min(Math.max(left, min), max)
}
