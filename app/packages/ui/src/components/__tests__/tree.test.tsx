import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { TreePrimitive, type TreeRowData } from "../display/tree"
import {
  createApiTreeFixture,
  createSmallTree,
  simulateViewport,
  type FixtureNode,
} from "./tree-fixtures"

function renderSmallTree(props: Partial<Parameters<typeof TreePrimitive<FixtureNode>>[0]> = {}) {
  const nodes = createSmallTree()
  const view = render(
    <div style={{ height: 300 }}>
      <TreePrimitive<FixtureNode>
        rootId="root"
        ariaLabel="接口树"
        dataLoader={{
          getItem: (id) => nodes[id]!,
          getChildren: (id) => nodes[id]?.children ?? [],
        }}
        {...props}
      />
    </div>,
  )
  simulateViewport(view.container, 300)
  return view
}

/** 渲染冒烟 + 核心（虚拟化 / roving tabindex / 键位 / type-ahead / 受控展开） */
describe("TreePrimitive 渲染与语义", () => {
  it("isItemFolder 自定义判定：空分组仍可按业务形态渲染为文件夹", () => {
    const nodes = createSmallTree()
    const { container } = render(
      <div style={{ height: 300 }}>
        <TreePrimitive<FixtureNode>
          rootId="root"
          ariaLabel="接口树"
          dataLoader={{
            getItem: (id) => nodes[id]!,
            getChildren: (id) => nodes[id]?.children ?? [],
          }}
          isItemFolder={(item) => item.children !== undefined}
          expandedItems={["g2"]}
        />
      </div>,
    )
    simulateViewport(container, 300)
    // g2（订单服务）children 为空数组，默认判定为叶子；业务判定后按文件夹展开
    const group = screen.getByRole("treeitem", { name: "订单服务" })
    expect(group).toHaveAttribute("aria-expanded", "true")
  })

  it("ARIA tree 语义：role / aria-label / treeitem 层级与展开态", () => {
    renderSmallTree({ expandedItems: ["g1"] })
    const tree = screen.getByRole("tree", { name: "接口树" })
    expect(tree).toBeInTheDocument()

    const group = screen.getByRole("treeitem", { name: "用户服务" })
    expect(group).toHaveAttribute("aria-level", "1")
    expect(group).toHaveAttribute("aria-expanded", "true")

    const leaf = screen.getByRole("treeitem", { name: "创建用户" })
    expect(leaf).toHaveAttribute("aria-level", "2")
    expect(leaf).not.toHaveAttribute("aria-expanded")
  })

  it("千级行 fixture 下渲染行数有界（虚拟化成立）", () => {
    const nodes = createApiTreeFixture()
    const { container } = render(
      <div style={{ height: 300 }}>
        <TreePrimitive<FixtureNode>
          rootId="root"
          ariaLabel="接口树"
          dataLoader={{
            getItem: (id) => nodes[id]!,
            getChildren: (id) => nodes[id]?.children ?? [],
          }}
          expandedItems={nodes.root!.children}
        />
      </div>,
    )
    simulateViewport(container, 300)
    const renderedRows = container.querySelectorAll('[role="treeitem"]').length
    // 300px 视口（10 行）+ overscan 有界窗口，远小于 1000 行总量
    expect(renderedRows).toBeGreaterThan(0)
    expect(renderedRows).toBeLessThan(60)
  })
})

