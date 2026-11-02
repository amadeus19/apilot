"use client"

import * as React from "react"
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog"
import { cn } from "cn"

import { Button } from "../display/button"
import { XIcon } from "lucide-react"
import { useUiText } from "../ui-text"

/**
 * 侧边抽屉（shadcn Sheet，Base UI 底座）：基于 @base-ui/react/dialog 封装，
 * 进出场动画走 data-open / data-closed 数据属性（tw-animate-css），
 * 退出动画结束后的卸载时机由 Base UI 管理，调用方无需自设延时。
 * SheetPortal 透传 container，可将抽屉锚定到任意定位容器做局部覆盖
 * （而非全屏侧滑）；锚定非 body 容器时以 absolute 覆写组件默认的 fixed 定位。
 */

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({ ...props }: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetPortal({ ...props }: SheetPrimitive.Portal.Props) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetOverlay({ className, ...props }: SheetPrimitive.Backdrop.Props) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-200 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  )
}

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  portalContainer,
  overlayClassName,
  ...props
}: SheetPrimitive.Popup.Props & {
  side?: "top" | "right" | "bottom" | "left"
  showCloseButton?: boolean
  /** Portal 宿主容器：局部锚定时传定位容器元素（缺省 body，全屏侧滑） */
  portalContainer?: SheetPrimitive.Portal.Props["container"]
  /** 遮罩附加类：局部锚定时以 absolute 覆写 fixed；模糊等官方视觉默认保持 */
  overlayClassName?: string
}) {
  const uiText = useUiText()
  return (
    <SheetPortal container={portalContainer}>
      <SheetOverlay className={overlayClassName} />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        className={cn(
          "fixed z-50 flex flex-col gap-4 bg-background shadow-lg transition duration-200 ease-in-out outline-none data-open:animate-in data-closed:animate-out",
          side === "right" &&
            "inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm data-open:slide-in-from-right data-closed:slide-out-to-right",
          side === "left" &&
            "inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm data-open:slide-in-from-left data-closed:slide-out-to-left",
          side === "top" &&
            "inset-x-0 top-0 h-auto border-b data-open:slide-in-from-top data-closed:slide-out-to-top",
          side === "bottom" &&
            "inset-x-0 bottom-0 h-auto border-t data-open:slide-in-from-bottom data-closed:slide-out-to-bottom",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            render={<Button variant="ghost" className="absolute top-2 right-2" size="icon-sm" />}
          >
            <XIcon />
            <span className="sr-only">{uiText.closeLabel}</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Popup>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-1.5 p-4", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  )
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("font-heading text-base leading-none font-medium", className)}
      {...props}
    />
  )
}

function SheetDescription({ className, ...props }: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
}
