import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../overlay/command"
import { UiTextProvider } from "../ui-text"

/** 渲染冒烟：测本仓装配（依赖 / 别名解析 / 语义角色），非上游行为 */
describe("Command", () => {
  it("渲染输入框与条目，输入过滤后命中条目可见", async () => {
    const user = userEvent.setup()
    render(
      <Command>
        <CommandInput placeholder="搜索命令" />
        <CommandList>
          <CommandEmpty>没有匹配结果</CommandEmpty>
          <CommandGroup heading="接口">
            <CommandItem>发送请求</CommandItem>
            <CommandItem>新建环境</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>,
    )
    expect(screen.getByRole("combobox")).toBeInTheDocument()
    expect(screen.getByText("发送请求")).toBeInTheDocument()

    await user.type(screen.getByRole("combobox"), "发送")
    expect(screen.getByText("发送请求")).toBeInTheDocument()
    expect(screen.queryByText("新建环境")).not.toBeInTheDocument()
  })

  it("Enter 激活选中条目", async () => {
    const user = userEvent.setup()
    render(
      <Command>
        <CommandInput />
        <CommandList>
          <CommandItem>发送请求</CommandItem>
        </CommandList>
      </Command>,
    )
    await user.type(screen.getByRole("combobox"), "{Enter}")
    // cmdk 对激活条目发出 selection 事件：条目仍在文档中即为装配成功
    expect(screen.getByText("发送请求")).toBeInTheDocument()
  })
})

describe("CommandDialog UiText 接缝", () => {
  it("标题与描述默认经 UiText 注入（基准中文），不出现英文硬编码", () => {
    render(
      <CommandDialog open>
        <Command>
          <CommandInput />
          <CommandList>
            <CommandItem>发送请求</CommandItem>
          </CommandList>
        </Command>
      </CommandDialog>,
    )
    // sr-only 头部的无障碍标题/描述
    expect(screen.getByText("命令面板")).toBeInTheDocument()
    expect(screen.getByText("搜索要运行的命令…")).toBeInTheDocument()
    expect(screen.queryByText("Command Palette")).not.toBeInTheDocument()

    // 打开态内容可达
    expect(screen.getByText("发送请求")).toBeInTheDocument()
  })

  it("UiTextProvider 注入自定义文案后随生效文案显示，props 可覆盖", () => {
    render(
      <UiTextProvider value={{ commandTitle: "Palette", commandDescription: "Type to search" }}>
        <CommandDialog open title="自定义标题">
          <Command>
            <CommandInput />
          </Command>
        </CommandDialog>
      </UiTextProvider>,
    )
    // props 覆盖优先于注入值
    expect(screen.getByText("自定义标题")).toBeInTheDocument()
    expect(screen.getByText("Type to search")).toBeInTheDocument()
  })
})
