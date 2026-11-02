import * as React from 'react'

import { RefreshCwIcon } from 'lucide-react'

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Button,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TreePrimitive,
  usePointContextMenu,
  type TreeRowData,
} from '@workspace/ui/components'

import { useI18n, type DictKey, type TranslateParams } from '@/i18n'
import { reportError } from '@/services/error-center'
import { useCurrentWorkspaceTreeQuery } from '@/features/workspaces/api'
import { useTabsStore } from '@/stores/tabs.store'
import { useTreeExpandedStore } from './tree-state.store'
import { useTreeMutations } from './use-tree-mutations'
import { useTreeNodeActions, type TreeNodeActions } from './tree-node-actions'
import { useTreeFiltering } from './use-tree-filtering'
import { useTreeDragSort } from './use-tree-drag-sort'
import { focusTreeNode } from './tree-attention'
import { ApiTreeRow } from './tree-row'
import {
  API_TREE_ROOT_ID,
  PINNED_GROUP_ID,
  buildApiTreeIndex,
  filterApiTree,
  type ApiTreeIndex,
  type ApiTreeNode,
} from './selector'
import { notifyTreeDataReady, registerTreeLocateHandler } from './tree-locate'
import { TreeDialogHost } from './tree-dialogs'
import { ensureProbeInit, useProbeStore } from '@/stores/probe.store'

/**
 * 接口树视图（左栏视图之一）：组装件——查询（当前工作空间树）+
 * 索引 / 过滤（selector 纯函数）+ 展开接线（会话落库）+ 拖拽排序
 * （useTreeDragSort）+ 节点动作（useTreeNodeActions）+ 树定位（面包屑等
 * 外部动作）+ 上下文菜单（行三通道右键 / Shift+F10 / Menu＋空白区根
 * 上下文）。各概念的实现归各自模块，本组件只接线。
 *
 * 展开语义：过滤模式进入时快照当前展开并自动展开命中祖先（useTreeFiltering）；
 * 树行 id 与工作台 Tab 身份同构（endpoint:{serviceId}:{key}），打开 Tab
 * 直接复用单实例契约。
 */

/** 空选中数组的稳定引用（受控 selectedItems 防每次渲染换引用） */
const EMPTY_SELECTED: string[] = []

/** 空祖先服务集的稳定引用（无激活接口时 useMemo 回落，防每次渲染换引用） */
const EMPTY_ANCESTOR_SERVICES: ReadonlySet<string> = new Set()

/** 手柄渲染判定：置顶组与其内接口不参与排序；过滤模式的树是子图不可拖 */
function shouldShowDragHandle(node: ApiTreeNode, filterActive: boolean): boolean {
  return !filterActive && node.kind !== 'pinnedGroup' && !node.parentIds.includes(PINNED_GROUP_ID)
}

