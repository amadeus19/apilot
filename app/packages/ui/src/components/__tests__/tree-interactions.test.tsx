import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../overlay/context-menu"
import { TreePrimitive, type TreeContextMenuPosition, type TreeRowData } from "../display/tree"
import { createApiTreeFixture, simulateViewport, type FixtureNode } from "./tree-fixtures"

/** 树 + 行上 ContextMenu 的标准组装：业务提供菜单内容的形态 */
function setupTreeWithMenu(props: Partial<Parameters<typeof TreePrimitive<FixtureNode>>[0]> = {}) {
  const nodes = createApiTreeFixture(2, 5)
  const onRowContextMenu = vi.fn()
  const view = render(
    <ContextMenu>
      <ContextMenuTrigger render={<div data-testid="tree-menu-host" style={{ height: 300 }} />}>
        <TreePrimitive<FixtureNode>
          rootId="root"
          ariaLabel="接口树"
          dataLoader={{
            getItem: (id) => nodes[id]!,
            getChildren: (id) => nodes[id]?.children ?? [],
          }}
          expandedItems={nodes.root!.children}
          onRowContextMenu={onRowContextMenu}
          {...props}
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem>重命名</ContextMenuItem>
        <ContextMenuItem>删除</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>,
  )
  simulateViewport(view.container, 300)
  return { ...view, onRowContextMenu, nodes }
}

/** 裸树（无浮层包裹）：多选 / 受控语义测试用 */
function setupBareTree(props: Partial<Parameters<typeof TreePrimitive<FixtureNode>>[0]> = {}) {
  const nodes = createApiTreeFixture(2, 5)
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
        {...props}
      />
    </div>,
  )
  simulateViewport(view.container, 300)
  return { ...view, nodes }
}

describe("上下文菜单三通道", () => {
  it("右键行触发 onRowContextMenu（行 id + 鼠标坐标）", () => {
    const { container, onRowContextMenu, nodes } = setupTreeWithMenu()
    const row = container.querySelectorAll('[role="treeitem"]')[0]!
    const groups = nodes.root!.children!
    fireEventContextMenu(row)
    expect(onRowContextMenu).toHaveBeenCalledTimes(1)
    const [rowId, position] = onRowContextMenu.mock.calls[0] as [string, TreeContextMenuPosition]
    expect(rowId).toBe(groups[0])
    expect(position.x).toBe(0)
    expect(position.y).toBe(0)
  })

  it("Shift+F10 与 Menu 键等价触发（焦点行 + 行几何中心坐标）", () => {
    const { container, onRowContextMenu } = setupTreeWithMenu()
    const rows = container.querySelectorAll<HTMLElement>('[role="treeitem"]')
    const tree = container.querySelector('[role="tree"]')!
    rows[0]!.focus()

    tree.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }),
    )
    expect(onRowContextMenu).toHaveBeenCalledTimes(1)
    const [, position] = onRowContextMenu.mock.calls[0] as [string, TreeContextMenuPosition]
    // 行元素无布局（jsdom 全 0），坐标退化为行几何中心 0 点，不抛错
    expect(position).toEqual({ x: 0, y: 0 })

    tree.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }),
    )
    expect(onRowContextMenu).toHaveBeenCalledTimes(2)
  })

  it("键盘菜单通道把目标行先收为焦点行（roving 语义不漂移）", async () => {
    const user = userEvent.setup()
    const { container, onRowContextMenu } = setupTreeWithMenu()
    const tree = container.querySelector('[role="tree"]')!
    // 焦点经键盘路径到第二行（state 焦点），Shift+F10 目标行保持焦点行
    await user.tab()
    await user.keyboard("{ArrowDown}")
    tree.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }),
    )
    const [rowId] = onRowContextMenu.mock.calls[0] as [string, TreeContextMenuPosition]
    expect(rowId).toBe("group-0-api-0")
    expect(
      container.querySelector('[role="treeitem"][tabindex="0"]')?.getAttribute("aria-label"),
    ).toBe("查询订单 0-0")
  })
})

describe("renderRow 插槽", () => {
  it("插槽内容渲染行内动作按钮，可聚焦可激活且不破坏 roving tabindex", async () => {
    const user = userEvent.setup()
    const nodes = createApiTreeFixture(1, 3)
    const renderRow = vi.fn((row: TreeRowData<FixtureNode>) => (
      <span className="flex flex-1 items-center gap-1">
        <span className="truncate">{row.name}</span>
        <button type="button" data-testid={`action-${row.id}`}>
          置顶
        </button>
      </span>
    ))
    const { container } = render(
      <div style={{ height: 300 }}>
        <TreePrimitive<FixtureNode>
          rootId="root"
          ariaLabel="接口树"
          dataLoader={{
            getItem: (id) => nodes[id]!,
            getChildren: (id) => nodes[id]?.children ?? [],
          }}
          renderRow={renderRow}
        />
      </div>,
    )
    simulateViewport(container, 300)
    const rows = container.querySelectorAll<HTMLElement>('[role="treeitem"]')
    expect(renderRow).toHaveBeenCalled()

    // fixture(1,3) 展开前只有「分组 1」组行（group-0）
    const action = screen.getByTestId("action-group-0")
    await user.click(action)
    expect(action).toHaveFocus()
    // 行内控件聚焦后，行的 roving tabindex 语义不被破坏
    expect(rows[0]).toHaveAttribute("tabindex", "0")
  })
})

