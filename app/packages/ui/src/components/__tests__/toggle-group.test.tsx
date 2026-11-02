import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ToggleGroup, ToggleGroupItem } from "../display/toggle-group"

/** 渲染冒烟：测本仓装配（依赖 / 别名解析 / 语义角色），非上游行为 */
describe("ToggleGroup", () => {
  it("渲染单选组：点击项后仅其按压态生效", async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <ToggleGroup onValueChange={onValueChange}>
        <ToggleGroupItem value="bold">加粗</ToggleGroupItem>
        <ToggleGroupItem value="italic">斜体</ToggleGroupItem>
      </ToggleGroup>,
    )
    await user.click(screen.getByRole("button", { name: "加粗" }))
    expect(onCalledWith(onValueChange, "bold")).toBe(true)
    expect(screen.getByRole("button", { name: "加粗" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "斜体" })).toHaveAttribute("aria-pressed", "false")
  })

  it("受控 value 响应外部变化", () => {
    const { rerender } = render(
      <ToggleGroup value={["bold"]}>
        <ToggleGroupItem value="bold">加粗</ToggleGroupItem>
        <ToggleGroupItem value="italic">斜体</ToggleGroupItem>
      </ToggleGroup>,
    )
    expect(screen.getByRole("button", { name: "加粗" })).toHaveAttribute("aria-pressed", "true")
    rerender(
      <ToggleGroup value={["italic"]}>
        <ToggleGroupItem value="bold">加粗</ToggleGroupItem>
        <ToggleGroupItem value="italic">斜体</ToggleGroupItem>
      </ToggleGroup>,
    )
    expect(screen.getByRole("button", { name: "加粗" })).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByRole("button", { name: "斜体" })).toHaveAttribute("aria-pressed", "true")
  })
})

/** ToggleGroupItem 的按压属性由底层决定（aria-pressed 或 data-state） */
function onCalledWith(fn: ReturnType<typeof vi.fn>, value: string): boolean {
  return fn.mock.calls.some((call) => JSON.stringify(call[0]).includes(value))
}
