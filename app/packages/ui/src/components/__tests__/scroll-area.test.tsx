import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { ScrollArea } from "../display/scroll-area"

/** 渲染冒烟：测本仓装配（依赖 / 别名解析 / 语义角色），非上游行为 */
describe("ScrollArea", () => {
  it("渲染滚动容器与内容", () => {
    render(
      <ScrollArea aria-label="接口列表">
        <div>内容行</div>
      </ScrollArea>,
    )
    const viewport = screen.getByLabelText("接口列表")
    expect(viewport).toBeInTheDocument()
    expect(screen.getByText("内容行")).toBeInTheDocument()
  })
})
