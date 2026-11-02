import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../overlay/tooltip"

/** 渲染冒烟：测本仓装配（依赖 / 别名解析 / 语义角色），非上游行为 */
describe("Tooltip", () => {
  it("悬停触发后提示内容可见，移出后消失", async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>设置</TooltipTrigger>
          <TooltipContent>打开设置面板</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    )
    expect(screen.queryByText("打开设置面板")).not.toBeInTheDocument()

    await user.hover(screen.getByRole("button", { name: "设置" }))
    await waitFor(() => {
      expect(screen.getByText("打开设置面板")).toBeInTheDocument()
    })

    await user.unhover(screen.getByRole("button", { name: "设置" }))
    await waitFor(() => {
      expect(screen.queryByText("打开设置面板")).not.toBeInTheDocument()
    })
  })
})
