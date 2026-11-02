import * as React from 'react'
import { ChevronRightIcon, GripVerticalIcon, PlusIcon } from 'lucide-react'

import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  toast,
  TreePrimitive,
  usePointContextMenu,
  type TreeRowData,
} from '@workspace/ui/components'

import { reportError } from '@/services/error-center'
import type { ServiceDto, WorkspaceDto } from '@/services/workbench-api'
import { SEMANTIC_ICONS } from '@/features/icons/semantic-icons'
import { useI18n, type DictKey, type TranslateParams } from '@/i18n'
import { useTabsStore } from '@/stores/tabs.store'

import {
  useAllWorkspaceServicesQuery,
  useSetCurrentWorkspaceMutation,
  useWorkspaceSortMutations,
  useWorkspacesQuery,
} from './api'
import { useWorkspacesStore } from './workspaces.store'
import { useWorkspaceNavDragSort } from './use-workspace-nav-drag-sort'
import { useWorkspaceNavFiltering } from './use-workspace-nav-filtering'
import { filterWorkspaceNav } from './workspace-nav-filter'
import type { WorkspaceNavIndex, WorkspaceNavNode } from './workspace-nav-dnd'

/**
 * 左栏「工作空间」树视图：两级树（第一级工作空间、第二级服务），接管
 * 工作空间域的全部左栏导航语义。树行点击＝打开该工作空间详情 Tab（内容
 * 指针随行指向的空间；同一行吞并窗口内的重复激活去重）；双击工作空间行
 * ＝设为当前空间（切换成功后树选中跟随，与恢复落地的详情校正构成三方
 * 一致）；激活工作空间行（当前空间）的名称图标常态染主题色（选中底色只
 * 跟选中，两态并存时叠加）；右键菜单按行种类分发（工作空间：设为当前 /
 * 重命名 / 上移下移 / 删除；服务：编辑 / 上移下移 / 删除；空白区：新建
 * 工作空间）。搜索过滤：命中工作空间名与服务名的可见子图（纯函数
 * workspace-nav-filter），进入时快照展开、清除时恢复；过滤中隐藏拖拽
 * 手柄（子图不可拖）。拖拽排序：工作空间行根层 before/after（走整批
 * reorder）、服务行仅同空间内 before/after（走 move_to），落点判定在
 * workspace-nav-dnd 纯函数，手柄武装制由 TreePrimitive 承担。
 * 底部固定「新建工作空间」动作条（同变量视图底部动作惯例）。
 * 对话框与 IPC 一律经 store 信号交给全局对话框宿主（workspaces-dialogs，
 * 唯一挂载点在 AppShell），本组件不再持对话框与 mutation。
 */

/** 树根 id（不渲染） */
const NAV_ROOT_ID = 'workspace-nav-root'

/** 双击吞并窗口：同一行该窗口内的第二次行激活跳过（双击＝click、click、
 *  dblclick 三连发，第二次 click 的导航与首击同身份幂等） */
const ACTIVATE_DEDUPE_MS = 300

/** 空选中/空数组的稳定引用（受控 props 防每次渲染换引用） */
const EMPTY_SELECTED: string[] = []
const EMPTY_ITEMS: WorkspaceDto[] = []

