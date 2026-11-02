import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { Radio, RadioGroup, RadioGroupItem } from "../form/radio-group"

/** 渲染冒烟 + 改造点测试：本仓相对上游的改造点是 `Radio` 裸单项导出（单选形态） */
describe("RadioGroup", () => {
  it("radiogroup 语义：选项渲染、点击选中", async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <RadioGroup aria-label="主题" onValueChange={onValueChange}>
        <RadioGroupItem value="dark" />
        <RadioGroupItem value="light" />
      </RadioGroup>,
    )
    const items = screen.getAllByRole("radio")
    expect(items).toHaveLength(2)
    await user.click(items[1]!)
    expect(items[1]).toBeChecked()
    expect(onValueChange).toHaveBeenCalledWith("light", expect.anything())
  })

  it("组内方向键 roving 切换选中项", async () => {
    const user = userEvent.setup()
    render(
      <RadioGroup aria-label="主题">
        <RadioGroupItem value="dark" />
        <RadioGroupItem value="light" />
      </RadioGroup>,
    )
    const items = screen.getAllByRole("radio")
    items[0]!.focus()
    await user.keyboard("{ArrowDown}")
    expect(items[1]).toBeChecked()
  })
})

describe("Radio（本仓改造点：裸单项，供自定义视觉形态接入）", () => {
  it("可在组内承载自定义视觉内容并参与选中语义", async () => {
    const user = userEvent.setup()
    render(
      <RadioGroup aria-label="强调色">
        <Radio value="teal">
          <span>青色</span>
        </Radio>
        <Radio value="violet">
          <span>紫色</span>
        </Radio>
      </RadioGroup>,
    )
    const radios = screen.getAllByRole("radio")
    expect(radios).toHaveLength(2)
    expect(screen.getByText("青色")).toBeInTheDocument()

    // 组内 roving：点击选中、再点另一项转移选中
    await user.click(radios[0]!)
    expect(radios[0]).toBeChecked()
    await user.click(radios[1]!)
    expect(radios[0]).not.toBeChecked()
    expect(radios[1]).toBeChecked()
  })
})
