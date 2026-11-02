import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../overlay/dialog"
import { UiTextProvider } from "../ui-text"

/** 渲染冒烟 + 改造点测试：本仓相对上游的改造点是 UiText 文案接缝 */
describe("Dialog 渲染", () => {
  it("打开后标题 / 描述 / 关闭按钮可见，Esc 关闭", async () => {
    const user = userEvent.setup()
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>应用偏好配置</DialogDescription>
        </DialogContent>
      </Dialog>,
    )
    expect(screen.getByText("设置")).toBeInTheDocument()
    expect(screen.getByText("应用偏好配置")).toBeInTheDocument()

    // 关闭按钮的无障碍标签来自 UiText 基准文案
    await user.click(screen.getByRole("button", { name: "关闭" }))
    expect(screen.queryByText("设置")).not.toBeInTheDocument()
  })

  it("UiTextProvider 注入后关闭按钮文案随生效语言", () => {
    render(
      <UiTextProvider value={{ closeLabel: "Close" }}>
        <Dialog defaultOpen>
          <DialogContent>
            <DialogTitle>Settings</DialogTitle>
          </DialogContent>
        </Dialog>
      </UiTextProvider>,
    )
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument()
  })

  it("DialogFooter 可显示关闭动作（showCloseButton）", () => {
    render(
      <Dialog defaultOpen>
        <DialogContent showCloseButton={false}>
          <DialogTitle>确认</DialogTitle>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>,
    )
    expect(screen.getAllByRole("button", { name: "关闭" }).length).toBeGreaterThan(0)
  })

  it("overlayClassName 追加到遮罩层（与基线类并存）", () => {
    render(
      <Dialog defaultOpen>
        <DialogContent overlayClassName="supports-backdrop-filter:backdrop-blur-md">
          <DialogTitle>设置CLI以在终端中使用</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    const overlay = document.querySelector('[data-slot="dialog-overlay"]')
    expect(overlay).not.toBeNull()
    expect(overlay).toHaveClass("supports-backdrop-filter:backdrop-blur-md")
    // 基线 scrim 保留：追加类只覆盖同 variant 链的模糊强度
    expect(overlay).toHaveClass("bg-black/10")
  })
})
