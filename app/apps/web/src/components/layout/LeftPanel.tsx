import * as React from 'react'

import { SearchInput } from '@workspace/ui/components'

import { useI18n } from '@/i18n'
import { useAppStore, type LeftPanelView } from '@/stores/app.store'
import { ApiTreePanel } from '@/features/api-tree/api-tree-panel'
import { HistoryPanel } from '@/features/history/history-panel'
import { VariablesView } from '@/features/variables/variables-view'
import { WorkflowsView } from '@/features/workflow/workflows-view'
import { WorkspacesView } from '@/features/workspaces/workspaces-view'

import { LEFT_PANEL_VIEWS } from './left-panel-views'

/**
 * 左栏面板（宽度由 AppShell 受控，默认 288）：五视图共享搜索框槽与内容区。
 * 接口树 / 请求历史 / 变量树 / 工作空间清单 / 工作流清单五视图搜索启用
 * （接口树四字段过滤 / 历史路径＋方法＋状态码过滤 / 变量分类名＋变量 key
 * 过滤 / 工作空间名＋服务名过滤 / 工作流名过滤）。各视图搜索词独立持有、
 * 互不串词；输入经 ~150ms 防抖才提交（过滤分组停顿重算，草稿即时回显
 * 不受防抖拖累）。
 */

const EMPTY_SEARCH_TERMS: Record<LeftPanelView, string> = {
  apis: '',
  history: '',
  variables: '',
  workspaces: '',
  workflows: '',
}

/** 启用搜索框的数据视图 */
const SEARCHABLE_VIEWS: ReadonlySet<LeftPanelView> = new Set([
  'apis',
  'history',
  'variables',
  'workspaces',
  'workflows',
])

/** 搜索提交防抖窗口：输入停顿后才重算过滤分组（约一拍打字间隔） */
const SEARCH_DEBOUNCE_MS = 150

/** 视图穷尽分发（无兜底分支：新增视图时 default 的 never 收窄失败，
 * 编译期即提醒在此接线） */
function renderView(view: LeftPanelView, searchValue: string, setSearch: (value: string) => void) {
  switch (view) {
    case 'apis':
      return <ApiTreePanel searchQuery={searchValue} onSearchChange={setSearch} />
    case 'history':
      return <HistoryPanel searchQuery={searchValue} onSearchChange={setSearch} />
    case 'variables':
      return <VariablesView searchQuery={searchValue} onSearchChange={setSearch} />
    case 'workspaces':
      return <WorkspacesView searchQuery={searchValue} onSearchChange={setSearch} />
    case 'workflows':
      return <WorkflowsView searchQuery={searchValue} onSearchChange={setSearch} />
    default: {
      const exhaustive: never = view
      return exhaustive
    }
  }
}

export function LeftPanel() {
  const { t } = useI18n()
  const leftView = useAppStore((s) => s.leftView)
  const view = LEFT_PANEL_VIEWS.find((v) => v.key === leftView) ?? LEFT_PANEL_VIEWS[0]!
  const [searchTerms, setSearchTerms] = React.useState(EMPTY_SEARCH_TERMS)
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  const searchEnabled = SEARCHABLE_VIEWS.has(leftView)

  // —— 搜索框草稿（防抖前即时值）：输入即时回显，停顿 150ms 才提交进
  // searchTerms（过滤分组重算的触发点）。草稿与已提交值分持，避免受控
  // 输入随防抖回显卡顿 ——
  const [draft, setDraft] = React.useState('')
  const [draftView, setDraftView] = React.useState<LeftPanelView>(leftView)
  const [debouncing, setDebouncing] = React.useState(false)
  const debounceTimerRef = React.useRef(0)

  // 渲染期收敛（条件随状态收敛，不构成循环）：
  // 1) 视图切换：草稿回到新视图的已提交搜索词（未提交草稿随切换丢弃）
  if (draftView !== leftView) {
    setDraftView(leftView)
    setDraft(searchTerms[leftView])
    setDebouncing(false)
  }
  // 2) 已提交值经外部通道变化（列表空态「清除搜索」直写 searchTerms）：
  //    非防抖窗口时草稿跟随，输入框与列表口径一致
  if (draftView === leftView && draft !== searchTerms[leftView] && !debouncing) {
    setDraft(searchTerms[leftView])
  }

  // 视图切换 / 卸载打断防抖：丢弃 pending 提交（防其落错视图）
  React.useEffect(() => {
    return () => window.clearTimeout(debounceTimerRef.current)
  }, [leftView])

  // 聚焦左栏搜索（Ctrl+K 命令 / 命令面板的信号消费点）
  const searchFocusNonce = useAppStore((s) => s.searchFocusNonce)
  React.useEffect(() => {
    if (searchFocusNonce === 0) return
    searchInputRef.current?.focus()
  }, [searchFocusNonce])

  const setSearch = React.useCallback(
    (value: string) => {
      setSearchTerms((prev) => ({ ...prev, [leftView]: value }))
    },
    [leftView],
  )
  const handleSearchInput = (value: string) => {
    setDraft(value)
    setDebouncing(true)
    window.clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = 0
      setSearch(value)
      setDebouncing(false)
    }, SEARCH_DEBOUNCE_MS)
  }
  const searchValue = searchTerms[leftView]
  const placeholder = t(view.placeholderKey)

  return (
    <div
      className="flex h-full w-full shrink-0 flex-col border-r bg-background"
      data-view={leftView}
    >
      {/* 各视图独立搜索框（互不串词）。历史视图的搜索
          行由 HistoryPanel 持有（输入框旁还有多选触发与手动刷新），此处不
          渲染；Ctrl+K 聚焦信号两边消费同一 nonce——本输入框未挂载时空转。
          容器底部留出焦点环空间、层级抬到内容区之上——聚焦环不被树滚动区
          裁切；下边距与左右一致（8px）：紧贴树首行会读成与搜索框同一块内容。
          行尾是视图专属动作（接口树的展开 / 收起全部等，见 LEFT_PANEL_VIEWS） */}
      {leftView !== 'history' && (
        <div className="relative z-10 flex items-center gap-1 p-2">
          <div className="min-w-0 flex-1">
            <SearchInput
              ref={searchInputRef}
              placeholder={placeholder}
              aria-label={placeholder}
              value={draft}
              onChange={(event) => handleSearchInput(event.target.value)}
              disabled={!searchEnabled}
              hint={
                searchEnabled ? (
                  <kbd className="rounded-sm border border-border bg-muted px-1 py-px font-mono text-micro text-muted-foreground">
                    Ctrl+K
                  </kbd>
                ) : undefined
              }
            />
          </div>
          {view.SearchAction && <view.SearchAction />}
        </div>
      )}
      {renderView(leftView, searchValue, setSearch)}
    </div>
  )
}