export function ApiTreePanel({
  searchQuery,
  onSearchChange,
}: {
  /** 搜索词（各视图独立、由左栏面板持有） */
  searchQuery: string
  onSearchChange: (value: string) => void
}) {
  const { t } = useI18n()

  // —— 数据：当前工作空间全树（一条复合查询，消费方共享缓存） ——
  const treeQuery = useCurrentWorkspaceTreeQuery()
  const tree = treeQuery.data
  const mutations = useTreeMutations(treeQuery.workspaceId ?? '')

  // —— tabs store（打开 Tab 的单点） ——
  const openEndpoint = useTabsStore((s) => s.openEndpoint)

  // —— 树索引与过滤（纯函数 selector，useMemo 组装） ——
  const index: ApiTreeIndex | null = React.useMemo(() => {
    if (!tree) return null
    const idx = buildApiTreeIndex(tree)
    // 置顶组是虚拟分组，显示名走 i18n（selector 保持纯函数不接语言）
    const group = idx.nodes.get(PINNED_GROUP_ID)
    if (group) group.name = t('apiTree.pinnedGroup')
    return idx
  }, [tree, t])
  const filterResult = React.useMemo(
    () => (index ? filterApiTree(index, searchQuery) : null),
    [index, searchQuery],
  )
  const activeIndex = filterResult?.index ?? index
  const filterActive = searchQuery.trim() !== ''

  // —— 过滤快照机：进入快照 / 命中祖先自动展开 / 清除恢复 ——
  useTreeFiltering(filterActive, filterResult)

  // —— 数据加载器（过滤可见子图 / 全量索引共用形状） ——
  const dataLoader = React.useMemo(
    () => ({
      getItem: (id: string): ApiTreeNode =>
        activeIndex?.nodes.get(id) ?? {
          // 过滤切换瞬间树实例可能仍引用已剔除节点：占位行防炸，下一帧消失
          id,
          kind: 'endpoint' as const,
          name: '',
          parentIds: [],
        },
      getChildren: (id: string) =>
        id === API_TREE_ROOT_ID
          ? (activeIndex?.rootChildren ?? [])
          : (activeIndex?.childrenOf.get(id) ?? []),
    }),
    [activeIndex],
  )

  // —— 选中行（F2 重命名与菜单上下文的当前行；store 持有供 Ctrl+T 等跨组件消费） ——
  const activeRowId = useTreeExpandedStore((s) => s.activeNodeId)
  const setActiveRowId = useTreeExpandedStore((s) => s.setActiveNode)
  const selectedItems = activeRowId ? [activeRowId] : EMPTY_SELECTED

  // —— 激活接口的祖先服务集：服务图标随其内激活接口点亮主题色。置顶组内
  //     接口的祖先链指向置顶组（树内实际呈现位置），无服务可点亮，符合呈现 ——
  const activeServiceIds = React.useMemo(() => {
    const node = activeRowId && activeIndex ? activeIndex.nodes.get(activeRowId) : null
    if (node?.kind !== 'endpoint') return EMPTY_ANCESTOR_SERVICES
    return new Set(node.parentIds.filter((id) => activeIndex?.nodes.get(id)?.kind === 'service'))
  }, [activeRowId, activeIndex])

  // —— 展开接线：会话 store 为真相（受控） ——
  const expandedIds = useTreeExpandedStore((s) => s.expandedIds)
  const setExpanded = useTreeExpandedStore((s) => s.setExpanded)

  // —— 跟随定位：激活 Tab 变化（AppShell 写入 activeNodeId）时展开其祖先链，
  // 滚动定位经 TreePrimitive 的 revealId 完成 ——
  React.useEffect(() => {
    if (activeRowId) focusTreeNode(index, activeRowId)
  }, [activeRowId, index])

  // —— 可达性探测状态面初始化（幂等：初始快照＋事件常驻订阅） ——
  React.useEffect(() => {
    void ensureProbeInit()
  }, [])

  // —— 节点动作（对话框状态机 + mutation 路由收敛模块） ——
  const actions = useTreeNodeActions({
    workspaceId: treeQuery.workspaceId ?? '',
    activeIndex,
    mutations,
    onError: reportError,
  })
  const { dialog, closeDialog } = actions

  // —— 树定位（面包屑等外部动作）：前置（切视图 / 展开面板）由 tree-locate
  // 接缝自保证。处理器只登记请求（清过滤 + 记待定位节点 + 推进代次），
  // 注意力内核（展开祖先 + 选中）由下方消费 effect 兑现——过滤清除后索引
  // 是异步换代的（下一渲染才是全量索引），在处理器里直调会用过滤期索引
  // 对子图外节点静默丢定位；代次同时驱动 TreePrimitive 的 revealNonce，
  // 重复定位同一节点（revealId 值不变）也重放滚动
  const locateStateRef = React.useRef({
    filtering: false,
    onSearchChange,
  })
  locateStateRef.current = { filtering: searchQuery.trim() !== '', onSearchChange }
  const [locateNonce, setLocateNonce] = React.useState(0)
  const pendingLocateRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    registerTreeLocateHandler((nodeId) => {
      const state = locateStateRef.current
      // 过滤模式先清过滤：定位＝呈现完整树（清除经由左栏搜索框回调）
      if (state.filtering) state.onSearchChange('')
      pendingLocateRef.current = nodeId
      setLocateNonce((n) => n + 1)
    })
    return () => registerTreeLocateHandler(null)
  }, [])
  // 定位消费：代次推进立即兑付；节点暂不在当前索引（过滤清除的换代间隙）
  // 时挂起，随索引到位兑现
  React.useEffect(() => {
    const pending = pendingLocateRef.current
    if (!pending || !index || !index.nodes.has(pending)) return
    pendingLocateRef.current = null
    focusTreeNode(index, pending)
  }, [index, locateNonce])

  // 数据就绪：兑现视图切换期间挂起的定位请求（挂载瞬间索引必然未就绪，
  // focusTreeNode 对未知节点不动作，消费须等索引可用）
  React.useEffect(() => {
    if (index) notifyTreeDataReady()
  }, [index])

  // —— 新建接口请求（Ctrl+T 等外部入口）：消费信号开对话框（serviceId null＝引导建服务） ——
  const newEndpointRequest = useTreeExpandedStore((s) => s.newEndpointRequest)
  const clearNewEndpointRequest = useTreeExpandedStore((s) => s.clearNewEndpointRequest)
  React.useEffect(() => {
    if (!newEndpointRequest) return
    clearNewEndpointRequest()
    actions.openNewEndpointRequest(newEndpointRequest.serviceId)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 信号只消费一次，动作经 actions 闭包直调
  }, [newEndpointRequest, clearNewEndpointRequest])

  // —— 三通道菜单（右键 / Shift+F10 / Menu 统一坐标回调） ——
  const menu = usePointContextMenu()
  const [menuNodeId, setMenuNodeId] = React.useState<string | null>(null)
  const menuNode = menuNodeId ? (index?.nodes.get(menuNodeId) ?? null) : null

  // —— 拖拽排序 ——
  const dragSort = useTreeDragSort({
    activeIndex,
    filterActive,
    mutations,
    onError: reportError,
  })

  // —— 动作：打开（菜单＝明确意图走常驻；单击走预览、Enter / 双击转正） ——
  const openNode = (node: ApiTreeNode, mode: 'preview' | 'persistent') => {
    if (node.kind !== 'endpoint' || !node.serviceId || !node.key) return
    openEndpoint({ serviceId: node.serviceId, key: node.key, title: node.name }, mode)
  }

  // —— F2：当前选中行的重命名快捷键（isComposing 守卫全应用规范） ——
  const handlePanelKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'F2' || event.nativeEvent.isComposing) return
    if (!activeRowId) return
    const node = index?.nodes.get(activeRowId)
    if (!node || !actions.canRename(node)) return
    event.preventDefault()
    actions.openRenameDialog(node)
  }

  // —— 行渲染（容器与行尾元信息归 tree-row 模块） ——
  const renderRow = (row: TreeRowData<ApiTreeNode>): React.ReactNode => (
    <ApiTreeRow
      row={row}
      showDragHandle={shouldShowDragHandle(row.data, filterActive)}
      containsActiveEndpoint={activeServiceIds.has(row.data.id)}
    />
  )

  // —— 空态分支 ——
  const counts = React.useMemo(() => {
    if (!tree) return null
    return {
      services: tree.services.length,
      endpoints: tree.services.reduce((sum, s) => sum + s.endpoints.length, 0),
    }
  }, [tree])

  const isEmptyTree = activeIndex !== null && activeIndex.rootChildren.length === 0
  const isFilterWithoutMatches = filterResult !== null && !filterResult.hasMatches

  if (treeQuery.isError) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col"
        data-view="api-tree"
        onKeyDown={handlePanelKeyDown}
      >
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>{t('apiTree.loadFailedTitle')}</EmptyTitle>
            <EmptyDescription>{treeQuery.error.message}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => void treeQuery.refetch()}>
              {t('apiTree.loadFailedRetry')}
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  if (isFilterWithoutMatches) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col"
        data-view="api-tree"
        onKeyDown={handlePanelKeyDown}
      >
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>{t('apiTree.searchNoResults')}</EmptyTitle>
            <EmptyDescription>{t('apiTree.searchNoResultsHint')}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => onSearchChange('')}>
              {t('apiTree.searchClear')}
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  if (isEmptyTree) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col"
        data-view="api-tree"
        onKeyDown={handlePanelKeyDown}
      >
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>{t('shell.apisEmptyTitle')}</EmptyTitle>
            <EmptyDescription>{t('shell.apisEmptyDescription')}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={actions.openNewServiceDialog}>{t('shell.apisCreateService')}</Button>
          </EmptyContent>
        </Empty>
        <TreeDialogHost
          state={dialog}
          onClose={closeDialog}
          onSubmitService={actions.submitService}
          onSubmitCategory={actions.submitCategory}
          onSubmitEndpoint={actions.submitEndpoint}
          onDelete={actions.confirmDelete}
        />
      </div>
    )
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-view="api-tree"
      onKeyDown={handlePanelKeyDown}
    >
      {/* 树体容器：空白区右键＝根上下文（唯一合法动作是新建服务——
          分类与接口必须挂在具体父级下）；行内右键由 TreePrimitive 行处理器
          接管并冒泡到此，按 treeitem 判定放行 */}
      <div
        className="min-h-0 flex-1"
        data-testid="api-tree-body"
        onContextMenu={(event) => {
          if ((event.target as HTMLElement).closest('[role="treeitem"]')) return
          event.preventDefault()
          setMenuNodeId(null)
          menu.openAt(event.clientX, event.clientY)
        }}
      >
        <TreePrimitive<ApiTreeNode>
          dataLoader={dataLoader}
          rootId={API_TREE_ROOT_ID}
          ariaLabel={t('shell.viewApis')}
          isItemFolder={(node) => node.kind !== 'endpoint'}
          expandedItems={expandedIds}
          onExpandedItemsChange={setExpanded}
          selectedItems={selectedItems}
          onSelectedItemsChange={(ids) => setActiveRowId(ids[ids.length - 1] ?? null)}
          onRowActivate={(row, source) =>
            openNode(row.data, source === 'click' ? 'preview' : 'persistent')
          }
          onRowDoubleClick={(row) => {
            if (row.data.kind === 'endpoint') openNode(row.data, 'persistent')
          }}
          onRowContextMenu={(rowId, position) => {
            // 置顶组是虚拟分组无动作，不开菜单
            if (rowId === PINNED_GROUP_ID) return
            setMenuNodeId(rowId)
            menu.openAt(position.x, position.y)
          }}
          isRowDraggable={dragSort.isRowDraggable}
          onRowDragStart={dragSort.handleRowDragStart}
          onRowDragOver={dragSort.handleRowDragOver}
          onRowDrop={dragSort.handleRowDrop}
          onRowDragEnd={dragSort.handleRowDragEnd}
          // 服务行粘顶：滚动时服务行钉在树顶部，其接口仍在可视范围内就不离开
          isRowSticky={(row) => row.data.kind === 'service'}
          renderRow={renderRow}
          revealId={activeRowId}
          revealNonce={locateNonce}
          className="min-h-0"
        />
      </div>

      {counts && (
        <div
          className="flex items-center gap-1 border-t px-2 py-1 text-row text-muted-foreground tabular-nums"
          data-testid="api-tree-counts"
        >
          <span className="min-w-0 flex-1">
            {t('apiTree.countLine', { services: counts.services, endpoints: counts.endpoints })}
          </span>
          {/* 全量刷新可达性（手动通道；状态经 probe://status 事件回流） */}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={t('apiTree.probeRefreshAll')}
                  data-testid="api-tree-probe-refresh-all"
                  className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors duration-150 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[2px] focus-visible:ring-ring/50"
                  onClick={() =>
                    useProbeStore
                      .getState()
                      .refreshAll()
                      .catch((error) => reportError(error))
                  }
                />
              }
            >
              <RefreshCwIcon aria-hidden className="size-3 shrink-0" />
            </TooltipTrigger>
            <TooltipContent>{t('apiTree.probeRefreshAll')}</TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* 三通道菜单：受控开合，坐标锚点由 usePointContextMenu 持有。
          menuNodeId null＝空白根上下文（新建服务）；行上下文节点缺失
          （过滤剔除瞬间）时不渲染菜单项 */}
      <ContextMenu open={menu.open} onOpenChange={(open) => !open && menu.close()}>
        <ContextMenuContent anchor={menu.anchor}>
          {(menuNodeId === null || menuNode) && (
            <TreeMenuItems
              node={menuNode}
              t={t}
              actions={actions}
              openNode={(node) => openNode(node, 'persistent')}
            />
          )}
        </ContextMenuContent>
      </ContextMenu>

      <TreeDialogHost
        state={dialog}
        onClose={closeDialog}
        onSubmitService={actions.submitService}
        onSubmitCategory={actions.submitCategory}
        onSubmitEndpoint={actions.submitEndpoint}
        onDelete={actions.confirmDelete}
      />
    </div>
  )
}