describe("roving tabindex 与键位", () => {
  it("初始焦点语义：无焦点时首行 tabIndex=0 作为 Tab 入口，其余 -1", async () => {
    const user = userEvent.setup()
    const { container } = renderSmallTree()
    const rows = container.querySelectorAll<HTMLElement>('[role="treeitem"]')
    expect(rows[0]).toHaveAttribute("tabindex", "0")
    expect(rows[1]).toHaveAttribute("tabindex", "-1")

    await user.tab()
    await waitFor(() => {
      expect(rows[0]).toHaveFocus()
    })
    expect(rows[0]).toHaveAttribute("tabindex", "0")
  })

  it("↑↓ 在可见行间移动焦点，焦点行 tabIndex 单点为 0", async () => {
    const user = userEvent.setup()
    const { container } = renderSmallTree({ expandedItems: ["g1"] })
    const rows = container.querySelectorAll<HTMLElement>('[role="treeitem"]')

    await user.tab()
    await waitFor(() => expect(rows[0]).toHaveFocus())

    await user.keyboard("{ArrowDown}")
    await waitFor(() => expect(rows[1]).toHaveAttribute("tabindex", "0"))
    expect(rows[0]).toHaveAttribute("tabindex", "-1")

    await user.keyboard("{ArrowUp}")
    await waitFor(() => expect(rows[0]).toHaveAttribute("tabindex", "0"))
  })

  it("→ 展开折叠组、← 折叠或回父级、Home/End 首尾", async () => {
    const user = userEvent.setup()
    const onExpandedItemsChange = vi.fn()
    const { container } = renderSmallTree({ onExpandedItemsChange })

    await user.tab()
    await waitFor(() => expect(container.querySelector('[role="treeitem"]')).toHaveFocus())

    // → 展开当前组（受控外抛）
    await user.keyboard("{ArrowRight}")
    expect(onExpandedItemsChange).toHaveBeenCalledWith(["g1"])

    // 展开后出现子行，焦点仍在组行；← 折叠
    await user.keyboard("{ArrowLeft}")
    expect(onExpandedItemsChange).toHaveBeenLastCalledWith([])

    // End 跳末行 / Home 回首行
    const rows = container.querySelectorAll<HTMLElement>('[role="treeitem"]')
    await user.keyboard("{End}")
    await waitFor(() => expect(rows[rows.length - 1]).toHaveAttribute("tabindex", "0"))
    await user.keyboard("{Home}")
    await waitFor(() => expect(rows[0]).toHaveAttribute("tabindex", "0"))
  })

  it("Enter 触发主动作回调", async () => {
    const user = userEvent.setup()
    const onRowActivate = vi.fn()
    renderSmallTree({ expandedItems: ["g1"], onRowActivate })

    // 初始焦点在首行 g1（用户服务）；↓ 到首个子行后 Enter 主动作
    await user.tab()
    await user.keyboard("{ArrowDown}")
    await user.keyboard("{Enter}")
    expect(onRowActivate).toHaveBeenCalledTimes(1)
    const row = onRowActivate.mock.calls[0][0] as TreeRowData<FixtureNode>
    expect(row.id).toBe("g1-a1")
    expect(row.name).toBe("GET /users")
  })

  it("Space 与 Enter 等价触发主动作（ARIA treeview 双激活键）", async () => {
    const user = userEvent.setup()
    const onRowActivate = vi.fn()
    const { container } = renderSmallTree({ onRowActivate })

    await user.tab()
    await waitFor(() => {
      expect(container.querySelector<HTMLElement>('[role="treeitem"]')).toHaveFocus()
    })
    await user.keyboard(" ")
    expect(onRowActivate).toHaveBeenCalledTimes(1)
    expect(onRowActivate.mock.calls[0][1]).toBe("keyboard")
  })
})

