"use client"

import * as React from "react"
import {
  hotkeysCoreFeature,
  selectionFeature,
  syncDataLoaderFeature,
  type ItemInstance,
  type TreeDataLoader,
} from "@headless-tree/core"
import { useTree } from "@headless-tree/react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ChevronRightIcon } from "lucide-react"
import { cn } from "cn"

/**
 * TreePrimitive：树视图纯原语（headless-tree 树语义 × react-virtual 虚拟化）。
 * 不内置业务形态——接口树 / 变量树 / 环境清单等业务树由业务侧以本原语组装。
 *
 * 行为规格：
 * - 焦点＝经典 roving tabindex（焦点行 tabIndex=0、其余 -1），focus-visible
 *   焦点环走 --ring；Tab 进入无焦点的树时落到首行
 * - 键位：↑↓ 移动、←→ 折叠/展开/回父级、Home/End 首尾、Enter/Space 主动作、
 *   type-ahead 字符跳转（中文输入法 isComposing 守卫；空格不参与 type-ahead，
 *   已被 Space 主动作占用）
 * - 上下文菜单三通道等价：右键 / Shift+F10 / Menu 键统一回调
 *   onRowContextMenu(rowId, 坐标)，坐标可直接供浮层定位
 * - 多选 API 支持但默认单焦点（Ctrl+A / Ctrl+Space 键位禁用）
 * - 受控展开 / 受控选中：传对应 prop 即受控；不传则内部管理，变化仍经回调外抛
 *
 * 渲染期写 ref 的豁免边界（UI 包原语特例，业务代码不援引）：本组件存在三处
 * 渲染期 ref 写入——受控基线同步（lastEmittedRef）、items 快照
 * （itemsRef）、虚拟化实例登记（virtualizerRef）。前两者的正确性依赖
 * 「渲染产物即真相」的时序：延迟到 effect 会在「渲染后、effect 前」的库
 * 事件回放窗口读到陈旧基线，造成受控模式重复外抛；第三处是虚拟化器在
 * 渲染中创建实例的库契约。收敛性已核对（写入幂等、无读取参与渲染输出、
 * 无条件分支依赖写入顺序），这是与业务代码 latest-ref 禁令的有意识例外。
 */

/** 树行对外数据视图：业务经 renderRow / 回调消费，不接触树实例内部 */
export interface TreeRowData<T> {
  /** 行唯一 id（稳定键） */
  id: string
  /** 行显示名 */
  name: string
  /** 业务节点数据 */
  data: T
  /** 层级（0 起算，根的直接子级为 0） */
  depth: number
  /** 该行缩进像素（层级 × 每级步进）——步进是组件内部常量，业务侧不自行相乘 */
  indentPx: number
  isFolder: boolean
  isExpanded: boolean
  isSelected: boolean
  isFocused: boolean
}

export interface TreeContextMenuPosition {
  x: number
  y: number
}

/** 行拖拽落点意图（业务在 onRowDragOver 判定；组件按此绘制指示器） */
export type TreeDropMode = "before" | "after" | "inside"

