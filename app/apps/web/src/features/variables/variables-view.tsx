import * as React from 'react'

import { useQueries } from '@tanstack/react-query'
import { ChevronRightIcon, GripVerticalIcon, PlusIcon } from 'lucide-react'

import { cn } from 'cn'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  copyTextWithFeedback,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  TreePrimitive,
  usePointContextMenu,
  useUiText,
  type TreeRowData,
} from '@workspace/ui/components'

import { useI18n, type DictKey, type TranslateParams } from '@/i18n'
import { toIpcError } from '@/services/ipc'
import { useIpcQuery } from '@/services/ipc-query'
import { VARIABLES_TAB_ID_PREFIX, useTabsStore } from '@/stores/tabs.store'
import { useVariableStore } from '@/stores/variable.store'
import { useWorkspacesQuery } from '@/features/workspaces/api'
import { useNavDragSort } from '@/lib/use-nav-drag-sort'
import { SEMANTIC_ICONS } from '@/features/icons/semantic-icons'

import { useVariableMutations } from './variable-mutations'
import {
  variableKeys,
  variableListCategories,
  variableListVariables,
  type VariableDto,
} from './variable-api'
import {
  categoryScopeOrder,
  computeVariablesNavDrop,
  type VariableNavDropAction,
  type VariableNavIndex,
  type VariableNavNode,
} from './variables-nav-dnd'
import { expandForVariablesFilter, filterVariablesNav } from './variables-nav-filter'
import { NewCategoryDialog, RenameCategoryDialog } from './category-dialogs'

/**
 * 左栏「变量」视图：两层树（分类行＋变量键行；全局分类置顶、本空间分类
 * 随后——兜底链「全局兜底、空间特化」的顺序与树内视觉顺序一致），形态
 * 与接口树 / 工作空间树同构——TreePrimitive 承担虚拟化、键盘导航（方向键
 * / type-ahead）、选中竖杠与缩进参考线，本组件只接线。
 *
 * - 分类行＝打开该分类的变量配置 Tab（常驻形态——配置页是低频设置入口，
 *   不与接口预览槽位互斥）；点击同时切换展开（headless-tree 文件夹行默认，
 *   与工作空间树点击行为一致）；分类图标与接口树同形的文件夹（展开换开页
 *   形状），激活态经图标主题色与名称字重表达——激活切换走右键菜单与
 *   命令面板（无行尾开关），同工作空间内激活分类独占、可全不激活，全局
 *   分类不可激活（行尾呈现「全局」标识）；
 * - 变量键行＝等宽字体 key＋Secret 锁标（锁标占定宽格位，key 起点恒定——
 *   树是高频扫视界面，同层行名称对齐比横向紧凑值钱）；行点击＝打开所属
 *   分类配置页；
 * - 右键菜单三通道（右键 / Shift+F10 / Menu）：分类行＝打开 / 激活 / 重命名
 *   / 删除；变量行＝打开所属分类；空白区＝新建分类（全局分类经对话框内
 *   开关建立）；F2＝重命名当前选中分类；
 * - 二级供数：全部分类的变量清单经 useQueries 并行批查（键与配置页共享——
 *   配置页 mutation 的 setQueryData 直写对树即时可见），分类数量是环境组
 *   量级（个位数），换取树形 dataLoader 的同步形状与工作空间树同构；
 * - 底部固定「新建分类」动作条（同工作空间视图惯例）；空态 / 加载失败态
 *   分支齐全，加载中不渲染空态（防「暂无分类」闪烁）。
 *
 * mutation 后缓存策略收口在 variable-mutations（激活 / 新建 / 改名返回
 * 刷新后的清单视图直写，分类与变量 mutation 一并失效 effective 键）；
 * 本视图只带自己的 UI 副作用——删除分类成功后关闭其配置 Tab（级联删除
 * 其下全部变量）、树选中行落在被删子树时清空。
 */

/** 树根 id（不渲染） */
const NAV_ROOT_ID = 'variable-nav-root'

/** 变量键行 id（跨分类唯一：分类 id 在域内唯一，前缀防与分类 id 同形） */
function variableRowId(categoryId: string, key: string): string {
  return `variable-item:${categoryId}:${key}`
}

/** 空选中数组的稳定引用（受控 selectedItems 防每次渲染换引用） */
const EMPTY_SELECTED: string[] = []

