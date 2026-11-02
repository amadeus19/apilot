import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { Toaster, toast, toastStore } from "../feedback/toast"

// 模块级 store 的用例间隔离：清空当前全部条目
function clearAllToasts(): void {
  for (const item of toastStore.getSnapshot()) toast.dismiss(item.id)
}

beforeEach(clearAllToasts)
afterEach(clearAllToasts)

describe("toast store", () => {
  it("push 后 store 可见，dismiss 后移除", () => {
    const id = toast.error("写库失败")
    expect(toastStore.getSnapshot()).toHaveLength(1)
    toast.dismiss(id)
    expect(toastStore.getSnapshot()).toHaveLength(0)
  })

  it("同屏上限 5 条，超出丢最旧（缓冲有界）", () => {
    const ids: number[] = []
    for (let i = 0; i < 7; i++) ids.push(toast.info(`消息 ${i}`))
    const snapshot = toastStore.getSnapshot()
    expect(snapshot).toHaveLength(5)
    // 最旧两条被挤出
    expect(snapshot[0]?.message).toBe("消息 2")
    expect(snapshot.at(-1)?.message).toBe("消息 6")
  })
})

describe("Toaster 渲染", () => {
  it("呈现 message 与 description，无条目时不渲染容器", () => {
    const { container } = render(<Toaster />)
    expect(container).toBeEmptyDOMElement()

    act(() => {
      toast.error("写库失败", { description: "SETTINGS_VALUE_TOO_LARGE" })
    })
    expect(screen.getByText("写库失败")).toBeInTheDocument()
    expect(screen.getByText("SETTINGS_VALUE_TOO_LARGE")).toBeInTheDocument()
  })

  it("点击关闭按钮可移除该条", async () => {
    const user = userEvent.setup()
    render(<Toaster />)
    act(() => {
      toast.info("提示")
    })
    await user.click(screen.getByRole("button", { name: "关闭" }))
    expect(screen.queryByText("提示")).not.toBeInTheDocument()
  })

  it("TTL 到期自动移除（默认 5s）", () => {
    vi.useFakeTimers()
    try {
      render(<Toaster />)
      act(() => {
        toast.info("会过期")
      })
      expect(screen.getByText("会过期")).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(5000)
      })
      expect(screen.queryByText("会过期")).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it("悬浮暂停 TTL：超过时长不消失，移出后重新计满到期消失", () => {
    vi.useFakeTimers()
    try {
      render(<Toaster />)
      act(() => {
        toast.info("悬浮我")
      })
      const entry = screen.getByText("悬浮我").closest('[data-slot="toast"]')!

      // 悬浮两个 TTL 时长不消失
      fireEvent.mouseEnter(entry)
      act(() => {
        vi.advanceTimersByTime(10_000)
      })
      expect(screen.getByText("悬浮我")).toBeInTheDocument()

      // 移出后重新计满，到期消失
      fireEvent.mouseLeave(entry)
      act(() => {
        vi.advanceTimersByTime(4_999)
      })
      expect(screen.getByText("悬浮我")).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(screen.queryByText("悬浮我")).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
