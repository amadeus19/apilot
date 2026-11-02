import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../overlay/context-menu"

/** 渲染冒烟：测本仓装配（依赖 / 别名解析 / 右键 Portal 弹层可达），非上游行为 */
describe("ContextMenu", () => {
  it("右键触发后菜单项可见，点击选中回调", async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <ContextMenu>
        <ContextMenuTrigger>目标区</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={onClick}>重命名</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    )
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument()

    const target = screen.getByText("目标区")
    target.focus()
    await user.pointer([{ keys: "[MouseRight]", target }])
    expect(screen.getByRole("menuitem", { name: "重命名" })).toBeInTheDocument()

    await user.click(screen.getByRole("menuitem", { name: "重命名" }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("菜单打开后 Esc 关闭（嵌套浮层 Esc 基线）", async () => {
    const user = userEvent.setup()
    render(
      <ContextMenu>
        <ContextMenuTrigger>目标区</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>删除</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    )
    const target = screen.getByText("目标区")
    target.focus()
    await user.pointer([{ keys: "[MouseRight]", target }])
    expect(screen.getByRole("menuitem", { name: "删除" })).toBeInTheDocument()

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument()
  })
})