export function WorkspacesView({
  searchQuery = '',
  onSearchChange,
}: {
  /** 搜索词（宿主持有；缺省空串＝不过滤，行为与无搜索一致） */
  searchQuery?: string
  /** 搜索词回调（空态「清除搜索」按钮经它清词；宿主接线前可为空） */
  onSearchChange?: (value: string) => void
}) {
  const { t } = useI18n()
  const workspacesQuery = useWorkspacesQuery()
  const items = workspacesQuery.data?.items ?? EMPTY_ITEMS
  const currentId = workspacesQuery.data?.currentId ?? null
  const servicesQuery = useAllWorkspaceServicesQuery(items)

  const setCurrent = useSetCurrentWorkspaceMutation()

  const openDialog = useWorkspacesStore((s) => s.openDialog)
  const treeSelectedWorkspaceId = useWorkspacesStore((s) => s.treeSelectedWorkspaceId)
  const setTreeSelectedWorkspace = useWorkspacesStore((s) => s.setTreeSelectedWorkspace)
  const treeExpandedIds = useWorkspacesStore((s) => s.treeExpandedIds)
  const setTreeExpandedIds = useWorkspacesStore((s) => s.setTreeExpandedIds)
  const openWorkspaceSettings = useTabsStore((s) => s.openWorkspaceSettings)

  // —— 服务清单按空间归组（批查询结果 → workspaceId → 服务行） ——
  const servicesByWorkspace = React.useMemo(() => {
    const map = new Map<string, ServiceDto[]>()
    items.forEach((workspace, index) => {
      map.set(workspace.id, servicesQuery.data?.[index] ?? [])
    })
    return map
  }, [items, servicesQuery.data])

  // —— 树索引（useMemo 组装；形状与接口树 selector 同构） ——
  const index = React.useMemo<WorkspaceNavIndex>(() => {
    const nodes = new Map<string, WorkspaceNavNode>()
    const rootChildren: string[] = []
    const childrenOf = new Map<string, string[]>()
    for (const workspace of items) {
      nodes.set(workspace.id, {
        kind: 'workspace',
        id: workspace.id,
        name: workspace.name,
        isCurrent: workspace.id === currentId,
      })
      rootChildren.push(workspace.id)
      const services = servicesByWorkspace.get(workspace.id) ?? []
      childrenOf.set(
        workspace.id,
        services.map((service) => service.id),
      )
      for (const service of services) {
        nodes.set(service.id, {
          kind: 'service',
          id: service.id,
          workspaceId: workspace.id,
          name: service.name,
          docUrl: service.docUrl,
        })
      }
    }
    return { nodes, rootChildren, childrenOf }
  }, [items, currentId, servicesByWorkspace])

  // —— 搜索过滤（纯函数 selector；空查询返回 null＝不过滤） ——
  const filterResult = React.useMemo(
    () => filterWorkspaceNav(index, searchQuery),
    [index, searchQuery],
  )
  const activeIndex = filterResult?.index ?? index
  const filterActive = searchQuery.trim() !== ''
  // —— 过滤快照机：进入快照 / 命中父级自动展开 / 清除恢复 ——
  useWorkspaceNavFiltering(filterActive, filterResult)

  // —— 数据加载器（过滤可见子图 / 全量索引共用形状；数据未就绪的瞬间
  //     以占位行防炸，下一帧消失） ——
  const dataLoader = React.useMemo(
    () => ({
      getItem: (id: string): WorkspaceNavNode =>
        activeIndex.nodes.get(id) ?? {
          kind: 'workspace',
          id,
          name: '',
          isCurrent: false,
        },
      getChildren: (id: string) =>
        id === NAV_ROOT_ID ? activeIndex.rootChildren : (activeIndex.childrenOf.get(id) ?? []),
    }),
    [activeIndex],
  )

  // —— 提交处理器：对话框与 IPC 全部收敛在全局对话框宿主，本视图只发信号 ——

  /** 行激活＝打开该工作空间详情（行选中随之；详情内容指针随行指向的空间
   *  切换）。同一工作空间在吞并窗口内的重复激活跳过：双击手势的前导第二击
   *  与首击同身份幂等，放行只会无谓推进激活序号；跨行快速点击不受影响 */
  const lastActivateRef = React.useRef<{ workspaceId: string; at: number } | null>(null)
  const activateWorkspace = (workspaceId: string): void => {
    const now = Date.now()
    const last = lastActivateRef.current
    lastActivateRef.current = { workspaceId, at: now }
    if (last && last.workspaceId === workspaceId && now - last.at < ACTIVATE_DEDUPE_MS) return
    const workspace = index.nodes.get(workspaceId)
    setTreeSelectedWorkspace(workspaceId)
    openWorkspaceSettings({
      workspaceId,
      name: workspace?.name ?? '',
      mode: 'persistent',
    })
  }

  // —— 三通道菜单（右键 / Shift+F10 / Menu 统一坐标回调） ——
  const menu = usePointContextMenu()
  const [menuNodeId, setMenuNodeId] = React.useState<string | null>(null)
  const menuNode = menuNodeId ? (index.nodes.get(menuNodeId) ?? null) : null

  // —— 拖拽排序与相邻移动（mutation 组与详情服务列表共享，失效同一前缀） ——
  const sortMutations = useWorkspaceSortMutations()
  const dragSort = useWorkspaceNavDragSort({
    index,
    mutations: sortMutations,
    onError: reportError,
  })

  /** 上移 / 下移：服务走 service.move 相邻交换；工作空间无相邻交换命令，
   *  走 workspace.reorder 交换相邻两项（一次到位） */
  const moveNode = (node: WorkspaceNavNode, direction: 'up' | 'down') => {
    if (node.kind === 'workspace') {
      const order = [...index.rootChildren]
      const at = order.indexOf(node.id)
      const to = direction === 'up' ? at - 1 : at + 1
      const neighbor = to >= 0 && to < order.length ? order[to] : undefined
      if (at < 0 || neighbor === undefined) return
      order[at] = neighbor
      order[to] = node.id
      sortMutations.reorderMutation.mutate(order, { onError: reportError })
    } else {
      sortMutations.serviceMoveMutation.mutate({ id: node.id, direction }, { onError: reportError })
    }
  }

  // —— 行渲染（容器骨架归本视图：折叠指示 + 语义图标 + 名称；当前空间
  //     行字重强化。激活行竖杠在此自绘——TreePrimitive 的选中竖杠只认
  //     受控选中。过滤模式的树是子图不可拖，手柄隐藏即不可武装） ——
  const renderRow = (row: TreeRowData<WorkspaceNavNode>): React.ReactNode => (
    <WorkspaceNavRowContent row={row} showDragHandle={!filterActive} />
  )

  if (workspacesQuery.isError) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-view="workspaces-tree">
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>{t('workspace.loadFailedTitle')}</EmptyTitle>
            <EmptyDescription>{workspacesQuery.error.message}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => void workspacesQuery.refetch()}>
              {t('workspace.loadFailedRetry')}
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  // —— 搜索无命中空态（对齐接口树空态形态；清除搜索经宿主回调） ——
  if (filterResult !== null && !filterResult.hasMatches) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-view="workspaces-tree">
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>{t('workspace.searchNoResults')}</EmptyTitle>
            <EmptyDescription>{t('workspace.searchNoResultsHint')}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => onSearchChange?.('')}>
              {t('workspace.searchClear')}
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-view="workspaces-tree">
      {/* 树体容器：空白区右键＝根上下文（新建工作空间）；行内右键由
          TreePrimitive 行处理器接管并冒泡到此，按 treeitem 判定放行 */}
      <div
        className="min-h-0 flex-1"
        data-testid="workspaces-tree-body"
        onContextMenu={(event) => {
          if ((event.target as HTMLElement).closest('[role="treeitem"]')) return
          event.preventDefault()
          setMenuNodeId(null)
          menu.openAt(event.clientX, event.clientY)
        }}
      >
        <TreePrimitive<WorkspaceNavNode>
          dataLoader={dataLoader}
          rootId={NAV_ROOT_ID}
          ariaLabel={t('shell.viewWorkspaces')}
          isItemFolder={(node) => node.kind === 'workspace'}
          expansionTrigger="chevron"
          expandedItems={treeExpandedIds}
          onExpandedItemsChange={setTreeExpandedIds}
          selectedItems={treeSelectedWorkspaceId ? [treeSelectedWorkspaceId] : EMPTY_SELECTED}
          onSelectedItemsChange={(ids) => setTreeSelectedWorkspace(ids[ids.length - 1] ?? null)}
          onRowActivate={(row) => {
            // 点击工作空间行或其下服务行＝打开该工作空间详情（行选中随之；
            // 详情内容指针随行指向的空间切换）
            activateWorkspace(row.data.kind === 'workspace' ? row.data.id : row.data.workspaceId)
          }}
          onRowDoubleClick={(row) => {
            // 双击工作空间行＝设为当前空间（切换直达，与接口树「双击转正」
            // 先例同构；已是当前的空间无切换语义不发）；切换成功树选中跟随
            // 新当前空间（树选中、详情指针与当前空间三方一致），并以一次性
            // toast 反馈，action 位可一键切回原空间；服务行无双击语义
            if (row.data.kind !== 'workspace' || row.data.isCurrent) return
            const { id, name } = row.data
            const from = currentId
            setCurrent.mutate(id, {
              onSuccess: () => {
                setTreeSelectedWorkspace(id)
                toast.info(t('workspace.switchedToast', { name }), {
                  action: {
                    label: t('workspace.switchBack'),
                    onClick: () => {
                      if (from !== null) {
                        setCurrent.mutate(from, {
                          onSuccess: () => setTreeSelectedWorkspace(from),
                        })
                      }
                    },
                  },
                })
              },
              onError: (error) => reportError(error),
            })
          }}
          onRowContextMenu={(rowId, position) => {
            setMenuNodeId(rowId)
            menu.openAt(position.x, position.y)
          }}
          isRowDraggable={dragSort.isRowDraggable}
          onRowDragStart={dragSort.handleRowDragStart}
          onRowDragOver={dragSort.handleRowDragOver}
          onRowDrop={dragSort.handleRowDrop}
          onRowDragEnd={dragSort.handleRowDragEnd}
          renderRow={renderRow}
          revealId={treeSelectedWorkspaceId}
          className="min-h-0"
        />
      </div>

      {/* 底部动作条：恒常驻「新建工作空间」（seeding 保证树非空，无空态分支） */}
      <div className="shrink-0 border-t border-border p-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-xs text-muted-foreground"
          data-testid="workspace-new"
          onClick={() => openDialog({ type: 'ws-new' })}
        >
          <PlusIcon aria-hidden className="size-3.5" />
          {t('workspace.newWorkspace')}
        </Button>
      </div>

      {/* 三通道菜单：受控开合，坐标锚点由 usePointContextMenu 持有。
          menuNodeId null＝空白根上下文（新建工作空间）；行上下文节点缺失
          （数据刷新瞬间）时不渲染菜单项 */}
      <ContextMenu open={menu.open} onOpenChange={(open) => !open && menu.close()}>
        <ContextMenuContent anchor={menu.anchor}>
          {(menuNodeId === null || menuNode) && (
            <NavMenuItems
              node={menuNode}
              index={index}
              t={t}
              onSetCurrent={(id) =>
                setCurrent.mutate(id, {
                  // 切换成功树选中跟随（同双击切换：三方一致的不变式）
                  onSuccess: () => setTreeSelectedWorkspace(id),
                  onError: (error) => reportError(error),
                })
              }
              onRename={(id, name) => openDialog({ type: 'ws-rename', id, name })}
              onDeleteWorkspace={(id, name) => openDialog({ type: 'ws-delete', id, name })}
              onEditService={(id, name, docUrl) =>
                openDialog({ type: 'service-edit', id, name, docUrl })
              }
              onDeleteService={(id, name) => openDialog({ type: 'service-delete', id, name })}
              onMoveUp={(node) => moveNode(node, 'up')}
              onMoveDown={(node) => moveNode(node, 'down')}
              onNewWorkspace={() => openDialog({ type: 'ws-new' })}
            />
          )}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}

