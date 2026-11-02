import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { DetailContentColumn, DetailSectionCard } from "../display/detail-section-card"

/** 基础渲染：卡头两形态与限宽列骨架（详情页拍板版式的结构不回归） */
describe("DetailSectionCard", () => {
  it("表单卡头（无 actions）：icon＋h2 标题，border-b 与卡体划界", () => {
    render(
      <DetailSectionCard icon={<span aria-hidden>图标</span>} title="基本信息">
        <p>卡体</p>
      </DetailSectionCard>,
    )
    const heading = screen.getByRole("heading", { name: "基本信息" })
    expect(heading.tagName).toBe("H2")
    expect(heading.className).toContain("text-sm")
    // 无动作区＝表单卡头（border-b 分隔；图标与标题平铺在卡头行）
    expect(heading.parentElement).toHaveClass("border-b")
    expect(screen.getByText("图标").parentElement).toBe(heading.parentElement)
  })

  it("列表卡头（带 actions）：左右两端对齐且不带 border-b（行自带分隔防双线）", () => {
    render(
      <DetailSectionCard
        icon={<span aria-hidden>图标</span>}
        title="服务"
        actions={<button type="button">新建服务</button>}
      >
        <p>卡体</p>
      </DetailSectionCard>,
    )
    const heading = screen.getByRole("heading", { name: "服务" })
    const leftGroup = heading.parentElement
    // 带动作区＝列表卡头（两端对齐；卡头不画线）
    expect(leftGroup?.parentElement).toHaveClass("justify-between")
    expect(leftGroup?.parentElement).not.toHaveClass("border-b")
    // 动作区落位卡头右侧（gap-1 动作组）
    expect(screen.getByRole("button", { name: "新建服务" }).parentElement).toHaveClass("gap-1")
  })

  it("卡体骨架与 section 属性透传（data-testid 等消费面接缝保留）", () => {
    render(
      <DetailSectionCard icon={<span aria-hidden>图标</span>} title="认证" data-testid="card">
        <p>卡体</p>
      </DetailSectionCard>,
    )
    const section = screen.getByTestId("card")
    expect(section.tagName).toBe("SECTION")
    expect(section.className).toContain("rounded-md")
    expect(screen.getByText("卡体").parentElement).toBe(section)
  })
})

describe("DetailContentColumn", () => {
  it("默认形态：居中限宽 max-w-3xl、卡间 gap-5", () => {
    const { container } = render(<DetailContentColumn>内容</DetailContentColumn>)
    expect(container.firstElementChild).toHaveClass("mx-auto", "max-w-3xl", "gap-5")
  })

  it("消费面差异经 className 覆盖（历史详情页左对齐窄间距形态）", () => {
    const { container } = render(
      <DetailContentColumn className="mx-0 gap-4">内容</DetailContentColumn>,
    )
    // 同冲突组后者胜出：不再含默认居中与宽间距（覆盖语义不回归）
    expect(container.firstElementChild).toHaveClass("mx-0", "gap-4")
    expect(container.firstElementChild).not.toHaveClass("mx-auto")
    expect(container.firstElementChild).not.toHaveClass("gap-5")
  })
})