/**
 * 上下文菜单项清单（node null＝空白根上下文；按行种类分发动作对象，
 * 文案与快捷键提示经 i18n）。动作经 actions 整体注入——加一个菜单
 * 动作只改此组件与 actions 模块，panel 不做逐回调转发。
 */
function TreeMenuItems({
  node,
  t,
  actions,
  openNode,
}: {
  node: ApiTreeNode | null
  t: (key: DictKey, params?: TranslateParams) => string
  actions: TreeNodeActions
  /** 打开接口 Tab（菜单「打开」＝明确意图，走常驻） */
  openNode: (node: ApiTreeNode) => void
}) {
  // 空白根上下文：服务是唯一可挂根级的节点（分类 / 接口必须挂具体父级）
  if (node === null) {
    return (
      <ContextMenuItem onClick={actions.openNewServiceDialog}>
        {t('apiTree.newService')}
      </ContextMenuItem>
    )
  }

  if (node.kind === 'endpoint') {
    return (
      <>
        <ContextMenuItem onClick={() => openNode(node)}>{t('apiTree.open')}</ContextMenuItem>
        {actions.canRename(node) && (
          <ContextMenuItem onClick={() => actions.openRenameDialog(node)}>
            {t('apiTree.rename')}
            <ContextMenuShortcut>F2</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => actions.togglePin(node)}>
          {node.pinned ? t('apiTree.unpin') : t('apiTree.pin')}
        </ContextMenuItem>
        {/* 排序（拖拽的键盘替代通道）；置顶行的树内位置由置顶组决定，不参与排序 */}
        {!node.pinned && (
          <>
            <ContextMenuItem onClick={() => actions.moveByDirection(node, 'up')}>
              {t('apiTree.moveUp')}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => actions.moveByDirection(node, 'down')}>
              {t('apiTree.moveDown')}
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => actions.openDeleteDialog(node)}>
          {t('apiTree.delete')}
        </ContextMenuItem>
      </>
    )
  }

  if (node.kind === 'category') {
    return (
      <>
        <ContextMenuItem onClick={() => actions.openNewEndpoint(node)}>
          {t('apiTree.newEndpoint')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => actions.openNewCategory(node)}>
          {t('apiTree.newCategory')}
        </ContextMenuItem>
        {actions.canRename(node) && (
          <ContextMenuItem onClick={() => actions.openRenameDialog(node)}>
            {t('apiTree.rename')}
            <ContextMenuShortcut>F2</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => actions.moveByDirection(node, 'up')}>
          {t('apiTree.moveUp')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => actions.moveByDirection(node, 'down')}>
          {t('apiTree.moveDown')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => actions.openDeleteDialog(node)}>
          {t('apiTree.delete')}
        </ContextMenuItem>
      </>
    )
  }

  // 服务行：新建入口 + 编辑 + 排序 + 级联删除（范围明示）
  return (
    <>
      <ContextMenuItem onClick={() => actions.openNewEndpoint(node)}>
        {t('apiTree.newEndpoint')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => actions.openNewCategory(node)}>
        {t('apiTree.newCategory')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      {/* 同步此服务（单服务直达：向导预勾选，保留选择段）；无文档地址
          服务不可参与同步，菜单项置灰＋行尾小徽标说明原因 */}
      <ContextMenuItem
        disabled={node.docUrl == null}
        onClick={() => actions.syncService(node)}
        data-testid="api-tree-sync-service"
      >
        {t('apiTree.syncService')}
        {node.docUrl == null && (
          <span className="ml-auto pl-4 text-micro text-muted-foreground">
            {t('apiTree.syncServiceNoDoc')}
          </span>
        )}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => actions.openRenameDialog(node)}>
        {t('apiTree.edit')}
        <ContextMenuShortcut>F2</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onClick={() => actions.moveByDirection(node, 'up')}>
        {t('apiTree.moveUp')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => actions.moveByDirection(node, 'down')}>
        {t('apiTree.moveDown')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" onClick={() => actions.openDeleteDialog(node)}>
        {t('apiTree.delete')}
      </ContextMenuItem>
    </>
  )
}
