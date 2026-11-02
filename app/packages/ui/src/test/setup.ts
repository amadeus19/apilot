// RTL 断言扩展 + 每用例 DOM 清理
import "@testing-library/jest-dom/vitest"

import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"

// jsdom 不实现 ResizeObserver：cmdk（命令面板）与虚拟化列表挂载期测量依赖它；
// 测试只断言语义与行为，不关心真实尺寸。mock 记录回调实例，需要模拟尺寸
// 变化的测试可经 ResizeObserverMock.instances 手动触发 callback
class ResizeObserverMock {
  static instances: ResizeObserverMock[] = []
  callback: ResizeObserverCallback
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    ResizeObserverMock.instances.push(this)
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver
}
export { ResizeObserverMock }

// jsdom 不实现 scrollIntoView：cmdk 选中项滚动可见性依赖它；测试不关心滚动
if (typeof Element.prototype.scrollIntoView === "undefined") {
  Element.prototype.scrollIntoView = function scrollIntoView() {}
}

afterEach(() => {
  cleanup()
  ResizeObserverMock.instances.length = 0
})