export interface TreePrimitiveProps<T> {
  /** 数据加载器：按 id 取节点数据与子 id 列表（同步形状） */
  dataLoader: TreeDataLoader<T>
  /** 根节点 id：只作树根，不渲染 */
  rootId: string
  /** 树的无障碍名称（业务从 i18n 传入） */
  ariaLabel: string
  /**
   * 文件夹判定：返回 true 的行渲染折叠指示并支持展开。
   * 默认「有子节点即文件夹」——空分组等业务自定义形态经此覆盖
   */
  isItemFolder?: (item: T) => boolean
  /** 展开行 id 列表（受控模式） */
  expandedItems?: string[]
  /** 展开变化回调（受控外抛；非受控时同样通知） */
  onExpandedItemsChange?: (ids: string[]) => void
  /** 选中行 id 列表（受控模式；不传走点击单选语义） */
  selectedItems?: string[]
  /** 选中变化回调 */
  onSelectedItemsChange?: (ids: string[]) => void
  /**
   * 主动作回调：单击行与 Enter/Space 均触发，source 区分来源——
   * 业务据此实现「单击＝预览打开、Enter＝常驻打开」等差异化语义
   */
  onRowActivate?: (row: TreeRowData<T>, source: "click" | "keyboard") => void
  /**
   * 展开触发面（默认「row」＝点击行任意处折叠/展开，接口树语义）：
   * 「chevron」＝仅行首折叠指示命中区（[data-tree-chevron]）点击折叠/展开——
   * 命中箭头时只收焦点与切换展开（不改选中、不触发主动作），行其余区域
   * 点击等价库的单选 / 焦点 / 主动作链路但不触碰展开态。适用于「行点击＝
   * 打开详情页」的导航树（变量树 / 工作空间树）。两模式下 ←/→ 键的
   * 折叠 / 展开 / 回父级语义不变
   */
  expansionTrigger?: "row" | "chevron"
  /** 上下文菜单三通道统一回调（坐标可供浮层定位） */
  onRowContextMenu?: (rowId: string, position: TreeContextMenuPosition) => void
  /** 行双击回调（与主动作独立的双击语义：预览 Tab 原地转正等） */
  onRowDoubleClick?: (row: TreeRowData<T>) => void
  /** 行是否可拖拽（每次渲染判定；不传＝整树不可拖） */
  isRowDraggable?: (row: TreeRowData<T>) => boolean
  /**
   * 顶部粘滞判定：返回 true 的容器行参与「粘顶」——滚动把行推出视口顶、
   * 其子树仍有内容在视口内时，行钉在滚动区顶部跟随（子树走完随末行自然
   * 滑出）。实现为子树范围包裹层＋原生 CSS sticky：钉住位移由合成器驱动，
   * 不依赖滚动事件的重渲染；本组件只按视口相交裁决包裹层挂载
   */
  isRowSticky?: (row: TreeRowData<T>) => boolean
  /**
   * 拖拽开始（业务经 event.dataTransfer 设置数据与效果）。
   * 拖拽发起采用「手柄武装制」：仅按住行内 `[data-drag-handle]` 元素才
   * 解锁该行 draggable——手柄是唯一拖拽入口，避免整行任意位置误拖。
   */
  onRowDragStart?: (row: TreeRowData<T>, event: React.DragEvent) => void
  /**
   * 拖拽悬停：业务返回落点意图（null＝此处不可落，不回调 onRowDrop）；
   * 落点指示器的绘制与随行清理由本组件承担
   */
  onRowDragOver?: (row: TreeRowData<T>, event: React.DragEvent) => TreeDropMode | null
  /** 放下（仅悬停判定为可落的目标行触发） */
  onRowDrop?: (row: TreeRowData<T>, event: React.DragEvent) => void
  /** 拖拽结束（落下与否都触发；业务在此清自身拖拽态） */
  onRowDragEnd?: (row: TreeRowData<T>, event: React.DragEvent) => void
  /**
   * 行内容渲染插槽：返回行内内容（缩进后的主体），行容器（键盘 / ARIA /
   * 虚拟化定位）仍由本组件持有；不传用默认行渲染（折叠指示 + 名称）
   */
  renderRow?: (row: TreeRowData<T>) => React.ReactNode
  /**
   * 跟随定位行 id（外部驱动，如「激活 Tab → 树行定位」）：值变化时把该行
   * 滚进可视区（已在可视区内则不动，点击行的场景零滋扰）；行因祖先折叠
   * 暂不在渲染序列时，待展开生效后自动补滚动。传 null / undefined 不动作。
   */
  revealId?: string | null
  /**
   * 定位请求代次（外部自增计数）：revealId 不变时（重复定位同一节点，
   * 如面包屑连续点击当前接口）React 值相等不触发 effect，经代次变化强制
   * 重放滚动。语义上与 revealId 合成一个「定位请求」：id 指目标、代次表
   * 「这是一次新请求」
   */
  revealNonce?: number
  /** 行高（虚拟化步长，px） */
  rowHeight?: number
  className?: string
}

/** 缺省行高：与 text-row（13px）行文匹配的紧凑桌面密度 */
const DEFAULT_ROW_HEIGHT = 28
/** 每层级缩进（px） */
const INDENT_PER_LEVEL = 14
/** 行内容水平留白（px）：与左栏搜索框的 p-2 基准一致，避免行首图标与
 * 行尾手柄贴住面板边缘 */
