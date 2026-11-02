import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../overlay/dropdown-menu"

/** 渲染冒烟：测本仓装配（依赖 / 别名解析 / 语义角色），非上游行为 */
describe("DropdownMenu", () => {
  it("点击触发后菜单项可见，Esc 关闭", async () => {
    const user = userEvent.setup()
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>操作</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>重命名</DropdownMenuItem>
          <DropdownMenuItem>删除</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    )
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "操作" }))
    expect(screen.getByRole("menuitem", { name: "重命名" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "删除" })).toBeInTheDocument()

    await user.keyboard("{Escape}")
    // 弹层带退出过渡（data-closed + animate-out），节点在动画结束后才移除：
    // 直接同步断言会在整包并行跑的负载下偶发失败（本测试为存量 flaky），
    // 故轮询等待移除
    await waitFor(() => {
      expect(screen.queryByRole("menuitem")).not.toBeInTheDocument()
    })
  })
})
