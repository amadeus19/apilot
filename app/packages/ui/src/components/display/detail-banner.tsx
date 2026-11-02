import * as React from "react"

import { cn } from "cn"

/**
 * 详情页身份横幅原语（详情页拍板版式的骨架提炼）：size-12 图标块＋行内
 * 标题（text-xl 档）＋徽章位＋meta 摘要行＋右侧动作 / 保存态区。纯视觉
 * 骨架——标题编辑态、徽章形态、meta 内容与动作全部经插槽传入，写通道
 * 与保存态语义归调用方。
 */
function DetailBanner({
  icon,
  title,
  badges,
  meta,
  actions,
  className,
  ...props
}: Omit<React.ComponentProps<"header">, "title"> & {
  /** 图标块内容：图标自身尺寸档（size-6）与 aria-hidden 由调用方给出 */
  icon: React.ReactNode
  /** 标题：传字符串渲染 h1（truncate text-xl font-semibold）；传元素原样
   *  渲染——行内改名输入经此插槽传入，输入自身承载 text-xl 字号档。
   *  覆写 HTML 全局 title（tooltip）属性：本组件的 title 是内容插槽 */
  title: React.ReactNode
  /** 徽章位（标题行内、标题之后）：徽章或「设为当前」类替代按钮由调用方决定 */
  badges?: React.ReactNode
  /** meta 摘要行内容（分隔点与等宽段由调用方拼装；未传不渲染该行） */
  meta?: React.ReactNode
  /** 右侧动作 / 保存态区（未传不渲染） */
  actions?: React.ReactNode
}) {
  const hasMeta = meta !== null && meta !== undefined
  const hasActions = actions !== null && actions !== undefined
  return (
    <header className={cn("shrink-0 border-b border-border px-8 py-6", className)} {...props}>
      <div className="flex items-center gap-4">
        <div className="grid size-12 shrink-0 place-items-center rounded-md bg-selection text-primary">
          {icon}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            {typeof title === "string" ? (
              <h1 className="truncate text-xl font-semibold">{title}</h1>
            ) : (
              title
            )}
            {badges}
          </div>
          {hasMeta && (
            <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">{meta}</p>
          )}
        </div>
        {hasActions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  )
}

export { DetailBanner }
