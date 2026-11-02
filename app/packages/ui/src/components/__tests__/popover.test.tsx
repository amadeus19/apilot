import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../overlay/popover"

/** 渲染冒烟：测本仓装配（依赖 / 别名解析 / Portal 弹层可达），非上游行为 */
describe("Popover", () => {
  it("默认关闭不渲染内容，触发后弹层内容可见", async () => {
    const user = userEvent.setup()
    render(
      <Popover>
        <PopoverTrigger>打开</PopoverTrigger>
        <PopoverContent>
          <PopoverTitle>标题</PopoverTitle>
          弹层内容
        </PopoverContent>
      </Popover>,
    )
    expect(screen.queryByText("弹层内容")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "打开" }))
    expect(screen.getByText("弹层内容")).toBeInTheDocument()
    expect(screen.getByText("标题")).toBeInTheDocument()
  })

  it("Esc 关闭后内容移除（浮层 Esc 分级基线）", async () => {
    const user = userEvent.setup()
    render(
      <Popover>
        <PopoverTrigger>打开</PopoverTrigger>
        <PopoverContent>弹层内容</PopoverContent>
      </Popover>,
    )
    await user.click(screen.getByRole("button", { name: "打开" }))
    expect(screen.getByText("弹层内容")).toBeInTheDocument()

    await user.keyboard("{Escape}")
    expect(screen.queryByText("弹层内容")).not.toBeInTheDocument()
  })
})
