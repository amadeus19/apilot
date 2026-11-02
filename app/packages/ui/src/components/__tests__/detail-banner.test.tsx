import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { DetailBanner } from "../display/detail-banner"

/** 基础渲染：插槽落位与骨架类名锚点（详情页拍板版式的结构不回归） */
describe("DetailBanner", () => {
  it("各插槽落位：图标块＋字符串标题渲染 h1＋徽章位＋meta 行＋右侧动作区", () => {
    render(
      <DetailBanner
        icon={<span aria-hidden>图标</span>}
        title="工作空间名"
        badges={<span>当前</span>}
        meta={
          <>
            <span className="font-mono">http://api.example.com</span>
            <span aria-hidden>·</span>
            <span>Bearer Token</span>
          </>
        }
        actions={<button type="button">设为当前</button>}
      />,
    )
    // 字符串标题渲染为 h1（text-xl 档行内标题锚点）
    const heading = screen.getByRole("heading", { name: "工作空间名" })
    expect(heading.tagName).toBe("H1")
    expect(heading.className).toContain("text-xl")
    // 图标块骨架（size-12 图标块承载图标插槽）
    expect(screen.getByText("图标").parentElement).toHaveClass("size-12")
    // 徽章位与标题同行（徽章插槽落在标题行内）
    expect(screen.getByText("当前").parentElement).toBe(heading.parentElement)
    // meta 摘要行骨架（gap-2 text-xs text-muted-foreground）
    expect(screen.getByText("http://api.example.com").closest("p")).toHaveClass(
      "text-xs",
      "text-muted-foreground",
    )
    // 右侧动作区骨架（shrink-0，动作插槽落入其中）
    expect(screen.getByRole("button", { name: "设为当前" }).parentElement).toHaveClass("shrink-0")
  })

  it("标题传元素原样渲染（行内改名输入插槽）；meta / actions 未传不渲染骨架行", () => {
    render(
      <DetailBanner
        icon={<span aria-hidden>图标</span>}
        title={<input aria-label="分类名称" defaultValue="开发" />}
      />,
    )
    // 元素标题不经 h1 包裹（行内编辑输入自身承载字号档）
    expect(screen.getByLabelText("分类名称")).toHaveValue("开发")
    expect(screen.queryByRole("heading")).not.toBeInTheDocument()
    // 未传插槽不留空壳（空 meta 行会占行高、空动作区会留空容器）
    expect(document.querySelector("p")).toBeNull()
    const banner = screen.getByRole("banner")
    // 横幅内容行＝图标块＋中列两块（无第三个动作区块）
    const row = banner.firstElementChild as HTMLElement
    expect(row.children).toHaveLength(2)
  })

  it("透传 header 属性（data-testid 等消费面接缝保留）", () => {
    render(
      <DetailBanner icon={<span aria-hidden>图标</span>} title="名" data-testid="detail-header" />,
    )
    const header = screen.getByTestId("detail-header")
    expect(header.tagName).toBe("HEADER")
    expect(header.className).toContain("border-b")
  })
})
