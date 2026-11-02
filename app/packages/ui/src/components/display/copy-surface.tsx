import * as React from "react"
import { CopyIcon } from "lucide-react"
import { cn } from "cn"

import { toast } from "../feedback/toast"
import { useUiText, type UiText } from "../ui-text"
import { Button } from "./button"

/**
 * 可复制文本域与复制按钮：根壳全局 select-none（整窗防误选）之下，
 * 由 CopySurface 逐区域放行文本选中——「能不能选」是区域级声明而非全局
 * 开关。选中即通向既有右键菜单 / Ctrl+C；一键复制走 CopyButton。
 */

interface CopyButtonProps extends Omit<
  React.ComponentProps<typeof Button>,
  "onClick" | "children"
> {
  /** 复制口径：点击时求值（复制格式化文本还是原文、是否脱敏由消费面决定） */
  getText: () => string
  /** 可见文字（缺省＝纯图标，无障碍标签回退接缝的 copyLabel） */
  label?: string
}

/**
 * 复制动作的唯一实现源：口径求值 → 写剪贴板 → toast 反馈（剪贴板拒绝与
 * 口径求值失败都不向外抛未捕获异常）。CopyButton 与消费面自定义复制入口
 * （如菜单项）共用，保证剪贴板行为与反馈文案一致。
 */
async function copyTextWithFeedback(
  getText: () => string,
  uiText: Pick<UiText, "copySuccess" | "copyFailed">,
): Promise<void> {
  let text: string
  try {
    text = getText()
  } catch {
    toast.error(uiText.copyFailed)
    return
  }
  try {
    await navigator.clipboard.writeText(text)
    toast.success(uiText.copySuccess)
  } catch {
    toast.error(uiText.copyFailed)
  }
}

/**
 * 复制小按钮：点击把 getText() 写入剪贴板，成功 / 失败均以 toast 反馈。
 * 悬浮定位不内建——独立摆放或随 CopySurface 组合由消费面经 className 决定。
 */
function CopyButton({ getText, label, size, className, ...props }: CopyButtonProps) {
  const uiText = useUiText()

  return (
    <Button
      type="button"
      data-slot="copy-button"
      aria-label={label ?? uiText.copyLabel}
      size={size ?? (label ? "xs" : "icon-xs")}
      className={cn(className)}
      onClick={() => void copyTextWithFeedback(getText, uiText)}
      {...props}
    >
      <CopyIcon aria-hidden data-icon="inline-start" />
      {label}
    </Button>
  )
}

interface CopySurfaceProps extends React.ComponentProps<"div"> {
  /**
   * 一键复制口径：提供时区域右上角渲染悬浮 CopyButton（悬浮 / 聚焦才
   * 显现，不遮挡阅读）；缺省＝纯可选中区域（复制按钮由消费面另行摆放）。
   */
  getText?: () => string
}

/**
 * 可复制文本域：select-text 覆盖祖先的 select-none（放行本区域鼠标选中，
 * 区域外不受影响）；右键沿用全局文本菜单宿主的既有路径，此处不接管。
 */
function CopySurface({ getText, className, children, ...props }: CopySurfaceProps) {
  return (
    <div
      data-slot="copy-surface"
      className={cn("select-text", getText && "group relative", className)}
      {...props}
    >
      {children}
      {getText && (
        <CopyButton
          getText={getText}
          className="absolute top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        />
      )}
    </div>
  )
}

export { CopySurface, CopyButton, copyTextWithFeedback }