describe("expansionTrigger=chevron 模式（行点击＝主动作，箭头＝展开）", () => {
  it("点击行首箭头：toggle 展开且不触发主动作、不改选中", async () => {
    const user = userEvent.setup()
    const onRowActivate = vi.fn()
    const onSelectedItemsChange = vi.fn()
    const onExpandedItemsChange = vi.fn()
    const { container } = renderSmallTree({
      expansionTrigger: "chevron",
      onRowActivate,
      onSelectedItemsChange,
      onExpandedItemsChange,
    })
    const chevron = container.querySelector("[data-tree-chevron]")!
    expect(chevron).not.toBeNull()

    await user.click(chevron)
    expect(onExpandedItemsChange).toHaveBeenCalledWith(["g1"])
    expect(onRowActivate).not.toHaveBeenCalled()
    expect(onSelectedItemsChange).not.toHaveBeenCalled()

    // 再点箭头＝收起
    await user.click(container.querySelector("[data-tree-chevron]")!)
    expect(onExpandedItemsChange).toHaveBeenLastCalledWith([])
  })

  it("点击 folder 行其余区域：触发主动作与选中，不 toggle 展开", async () => {
    const user = userEvent.setup()
    const onRowActivate = vi.fn()
    const onSelectedItemsChange = vi.fn()
    const onExpandedItemsChange = vi.fn()
    const { container } = renderSmallTree({
      expansionTrigger: "chevron",
      onRowActivate,
      onSelectedItemsChange,
      onExpandedItemsChange,
    })
    // jsdom 无布局：点击行元素自身即「行其余区域」（目标不在箭头内）
    await user.click(container.querySelectorAll<HTMLElement>('[role="treeitem"]')[0]!)

    expect(onRowActivate).toHaveBeenCalledTimes(1)
    expect(onRowActivate.mock.calls[0][0]).toMatchObject({ id: "g1", name: "用户服务" })
    expect(onSelectedItemsChange).toHaveBeenCalledWith(["g1"])
    expect(onExpandedItemsChange).not.toHaveBeenCalled()
  })

  it("默认 row 模式（接口树语义）不变：点击 folder 行＝选中＋主动作＋toggle 展开", async () => {
    const user = userEvent.setup()
    const onRowActivate = vi.fn()
    const onExpandedItemsChange = vi.fn()
    const { container } = renderSmallTree({ onRowActivate, onExpandedItemsChange })

    await user.click(container.querySelectorAll<HTMLElement>('[role="treeitem"]')[0]!)
    expect(onRowActivate).toHaveBeenCalledTimes(1)
    expect(onExpandedItemsChange).toHaveBeenCalledWith(["g1"])
  })
})

describe("type-ahead", () => {
  it("键入字符跳转到行名前缀匹配行；超时后重新起词", async () => {
    const user = userEvent.setup()
    const { container } = renderSmallTree()
    const rows = container.querySelectorAll<HTMLElement>('[role="treeitem"]')
    // 行序：用户服务（g1）、订单服务（g2）；键入「订」应跳到订单服务
    await user.tab()
    await waitFor(() => expect(rows[0]).toHaveFocus())

    await user.keyboard("订")
    await waitFor(() => expect(rows[1]).toHaveAttribute("tabindex", "0"))
  })

  it("输入法组合（isComposing）期间不消费字符", () => {
    const { container } = renderSmallTree()
    const rows = container.querySelectorAll<HTMLElement>('[role="treeitem"]')
    rows[0]!.focus()
    rows[0]!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ding",
        bubbles: true,
        cancelable: true,
        isComposing: true,
      }),
    )
    // 组合中的字符不触发跳转，焦点保持在原行
    expect(rows[0]).toHaveAttribute("tabindex", "0")
    expect(rows[1]).toHaveAttribute("tabindex", "-1")
  })
})