const ROW_INLINE_PADDING = 8
/** type-ahead 缓冲有效期（ms）：超时视为新词 */
const TYPE_AHEAD_RESET_MS = 500

interface TreeSlice {
  expandedItems: string[]
  selectedItems: string[]
  focusedItem: string | null
}

function toRowData<T>(item: ItemInstance<T>): TreeRowData<T> {
  return {
    id: item.getId(),
    name: item.getItemName(),
    data: item.getItemData(),
    depth: item.getItemMeta().level,
    indentPx: item.getItemMeta().level * INDENT_PER_LEVEL,
    isFolder: item.isFolder(),
    isExpanded: item.isExpanded(),
    isSelected: item.isSelected(),
    isFocused: item.isFocused(),
  }
}

/** id 数组浅比较（同序同值），用于状态桥的去重外抛守卫 */
function arrayShallowEquals(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((id, index) => id === b![index])
}

/**
 * 目标行上方「将钉在视口顶」的粘滞祖先行数：自目标行回扫行序，层级变浅的
 * 行即某级祖先（虚拟化平铺行序上，更浅的行只可能是祖先），计数其中参与
 * 粘滞的。跟随定位的可见判定与贴顶滚动都须让出这些行的高度——粘滞行
 * 不透明且钉在视口顶，贴顶的目标行会被其遮住
 */
function countStickyAncestors<T>(
  items: ItemInstance<T>[],
  index: number,
  isRowSticky?: (row: TreeRowData<T>) => boolean,
): number {
  if (!isRowSticky) return 0
  let count = 0
  let level = items[index]!.getItemMeta().level
  for (let i = index - 1; i >= 0; i--) {
    const prevLevel = items[i]!.getItemMeta().level
    if (prevLevel < level) {
      if (isRowSticky(toRowData(items[i]!))) count++
      level = prevLevel
    }
    if (prevLevel === 0) break
  }
  return count
}

