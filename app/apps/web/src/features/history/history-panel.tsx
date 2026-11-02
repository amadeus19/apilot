import * as React from 'react'
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query'

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
  Checkbox,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  SearchInput,
  toast,
  usePointContextMenu,
} from '@workspace/ui/components'

import { useI18n, formatDuration } from '@/i18n'
import { MethodBadge } from '@/features/api-tree/method-badge'
import { SEMANTIC_ICONS } from '@/features/icons/semantic-icons'
import { useWorkspacesQuery } from '@/features/workspaces/api'
import { httpKeys } from '@/features/http/http-api'
import { runStatusOutcome, type StatusOutcome } from '@/features/http/constants'
import { useTabsStore } from '@/stores/tabs.store'
import { useAppStore } from '@/stores/app.store'
import { HISTORY_PAGE_SIZE, runDelete, runListPage, type RunListItemDto } from './history-api'
import { filterHistoryItems, urlPathNameOf, urlPathOf } from './history-grouping'
import { relativeTimeParts } from './relative-time'

/**
 * 请求历史视图（左栏视图之一）：当前工作空间的 run_records 平铺分页列表
 * （GUI 与 CLI 来源同现）＋子串搜索过滤＋点击行打开单例历史详情 Tab＋刷新
 * 双保险（窗口聚焦桥接见 focus-bridge；手动刷新按钮在搜索行）。
 *
 * 列表形态（用户裁定）：不分组，纯时间倒序平铺。行＝常驻 Checkbox＋双行
 * 信息（首行＝source 芯片＋方法徽章＋路径＋状态芯片；次行＝耗时 · 相对时间
 * · 接口名），行点击只打开详情——勾选唯一入口是行首 Checkbox（点击行、
 * Ctrl/Shift 修饰键都不改勾选）。
 *
 * 底部状态栏常驻：三态全选框（未选 / 部分选＝横杆 / 全选；点击在「全选当前
 * 列表已加载数据」与清空间切换）＋已选计数与删除按钮（有勾选才显现）＋右侧
 * 历史总条数。删除走 AlertDialog 确认（destructive）。
 *
 * 搜索行由本面板持有（接口树视图仍由 LeftPanel 持有）：搜索框（草稿防抖
 * 提交，与 LeftPanel 同款 150ms 口径）＋手动刷新。Ctrl+K 聚焦信号
 * （searchFocusNonce）与 LeftPanel 消费同一 store 键——哪个视图挂着输入框
 * 就聚焦哪个，不切换视图。搜索行容器与 LeftPanel 同款（p-2、无分隔线），
 * 四视图切用时搜索框同位不位移。
 *
 * 分页形态（用户裁定）：页容量 50＋「加载更多」按钮追加下一页，**不引入
 * 虚拟列表**——run_records 封顶修剪（1000 行量级）下成立；若未来历史量级
 * 放宽到万级，需重新评估滚动虚拟化。
 *
 * 每页一条独立查询（键＝httpKeys.history(workspaceId, page)，缓存域随空间
 * 隔离——切工作空间即换键重取，不依赖失效通道）：发送完成的失效前缀、
 * 焦点重取、手动刷新对任意已加载页统一生效；「加载更多」只追加页数，翻页
 * 进度是空间的伴生态，切空间即归位。
 * 删除成功同样失效该前缀（全页重取，跨页选中删除后无幽灵行）。
 * 刷新指示仅首屏初次加载旋转；空列表空态带「去发送第一个请求」CTA
 * （激活已有接口 Tab，无 Tab 时聚焦接口树）。
 */

/** 相对时间的「当前时间」刷新间隔：秒 / 分档显示的陈旧度上限（单一定时器，随视图卸载清理） */
const NOW_TICK_MS = 30_000

/** 搜索提交防抖窗口：输入停顿后才提交进已提交值（与 LeftPanel 接口树视图同口径） */
const SEARCH_DEBOUNCE_MS = 150

/** 状态芯片形态（浅底深字）：语义档 → 底/字色（分档事实源＝runStatusOutcome） */
const CHIP_CLASS: Record<StatusOutcome, string> = {
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning/40 bg-warning/10 text-warning',
  destructive: 'border-destructive/30 bg-destructive/10 text-destructive',
  muted: 'border-border bg-muted text-muted-foreground',
}

