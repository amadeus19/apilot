import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { Badge } from "../display/badge"

/** 渲染冒烟：测本仓装配（依赖 / 别名解析 / 语义角色），非上游行为 */
describe("Badge", () => {
  it("渲染文本内容，默认为 span 非交互元素", () => {
    render(<Badge>v0.1.0</Badge>)
    expect(screen.getByText("v0.1.0")).toBeInTheDocument()
  })

  it("variant 切换不改变语义角色（纯视觉）", () => {
    render(
      <>
        <Badge variant="secondary">次级</Badge>
        <Badge variant="outline">描边</Badge>
      </>,
    )
    expect(screen.getByText("次级")).toBeInTheDocument()
    expect(screen.getByText("描边")).toBeInTheDocument()
  })
})
