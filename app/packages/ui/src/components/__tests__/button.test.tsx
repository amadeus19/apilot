import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { Button } from "../display/button"

/** 渲染冒烟：测本仓装配（依赖 / 别名解析 / 语义角色），非上游行为 */
describe("Button", () => {
  it("渲染 button 角色，点击触发回调", async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<Button onClick={onClick}>保存</Button>)
    await user.click(screen.getByRole("button", { name: "保存" }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("disabled 时不可点击", async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <Button onClick={onClick} disabled>
        保存
      </Button>,
    )
    const button = screen.getByRole("button", { name: "保存" })
    expect(button).toBeDisabled()
    await user.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })
})