describe("顶部粘滞行（isRowSticky）", () => {
  /** 两分组各带 25 接口（52 行 × 28px ＝ 1456px 总高，视口 300px），
      depth 0 的分组行粘滞——形态对应接口树的服务行 */
  function renderStickyTree() {
    const nodes = createApiTreeFixture(2, 25)
    const view = render(
      <div style={{ height: 300 }}>
        <TreePrimitive<FixtureNode>
          rootId="root"
          ariaLabel="接口树"
          dataLoader={{
            getItem: (id) => nodes[id]!,
            getChildren: (id) => nodes[id]?.children ?? [],
          }}
          expandedItems={nodes.root!.children}
          isRowSticky={(row) => row.depth === 0}
        />
      </div>,
    )
    simulateViewport(view.container, 300)
    return view
  }

  function scrollTo(view: ReturnType<typeof renderStickyTree>, top: number): void {
    const scrollEl = view.container.querySelector<HTMLElement>('[data-slot="tree-scroll"]')!
    scrollEl.scrollTop = top
    act(() => {
      fireEvent.scroll(scrollEl)
    })
  }

  it("挂载即预挂首个粘滞行：包裹层钉在子树范围上，行以 sticky 形态单份呈现", () => {
    const view = renderStickyTree()
    // 分组 1（index 0，子树 [0,728)）与视口相交即挂包裹层；分组 2 未入视口不挂
    const wrappers = view.container.querySelectorAll('[data-slot="tree-sticky-range"]')
    expect(wrappers).toHaveLength(1)
    expect(wrappers[0]).toHaveStyle({ top: "0px", height: "728px" })
    // 行由包裹层独占渲染：native sticky（无 transform 位移），ARIA 树不重复
    const rows = screen.getAllByRole("treeitem", { name: "分组 1" })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveClass("sticky", "top-0")
    expect(rows[0].style.transform).toBe("")
    // 未滚动＝行在自然位置（未被钉住）：不带钉住态的底边线
    expect(rows[0]).not.toHaveClass("border-b")
  })

  it("滚入子树深处：行已滚出虚拟窗口仍由包裹层呈现；后继分组保持自然渲染", () => {
    const view = renderStickyTree()
    scrollTo(view, 280) // 视口首行 ≈ index 10，分组 1 自然位置（0）已远在窗口外
    const rows = screen.getAllByRole("treeitem", { name: "分组 1" })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveClass("sticky")
    expect(rows[0].style.transform).toBe("")
    // 滚动已越过行顶＝正被钉住：底边线呈现（区隔下层滚过的行）
    expect(rows[0]).toHaveClass("border-b")
    // 未滚出视口顶的后继分组不在包裹层内：自然渲染（absolute + 自然 transform）
    const next = screen.getByRole("treeitem", { name: "分组 2" })
    expect(next).not.toHaveClass("sticky")
    expect(next.style.transform).toBe("translateY(728px)")
    expect(view.container.querySelectorAll('[data-slot="tree-sticky-range"]')).toHaveLength(1)
  })

  it("子树末端包裹层在场（滑出段由 sticky 上下界钳制），走完卸载、下一分组接棒", () => {
    const view = renderStickyTree()
    scrollTo(view, 700) // 子树 [0,728) 末端仍在视口：包裹层保持挂载
    expect(screen.getAllByRole("treeitem", { name: "分组 1" })).toHaveLength(1)

    scrollTo(view, 800) // 分组 1 子树走完：卸载（滚出视口不再渲染），分组 2 接棒
    expect(screen.queryByRole("treeitem", { name: "分组 1" })).toBeNull()
    const next = screen.getAllByRole("treeitem", { name: "分组 2" })
    expect(next).toHaveLength(1)
    expect(next[0]).toHaveClass("sticky")
    expect(next[0].style.transform).toBe("")
    // 800 > 分组 2 行顶 728：接棒即处于钉住态
    expect(next[0]).toHaveClass("border-b")
    const wrappers = view.container.querySelectorAll('[data-slot="tree-sticky-range"]')
    expect(wrappers).toHaveLength(1)
    expect(wrappers[0]).toHaveStyle({ top: "728px", height: "728px" })
  })

  it("不传 isRowSticky：无包裹层，滚出视口即不渲染（现状行为不变）", () => {
    const nodes = createApiTreeFixture(2, 25)
    const view = render(
      <div style={{ height: 300 }}>
        <TreePrimitive<FixtureNode>
          rootId="root"
          ariaLabel="接口树"
          dataLoader={{
            getItem: (id) => nodes[id]!,
            getChildren: (id) => nodes[id]?.children ?? [],
          }}
          expandedItems={nodes.root!.children}
        />
      </div>,
    )
    simulateViewport(view.container, 300)
    scrollTo(view, 280)
    expect(view.container.querySelector('[data-slot="tree-sticky-range"]')).toBeNull()
    expect(screen.queryByRole("treeitem", { name: "分组 1" })).toBeNull()
  })
})