export function TreePrimitive<T>({
  dataLoader,
  rootId,
  ariaLabel,
  isItemFolder,
  expandedItems,
  onExpandedItemsChange,
  selectedItems,
  onSelectedItemsChange,
  onRowActivate,
  onRowContextMenu,
  onRowDoubleClick,
  expansionTrigger = "row",
  isRowDraggable,
  isRowSticky,
  onRowDragStart,
  onRowDragOver,
  onRowDrop,
  onRowDragEnd,
  renderRow,
  revealId,
  revealNonce,
  rowHeight = DEFAULT_ROW_HEIGHT,
  className,
}: TreePrimitiveProps<T>) {
  // —— 树状态：受控 props 优先，非受控走内部 state；展开 / 选中变化统一外抛 ——
  const [internalState, setInternalState] = React.useState<TreeSlice>(() => ({
    expandedItems: [],
    selectedItems: [],
    focusedItem: null,
  }))

  const expanded = expandedItems ?? internalState.expandedItems
  const selected = selectedItems ?? internalState.selectedItems

  // 外抛守卫：库在 mount 回放与事件链上会对桥重复通知同值，
  // 以「上次外抛值」基线去重——仅真变化才回调。基线初值＝初始生效值；
  // 受控模式下渲染期把基线同步为受控当前值（prop 即真相），使库对同值
  // 的重复通知与 mount 回放都不外抛
  const lastEmittedRef = React.useRef<{ expanded?: string[]; selected?: string[] }>({
    expanded: expandedItems ?? [],
    selected: selectedItems ?? [],
  })
  if (expandedItems !== undefined) lastEmittedRef.current.expanded = expandedItems
  if (selectedItems !== undefined) lastEmittedRef.current.selected = selectedItems

  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  // scrollToItem / 跟随定位挂点在 useTree config 内，经 ref 解引用虚拟化实例
  // （避免声明顺序耦合）
  const virtualizerRef = React.useRef<{
    scrollToIndex: (index: number, options?: { align?: "start" | "end" | "auto" }) => void
    getVirtualItems: () => { index: number }[]
  } | null>(null)

  const tree = useTree<T>({
    features: [syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
    rootItemId: rootId,
    dataLoader,
    getItemName: (item) => String((item.getItemData() as { name?: string })?.name ?? ""),
    isItemFolder: isItemFolder
      ? (item) => isItemFolder(item.getItemData())
      : (item) => item.getChildren().length > 0,
    // 状态桥：headless-tree 内部先按自身 state resolve 再通知；这里同步内部
    // state（非受控键生效），经基线去重后把展开 / 选中变化外抛（受控键由 prop 回灌）
    setState: (updaterOrValue) => {
      const next =
        typeof updaterOrValue === "function" ? updaterOrValue(tree.getState()) : updaterOrValue
      setInternalState((prev) => ({ ...prev, ...next }))
      if (
        next.expandedItems !== undefined &&
        !arrayShallowEquals(lastEmittedRef.current.expanded, next.expandedItems)
      ) {
        lastEmittedRef.current.expanded = next.expandedItems
        onExpandedItemsChange?.(next.expandedItems)
      }
      if (
        next.selectedItems !== undefined &&
        !arrayShallowEquals(lastEmittedRef.current.selected, next.selectedItems)
      ) {
        lastEmittedRef.current.selected = next.selectedItems
        onSelectedItemsChange?.(next.selectedItems)
      }
    },
    onPrimaryAction: (item) => onRowActivate?.(toRowData(item), "click"),
    // 焦点移动后（updateDomFocus 内）滚动虚拟化窗口跟随
    scrollToItem: (item) => virtualizerRef.current?.scrollToIndex(item.getItemMeta().index),
    hotkeys: {
      // 默认单焦点纪律：Ctrl+A / Ctrl+Space 键位禁用；
      // 覆盖项须保留 hotkey 字段（注册表按键整体替换而非合并）
      selectAll: { hotkey: "Control+KeyA", isEnabled: () => false },
      toggleSelectedItem: { hotkey: "Control+Space", isEnabled: () => false },
      // Enter / Space 主动作：业务定义打开语义（ARIA treeview 双激活键惯例）
      customActivate: {
        hotkey: "Enter",
        preventDefault: true,
        handler: (_event, treeInstance) => {
          const focused = treeInstance.getItems().find((item) => item.isFocused())
          if (focused) onRowActivate?.(toRowData(focused), "keyboard")
        },
      },
      customActivateSpace: {
        hotkey: "Space",
        preventDefault: true,
        handler: (_event, treeInstance) => {
          const focused = treeInstance.getItems().find((item) => item.isFocused())
          if (focused) onRowActivate?.(toRowData(focused), "keyboard")
        },
      },
    },
    state: {
      expandedItems: expanded,
      selectedItems: selected,
      focusedItem: internalState.focusedItem,
    },
  })

  // 数据结构重建：库只在挂载与展开态变化时重建实例表；dataLoader 引用
  // 变化即视为结构变化（搜索过滤、数据刷新产生新 loader），自动重建——
  // 「哪些数据变化算结构变化」由本 adapter 裁决，调用方不感知
  React.useEffect(() => {
    tree.rebuildTree()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tree 实例引用恒定，重建仅由 loader 引用驱动
  }, [tree, dataLoader])

  const items = tree.getItems()

  // —— 跟随定位：定位请求（revealId＋代次）或展开态变化（祖先补展开后
  // 行才出现）时滚动；目标行已在真实视口内则不动（点击行的场景零滋扰）。
  // 视口判定用滚动容器的 scrollTop / clientHeight 而非虚拟窗口——
  // getVirtualItems 含 overscan（默认 8 行），拿它判「可见」会让视口外
  // 数行处于「看不见却不滚」的盲区 ——
  const itemsRef = React.useRef(items)
  itemsRef.current = items
  const expandedKey = expanded.join("\u0000")
  React.useEffect(() => {
    if (!revealId) return
    const items = itemsRef.current
    const index = items.findIndex((item) => item.getId() === revealId)
    if (index < 0) return
    const virtualizer = virtualizerRef.current
    const scrollEl = scrollRef.current
    const rowTop = index * rowHeight
    if (scrollEl) {
      // 粘滞祖先会钉在视口顶：可见判定与贴顶滚动都让出其高度
      //（countStickyAncestors 语义见其注释）
      const stickyAncestors = countStickyAncestors(items, index, isRowSticky)
      if (
        rowTop >= scrollEl.scrollTop + stickyAncestors * rowHeight &&
        rowTop + rowHeight <= scrollEl.scrollTop + scrollEl.clientHeight
      ) {
        return
      }
      // 最小滚动：下方行贴底呈现、上方行上移贴顶。不用 align auto——它按含
      // overscan 的虚拟窗口判「已在位」，视口边缘行会被漏滚
      if (rowTop >= scrollEl.scrollTop) {
        virtualizer?.scrollToIndex(index, { align: "end" })
        return
      }
      if (stickyAncestors > 0) {
        scrollEl.scrollTo({ top: Math.max(0, rowTop - stickyAncestors * rowHeight) })
        return
      }
      virtualizer?.scrollToIndex(index, { align: "start" })
      return
    }
    virtualizer?.scrollToIndex(index)
    // items 经 ref 读取（每次渲染新引用，不进依赖）；展开键触发祖先补展开后的补滚动
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖语义见上
  }, [revealId, revealNonce, expandedKey, rowHeight])

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
  })
  virtualizerRef.current = rowVirtualizer

  // —— 顶部粘滞（isRowSticky）：以「子树范围包裹层＋原生 CSS sticky」实现。
  // 包裹层绝对定位在粘滞行的子树像素范围上（行高恒定 ⇒ 几何由行序推出：
  // 行顶＝index × rowHeight，子树末＝首个不深于自身的后继行），行元素
  // sticky top-0 受包裹层上下界钳制——滚出视口顶即钉住、子树末行到达即
  // 随之上滑。钉住位移由合成器驱动，不经滚动事件的重渲染，滚动再忙也不
  // 落后一帧；JS 只裁决包裹层挂载（子树范围与视口相交即挂，含一行预挂
  // 缓冲；挂载晚一帧只是多渲染一个不可见行，不产生视觉错位）。stuck＝
  // 滚动位置已越过行顶（行正被钉住）——CSS 自身感知不到钉住态，边框等
  // 钉住专属的视觉以此标记呈现 ——
  const [viewport, setViewport] = React.useState({ top: 0, height: 0 })
  const stickyRanges = React.useMemo(() => {
    const ranges = new Map<number, { startPx: number; endPx: number; stuck: boolean }>()
    if (!isRowSticky || items.length === 0) return ranges
    const viewportBottom = viewport.top + viewport.height + rowHeight
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!
      if (!item.isFolder()) continue
      const row = toRowData(item)
      if (!isRowSticky(row)) continue
      const depth = item.getItemMeta().level
      let end = i + 1
      while (end < items.length && items[end]!.getItemMeta().level > depth) end++
      const startPx = i * rowHeight
      const endPx = end * rowHeight
      if (startPx < viewportBottom && endPx > viewport.top) {
        ranges.set(i, { startPx, endPx, stuck: viewport.top > startPx })
      }
    }
    return ranges
  }, [items, viewport, rowHeight, isRowSticky])

  const focusItem = (item: ItemInstance<T> | undefined): void => {
    if (!item) return
    item.setFocused()
    tree.updateDomFocus()
    rowVirtualizer.scrollToIndex(item.getItemMeta().index)
  }

  // —— type-ahead：可打印字符累积匹配行名；输入法组合（isComposing）期间不消费 ——
  const typeAheadRef = React.useRef({ buffer: "", at: 0 })

  const handleTypeAhead = (event: React.KeyboardEvent): void => {
    if (event.nativeEvent.isComposing) return
    // 空格是 Space 主动作键（已由 hotkey 分发并阻止默认滚动），不作为
    // type-ahead 输入字符，避免污染前缀匹配缓冲
    if (event.key === " ") return
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return
    const now = Date.now()
    const ahead = typeAheadRef.current
    const buffer =
      now - ahead.at <= TYPE_AHEAD_RESET_MS
        ? ahead.buffer + event.key.toLowerCase()
        : event.key.toLowerCase()
    ahead.at = now

    const allItems = tree.getItems()
    if (allItems.length === 0) return
    const focusedIndex = allItems.findIndex((item) => item.isFocused())
    const ordered = [...allItems.slice(focusedIndex + 1), ...allItems.slice(0, focusedIndex + 1)]
    const match = ordered.find((item) => item.getItemName().toLowerCase().startsWith(buffer))
    if (match) {
      ahead.buffer = buffer
      focusItem(match)
    } else {
      // 无匹配则丢弃旧缓冲，以本键重开（连续敲错不粘滞）
      ahead.buffer = event.key.toLowerCase()
    }
    event.preventDefault()
  }

  // —— 上下文菜单三通道：右键 / Shift+F10 / Menu 统一收敛到 onRowContextMenu ——
  const openRowContextMenu = (rowId: string, position: TreeContextMenuPosition): void => {
    // 键盘通道与右键通道等价前置：菜单目标行先成为焦点行
    const item = tree.getItemInstance(rowId)
    if (item && !item.isFocused()) focusItem(item)
    onRowContextMenu?.(rowId, position)
  }

  const handleRowContextMenu = (event: React.MouseEvent, item: ItemInstance<T>): void => {
    event.preventDefault()
    openRowContextMenu(item.getId(), { x: event.clientX, y: event.clientY })
  }

  // —— chevron 模式行点击：替代库 onClick（其内置「folder 行 toggle 展开」
  // 无法按命中区域关闭，故整体等价重写）。行为对齐主流文件树（VS Code）：
  // 箭头命中＝纯展开/收起（收焦点，不改选中、不触发主动作——展开意图与
  // 「打开详情」意图互斥）；行其余区域＝库同款单选 / 修饰键多选 / 焦点 /
  // 主动作链路，唯独不 toggle 展开 ——
  const handleRowClickChevron = (event: React.MouseEvent, item: ItemInstance<T>): void => {
    item.setFocused()
    if (
      item.isFolder() &&
      event.target instanceof Element &&
      event.target.closest("[data-tree-chevron]")
    ) {
      if (item.isExpanded()) {
        item.collapse()
      } else {
        item.expand()
      }
      return
    }
    if (event.shiftKey) {
      item.selectUpTo(event.ctrlKey || event.metaKey)
    } else if (event.ctrlKey || event.metaKey) {
      item.toggleSelect()
    } else {
      tree.setSelectedItems([item.getId()])
    }
    if (!event.shiftKey) {
      tree.getDataRef<{ selectUpToAnchorId?: string | null }>().current.selectUpToAnchorId =
        item.getId()
    }
    item.primaryAction()
  }

  const handleContainerKeyDown = (event: React.KeyboardEvent): void => {
    if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
      const focused = tree.getItems().find((item) => item.isFocused())
      if (!focused) return
      // 浮层锚点取焦点行几何中心（无布局信息时退化为 0 点，业务可自行兜底）
      const rect = focused.getElement()?.getBoundingClientRect()
      openRowContextMenu(focused.getId(), {
        x: rect ? rect.left + rect.width / 2 : 0,
        y: rect ? rect.top + rect.height / 2 : 0,
      })
      event.preventDefault()
      return
    }
    handleTypeAhead(event)
  }

  // —— 行拖拽：落点指示器单一状态（同屏至多一行有指示），随 dragover 刷新 ——
  // dropHint 的读取（onDrop）经 ref 镜像，避免事件闭包读到过期 state
  const [dropHint, setDropHintState] = React.useState<{ id: string; mode: TreeDropMode } | null>(
    null,
  )
  const dropHintRef = React.useRef(dropHint)
  const setDropHint = (next: { id: string; mode: TreeDropMode } | null): void => {
    const prev = dropHintRef.current
    if (prev?.id === next?.id && prev?.mode === next?.mode) return
    dropHintRef.current = next
    setDropHintState(next)
  }

  // —— 手柄武装制：行默认不带 draggable；按住行内 [data-drag-handle] 的
  // mousedown 才解锁该行拖拽（拖动意图检测发生在 mousedown 之后的移动帧，
  // React 属性落 DOM 早于浏览器拖动阈值），松手 / 拖拽结束即重新上锁 ——
  const [dragArmedId, setDragArmedId] = React.useState<string | null>(null)

  const containerProps = tree.getContainerProps(ariaLabel)
  const virtualItems = rowVirtualizer.getVirtualItems()

  /** 单行定位：absolute＝虚拟化常规行（transform 平移）；sticky＝粘滞行（包裹层内原生钉顶，stuck＝正被钉住） */
  type RowPositioning =
    { mode: "absolute"; size: number; start: number } | { mode: "sticky"; stuck: boolean }

  /**
   * 单行渲染：sticky 形态由包裹层内的原生 CSS sticky 承担位移（不设
   * transform），不透明底遮挡下层滚过的行；底边线只在行被实际钉住时呈现
   * （stuck 标记）——未钉住的行与常规行无异，不引入常态分节线
   */
  const renderItemRow = (
    item: ItemInstance<T>,
    positioning: RowPositioning,
    keyPrefix = "",
  ): React.ReactNode => {
    const row = toRowData(item)
    const rowProps = item.getProps() as React.HTMLAttributes<HTMLDivElement> & {
      ref?: (element: HTMLDivElement | null) => void
    }
    const hint = dropHintRef.current?.id === row.id ? dropHintRef.current.mode : null
    // 行状态填充用主题浅色两档：悬停 --selection-hover、选中 --selection。
    // data-selected 变体编译为 `:where([data-selected=true])`，`:where` 不贡献
    // 特异性，故悬停（0-2-0）盖过选中（0-1-0）——悬停当前行时只是同色相轻微
    // 提亮、左侧强调条不受影响，属可接受行为，不必为其强行提权
    return (
      <div
        key={`${keyPrefix}${item.getKey()}`}
        {...rowProps}
        // chevron 模式整体接管行点击（见 handleRowClickChevron）；
        // 默认 row 模式沿用库 onClick（选中 + 主动作 + folder toggle）
        onClick={
          expansionTrigger === "chevron"
            ? (event: React.MouseEvent<HTMLDivElement>) => handleRowClickChevron(event, item)
            : rowProps.onClick
        }
        onContextMenu={(event) => handleRowContextMenu(event, item)}
        onDoubleClick={() => onRowDoubleClick?.(row)}
        draggable={
          dragArmedId === row.id && (!isRowDraggable || isRowDraggable(row)) ? true : undefined
        }
        onMouseDown={(event) => {
          setDragArmedId(
            event.target instanceof Element && event.target.closest("[data-drag-handle]")
              ? row.id
              : null,
          )
        }}
        onMouseUp={() => setDragArmedId(null)}
        onDragStart={(event) => onRowDragStart?.(row, event)}
        onDragOver={(event) => {
          if (!onRowDragOver) return
          const mode = onRowDragOver(row, event)
          if (mode) {
            event.preventDefault()
            event.dataTransfer.dropEffect = "move"
          }
          setDropHint(mode ? { id: row.id, mode } : null)
        }}
        onDragLeave={() => {
          if (dropHintRef.current?.id === row.id) setDropHint(null)
        }}
        onDrop={(event) => {
          const hinted = dropHintRef.current?.id === row.id
          setDropHint(null)
          if (hinted) onRowDrop?.(row, event)
        }}
        onDragEnd={(event) => {
          setDragArmedId(null)
          setDropHint(null)
          onRowDragEnd?.(row, event)
        }}
        data-slot="tree-row"
        data-selected={row.isSelected || undefined}
        className={cn(
          "flex w-full cursor-default items-center text-row outline-none hover:bg-accent focus-visible:ring-[2px] focus-visible:ring-ring focus-visible:ring-inset data-selected:bg-selection",
          positioning.mode === "sticky"
            ? cn(
                "pointer-events-auto sticky top-0 z-10 bg-background",
                positioning.stuck && "border-b border-border",
              )
            : "absolute top-0 left-0",
        )}
        style={
          positioning.mode === "sticky"
            ? { height: rowHeight, paddingInline: ROW_INLINE_PADDING }
            : {
                height: positioning.size,
                transform: `translateY(${positioning.start}px)`,
                paddingInline: ROW_INLINE_PADDING,
              }
        }
      >
        {/* 缩进参考线：每级一条 1px 竖线，深层级下「谁属于谁」不必靠数缩进。
                  位置取父级展开指示的中线（而非子级内容起点）——落在子级内容起点
                  上会与类型图标 / 方法徽章贴在一起；仅指针进入树时淡入，
                  静止时保持树面干净 */}
        {Array.from({ length: row.depth }, (_, level) => (
          <span
            key={level}
            aria-hidden
            data-slot="tree-indent-guide"
            className="pointer-events-none absolute inset-y-0 w-px bg-border opacity-0 transition-opacity duration-100 group-hover/tree:opacity-100"
            style={{
              insetInlineStart:
                ROW_INLINE_PADDING + (level + 1) * INDENT_PER_LEVEL - INDENT_PER_LEVEL / 2,
            }}
          />
        ))}
        {/* 选中第二线索：左侧 2px 强调条——底色之外的位置线索，
                  避免「当前选中」只由一个明度差承担 */}
        {row.isSelected && (
          <span
            aria-hidden
            data-slot="tree-row-selected-bar"
            className="pointer-events-none absolute inset-y-0 start-0 w-0.5 bg-primary"
          />
        )}
        {renderRow ? (
          renderRow(row)
        ) : (
          <span
            className="flex min-w-0 flex-1 items-center gap-1"
            style={{ paddingInlineStart: row.indentPx }}
          >
            {row.isFolder && (
              <span
                aria-hidden
                data-tree-chevron
                className="relative grid size-3.5 shrink-0 place-items-center text-muted-foreground after:absolute after:-inset-x-2 after:-inset-y-1.5"
              >
                <ChevronRightIcon
                  className={cn(
                    "size-3.5 transition-transform duration-150",
                    row.isExpanded && "rotate-90",
                  )}
                />
              </span>
            )}
            <span className="truncate">{row.name}</span>
          </span>
        )}
        {hint && (
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute rounded-full bg-primary",
              hint === "before" && "inset-x-1 top-0 h-0.5",
              hint === "after" && "inset-x-1 bottom-0 h-0.5",
              hint === "inside" && "inset-0 rounded-sm bg-primary/5 ring-2 ring-primary ring-inset",
            )}
          />
        )}
      </div>
    )
  }

  return (
    <div
      ref={scrollRef}
      className={cn("group/tree h-full overflow-auto", className)}
      data-slot="tree-scroll"
      // 滚动跟踪只为粘滞包裹层的挂载裁决（位移由原生 sticky 承担）：
      // 高度初始 0 也安全——视口内的行照常由虚拟窗口自然渲染，首次滚动
      // 即补齐真实高度
      onScroll={
        isRowSticky
          ? (event) =>
              setViewport({
                top: event.currentTarget.scrollTop,
                height: event.currentTarget.clientHeight,
              })
          : undefined
      }
    >
      <div
        {...containerProps}
        tabIndex={internalState.focusedItem ? -1 : 0}
        className="relative w-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        style={{ height: rowVirtualizer.getTotalSize() }}
        onKeyDown={handleContainerKeyDown}
        // Tab 进入无焦点的树时把焦点落到首行（roving tabindex 入口）
        onFocus={(event) => {
          containerProps.onFocus?.(event)
          if (event.target !== event.currentTarget) return
          if (tree.getState().focusedItem == null) focusItem(tree.getItems()[0])
        }}
      >
        {virtualItems.map((virtualRow) => {
          const item = items[virtualRow.index]
          if (!item) return null
          // 粘滞行由包裹层独占渲染（同一行只此一份，ARIA 树语义不重复）
          if (stickyRanges.has(virtualRow.index)) return null
          return renderItemRow(item, {
            mode: "absolute",
            size: virtualRow.size,
            start: virtualRow.start,
          })
        })}
        {[...stickyRanges.entries()].map(([index, range]) => {
          const item = items[index]
          if (!item) return null
          return (
            <div
              key={`sticky-${item.getKey()}`}
              data-slot="tree-sticky-range"
              className="pointer-events-none absolute inset-x-0 z-10"
              style={{ top: range.startPx, height: range.endPx - range.startPx }}
            >
              {renderItemRow(item, { mode: "sticky", stuck: range.stuck }, "sticky-")}
            </div>
          )
        })}
      </div>
    </div>
  )
}
