import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "../display/tabs"

/** 渲染冒烟：测本仓装配（依赖 / 别名解析 / 语义角色），非上游行为 */
describe("Tabs", () => {
  it("渲染 tab 语义角色，默认激活第一项", () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">请求</TabsTrigger>
          <TabsTrigger value="b">响应</TabsTrigger>
        </TabsList>
        <TabsContent value="a">请求面板</TabsContent>
        <TabsContent value="b">响应面板</TabsContent>
      </Tabs>,
    )
    const tabs = screen.getAllByRole("tab")
    expect(tabs).toHaveLength(2)
    expect(tabs[0]).toHaveAttribute("aria-selected", "true")
    expect(screen.getByText("请求面板")).toBeInTheDocument()
    expect(screen.queryByText("响应面板")).not.toBeInTheDocument()
  })

  it("点击切换激活项与对应面板", async () => {
    const user = userEvent.setup()
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">请求</TabsTrigger>
          <TabsTrigger value="b">响应</TabsTrigger>
        </TabsList>
        <TabsContent value="a">请求面板</TabsContent>
        <TabsContent value="b">响应面板</TabsContent>
      </Tabs>,
    )
    await user.click(screen.getByRole("tab", { name: "响应" }))
    expect(screen.getByRole("tab", { name: "响应" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByText("响应面板")).toBeInTheDocument()
    expect(screen.queryByText("请求面板")).not.toBeInTheDocument()
  })

  it("pill 变体：形态类收敛在底座（选中＝主题色实底＋白字，触发项随内容收缩）", () => {
    render(
      <Tabs defaultValue="a">
        <TabsList variant="pill">
          <TabsTrigger value="a">JSON</TabsTrigger>
          <TabsTrigger value="b">Text</TabsTrigger>
        </TabsList>
      </Tabs>,
    )
    expect(screen.getByRole("tablist")).toHaveAttribute("data-variant", "pill")
    const active = screen.getByRole("tab", { name: "JSON" })
    // 激活态与收缩形态都经 group-data 前缀驱动，断言关键类挂上即可
    expect(active.className).toContain("data-active:bg-primary")
    expect(active.className).toContain("data-active:text-primary-foreground")
    expect(active.className).toContain("flex-none")
    // pill 无下划线强调条（对齐类型行形态：行不画线、选中项不起线）——
    // line 变体的条件类虽在串里但不匹配 pill，精确 token 断言不误伤
    expect(active.classList.contains("after:opacity-100")).toBe(false)
  })

  it("line 变体：下划线强调条归底座，左内边可由消费面覆写归零（对齐归消费面行）", () => {
    render(
      <Tabs defaultValue="a">
        <TabsList variant="line" className="pl-0">
          <TabsTrigger value="a">Params</TabsTrigger>
          <TabsTrigger value="b">Body</TabsTrigger>
        </TabsList>
      </Tabs>,
    )
    const list = screen.getByRole("tablist")
    expect(list).toHaveAttribute("data-variant", "line")
    // 底座 p-[3px]（承载激活线落线几何的垂直内边）与消费面 pl-0 并存：
    // 合并结果保留两类，CSS 层 pl 工具类生成在 p 之后、覆盖其左分量，
    // 使首个触发项左缘＝TabsList 盒左缘（对齐基准交给消费面行容器）
    expect(list).toHaveClass("p-[3px]", "pl-0")
    // 下划线形态归底座：选中项起 after 强调条、与触发项同宽（inset-x-0）
    const active = screen.getByRole("tab", { name: "Params" })
    expect(active.className).toContain("group-data-horizontal/tabs:after:inset-x-0")
    expect(active.className).toContain(
      "group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
    )
  })
})
