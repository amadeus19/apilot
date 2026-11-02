import * as React from "react"

import { cn } from "cn"

/**
 * 详情页居中限宽内容列（详情页拍板版式的身体容器）：mx-auto 居中＋
 * max-w-3xl 限宽的纵向单列，分节卡之间 gap-5。个别消费面的形态差异
 * （如历史详情页的左对齐窄间距形态）经 className 覆盖。
 */
function DetailContentColumn({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-6", className)}
      {...props}
    />
  )
}

/**
 * 详情页分节卡原语（纯视觉骨架）：rounded-md border 卡体＋卡头。卡头两
 * 形态随 actions 有无切换——表单卡头（无动作区：icon＋标题，border-b 与
 * 卡体划界）与列表卡头（带动作区：左 icon＋标题、右动作组两端对齐；列
 * 表行自带 border-t 分隔，卡头不再画线避免双线）。卡体内容归调用方。
 */
function DetailSectionCard({
  icon,
  title,
  actions,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"section">, "title"> & {
  /** 卡头图标：尺寸档（size-4 text-muted-foreground）与 aria-hidden 由调用方给出 */
  icon?: React.ReactNode
  /** 卡头标题（渲染为 h2 text-sm font-medium；计数等内嵌元素由调用方拼进标题）。
   *  覆写 HTML 全局 title（tooltip）属性：本组件的 title 是内容插槽 */
  title: React.ReactNode
  /** 卡头右侧动作区（存在时卡头转两端对齐且不带 border-b） */
  actions?: React.ReactNode
}) {
  const hasActions = actions !== null && actions !== undefined
  return (
    <section className={cn("rounded-md border", className)} {...props}>
      {hasActions ? (
        <div className="flex items-center justify-between gap-2 px-4 py-2.5">
          <div className="flex items-center gap-2">
            {icon}
            <h2 className="text-sm font-medium">{title}</h2>
          </div>
          <div className="flex items-center gap-1">{actions}</div>
        </div>
      ) : (
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          {icon}
          <h2 className="text-sm font-medium">{title}</h2>
        </div>
      )}
      {children}
    </section>
  )
}

export { DetailContentColumn, DetailSectionCard }
