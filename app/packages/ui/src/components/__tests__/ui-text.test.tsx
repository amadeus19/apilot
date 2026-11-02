import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { UiTextProvider, useUiText } from "../ui-text"

/**
 * 自研组件全基线：ui-text 是文案注入接缝（Provider + hook）。
 * 渲染冒烟 + 受控反转（注入值合并与覆盖语义）；无交互面，无键盘路径。
 */

function Probe(): React.ReactElement {
  const uiText = useUiText()
  return <div>{`${uiText.closeLabel}|${uiText.commandTitle}|${uiText.commandDescription}`}</div>
}

describe("UiTextProvider", () => {
  it("未注入时提供基准语言默认值（zh-CN 兜底）", () => {
    render(<Probe />)
    expect(screen.getByText("关闭|命令面板|搜索要运行的命令…")).toBeInTheDocument()
  })

  it("注入值覆盖默认值（受控反转）", () => {
    render(
      <UiTextProvider value={{ closeLabel: "Close" }}>
        <Probe />
      </UiTextProvider>,
    )
    // 覆盖键生效，未覆盖键保持默认（部分合并语义）
    expect(screen.getByText("Close|命令面板|搜索要运行的命令…")).toBeInTheDocument()
  })
})
