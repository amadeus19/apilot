import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import { Input } from "../form/input"

/** 渲染冒烟：测本仓装配（依赖 / 别名解析 / 语义角色），非上游行为 */
describe("Input", () => {
  it("渲染 textbox 语义角色，可输入", async () => {
    const user = userEvent.setup()
    render(<Input aria-label="搜索" placeholder="输入关键字" />)
    const input = screen.getByRole("textbox", { name: "搜索" })
    expect(input).toHaveAttribute("placeholder", "输入关键字")
    await user.type(input, "环境")
    expect(input).toHaveValue("环境")
  })
})