describe("跟随定位（revealId）", () => {
  /** 52 行 × 28px、视口 300px：定位目标取分组 2 内接口（自然位置远在视口外） */
  function renderRevealTree(isRowSticky?: (row: TreeRowData<FixtureNode>) => boolean) {
    const nodes = createApiTreeFixture(2, 25)
    const view = render(
      <div style={{ height: 300 }}>
        <TreePrimitive<FixtureNode>
          rootId="root"
          ariaLabel="接口树"
          dataLoader={{
            getItem: (id) => nodes[id]!,
            getChildren: (id) => nodes[id]?.children ?? [],
          }}
          expandedItems={nodes.root!.children}
          isRowSticky={isRowSticky}
          revealId={null}
        />
      </div>,
    )
    simulateViewport(view.container, 300)
    const scrollEl = view.container.querySelector<HTMLElement>('[data-slot="tree-scroll"]')!
    scrollEl.scrollTo = vi.fn()
    return { nodes, view, scrollEl }
  }

  function rerenderReveal(
    view: ReturnType<typeof render>,
    nodes: Record<string, FixtureNode>,
    props: { revealId: string | null; revealNonce?: number },
    isRowSticky?: (row: TreeRowData<FixtureNode>) => boolean,
  ): void {
    view.rerender(
      <div style={{ height: 300 }}>
        <TreePrimitive<FixtureNode>
          rootId="root"
          ariaLabel="接口树"
          dataLoader={{
            getItem: (id) => nodes[id]!,
            getChildren: (id) => nodes[id]?.children ?? [],
          }}
          expandedItems={nodes.root!.children}
          isRowSticky={isRowSticky}
          {...props}
        />
      </div>,
    )
  }

  it("定位视口外的行：滚动到该行（jsdom 无布局 clientHeight=0，行必判定为视口外）", () => {
    const { nodes, view, scrollEl } = renderRevealTree()
    rerenderReveal(view, nodes, { revealId: "group-1-api-20" })
    expect(scrollEl.scrollTo).toHaveBeenCalled()
  })

  it("目标行已在真实视口内：不滚动（点击行场景零滋扰）", () => {
    const { nodes, view, scrollEl } = renderRevealTree()
    // 视口 [0,300)：index 2（rowTop 56）完全在视口内
    Object.defineProperty(scrollEl, "clientHeight", { configurable: true, value: 300 })
    rerenderReveal(view, nodes, { revealId: "group-0-api-1" })
    expect(scrollEl.scrollTo).not.toHaveBeenCalled()
  })

  it("同 id 重复定位：revealId 值不变，代次变化仍重放滚动", () => {
    const { nodes, view, scrollEl } = renderRevealTree()
    rerenderReveal(view, nodes, { revealId: "group-1-api-20", revealNonce: 1 })
    expect(scrollEl.scrollTo).toHaveBeenCalledTimes(1)
    rerenderReveal(view, nodes, { revealId: "group-1-api-20", revealNonce: 2 })
    expect(scrollEl.scrollTo).toHaveBeenCalledTimes(2)
  })

  it("粘滞树定位子树深处行：贴顶让出钉住分组行的高度（目标行不被遮）", () => {
    const sticky = (row: TreeRowData<FixtureNode>): boolean => row.depth === 0
    const { nodes, view, scrollEl } = renderRevealTree(sticky)
    // 先滚进分组 2 子树：目标行（index 10，rowTop 280）已在视口上方
    scrollEl.scrollTop = 800
    act(() => {
      fireEvent.scroll(scrollEl)
    })
    rerenderReveal(view, nodes, { revealId: "group-0-api-9" }, sticky)
    // 贴顶但下移一行：280 - 28 = 252（钉住的分组行占视口顶 28px）
    expect(scrollEl.scrollTo).toHaveBeenLastCalledWith({ top: 252 })
  })

  it("目标行贴视口顶但被钉住分组行覆盖：不视为已可见，仍滚动", () => {
    const sticky = (row: TreeRowData<FixtureNode>): boolean => row.depth === 0
    const { nodes, view, scrollEl } = renderRevealTree(sticky)
    Object.defineProperty(scrollEl, "clientHeight", { configurable: true, value: 300 })
    // 目标行（index 10，rowTop 280）恰好贴视口顶：无让位时会被判「可见」而漏滚
    scrollEl.scrollTop = 280
    act(() => {
      fireEvent.scroll(scrollEl)
    })
    rerenderReveal(view, nodes, { revealId: "group-0-api-9" }, sticky)
    expect(scrollEl.scrollTo).toHaveBeenCalled()
  })
})