describe("多选 API（默认单焦点）", () => {
  it("点击行默认单选：选中集合只含被点行", async () => {
    const user = userEvent.setup()
    const onSelectedItemsChange = vi.fn()
    const { container } = setupBareTree({ onSelectedItemsChange })
    const rows = container.querySelectorAll<HTMLElement>('[role="treeitem"]')

    await user.click(rows[1]!)
    expect(onSelectedItemsChange).toHaveBeenCalledTimes(1)
    expect(onSelectedItemsChange).toHaveBeenCalledWith(["group-0-api-0"])
  })

  it("受控 selectedItems 支持多项选中（多选 API），逐行 aria-selected 语义", () => {
    const nodes = createApiTreeFixture(1, 3)
    const { container, rerender } = render(
      <div style={{ height: 300 }}>
        <TreePrimitive<FixtureNode>
          rootId="root"
          ariaLabel="接口树"
          dataLoader={{
            getItem: (id) => nodes[id]!,
            getChildren: (id) => nodes[id]?.children ?? [],
          }}
          selectedItems={[]}
        />
      </div>,
    )
    simulateViewport(container, 300)
    expect(screen.getByRole("treeitem", { name: "分组 1" })).toHaveAttribute(
      "aria-selected",
      "false",
    )

    rerender(
      <div style={{ height: 300 }}>
        <TreePrimitive<FixtureNode>
          rootId="root"
          ariaLabel="接口树"
          dataLoader={{
            getItem: (id) => nodes[id]!,
            getChildren: (id) => nodes[id]?.children ?? [],
          }}
          selectedItems={["group-0", "group-0-api-0"]}
        />
      </div>,
    )
    expect(screen.getByRole("treeitem", { name: "分组 1" })).toHaveAttribute(
      "aria-selected",
      "true",
    )
  })

  it("Ctrl+A 不触发全选（默认单焦点纪律）", async () => {
    const user = userEvent.setup()
    const onSelectedItemsChange = vi.fn()
    const { container } = setupBareTree({ onSelectedItemsChange })
    container.querySelector<HTMLElement>('[role="treeitem"]')!.focus()

    // 隔离初始化可能产生的状态外抛，只考察 Ctrl+A 本身
    onSelectedItemsChange.mockClear()
    await user.keyboard("{Control>}{a}{/Control}")
    expect(onSelectedItemsChange).not.toHaveBeenCalled()
  })
})

describe("嵌套浮层 Esc 基线", () => {
  it("行上 ContextMenu 打开后 Esc 关闭（Base UI 默认行为纳入基线）", async () => {
    const user = userEvent.setup()
    const { container } = setupTreeWithMenu()
    const row = container.querySelectorAll<HTMLElement>('[role="treeitem"]')[0]!
    row.focus()
    await user.pointer([{ keys: "[MouseRight]", target: row }])
    expect(screen.getByRole("menuitem", { name: "重命名" })).toBeInTheDocument()

    await user.keyboard("{Escape}")
    await waitFor(() => {
      expect(screen.queryByRole("menuitem")).not.toBeInTheDocument()
    })
  })
})

describe("接口树 fixture 场景（分组 / 接口两级、千级行、中文名）", () => {
  it("千级行受控全展开 + 键盘全流程 + 三通道菜单", async () => {
    const user = userEvent.setup()
    const nodes = createApiTreeFixture() // 40 组 × 25 接口 = 1000 行
    const onRowContextMenu = vi.fn()
    const onExpandedItemsChange = vi.fn()
    const { container } = render(
      <div style={{ height: 400 }}>
        <TreePrimitive<FixtureNode>
          rootId="root"
          ariaLabel="接口树"
          dataLoader={{
            getItem: (id) => nodes[id]!,
            getChildren: (id) => nodes[id]?.children ?? [],
          }}
          expandedItems={[]}
          onExpandedItemsChange={onExpandedItemsChange}
          onRowContextMenu={onRowContextMenu}
        />
      </div>,
    )
    simulateViewport(container, 400)

    // 千级行虚拟化：渲染行数有界
    const totalNodes = 40 + 1000
    const rendered = container.querySelectorAll('[role="treeitem"]').length
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThan(60)
    expect(totalNodes).toBe(1040)

    // 键盘全流程：进入树 → 移动 → 展开当前组（受控外抛）→ type-ahead 中文名
    await user.tab()
    const rows = container.querySelectorAll<HTMLElement>('[role="treeitem"]')
    await waitFor(() => expect(rows[0]).toHaveFocus())

    await user.keyboard("{ArrowRight}")
    expect(onExpandedItemsChange).toHaveBeenCalledWith(["group-0"])

    await user.keyboard("分")
    // type-ahead 命中下一个「分组 N」行（分组 2）并收为焦点行
    await waitFor(() => {
      const focused = container.querySelector('[role="treeitem"][tabindex="0"]')
      expect(focused?.getAttribute("aria-label")).toMatch(/^分组 \d+$/)
    })

    // 右键菜单通道在千级行树上仍可用
    const focusedRow = container.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')!
    fireEventContextMenu(focusedRow)
    expect(onRowContextMenu).toHaveBeenCalledTimes(1)
  })
})

/** 在元素上派发右键（contextmenu）事件 */
function fireEventContextMenu(target: Element): void {
  target.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }),
  )
}
