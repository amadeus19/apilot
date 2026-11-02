import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { Switch } from "../form/switch"

/** 渲染冒烟：测本仓装配（依赖 / 别名解析 / 语义角色），非上游行为 */
describe("Switch", () => {
  it("渲染 switch 语义角色，默认未选中", () => {
    render(<Switch aria-label="自动检查更新" />)
    const sw = screen.getByRole("switch", { name: "自动检查更新" })
    expect(sw).toHaveAttribute("aria-checked", "false")
  })

  it("点击切换选中态并回调", async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    render(<Switch aria-label="开关" onCheckedChange={onCheckedChange} />)
    const sw = screen.getByRole("switch", { name: "开关" })
    await user.click(sw)
    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything())
    expect(sw).toHaveAttribute("aria-checked", "true")
  })

  it("受控 checked 响应外部变化", () => {
    const { rerender } = render(<Switch aria-label="开关" checked />)
    expect(screen.getByRole("switch", { name: "开关" })).toHaveAttribute("aria-checked", "true")
    rerender(<Switch aria-label="开关" checked={false} />)
    expect(screen.getByRole("switch", { name: "开关" })).toHaveAttribute("aria-checked", "false")
  })
})
