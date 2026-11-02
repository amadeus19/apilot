import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../display/empty"

/** 渲染冒烟：测本仓装配（依赖 / 别名解析 / 语义角色），非上游行为 */
describe("Empty", () => {
  it("空态组合渲染：标题、描述与动作内容", () => {
    render(
      <Empty>
        <EmptyHeader>
          <EmptyTitle>尚无服务</EmptyTitle>
          <EmptyDescription>创建服务后即可同步接口</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <button type="button">新建服务</button>
        </EmptyContent>
      </Empty>,
    )
    expect(screen.getByText("尚无服务")).toBeInTheDocument()
    expect(screen.getByText("创建服务后即可同步接口")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "新建服务" })).toBeInTheDocument()
  })
})