/** 树行内容：分类行（折叠指示＋文件夹图标＋名称＋行尾标识）／变量键行（锁标格＋等宽 key） */
function NavRowContent({
  row,
  showDragHandle,
}: {
  row: TreeRowData<VariableNavNode>
  /** 拖拽手柄显形（过滤模式的树是子图，不可拖） */
  showDragHandle: boolean
}) {
  const { t } = useI18n()
  const node = row.data

  if (node.kind === 'variable') {
    return (
      <span
        data-testid="variables-item-row"
        data-secret={node.secret || undefined}
        className="flex min-w-0 flex-1 items-center gap-1"
        style={{ paddingInlineStart: row.indentPx }}
      >
        {/* 锁标占定宽格位（无 Secret 占位空格）：同层 key 起点恒定 */}
        <span className="grid size-3.5 shrink-0 place-items-center">
          {node.secret && (
            <SEMANTIC_ICONS.secret aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          )}
        </span>
        <span className="truncate font-mono">{node.name}</span>
      </span>
    )
  }

  return (
    <span
      data-testid="variables-category"
      data-category-id={node.id}
      data-global={node.isGlobal}
      className="group/row flex min-w-0 flex-1 items-center gap-1"
      style={{ paddingInlineStart: row.indentPx }}
    >
      {/* 折叠指示＝chevron 模式唯一展开入口（行其余区域点击＝打开配置页）：
          热区经 after 伪元素外扩至可点击目标大小，title 提示按当前态切换 */}
      <span
        data-tree-chevron
        aria-hidden
        title={row.isExpanded ? t('variables.tree.collapse') : t('variables.tree.expand')}
        className="relative grid size-3.5 shrink-0 place-items-center text-muted-foreground after:absolute after:-inset-x-2 after:-inset-y-1.5"
      >
        <ChevronRightIcon
          className={cn(
            'size-3.5 transition-transform duration-150',
            row.isExpanded && 'rotate-90',
          )}
        />
      </span>
      {/* 分类图标与接口树同形：文件夹收 / 开两态；激活分类图标点亮主题色 */}
      {(() => {
        const CategoryIcon = row.isExpanded
          ? SEMANTIC_ICONS.categoryExpanded
          : SEMANTIC_ICONS.category
        return (
          <CategoryIcon
            aria-hidden
            className={cn(
              'size-3.5 shrink-0',
              node.activated ? 'text-primary' : 'text-muted-foreground',
            )}
          />
        )
      })()}
      <span className={cn('truncate', node.activated && 'font-medium')}>{node.name}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1 pr-0.5">
        {node.isGlobal && (
          // 全局标识＝中性浅底小芯片（与树内徽标芯片同族形态；全局是分类
          // 归属标签而非激活态，保持中性灰不染强调色）
          <span className="shrink-0 rounded-full bg-muted px-1.5 text-micro text-muted-foreground">
            {t('variables.config.globalBadge')}
          </span>
        )}
        {/* 拖拽手柄＝排序通道唯一入口（hover 显形，按住才解锁该行拖拽——
            手柄武装制由 TreePrimitive 承担；过滤中隐藏＝子图不可拖） */}
        {showDragHandle && (
          <span
            data-drag-handle
            aria-hidden
            className="grid size-5 cursor-grab place-items-center rounded-sm text-muted-foreground opacity-0 transition-[opacity,background-color] duration-150 group-hover/row:bg-muted group-hover/row:opacity-100 active:cursor-grabbing"
          >
            <GripVerticalIcon className="size-3.5 shrink-0" />
          </span>
        )}
      </span>
    </span>
  )
}

/**
 * 右键菜单项清单（node null＝空白根上下文＝新建分类；按行种类分发动作
 * 回调，文案经 i18n）。上移 / 下移是分类排序的键盘替代通道（拖拽同通道）：
 * 边界行对应方向禁用（按自身所在区——全局组 / 本空间组——的边界判定）。
 */
