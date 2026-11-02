import { act } from "@testing-library/react"

import { ResizeObserverMock } from "../../test/setup"

/**
 * TreePrimitive 测试共用设施：接口树形态的模拟数据（分组 / 接口两级、
 * 千级行、含中文名）与 jsdom 视口模拟。
 */

export interface FixtureNode {
  id: string
  name: string
  children?: string[]
}

/** 小型树：两级分组 + 接口，覆盖折叠 / 展开 / 叶子各形态 */
export function createSmallTree(): Record<string, FixtureNode> {
  return {
    root: { id: "root", name: "根", children: ["g1", "g2"] },
    g1: { id: "g1", name: "用户服务", children: ["g1-a1", "g1-a2"] },
    g2: { id: "g2", name: "订单服务", children: [] },
    "g1-a1": { id: "g1-a1", name: "GET /users" },
    "g1-a2": { id: "g1-a2", name: "创建用户" },
  }
}

/**
 * 接口树 fixture：分组 / 接口两级、千级行、含中文名。
 * groupCount × apisPerGroup 行（不含根），默认 40 × 25 = 1000 行。
 */
export function createApiTreeFixture(
  groupCount = 40,
  apisPerGroup = 25,
): Record<string, FixtureNode> {
  const nodes: Record<string, FixtureNode> = {
    root: { id: "root", name: "根", children: [] },
  }
  const methodNames = ["查询订单", "创建订单", "删除订单", "GET /orders", "POST /orders"]
  for (let g = 0; g < groupCount; g++) {
    const groupId = `group-${g}`
    const apiIds: string[] = []
    for (let a = 0; a < apisPerGroup; a++) {
      const apiId = `${groupId}-api-${a}`
      // 名字混合中文与接口形态，保证 type-ahead / 截断渲染覆盖
      nodes[apiId] = {
        id: apiId,
        name: `${methodNames[a % methodNames.length]} ${g}-${a}`,
      }
      apiIds.push(apiId)
    }
    nodes[groupId] = { id: groupId, name: `分组 ${g + 1}`, children: apiIds }
    nodes.root!.children!.push(groupId)
  }
  return nodes
}

/** 模拟视口高度：jsdom 无布局，定义 offsetHeight 后手动触发 ResizeObserver 回调 */
export function simulateViewport(container: HTMLElement, height: number): void {
  const scrollEl = container.querySelector<HTMLElement>('[data-slot="tree-scroll"]')
  if (!scrollEl) throw new Error("tree scroll element not found")
  Object.defineProperty(scrollEl, "offsetHeight", { configurable: true, value: height })
  const observer = ResizeObserverMock.instances.at(-1)
  act(() => {
    observer?.callback([] as ResizeObserverEntry[], observer as unknown as ResizeObserver)
  })
}
