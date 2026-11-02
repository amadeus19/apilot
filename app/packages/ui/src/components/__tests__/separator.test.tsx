import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { Separator } from "../display/separator"

/** 渲染冒烟：测本仓装配（依赖 / 别名解析 / 语义角色），非上游行为 */
describe("Separator", () => {
  it("渲染 separator 语义角色，默认水平", () => {
    const { container } = render(<Separator />)
    const el = container.querySelector('[role="separator"], [data-slot="separator"]')
    expect(el).toBeInTheDocument()
  })
})
