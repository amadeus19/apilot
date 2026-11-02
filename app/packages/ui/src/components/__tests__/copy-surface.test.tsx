import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { CopyButton, CopySurface } from "../display/copy-surface"
import { Toaster, toast, toastStore } from "../feedback/toast"

// 模块级 toast store 的用例间隔离：清空当前全部条目
function clearAllToasts(): void {
  for (const item of toastStore.getSnapshot()) toast.dismiss(item.id)
}

// 剪贴板 spy 持有器（beforeEach 换新实例，测试体内经 .current 断言）；
// jsdom 的 navigator.clipboard 替换跨版本形态不稳，用 Proxy 全局 stub，
// 其余属性透传原生 navigator
const clipboardState = vi.hoisted(() => ({
  current: { writeText: vi.fn() },
}))

beforeEach(() => {
  clearAllToasts()
  clipboardState.current = { writeText: vi.fn().mockResolvedValue(undefined) }
  vi.stubGlobal(
    "navigator",
    new Proxy(navigator, {
      get: (target, key) =>
        key === "clipboard" ? clipboardState.current : Reflect.get(target, key),
    }),
  )
})
afterEach(() => {
  clearAllToasts()
  vi.unstubAllGlobals()
})

/** 渲染待测组件＋Toast 宿主（成功 / 失败反馈的呈现面） */
function renderWithToaster(ui: ReactElement) {
  return render(
    <>
      {ui}
      <Toaster />
    </>,
  )
}

describe("CopySurface 可复制文本域", () => {
  it("声明可选中：data-slot＋select-text；纯态（无 getText）不渲染复制按钮", () => {
    const { container } = render(<CopySurface>正文文本</CopySurface>)
    const surface = container.querySelector('[data-slot="copy-surface"]')
    expect(surface).not.toBeNull()
    expect(surface).toHaveClass("select-text")
    expect(container.querySelector('[data-slot="copy-button"]')).toBeNull()
  })

  it("组合态（提供 getText）：区域右上角渲染悬浮复制按钮", () => {
    const { container } = render(<CopySurface getText={() => "文本"}>正文</CopySurface>)
    const button = container.querySelector('[data-slot="copy-button"]')
    expect(button).not.toBeNull()
    // 悬浮显现：默认隐藏、悬浮 / 聚焦可见
    expect(button).toHaveClass("opacity-0", "group-hover:opacity-100", "focus-visible:opacity-100")
  })

  it("className 可叠加布局而不丢 select-text", () => {
    const { container } = render(
      <CopySurface className="min-h-0 flex-1" getText={() => "文本"}>
        正文
      </CopySurface>,
    )
    expect(container.querySelector('[data-slot="copy-surface"]')).toHaveClass(
      "select-text",
      "min-h-0",
      "flex-1",
    )
  })
})

describe("CopyButton 复制链路", () => {
  it("点击：按 getText 口径写剪贴板并 toast 成功", async () => {
    const user = userEvent.setup()
    renderWithToaster(<CopyButton getText={() => "口径文本"} />)
    await user.click(screen.getByRole("button", { name: "复制" }))
    // 复制是 async 链：等 toast 出现再断言 spy
    expect(await screen.findByText("已复制")).toBeInTheDocument()
    expect(clipboardState.current.writeText).toHaveBeenCalledWith("口径文本")
  })

  it("点击时求值 getText：取的是点击时点的最新口径", async () => {
    const user = userEvent.setup()
    let text = "第一版"
    renderWithToaster(<CopyButton getText={() => text} />)
    text = "第二版"
    await user.click(screen.getByRole("button", { name: "复制" }))
    expect(await screen.findByText("已复制")).toBeInTheDocument()
    expect(clipboardState.current.writeText).toHaveBeenCalledWith("第二版")
  })

  it("剪贴板拒绝：toast 错误提示，不抛未捕获异常", async () => {
    const onUnhandled = vi.fn()
    window.addEventListener("unhandledrejection", onUnhandled)
    clipboardState.current.writeText.mockRejectedValue(new Error("denied"))
    const user = userEvent.setup()
    try {
      renderWithToaster(<CopyButton getText={() => "文本"} />)
      await user.click(screen.getByRole("button", { name: "复制" }))
      expect(await screen.findByText("复制失败，请手动复制")).toBeInTheDocument()
      expect(onUnhandled).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandled)
    }
  })

  it("getText 求值抛错：同样落到失败 toast，不向外抛", async () => {
    const user = userEvent.setup()
    renderWithToaster(
      <CopyButton
        getText={() => {
          throw new Error("口径失效")
        }}
      />,
    )
    await user.click(screen.getByRole("button", { name: "复制" }))
    expect(await screen.findByText("复制失败，请手动复制")).toBeInTheDocument()
    expect(clipboardState.current.writeText).not.toHaveBeenCalled()
  })

  it("成功 toast 到期自动消失（TTL 默认 5s）", async () => {
    vi.useFakeTimers()
    try {
      renderWithToaster(<CopyButton getText={() => "文本"} />)
      fireEvent.click(screen.getByRole("button", { name: "复制" }))
      // 冲刷微任务链：writeText resolve → toast push → 条目挂载并武装 TTL 定时器
      await act(async () => {})
      expect(screen.getByText("已复制")).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(5000)
      })
      expect(screen.queryByText("已复制")).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it("label 态：可见文字入按钮，无障碍名随文字", async () => {
    const user = userEvent.setup()
    renderWithToaster(<CopyButton label="复制全部 Headers" getText={() => "a: 1"} />)
    const button = screen.getByRole("button", { name: "复制全部 Headers" })
    await user.click(button)
    expect(await screen.findByText("已复制")).toBeInTheDocument()
    expect(clipboardState.current.writeText).toHaveBeenCalledWith("a: 1")
  })
})