/**
 * 树行内容：工作空间行＝折叠指示 + workspace 图标 + 名称；服务行＝
 * 服务图标 + 名称（树是导航面，不标注「无文档地址」——该事实由详情页
 * 服务表格唯一承载）。当前工作空间行（isCurrent）名称加中文字重并以
 * 主题色染图标，选中态竖杠与底色由 TreePrimitive 画，两态并存时叠加。
 * 行尾拖拽手柄＝命中目标芯片（行悬浮亮底显形，与详情页表格手柄同款），
 * 对齐接口树 DragHandle 形态（hover 才现，按住才解锁该行拖拽）；
 * 过滤模式不渲染手柄——过滤子图不参与排序，行拖拽必须经手柄武装。
 */
function WorkspaceNavRowContent({
  row,
  showDragHandle,
}: {
  row: TreeRowData<WorkspaceNavNode>
  showDragHandle: boolean
}) {
  const { t } = useI18n()
  const node = row.data
  const isWorkspace = node.kind === 'workspace'
  const Icon = isWorkspace ? SEMANTIC_ICONS.workspace : SEMANTIC_ICONS.service
  return (
    <span
      className="group/row flex min-w-0 flex-1 items-center gap-1"
      // 工作空间行 title 提示双击手势（双击设当前不可自发现）
      title={isWorkspace ? t('workspace.doubleClickHint') : undefined}
      style={{
        // 服务行无折叠指示：补一格 chevron 空位（图标 14px + gap 4px），
        // 使服务行整体缩进深过工作空间行——层级深度不因图标格数差而反转
        paddingInlineStart: isWorkspace ? row.indentPx : row.indentPx + 18,
      }}
    >
      {/* 折叠指示＝chevron 模式唯一展开入口（行其余区域点击＝打开详情 Tab）：
          热区经 after 伪元素外扩至可点击目标大小，title 提示按当前态切换 */}
      {isWorkspace && (
        <span
          data-tree-chevron
          aria-hidden
          title={row.isExpanded ? t('workspace.collapse') : t('workspace.expand')}
          className="relative grid size-3.5 shrink-0 place-items-center text-muted-foreground after:absolute after:-inset-x-2 after:-inset-y-1.5"
        >
          <ChevronRightIcon
            className={`size-3.5 transition-transform duration-150 ${
              row.isExpanded ? 'rotate-90' : ''
            }`}
          />
        </span>
      )}
      <Icon
        aria-hidden
        className={`size-3.5 shrink-0 ${
          isWorkspace && node.isCurrent ? 'text-primary' : 'text-muted-foreground'
        }`}
      />
      <span className={`truncate${isWorkspace && node.isCurrent ? 'font-medium' : ''}`}>
        {node.name}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
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
 * 右键菜单项清单（node null＝空白根上下文；按行种类分发动作回调，
 * 文案经 i18n）。上移 / 下移是拖拽排序的键盘替代通道：边界行对应方向
 * 禁用（首行禁上、末行禁下；边界按自身所在序列——工作空间根层序 /
 * 空间内服务序——判定）。
 */
function NavMenuItems({
  node,
  index,
  t,
  onSetCurrent,
  onRename,
  onDeleteWorkspace,
  onEditService,
  onDeleteService,
  onMoveUp,
  onMoveDown,
  onNewWorkspace,
}: {
  node: WorkspaceNavNode | null
  index: WorkspaceNavIndex
  t: (key: DictKey, params?: TranslateParams) => string
  onSetCurrent: (id: string) => void
  onRename: (id: string, name: string) => void
  onDeleteWorkspace: (id: string, name: string) => void
  onEditService: (id: string, name: string, docUrl: string | null) => void
  onDeleteService: (id: string, name: string) => void
  onMoveUp: (node: WorkspaceNavNode) => void
  onMoveDown: (node: WorkspaceNavNode) => void
  onNewWorkspace: () => void
}) {
  if (node === null) {
    return <ContextMenuItem onClick={onNewWorkspace}>{t('workspace.newWorkspace')}</ContextMenuItem>
  }

  // 上移 / 下移边界：位置取自身所在序列（工作空间根层序或空间内服务序）
  const siblings =
    node.kind === 'workspace' ? index.rootChildren : (index.childrenOf.get(node.workspaceId) ?? [])
  const at = siblings.indexOf(node.id)
  const isFirst = at <= 0
  const isLast = at < 0 || at >= siblings.length - 1
  const moveItems = (
    <>
      <ContextMenuItem disabled={isFirst} onClick={() => onMoveUp(node)}>
        {t('workspace.moveUp')}
      </ContextMenuItem>
      <ContextMenuItem disabled={isLast} onClick={() => onMoveDown(node)}>
        {t('workspace.moveDown')}
      </ContextMenuItem>
    </>
  )

  if (node.kind === 'workspace') {
    return (
      <>
        <ContextMenuItem disabled={node.isCurrent} onClick={() => onSetCurrent(node.id)}>
          {t('workspace.actionSetCurrent')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onRename(node.id, node.name)}>
          {t('workspace.actionRename')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        {moveItems}
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          onClick={() => onDeleteWorkspace(node.id, node.name)}
        >
          {t('workspace.actionDelete')}
        </ContextMenuItem>
      </>
    )
  }

  return (
    <>
      <ContextMenuItem onClick={() => onEditService(node.id, node.name, node.docUrl)}>
        {t('workspace.actionEdit')}
      </ContextMenuItem>
      {moveItems}
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" onClick={() => onDeleteService(node.id, node.name)}>
        {t('workspace.actionDelete')}
      </ContextMenuItem>
    </>
  )
}