function NavMenuItems({
  node,
  t,
  onNewCategory,
  onOpenCategory,
  onToggleActivate,
  onRename,
  onDelete,
  onCopyVariable,
  move,
}: {
  node: VariableNavNode | null
  t: (key: DictKey, params?: TranslateParams) => string
  onNewCategory: () => void
  onOpenCategory: (categoryId: string) => void
  onToggleActivate: (categoryId: string, activated: boolean) => void
  onRename: (target: { id: string; name: string }) => void
  onDelete: (target: { id: string; name: string }) => void
  /** 复制 `{{键}}` 引用到剪贴板（变量行；配合 Ctrl+V 插入任意输入位） */
  onCopyVariable: (key: string) => void
  /** 分类排序通道（上移 / 下移；null＝非分类行不渲染） */
  move: {
    up: () => void
    down: () => void
    upDisabled: boolean
    downDisabled: boolean
  } | null
}) {
  if (node === null) {
    return (
      <ContextMenuItem onClick={onNewCategory}>{t('variables.tree.newCategory')}</ContextMenuItem>
    )
  }

  if (node.kind === 'variable') {
    return (
      <>
        <ContextMenuItem onClick={() => onCopyVariable(node.name)}>
          {t('variables.tree.copyVariable')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onOpenCategory(node.categoryId)}>
          {t('variables.tree.open')}
        </ContextMenuItem>
      </>
    )
  }

  return (
    <>
      <ContextMenuItem onClick={() => onOpenCategory(node.id)}>
        {t('variables.tree.open')}
      </ContextMenuItem>
      {!node.isGlobal && (
        <ContextMenuItem onClick={() => onToggleActivate(node.id, node.activated)}>
          {node.activated ? t('variables.tree.deactivate') : t('variables.tree.activate')}
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={() => onRename({ id: node.id, name: node.name })}>
        {t('variables.tree.rename')}
        <ContextMenuShortcut>F2</ContextMenuShortcut>
      </ContextMenuItem>
      {move && (
        <>
          <ContextMenuItem disabled={move.upDisabled} onClick={move.up}>
            {t('variables.tree.moveUp')}
          </ContextMenuItem>
          <ContextMenuItem disabled={move.downDisabled} onClick={move.down}>
            {t('variables.tree.moveDown')}
          </ContextMenuItem>
        </>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        variant="destructive"
        onClick={() => onDelete({ id: node.id, name: node.name })}
      >
        {t('variables.tree.delete')}
      </ContextMenuItem>
    </>
  )
}

export function VariablesView({
  searchQuery = '',
  onSearchChange,
}: {
  /** 搜索词（左栏面板持有、各视图独立；缺省空串＝不过滤＝现状形态） */
  searchQuery?: string
  /** 清除搜索通道（空结果空态的「清除搜索」按钮回调，由宿主搜索框承接） */
  onSearchChange?: (value: string) => void
}) {
  const { t } = useI18n()
  // 右键「复制变量」的复制反馈（剪贴板＋toast 与复制按钮同一实现源）
  const uiText = useUiText()
  const { data: workspaces } = useWorkspacesQuery()
  const workspaceId = workspaces?.currentId ?? null

  const openVariables = useTabsStore((s) => s.openVariables)
  const closeTab = useTabsStore((s) => s.close)

  // —— 树选中与展开（受控，会话内 UI 态） ——
  const treeExpandedIds = useVariableStore((s) => s.treeExpandedIds)
  const setTreeExpandedIds = useVariableStore((s) => s.setTreeExpandedIds)
  const treeSelectedNodeId = useVariableStore((s) => s.treeSelectedNodeId)
  const setTreeSelectedNodeId = useVariableStore((s) => s.setTreeSelectedNodeId)

  // —— 数据：分类清单（激活指针随行）＋全部分类变量并行批查（键与配置页共享） ——
  const categoriesQuery = useIpcQuery({
    queryKey: variableKeys.categories(workspaceId ?? ''),
    queryFn: () => variableListCategories(workspaceId!),
    enabled: workspaceId !== null,
    staleTime: 30_000,
  })
  const items = categoriesQuery.data?.items
  const variableQueries = React.useMemo(
    () =>
      (items ?? []).map((category) => ({
        queryKey: variableKeys.variables(category.id),
        queryFn: async () => {
          try {
            return await variableListVariables(category.id)
          } catch (raw) {
            throw toIpcError(raw)
          }
        },
        staleTime: 30_000,
      })),
    [items],
  )
  const variablesByCategory = useQueries({
    queries: variableQueries,
    combine: (results) => {
      const map = new Map<string, VariableDto[]>()
      results.forEach((result, index) => {
        const category = items?.[index]
        if (category && result.data) map.set(category.id, result.data.items)
      })
      return map
    },
  })

  // —— 树索引（全局分类置顶、本空间分类随后——与兜底链「全局兜底、
  //     空间特化」的语义顺序一致；各自保持后端稳定序） ——
  const index = React.useMemo<VariableNavIndex>(() => {
    const all = items ?? []
    const activeCategoryId = categoriesQuery.data?.activeCategoryId ?? null
    const nodes = new Map<string, VariableNavNode>()
    const rootChildren: string[] = []
    const childrenOf = new Map<string, string[]>()
    const ordered = [...all.filter((c) => c.isGlobal), ...all.filter((c) => !c.isGlobal)]
    for (const category of ordered) {
      nodes.set(category.id, {
        kind: 'category',
        id: category.id,
        name: category.name,
        isGlobal: category.isGlobal,
        activated: activeCategoryId === category.id,
      })
      rootChildren.push(category.id)
      const variables = variablesByCategory.get(category.id) ?? []
      childrenOf.set(
        category.id,
        variables.map((v) => variableRowId(category.id, v.key)),
      )
      for (const variable of variables) {
        const id = variableRowId(category.id, variable.key)
        nodes.set(id, {
          kind: 'variable',
          id,
          name: variable.key,
          categoryId: category.id,
          secret: variable.secret,
        })
      }
    }
    return { nodes, rootChildren, childrenOf }
  }, [items, categoriesQuery.data?.activeCategoryId, variablesByCategory])

  // —— 搜索过滤（纯函数 selector）：命中子图替换树索引；空查询＝全量索引 ——
  const filterResult = React.useMemo(
    () => filterVariablesNav(index, searchQuery),
    [index, searchQuery],
  )
  const activeIndex = filterResult?.index ?? index
  const filterActive = searchQuery.trim() !== ''

  // —— 数据加载器（数据未就绪的瞬间以占位行防炸，下一帧消失） ——
  const dataLoader = React.useMemo(
    () => ({
      getItem: (id: string): VariableNavNode =>
        activeIndex.nodes.get(id) ?? {
          kind: 'category',
          id,
          name: '',
          isGlobal: false,
          activated: false,
        },
      getChildren: (id: string) =>
        id === NAV_ROOT_ID ? activeIndex.rootChildren : (activeIndex.childrenOf.get(id) ?? []),
    }),
    [activeIndex],
  )

  // —— 过滤快照机：进入过滤快照当前展开集（清除时恢复），命中变量的父
  //     分类自动展开（并集）；过滤中的手动折叠不落快照，快照只在进入那
  //     一刻定格 ——
  const filterSnapshotRef = React.useRef<string[] | null>(null)
  const prevFilterActiveRef = React.useRef(false)
  React.useEffect(() => {
    const wasActive = prevFilterActiveRef.current
    if (filterActive && !wasActive) {
      filterSnapshotRef.current = useVariableStore.getState().treeExpandedIds
    }
    if (filterActive && filterResult) {
      // 同内容不重复写入：本 effect 会随过滤结果引用变化重跑（useQueries
      // 组装的索引每轮渲染换新引用），无条件写新数组会让 store 更新驱动的
      // 重渲染再造过滤结果，形成「写 → 重渲染 → 再写」的更新环
      const base = useVariableStore.getState().treeExpandedIds
      const next = expandForVariablesFilter(base, filterResult.ancestorsToExpand)
      const unchanged = next.length === base.length && next.every((id, i) => base[i] === id)
      if (!unchanged) setTreeExpandedIds(next)
    }
    if (!filterActive && wasActive) {
      setTreeExpandedIds(filterSnapshotRef.current ?? [])
      filterSnapshotRef.current = null
    }
    prevFilterActiveRef.current = filterActive
  }, [filterActive, filterResult, setTreeExpandedIds])

  const categoriesById = React.useMemo(
    () => new Map((items ?? []).map((category) => [category.id, category])),
    [items],
  )

  // —— 对话框状态机（按会话挂载：null＝关闭，非 null＝持目标挂载） ——
  const [createOpen, setCreateOpen] = React.useState(false)
  const [renameTarget, setRenameTarget] = React.useState<{ id: string; name: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<{ id: string; name: string } | null>(null)

  // —— 分类级 mutation（缓存后处理收口在 hook；此处只带 UI 副作用） ——
  const { activateCategoryMutation, deleteCategoryMutation, moveCategoryMutation } =
    useVariableMutations(workspaceId ?? '')

  // —— 三通道菜单（右键 / Shift+F10 / Menu 统一坐标回调） ——
  const menu = usePointContextMenu()
  const [menuNodeId, setMenuNodeId] = React.useState<string | null>(null)
  const menuNode = menuNodeId ? (index.nodes.get(menuNodeId) ?? null) : null

  // —— 分类排序（树拖拽＋菜单上移下移同走 move_category 命令）：拖拽协议归
  //     useNavDragSort 单点，落点判定与动作见 variables-nav-dnd ——
  const drag = useNavDragSort<VariableNavNode, TreeRowData<VariableNavNode>, VariableNavDropAction>(
    {
      getNode: (row) => row.data,
      computeDrop: (source, target, ratio) => computeVariablesNavDrop(source, target, ratio, index),
      onAction: (action) =>
        moveCategoryMutation.mutate({ categoryId: action.id, index: action.index }),
    },
  )

  // 菜单排序通道的边界（按自身所在区判定；null＝非分类行）
  const menuMove = (() => {
    if (menuNode?.kind !== 'category') return null
    const scope = categoryScopeOrder(index, menuNode.isGlobal)
    const at = scope.indexOf(menuNode.id)
    if (at < 0) return null
    return {
      up: () => moveCategoryMutation.mutate({ categoryId: menuNode.id, index: at - 1 }),
      down: () => moveCategoryMutation.mutate({ categoryId: menuNode.id, index: at + 1 }),
      upDisabled: at <= 0,
      downDisabled: at >= scope.length - 1,
    }
  })()

  /** 打开分类配置 Tab（分类行 / 变量行共用；行选中随之） */
  const openCategory = React.useCallback(
    (categoryId: string) => {
      const category = categoriesById.get(categoryId)
      if (!category) return
      setTreeSelectedNodeId(categoryId)
      openVariables({ categoryId: category.id, name: category.name })
    },
    [categoriesById, openVariables, setTreeSelectedNodeId],
  )

  // —— F2：当前选中分类行的重命名快捷键（isComposing 守卫全应用规范） ——
  const handlePanelKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'F2' || event.nativeEvent.isComposing) return
    if (!treeSelectedNodeId) return
    const node = index.nodes.get(treeSelectedNodeId)
    if (node?.kind !== 'category') return
    event.preventDefault()
    setRenameTarget({ id: node.id, name: node.name })
  }

  // —— 空态 / 错误态判定（加载中不渲染空态，防闪烁） ——
  const ready = items !== undefined
  const isEmpty = ready && index.rootChildren.length === 0

  if (categoriesQuery.isError) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-view="variables-tree">
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>{t('variables.tree.loadFailedTitle')}</EmptyTitle>
            <EmptyDescription>{categoriesQuery.error.message}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => void categoriesQuery.refetch()}>
              {t('variables.tree.loadFailedRetry')}
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  if (!ready) {
    return <div className="min-h-0 flex-1" data-view="variables-tree" />
  }

  // —— 过滤无命中＝搜索空态（树数据仍在，只是无可见行；清除通道回到宿主搜索框） ——
  const isFilterWithoutMatches = filterResult !== null && !filterResult.hasMatches
  if (isFilterWithoutMatches) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col"
        data-view="variables-tree"
        data-testid="variables-view"
        onKeyDown={handlePanelKeyDown}
      >
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>{t('variables.tree.searchNoResults')}</EmptyTitle>
            <EmptyDescription>{t('variables.tree.searchNoResultsHint')}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => onSearchChange?.('')}>
              {t('variables.tree.searchClear')}
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-view="variables-tree"
      data-testid="variables-view"
      onKeyDown={handlePanelKeyDown}
    >
      {isEmpty ? (
        <Empty className="flex-1 justify-center">
          <EmptyHeader>
            <EmptyTitle>{t('variables.tree.emptyTitle')}</EmptyTitle>
            <EmptyDescription>{t('variables.tree.emptyDescription')}</EmptyDescription>
          </EmptyHeader>
          {workspaceId && (
            <EmptyContent>
              <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                {t('variables.tree.newCategory')}
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <>
          {/* 树体容器：空白区右键＝根上下文（新建分类）；行内右键由
              TreePrimitive 行处理器接管并冒泡到此，按 treeitem 判定放行 */}
          <div
            className="min-h-0 flex-1"
            data-testid="variables-tree-body"
            onContextMenu={(event) => {
              if ((event.target as HTMLElement).closest('[role="treeitem"]')) return
              event.preventDefault()
              setMenuNodeId(null)
              menu.openAt(event.clientX, event.clientY)
            }}
          >
            <TreePrimitive<VariableNavNode>
              dataLoader={dataLoader}
              rootId={NAV_ROOT_ID}
              ariaLabel={t('shell.viewVariables')}
              isItemFolder={(node) => node.kind !== 'variable'}
              expansionTrigger="chevron"
              expandedItems={treeExpandedIds}
              onExpandedItemsChange={setTreeExpandedIds}
              selectedItems={treeSelectedNodeId ? [treeSelectedNodeId] : EMPTY_SELECTED}
              onSelectedItemsChange={(ids) => setTreeSelectedNodeId(ids[ids.length - 1] ?? null)}
              onRowActivate={(row) => {
                openCategory(row.data.kind === 'category' ? row.data.id : row.data.categoryId)
              }}
              onRowContextMenu={(rowId, position) => {
                setMenuNodeId(rowId)
                menu.openAt(position.x, position.y)
              }}
              isRowDraggable={(row) => row.data.kind === 'category'}
              onRowDragStart={drag.handleDragStart}
              onRowDragOver={drag.handleDragOver}
              onRowDrop={drag.handleDrop}
              onRowDragEnd={drag.handleDragEnd}
              renderRow={(row) => <NavRowContent row={row} showDragHandle={!filterActive} />}
              revealId={treeSelectedNodeId}
              className="min-h-0"
            />
          </div>

          {/* 底部动作条：恒常驻「新建分类」（空态入口在 Empty 内） */}
          {workspaceId && (
            <div className="shrink-0 border-t border-border p-1.5">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-xs text-muted-foreground"
                onClick={() => setCreateOpen(true)}
                data-testid="variables-new-category"
              >
                <PlusIcon aria-hidden className="size-3.5" />
                {t('variables.tree.newCategory')}
              </Button>
            </div>
          )}
        </>
      )}

      {/* 三通道菜单：受控开合，坐标锚点由 usePointContextMenu 持有。
          menuNodeId null＝空白根上下文（新建分类）；行上下文节点缺失
          （数据刷新瞬间）时不渲染菜单项 */}
      <ContextMenu open={menu.open} onOpenChange={(open) => !open && menu.close()}>
        <ContextMenuContent anchor={menu.anchor}>
          {(menuNodeId === null || menuNode) && (
            <NavMenuItems
              node={menuNode}
              t={t}
              onNewCategory={() => {
                if (!workspaceId) return
                setCreateOpen(true)
              }}
              onOpenCategory={openCategory}
              onToggleActivate={(id, activated) =>
                activateCategoryMutation.mutate(activated ? null : id)
              }
              onRename={setRenameTarget}
              onDelete={setDeleteTarget}
              onCopyVariable={(key) => void copyTextWithFeedback(() => `{{${key}}}`, uiText)}
              move={menuMove}
            />
          )}
        </ContextMenuContent>
      </ContextMenu>

      {/* 对话框按会话挂载（关闭即卸载，草稿不残留） */}
      {workspaceId && createOpen && (
        <NewCategoryDialog workspaceId={workspaceId} onOpenChange={() => setCreateOpen(false)} />
      )}
      {workspaceId && renameTarget && (
        <RenameCategoryDialog
          workspaceId={workspaceId}
          target={renameTarget}
          onOpenChange={() => setRenameTarget(null)}
        />
      )}
      {/* 删除分类确认（级联范围明示；进行中禁确认钮防连点重复 mutate，
          失败保持弹窗在场可重试——对齐工作空间域删除确认口径） */}
      {workspaceId && deleteTarget && (
        <AlertDialog open onOpenChange={(open) => !open && setDeleteTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('variables.config.deleteConfirmTitle')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('variables.config.deleteConfirmDescription', { name: deleteTarget.name })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('variables.config.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={deleteCategoryMutation.isPending}
                data-testid="variables-delete-category-confirm"
                onClick={() =>
                  deleteCategoryMutation.mutate(deleteTarget.id, {
                    onSuccess: (_view, categoryId) => {
                      // 关闭被删分类的配置 Tab（Tab 身份＝variables:{categoryId}）
                      closeTab(`${VARIABLES_TAB_ID_PREFIX}${categoryId}`)
                      // 树选中行落在被删子树（分类行或其变量行）时清空
                      const selected = useVariableStore.getState().treeSelectedNodeId
                      if (
                        selected === categoryId ||
                        selected?.startsWith(`variable-item:${categoryId}:`)
                      ) {
                        setTreeSelectedNodeId(null)
                      }
                      setDeleteTarget(null)
                    },
                  })
                }
              >
                {deleteCategoryMutation.isPending
                  ? t('variables.config.deleteConfirmPending')
                  : t('variables.config.deleteConfirmAction')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  )
}
