import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { Toggle } from "../display/toggle"

/** 渲染冒烟：测本仓装配（依赖 / 别名解析 / 语义角色），非上游行为 */
describe("Toggle", () => {
  it("渲染 toggle button 语义，默认未按压", () => {
    render(<Toggle>加粗</Toggle>)
    expect(screen.getByRole("button", { name: "加粗" })).toHaveAttribute("aria-pressed", "false")
  })

  it("点击切换按压态并回调", async () => {
    const user = userEvent.setup()
    const onPressedChange = vi.fn()
    render(<Toggle onPressedChange={onPressedChange}>加粗</Toggle>)
    const toggle = screen.getByRole("button", { name: "加粗" })
    await user.click(toggle)
    expect(onPressedChange).toHaveBeenCalledWith(true, expect.anything())
    expect(toggle).toHaveAttribute("aria-pressed", "true")
  })
})
