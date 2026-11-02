import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../form/select"

/** 渲染冒烟：测本仓装配（依赖 / 别名解析 / 语义角色），非上游行为 */
describe("Select", () => {
  it("触发后选项可见，选择回填值并回调", async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <Select onValueChange={onValueChange}>
        <SelectTrigger aria-label="主题">
          <SelectValue placeholder="选择主题" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="dark">深色</SelectItem>
          <SelectItem value="light">浅色</SelectItem>
        </SelectContent>
      </Select>,
    )
    await user.click(screen.getByRole("combobox", { name: "主题" }))
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "深色" })).toBeInTheDocument()
    })

    await user.click(screen.getByRole("option", { name: "深色" }))
    expect(onValueChange).toHaveBeenCalledWith("dark", expect.anything())
  })
})
