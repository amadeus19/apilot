import * as React from 'react'

import { Separator as SeparatorBase } from 'react-resizable-panels'

import { cn } from 'cn'

/**
 * 分栏把手（左右 / 上下两处分栏的单一实现源）：
 *
 * 命中区＝库 Separator 本体，布局零占位（不设宽高，flex-basis auto），相邻面板
 * 自绘的 1px 结构线保持原位贴合；拖拽命中由库在命中检测层扩展（鼠标指针 10px、
 * 触屏 20px），不随可见形态收窄。
 *
 * 可见形态＝悬浮在命中区正中的 2px 短把手（24px 长）：常态与相邻面板贯穿全长
 * 的 1px 结构线（左栏树面板 border-r、响应区 border-t）同色淡显、融入结构线，
 * 不与版面内容争抢注意力；悬浮 / 拖拽 / 聚焦时点亮主题色，以色彩变化宣告
 * 「可抓取」。把手绝对定位、pointer-events 穿透——事件与命中全部归库
 * Separator，视觉不参与布局。
 *
 * 交互态沿用库 data-separator 状态机：hover / active（拖拽中）/ focus 时把手
 * 自常态淡色转主题色满色；命中区 focus 环保持 inset ring（不外溢到相邻面板）。
 * 转色过渡 100ms、仅颜色通道——reduced-motion 不涉运动语义，无需降级。
 *
 * orientation 是分隔线走向（与 aria-orientation 同语义）：外层左右分栏传
 * vertical、内层上下分栏传 horizontal，与 Group 的「排布方向」取值相反。
 */

/** 命中区形态：状态机选择器挂 group/sep，供把手子元素经 group-data 前缀读取 */
const PANEL_SEPARATOR_HIT_CLASS =
  'group/sep relative outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset'

interface PanelSeparatorProps extends React.ComponentProps<typeof SeparatorBase> {
  /** 分隔线走向（与 aria-orientation 同语义），左右分栏 vertical、上下分栏 horizontal */
  orientation: 'horizontal' | 'vertical'
}

export function PanelSeparator({
  orientation,
  className,
  ...props
}: PanelSeparatorProps): React.ReactElement {
  return (
    <SeparatorBase className={cn(PANEL_SEPARATOR_HIT_CLASS, className)} {...props}>
      <span
        data-slot="panel-grip"
        data-orientation={orientation}
        aria-hidden
        className={cn(
          'pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-border',
          'transition-colors duration-100',
          'group-data-[separator=active]/sep:bg-primary group-data-[separator=focus]/sep:bg-primary group-data-[separator=hover]/sep:bg-primary',
          orientation === 'horizontal' ? 'h-0.5 w-6' : 'h-6 w-0.5',
        )}
      />
    </SeparatorBase>
  )
}
