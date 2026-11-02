import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import { SearchInput } from "../form/search-input"

/** 行为测试：清除钮的显隐、清空回调与焦点保持（业务收敛的核心契约） */
describe("SearchInput", () => {
  it("无值不渲染清除钮；有值渲染", () => {
    const { rerender } = render(<SearchInput value="" onChange={() => {}} placeholder="搜索" />)
    expect(screen.queryByRole("button", { name: "清空搜索" })).toBeNull()

    rerender(<SearchInput value="abc" onChange={() => {}} placeholder="搜索" />)
    expect(screen.getByRole("button", { name: "清空搜索" })).toBeInTheDocument()
  })

  it("hint 槽：无值时呈现，有值时让位给清除钮", () => {
    const { rerender } = render(
      <SearchInput value="" onChange={() => {}} placeholder="搜索" hint={<kbd>Ctrl+K</kbd>} />,
    )
    expect(screen.getByText("Ctrl+K")).toBeInTheDocument()

    rerender(
      <SearchInput value="abc" onChange={() => {}} placeholder="搜索" hint={<kbd>Ctrl+K</kbd>} />,
    )
    expect(screen.queryByText("Ctrl+K")).toBeNull()
    expect(screen.getByRole("button", { name: "清空搜索" })).toBeInTheDocument()
  })

  it("点击清除钮：以空值回调 onChange 且焦点保持在输入框", async () => {
    const user = userEvent.setup()
    let received = ""
    render(
      <SearchInput
        value="abc"
        onChange={(event) => {
          received = event.target.value
        }}
        placeholder="搜索"
      />,
    )
    const input = screen.getByPlaceholderText("搜索")
    await user.click(screen.getByRole("button", { name: "清空搜索" }))
    expect(received).toBe("")
    expect(input).toHaveFocus()
  })
})