export function HistoryPanel({
  searchQuery,
  onSearchChange,
}: {
  /** 搜索词（各视图独立、由左栏面板持有） */
  searchQuery: string
  onSearchChange: (value: string) => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  // 当前工作空间 id（清单查询与标题栏切换器共用缓存）：历史数据作用域的
  // 事实源，入查询键后缓存域随空间隔离，键变化即驱动重取
  const { data: workspaces } = useWorkspacesQuery()
  const workspaceId = workspaces?.currentId ?? null

  // 已加载页数（「加载更多」自增；简单分页，不回退）
  const [pageCount, setPageCount] = React.useState(1)
  // 渲染期调整模式：翻页进度是空间的伴生态，切工作空间即归位——上一空间
  // 的多页请求不带入新空间（条件随 workspaceId 收敛，不构成循环）
  const [pageScopedWorkspaceId, setPageScopedWorkspaceId] = React.useState(workspaceId)
  if (pageScopedWorkspaceId !== workspaceId) {
    setPageScopedWorkspaceId(workspaceId)
    setPageCount(1)
  }

  // —— 搜索行（本面板持有输入框）：草稿即时回显，停顿 150ms 才提交；外部
  // 通道直写已提交值（过滤空态「清除搜索」）时非防抖窗口内草稿跟随 ——
  const [draft, setDraft] = React.useState(searchQuery)
  const [debouncing, setDebouncing] = React.useState(false)
  const debounceTimerRef = React.useRef(0)
  // 渲染期收敛（条件随状态收敛，不构成循环）：已提交值经外部通道变化时
  // 草稿跟随，输入框与列表口径一致
  if (!debouncing && draft !== searchQuery) {
    setDraft(searchQuery)
  }
  React.useEffect(() => {
    return () => window.clearTimeout(debounceTimerRef.current)
  }, [])
  const handleSearchInput = (value: string) => {
    setDraft(value)
    setDebouncing(true)
    window.clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = 0
      onSearchChange(value)
      setDebouncing(false)
    }, SEARCH_DEBOUNCE_MS)
  }

  // Ctrl+K 聚焦信号消费点（历史视图的输入框在本面板；LeftPanel 的同款
  // 消费在其输入框未挂载时 ref 为空，安全空转）
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  const searchFocusNonce = useAppStore((s) => s.searchFocusNonce)
  React.useEffect(() => {
    if (searchFocusNonce === 0) return
    searchInputRef.current?.focus()
  }, [searchFocusNonce])

  const pageQueries = useQueries({
    queries: Array.from({ length: pageCount }, (_, index) => ({
      // workspaceId 段在空间未加载（清单在途）期间以 '' 占位并 enabled 门控：
      // 不以空身份发起请求，清单就绪后换真键再取（沿 workspaces 域 tree 键约定）
      queryKey: httpKeys.history(workspaceId ?? '', index + 1),
      queryFn: () => runListPage(index + 1),
      enabled: workspaceId !== null,
      // 仅历史域覆写全局默认（false）：窗口焦点（focus-bridge 桥接）触发重取，
      // CLI 写入后聚焦即见；其余查询不受影响
      refetchOnWindowFocus: true,
    })),
  })
  const firstPage = pageQueries[0]!
  const lastPage = pageQueries[pageQueries.length - 1]!
  // 刷新指示仅首屏（第一页初次加载、尚无任何数据）旋转；后台静默重取
  // （窗口聚焦桥接 / 手动失效）与翻页进行中都不转——列表已有内容时旋转
  // 是噪音而非状态信号
  const firstScreenFetching = firstPage.isPending && firstPage.isFetching

  // 相对时间的「当前时间」：打开视图时取真值，此后周期刷新（命令式定时器
  // 回调里 setState＝与外部系统同步的合法场景）
  const [now, setNow] = React.useState(() => new Date())
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), NOW_TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

  const items = React.useMemo(() => pageQueries.flatMap((query) => query.data ?? []), [pageQueries])
  const filtered = React.useMemo(() => filterHistoryItems(items, searchQuery), [items, searchQuery])

  // 满页＝可能有下一页（后端无总数接口，以页大小判定到底）；翻页进行中
  // （新页尚无数据）沿用上一满页判定，按钮保留为禁用态而非消失
  const lastLoaded = [...pageQueries].reverse().find((query) => query.data !== undefined)
  const hasMore = (lastLoaded?.data?.length ?? 0) === HISTORY_PAGE_SIZE

  // —— 行选中态：激活的历史详情 Tab 正在展示的 run（单例 Tab 的内容指针） ——
  const openHistoryDetail = useTabsStore((s) => s.openHistoryDetail)
  const selectedRunId = useTabsStore((s) => {
    const active = s.tabs.find((tab) => tab.id === s.activeTabId)
    return active?.kind === 'historyDetail' ? (active.key ?? null) : null
  })

  // —— 勾选集（runId 集合）：唯一入口＝行首 Checkbox 与底栏三态框；搜索
  // 过滤不改勾选集（跨过滤存续），只有删除成功按 id 修剪 ——
  const [selection, setSelection] = React.useState<ReadonlySet<string>>(() => new Set())
  const toggleSelection = (runId: string) => {
    setSelection((prev) => {
      const next = new Set(prev)
      if (next.has(runId)) next.delete(runId)
      else next.add(runId)
      return next
    })
  }
  // 三态框口径：全选＝当前列表（搜索命中集）逐项全覆盖；部分选＝横杆。
  // 勾选集跨过滤存续——只比数量会被命中集外的勾选误判成全覆盖
  const allSelected = filtered.length > 0 && filtered.every((item) => selection.has(item.runId))
  const toggleSelectAll = () => {
    if (allSelected) {
      setSelection(new Set())
    } else {
      setSelection(new Set(filtered.map((item) => item.runId)))
    }
  }

  // —— roving tabindex：焦点行持有唯一 Tab 停靠，↑↓ 在行间移动 ——
  const [focusedId, setFocusedId] = React.useState<string | null>(null)
  // 行元素登记表（事件回调内寻址聚焦；渲染期不读写）
  const rowRefs = React.useRef(new Map<string, HTMLDivElement>())
  const registerRow = React.useCallback((id: string, element: HTMLDivElement | null) => {
    if (element) {
      rowRefs.current.set(id, element)
    } else {
      rowRefs.current.delete(id)
    }
  }, [])

  // 焦点行被删除 / 过滤后收敛到当前首行（渲染期调整：条件随列表收敛，
  // 列表稳定后不再触发，不构成循环）
  if (focusedId !== null && !filtered.some((item) => item.runId === focusedId)) {
    setFocusedId(filtered[0]?.runId ?? null)
  }

  // —— 删除 mutation：成功后修剪勾选集并失效历史前缀（全页重取）。
  // 失效经组件上下文的 queryClient（与手动刷新同一路径；invalidateHistory
  // 的全局单例通道留给发送完成等非组件上下文，生产中两者是同一实例） ——
  const deleteMutation = useMutation({
    mutationFn: runDelete,
    onSuccess: (_deleted, ids) => {
      setSelection((prev) => {
        const next = new Set(prev)
        for (const id of ids) next.delete(id)
        return next
      })
      void queryClient.invalidateQueries({ queryKey: httpKeys.historyRoot() })
    },
  })

  // —— 删除确认对话框状态（删除批的目标 ids） ——
  const [confirmDeleteIds, setConfirmDeleteIds] = React.useState<string[] | null>(null)

  // —— 右键菜单：受控坐标锚点（沿 api-tree 三通道菜单形态） ——
  const menu = usePointContextMenu()
  const [menuRunId, setMenuRunId] = React.useState<string | null>(null)
  const menuItem =
    menuRunId === null ? null : (items.find((item) => item.runId === menuRunId) ?? null)

  const copyUrl = (url: string) => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(url)
        toast.success(t('common.copyDone'))
      } catch {
        toast.error(t('common.copyFailed'))
      }
    })()
  }

  // —— 行激活：恒为打开详情（勾选只走行首 Checkbox，修饰键不参与） ——
  const handleRowActivate = (item: RunListItemDto) => {
    openHistoryDetail(item.runId)
  }
  const handleRowContextMenu = (event: React.MouseEvent, item: RunListItemDto) => {
    event.preventDefault()
    event.stopPropagation()
    setMenuRunId(item.runId)
    menu.openAt(event.clientX, event.clientY)
  }

  // ↑↓ 在行间移动焦点并滚动跟进（focus 自带滚动可见）
  const handleListKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (filtered.length === 0) return
      event.preventDefault()
      const orderedIds = filtered.map((item) => item.runId)
      const currentIndex = focusedId === null ? -1 : orderedIds.indexOf(focusedId)
      const nextIndex =
        event.key === 'ArrowDown'
          ? Math.min(currentIndex + 1, orderedIds.length - 1)
          : Math.max(currentIndex - 1, 0)
      const nextId = orderedIds[nextIndex]!
      setFocusedId(nextId)
      rowRefs.current.get(nextId)?.focus()
    }
  }

  // —— 刷新 B：手动失效历史前缀（确定性兜底；E2E 断言 data-testid） ——
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: httpKeys.historyRoot() })
  }

  // —— 空态 CTA「去发送第一个请求」：已有接口 Tab 时激活之（用户回到
  // 工作台按发送），否则聚焦左栏接口树（从树里选 / 建接口）—— 都取现有
  // 能力，点击时即时读 store（非渲染期求值） ——
  const goSendFirstRequest = () => {
    const endpoint = useTabsStore.getState().tabs.find((tab) => tab.kind === 'endpoint')
    if (endpoint) {
      useTabsStore.getState().setActive(endpoint.id)
    } else {
      useAppStore.getState().setLeftView('apis')
    }
  }

  // —— 分支态渲染（错误 / 加载 / 空列表 / 过滤无匹配；搜索行与底栏恒在场
  // ——空列表也要能手动刷新与读总条数） ——
  if (firstPage.isError) {
    return (
      <div className="flex h-full flex-col" data-view="history">
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>{t('history.loadFailedTitle')}</EmptyTitle>
            <EmptyDescription>{firstPage.error.message}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => void firstPage.refetch()}>
              {t('history.loadFailedRetry')}
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  const body =
    items.length === 0 ? (
      firstPage.isPending ? (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          {t('history.loading')}
        </div>
      ) : (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SEMANTIC_ICONS.requestHistory />
            </EmptyMedia>
            <EmptyTitle>{t('shell.historyEmptyTitle')}</EmptyTitle>
            <EmptyDescription>{t('shell.historyEmptyDescription')}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" data-testid="history-empty-cta" onClick={goSendFirstRequest}>
              {t('shell.historyEmptyCta')}
            </Button>
          </EmptyContent>
        </Empty>
      )
    ) : filtered.length === 0 ? (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>{t('history.searchNoResults')}</EmptyTitle>
          <EmptyDescription>{t('history.searchNoResultsHint')}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" onClick={() => onSearchChange('')}>
            {t('history.searchClear')}
          </Button>
        </EmptyContent>
      </Empty>
    ) : (
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="history-list"
        onKeyDown={handleListKeyDown}
      >
        {filtered.map((item) => (
          <HistoryRow
            key={item.runId}
            item={item}
            now={now}
            selected={item.runId === selectedRunId}
            checked={selection.has(item.runId)}
            tabStop={focusedId === item.runId || (focusedId === null && filtered[0] === item)}
            onActivate={handleRowActivate}
            onToggleCheck={toggleSelection}
            onRowFocus={setFocusedId}
            onContextMenu={handleRowContextMenu}
            registerRow={registerRow}
          />
        ))}
        {/* 加载更多：满页才可能翻页；下一页请求进行中禁用防连点 */}
        {hasMore && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            data-testid="history-load-more"
            disabled={lastPage.isPending}
            onClick={() => setPageCount((count) => count + 1)}
          >
            {t('history.loadMore')}
          </Button>
        )}
      </div>
    )

  return (
    <div className="flex h-full min-h-0 flex-col" data-view="history">
      {/* 搜索行（本面板持有）：搜索框＋手动刷新（刷新 B——聚焦桥接之外的
          确定性兜底通道）。容器与 LeftPanel 搜索行同款（p-2、无分隔线、
          min-w-0 flex-1 包裹、层级抬到内容区之上）——四视图切用时搜索框
          同位不位移 */}
      <div className="relative z-10 flex shrink-0 items-center gap-1 p-2">
        <div className="min-w-0 flex-1">
          <SearchInput
            ref={searchInputRef}
            value={draft}
            onChange={(event) => handleSearchInput(event.target.value)}
            placeholder={t('shell.searchHistoryPlaceholder')}
            aria-label={t('shell.searchHistoryPlaceholder')}
            spellCheck={false}
            hint={
              <kbd className="rounded-sm border border-border bg-muted px-1 py-px font-mono text-micro text-muted-foreground">
                Ctrl+K
              </kbd>
            }
          />
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('history.refresh')}
          title={t('history.refresh')}
          data-testid="history-refresh"
          onClick={refresh}
          className="text-muted-foreground"
        >
          <SEMANTIC_ICONS.refresh
            aria-hidden
            className={`size-3.5 ${firstScreenFetching ? 'animate-spin' : ''}`}
          />
        </Button>
      </div>
      {body}

      {/* 底部状态栏（常驻）：三态全选框（与行首 Checkbox 同列对齐）＋已选
          计数＋删除（文字按钮，均有勾选才显现）＋右侧历史总条数 */}
      <div
        className="flex h-9 shrink-0 items-center gap-1.5 border-t border-border px-2"
        data-testid="history-footer"
      >
        <Checkbox
          checked={allSelected}
          indeterminate={!allSelected && selection.size > 0}
          onCheckedChange={toggleSelectAll}
          disabled={filtered.length === 0}
          aria-label={allSelected ? t('history.deselectAll') : t('history.selectAllVisible')}
          data-testid="history-select-all"
        />
        {selection.size > 0 && (
          <span
            className="text-xs whitespace-nowrap text-muted-foreground tabular-nums"
            data-testid="history-selection-count"
          >
            {t('history.selectedCount', { count: selection.size })}
          </span>
        )}
        {selection.size > 0 && (
          <Button
            variant="ghost"
            size="xs"
            className="h-6 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
            aria-label={t('history.deleteSelected')}
            data-testid="history-delete-selected"
            disabled={deleteMutation.isPending}
            onClick={() => setConfirmDeleteIds([...selection])}
          >
            {t('history.deleteSelected')}
          </Button>
        )}
        <span
          className="ml-auto text-xs whitespace-nowrap text-muted-foreground tabular-nums"
          data-testid="history-total-count"
        >
          {t('history.loadedCount', { count: items.length })}
        </span>
      </div>

      {/* 行右键菜单（受控坐标锚点；行被过滤剔除瞬间菜单项不渲染） */}
      <ContextMenu open={menu.open} onOpenChange={(next) => !next && menu.close()}>
        <ContextMenuContent anchor={menu.anchor}>
          {menuItem && (
            <>
              <ContextMenuItem onClick={() => openHistoryDetail(menuItem.runId)}>
                {t('history.menuOpen')}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => copyUrl(menuItem.url)}>
                {t('history.menuCopyUrl')}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                variant="destructive"
                onClick={() => setConfirmDeleteIds([menuItem.runId])}
              >
                {t('history.menuDelete')}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {/* 删除确认（destructive）：底栏批删与右键单删共用 */}
      <AlertDialog
        open={confirmDeleteIds !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmDeleteIds(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('history.deleteConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('history.deleteConfirmDescription', { count: confirmDeleteIds?.length ?? 0 })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('history.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid="history-delete-confirm"
              disabled={deleteMutation.isPending}
              onClick={() => {
                const ids = confirmDeleteIds ?? []
                if (ids.length > 0) deleteMutation.mutate(ids)
                setConfirmDeleteIds(null)
              }}
            >
              {t('history.confirmDelete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** 行事件回调组（面板闭包注入；行组件保持纯展示） */
interface HistoryRowHandlers {
  /** 点击 / Enter：打开单例历史详情 */
  onActivate: (item: RunListItemDto) => void
  /** 行首 Checkbox 勾选切换（勾选唯一入口；点击不冒泡为行激活） */
  onToggleCheck: (runId: string) => void
  onRowFocus: (id: string) => void
  onContextMenu: (event: React.MouseEvent, item: RunListItemDto) => void
  /** 行元素登记（roving tabindex 聚焦寻址；commit 阶段调用） */
  registerRow: (id: string, element: HTMLDivElement | null) => void
}

/**
 * 历史行（双行信息，平铺不分组；勾选唯一入口＝行首常驻 Checkbox）：
 * 首行＝source 芯片＋方法徽章＋路径（font-medium 等宽截断，title＝完整
 * URL）＋状态芯片（浅底深字，行尾右对齐）；次行＝耗时 · 相对时间 · 接口名
 * （endpoints.title 联查名，接口已删回落 path 段）。行高 h-12 承载双行。
 * 行选中态＝左侧 2px 强调条＋selection 底色（详情指针与勾选共用同一语言）；
 * 点击 / Enter 恒为打开详情，勾选只走 Checkbox（不冒泡）。
 * tabIndex 由 roving tabindex 管理（焦点行 0、其余 -1）；Checkbox 自身
 * 可 Tab 聚焦（勾选的键盘路径）。
 */
function HistoryRow({
  item,
  now,
  selected,
  checked,
  tabStop,
  onActivate,
  onToggleCheck,
  onRowFocus,
  onContextMenu,
  registerRow,
}: {
  item: RunListItemDto
  now: Date
  /** 详情 Tab 内容指针高亮（与勾选相互独立） */
  selected: boolean
  /** 勾选（Checkbox 与行底色） */
  checked: boolean
  /** roving tabindex：本行是否持有列表的唯一 Tab 停靠 */
  tabStop: boolean
} & HistoryRowHandlers) {
  const { t } = useI18n()
  const relative = relativeTimeParts(item.createdAt, now)

  // 次行元信息段（顺序＝耗时 · 相对时间 · 接口名；缺项与空串跳过——失败
  // 终态的 URL 落库为空串时无路径段，分隔点不悬尾）
  const metaParts = [
    item.durationMs !== null ? formatDuration(item.durationMs) : null,
    relative ? t(relative.key, { count: relative.count }) : null,
    item.endpointName ?? urlPathNameOf(item.url),
  ].filter((part): part is string => part !== null && part !== '')

  return (
    <div
      role="button"
      tabIndex={tabStop ? 0 : -1}
      data-testid="history-row"
      data-run-id={item.runId}
      data-source={item.source}
      data-selected={selected || undefined}
      data-checked={checked || undefined}
      ref={(element) => registerRow(item.runId, element)}
      className="group/history-row relative flex h-12 w-full cursor-pointer items-center gap-1.5 px-2 text-left text-row outline-none hover:bg-accent focus-visible:ring-[2px] focus-visible:ring-ring/50 focus-visible:ring-inset data-checked:bg-selection data-selected:bg-selection"
      onClick={() => onActivate(item)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          onActivate(item)
        }
      }}
      onFocus={() => onRowFocus(item.runId)}
      onContextMenu={(event) => onContextMenu(event, item)}
    >
      {/* 选中第二线索：左侧 2px 强调条（详情指针与勾选共用同一语言） */}
      {(selected || checked) && (
        <span aria-hidden className="absolute inset-y-0 start-0 w-0.5 bg-primary" />
      )}
      {/* 行首常驻 Checkbox（勾选唯一入口）：点击不冒泡为行激活；Tab 可达
          （勾选的键盘路径与行导航分离） */}
      <Checkbox
        checked={checked}
        aria-label={t('history.selectRow')}
        data-testid="history-row-check"
        className="shrink-0"
        onClick={(event) => event.stopPropagation()}
        onCheckedChange={() => onToggleCheck(item.runId)}
      />
      <div className="min-w-0 flex-1">
        {/* 首行：source 芯片＋方法徽章＋路径＋状态芯片 */}
        <div className="flex items-center gap-1.5">
          <span
            className="shrink-0 rounded-sm border border-border px-1 font-mono text-micro leading-4 text-muted-foreground"
            data-testid="history-row-source"
          >
            {item.source === 'cli' ? t('history.sourceCli') : t('history.sourceGui')}
          </span>
          <MethodBadge method={item.method} />
          <span
            className="min-w-0 flex-1 truncate font-mono font-medium"
            title={item.url}
            data-testid="history-row-path"
          >
            {urlPathOf(item.url)}
          </span>
          <span
            className={`shrink-0 rounded-sm border px-1 font-mono text-micro leading-4 font-medium tabular-nums ${
              CHIP_CLASS[runStatusOutcome(item.state, item.statusCode)]
            }`}
            data-testid="history-row-status"
          >
            {item.state === 'cancelled'
              ? t('history.statusCancelled')
              : item.state === 'failed'
                ? t('history.statusFailed')
                : item.statusCode === null
                  ? '—'
                  : item.statusCode}
          </span>
        </div>
        {/* 次行：耗时 · 相对时间 · 接口名 */}
        <div
          className="mt-0.5 flex min-w-0 items-center gap-1.5 text-micro text-muted-foreground"
          data-testid="history-row-meta"
        >
          <span className="min-w-0 truncate">{metaParts.join(' · ')}</span>
        </div>
      </div>
    </div>
  )
}
