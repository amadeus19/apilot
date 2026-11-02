import * as React from 'react'

import { Loader2Icon, XIcon } from 'lucide-react'

import { cn } from 'cn'

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  usePointContextMenu,
} from '@workspace/ui/components'
import { useCurrentWorkspaceTreeQuery } from '@/features/workspaces/api'
import { useResponseStore } from '@/features/http/response.store'
import { MethodBadge } from '@/features/api-tree/method-badge'
import { useDraftStore } from '@/features/workbench/draft.store'
import { useWorkflowCloseGuard } from '@/features/workflow/workflow-close'
import { SEMANTIC_ICONS } from '@/features/icons/semantic-icons'
import { useI18n, type DictKey } from '@/i18n'
import { makeEndpointNodeId } from '@/lib/tree-identity'
import { selectActiveTab, useTabsStore, type TabMeta } from '@/stores/tabs.store'

/**
 * 标签栏（h-8，主区顶部固定 chrome，不在分栏结构内；VS Code 编辑器 Tab 形态）：
 * 方角 Tab 按内容自适应宽度（min 下限 / max 上限）不压缩，相邻成排、行间仅以
 * 细分隔线相隔；条带底边线由标签栏统一绘制，激活 Tab 以内容底色盖住自己名下
 * 的一段边线并自顶部伸出强调色短条，与下方工作区连成一体（「Tab 包住内容」）。
 * Tab 溢出走横向滚动：滚轮纵向轮转横向，悬停条带时底部淡入溢出指示条
 * （仅提示内容量，滚动靠滚轮与键盘，不承担拖动）。
 * 接口 Tab 前缀方法徽章（方法语义色恒定）、工作空间设置 Tab 前缀设置图标、
 * 历史详情 Tab 前缀请求历史图标；草稿 Tab（历史恢复）同接口 Tab 走方法
 * 徽章（方法取自内存草稿 store）；发送中的 Tab 标题旁小 spinner——切 Tab
 * 不取消在途请求，非激活行以 spinner 提示请求仍在后台进行；
 * 预览 Tab 标题去强调（不用斜体，中文无真斜体）。关闭钮沿设计稿口径——激活 Tab 常显、
 * 非激活 hover / 聚焦显示。点击＝激活；双击＝预览转常驻。
 * 键盘：Enter / Space＝激活（tablist 惯例）、←→ / Home / End 切换激活
 * （roving tabindex，焦点跟随）；Ctrl+Enter 不在此拦——归全局发送命令；
 * 中键＝关闭；右键菜单＝关闭 / 关闭其他 / 关闭右侧 / 关闭全部。
 * 树 / 命令等外部打开动作（activationSeq）即使目标已激活，也把激活 Tab
 * 滚回可视区（nearest 语义：完全可见不动，否则贴齐左 / 右缘）。
 */
export function TabBar() {
  const { t } = useI18n()
  const tabs = useTabsStore((s) => s.tabs)
  const activeTab = useTabsStore(selectActiveTab)
  const activationSeq = useTabsStore((s) => s.activationSeq)
  const setActive = useTabsStore((s) => s.setActive)
  const promote = useTabsStore((s) => s.promote)
  const close = useTabsStore((s) => s.close)
  const closeOthers = useTabsStore((s) => s.closeOthers)
  const closeToRight = useTabsStore((s) => s.closeToRight)
  const closeAll = useTabsStore((s) => s.closeAll)

  // Tab 方法徽章数据源：与接口树同一条「当前工作空间的树」查询（缓存去重）；
  // 草稿 Tab 不在树里，方法取自内存草稿 store
  const { data: tree } = useCurrentWorkspaceTreeQuery()
  const drafts = useDraftStore((s) => s.drafts)
  // 在途发送指示数据源：response store 条目按 tabId 判 sending 态（切 Tab
  // 不取消在途请求，非激活 Tab 行的 spinner 是请求后台继续的唯一可见线索）
  const entries = useResponseStore((s) => s.entries)
  const methodByTabId = React.useMemo(() => {
    const map = new Map<string, string>()
    tree?.services.forEach((service) => {
      service.endpoints.forEach((endpoint) => {
        map.set(makeEndpointNodeId(service.id, endpoint.key), endpoint.definition.method)
      })
    })
    for (const [draftId, data] of Object.entries(drafts)) {
      map.set(draftId, data.method)
    }
    return map
  }, [tree, drafts])

  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const thumbRef = React.useRef<HTMLDivElement | null>(null)

  /**
   * 溢出指示条度量：thumb 宽＝视口占内容比、位移＝滚动进度。ref 直写样式，
   * 不逐帧重渲染；无溢出时宽度归零（指示条常挂载，靠透明度隐藏）。
   */
  const syncScrollbar = React.useCallback(() => {
    const el = scrollRef.current
    const thumb = thumbRef.current
    if (!el || !thumb) return
    const overflow = el.scrollWidth - el.clientWidth
    if (overflow <= 1) {
      thumb.style.width = '0px'
      return
    }
    const width = Math.max((el.clientWidth / el.scrollWidth) * el.clientWidth, 24)
    thumb.style.width = `${width}px`
    thumb.style.transform = `translateX(${(el.scrollLeft / overflow) * (el.clientWidth - width)}px)`
  }, [])

  // 溢出状态跟随容器尺寸（窗口缩放）与 Tab 数量（开 / 关）；滚动进度走 onScroll
  React.useLayoutEffect(() => {
    syncScrollbar()
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(syncScrollbar)
    observer.observe(el)
    return () => observer.disconnect()
  }, [tabs.length, syncScrollbar])

  /**
   * 激活 Tab 滚回可视区＋焦点跟随（挂载 / 切换 / 外部打开均触发）：树点击已
   * 激活 Tab 时 activeTabId 不变，唯有 activationSeq 能表达「用户再次指向了
   * 这个 Tab」。手动计算滚动量而非 scrollIntoView——后者可能连带滚动祖先容器。
   *
   * 焦点跟随由键盘通道置标志触发（点击 / 程序化激活不抢焦点），且落在布局
   * 效应里而非 rAF：rAF 要等下一帧，其间到位的按键仍落在上一行上
   * （「→ 后紧接 Enter」会激活错行）；布局效应在提交后同步执行，焦点恒与激活行一致。
   */
  const followFocusRef = React.useRef(false)

  React.useLayoutEffect(() => {
    const container = scrollRef.current
    const activeId = useTabsStore.getState().activeTabId
    if (!container || !activeId) return
    const el = container.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeId)}"]`)
    if (!el) return
    if (followFocusRef.current) {
      followFocusRef.current = false
      el.focus()
    }
    const left = el.offsetLeft
    const right = left + el.offsetWidth
    if (left < container.scrollLeft) {
      container.scrollLeft = left
    } else if (right > container.scrollLeft + container.clientWidth) {
      container.scrollLeft = right - container.clientWidth
    }
  }, [activeTab?.id, activationSeq])

  // —— 工作流脏态关闭守卫：受影响范围存在未保存工作流 → 弹确认
  //     （保存并关闭 / 不保存关闭 / 取消）；编排（含回收与确认弹层）
  //     单点在 workflow 域，此处只接线 ——
  const { guardClose, closeGuardDialog } = useWorkflowCloseGuard()

  // 关闭激活 Tab 后焦点跟到新激活行（中键 / 点 × 关闭时焦点不掉到 body）
  const closeTab = (tabId: string): void => {
    const state = useTabsStore.getState()
    const tab = state.tabs.find((entry) => entry.id === tabId)
    if (!tab) return
    const wasActive = state.activeTabId === tabId
    guardClose([tab], () => {
      close(tabId)
      if (wasActive) followFocusRef.current = true
    })
  }

  // ←→ / Home / End：切换激活（roving tabindex 焦点跟随激活行）
  const handleListKeyDown = (event: React.KeyboardEvent): void => {
    if (event.nativeEvent.isComposing) return
    const currentIndex = tabs.findIndex((tab) => tab.id === activeTab?.id)
    let nextIndex: number
    if (event.key === 'ArrowRight') nextIndex = currentIndex + 1
    else if (event.key === 'ArrowLeft') nextIndex = currentIndex - 1
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = tabs.length - 1
    else return
    if (nextIndex < 0 || nextIndex >= tabs.length || nextIndex === currentIndex) return
    event.preventDefault()
    followFocusRef.current = true
    setActive(tabs[nextIndex]!.id)
  }

  // 滚轮纵向轮转横向（Tab 溢出时的桌面惯例；不阻止默认，页面本无纵滚）
  const handleWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    const element = event.currentTarget
    if (event.deltaY !== 0 && element.scrollWidth > element.clientWidth) {
      element.scrollLeft += event.deltaY
    }
  }

  // 右键菜单：坐标锚点 + 当前行 id 并行持有
  const menu = usePointContextMenu()
  const [menuTabId, setMenuTabId] = React.useState<string | null>(null)
  const menuTabIndex = menuTabId ? tabs.findIndex((tab) => tab.id === menuTabId) : -1

  return (
    <div
      className="group/tabbar relative flex h-8 shrink-0 items-stretch bg-muted/50"
      data-testid="tabbar"
    >
      <div
        ref={scrollRef}
        role="tablist"
        aria-label={t('shell.tabbarLabel')}
        onKeyDown={handleListKeyDown}
        onWheel={handleWheel}
        onScroll={syncScrollbar}
        className="relative flex h-full min-w-0 flex-1 [scrollbar-width:none] items-stretch overflow-x-auto [&::-webkit-scrollbar]:hidden"
      >
        {tabs.length === 0 ? (
          <span className="flex items-center px-3 text-xs text-muted-foreground">
            {t('shell.tabbarEmpty')}
          </span>
        ) : (
          tabs.map((tab, index) => (
            <TabButton
              key={tab.id}
              tab={tab}
              active={activeTab?.id === tab.id}
              separated={index > 0}
              last={index === tabs.length - 1}
              activeTitle={activeTitle(tab, t)}
              method={
                tab.kind === 'endpoint' || tab.kind === 'draft'
                  ? (methodByTabId.get(tab.id) ?? null)
                  : null
              }
              busy={entries[tab.id]?.phase === 'sending'}
              onActivate={() => setActive(tab.id)}
              onPromote={() => promote(tab.id)}
              onClose={() => closeTab(tab.id)}
              onContextMenu={(event) => {
                event.preventDefault()
                setMenuTabId(tab.id)
                menu.openAt(event.clientX, event.clientY)
              }}
            />
          ))
        )}
      </div>

      {/* 条带底边线由标签栏统一绘制；激活 Tab（z-10＋内容底色）盖住名下一段，
          与下方工作区连成一体——「Tab 包住内容」而非一排分割线 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-px bg-border"
      />

      {/* 溢出指示条：悬停条带时淡入，只提示内容量（滚动靠滚轮 / 键盘） */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-[3px] opacity-0 transition-opacity duration-100 group-hover/tabbar:opacity-100"
      >
        <div ref={thumbRef} className="h-full rounded-full bg-foreground/25" />
      </div>

      {/* 行右键菜单：关闭 ‖ 关闭其他 / 关闭右侧 / 关闭全部 */}
      <ContextMenu open={menu.open} onOpenChange={(open) => !open && menu.close()}>
        <ContextMenuContent anchor={menu.anchor}>
          <ContextMenuItem
            onClick={() => {
              if (menuTabId) closeTab(menuTabId)
            }}
          >
            {t('tabs.close')}
            <ContextMenuShortcut>Ctrl+W</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={tabs.length <= 1}
            onClick={() => {
              if (menuTabId)
                guardClose(
                  tabs.filter((tab) => tab.id !== menuTabId),
                  () => closeOthers(menuTabId),
                )
            }}
          >
            {t('tabs.closeOthers')}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={menuTabIndex < 0 || menuTabIndex >= tabs.length - 1}
            onClick={() => {
              if (menuTabId) guardClose(tabs.slice(menuTabIndex + 1), () => closeToRight(menuTabId))
            }}
          >
            {t('tabs.closeToRight')}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={tabs.length === 0}
            onClick={() => guardClose(tabs, () => closeAll())}
          >
            {t('tabs.closeAll')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* 工作流未保存关闭确认（guardClose 触发；取消＝仅关弹层） */}
      {closeGuardDialog}
    </div>
  )
}

/** 固定标题 Tab（历史详情）的标题恒走 i18n（语言切换即时生效，不落会话 JSON）；
 *  工作空间详情 Tab 的 title＝工作空间名（数据，重命名经 setTabTitle 同步），
 *  空值兜底 i18n 文案；变量配置 Tab 的 title＝分类名（数据），展示格式
 *  「变量 · {name}」在此格式化 */
function activeTitle(
  tab: TabMeta,
  t: (key: DictKey, params?: Record<string, string | number>) => string,
): string {
  if (tab.kind === 'workspaceSettings')
    return tab.title !== '' ? tab.title : t('tabs.workspaceSettingsTitle')
  if (tab.kind === 'historyDetail') return t('tabs.historyDetailTitle')
  if (tab.kind === 'variables') return t('variables.tabTitle', { name: tab.title })
  return tab.title
}

function TabButton({
  tab,
  active,
  separated,
  last,
  activeTitle: title,
  method,
  busy,
  onActivate,
  onPromote,
  onClose,
  onContextMenu,
}: {
  tab: TabMeta
  active: boolean
  /** 非首行的左分隔线（贴合成排：分隔只出现在 Tab 之间） */
  separated: boolean
  /** 末位行的右分隔线（与右侧空白条带区的闭合边界） */
  last: boolean
  activeTitle: string
  /** 接口 Tab 的 HTTP 方法（树数据缺席时 null＝不渲染徽章） */
  method: string | null
  /** 在途发送（response store 条目 sending 态）：标题旁小 spinner */
  busy: boolean
  onActivate: () => void
  onPromote: () => void
  onClose: () => void
  onContextMenu: (event: React.MouseEvent) => void
}) {
  const { t } = useI18n()
  const closeLabel = t('tabs.closeTab', { title })
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      data-testid="tabbar-tab"
      data-tab-id={tab.id}
      data-preview={tab.preview || undefined}
      onClick={onActivate}
      onDoubleClick={onPromote}
      // 中键＝关闭（桌面标签惯例；auxclick 只对非左键派发）
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault()
          onClose()
        }
      }}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        // Ctrl+Enter 不拦不激活（放行冒泡到全局分发器＝发送命令）；
        // Enter / Space＝激活（tablist 惯例）
        if ((event.key === 'Enter' && !event.ctrlKey) || event.key === ' ') {
          event.preventDefault()
          onActivate()
        }
      }}
      className={cn(
        'group/tab relative flex h-full w-[160px] shrink-0 cursor-pointer items-center gap-1.5 px-2.5 text-xs outline-none select-none hover:bg-accent focus-visible:ring-[2px] focus-visible:ring-ring/50 focus-visible:ring-inset',
        separated && 'border-l border-border/60',
        // 末位 Tab 的右分隔线：与右侧空白条带区的闭合边界（Tab 溢出滚动时
        // 贴视口右缘，不可见亦无害）
        last && 'border-r border-border/60',
        // 激活＝内容底色＋z 盖住条带底边线，与下方工作区连成一体；
        // 非激活＝透明底沉入条带
        active ? 'z-10 bg-background text-foreground' : 'text-muted-foreground',
      )}
    >
      {tab.kind === 'workspaceSettings' ? (
        <SEMANTIC_ICONS.workspaceSettings aria-hidden className="size-3.5 shrink-0" />
      ) : tab.kind === 'historyDetail' ? (
        <SEMANTIC_ICONS.requestHistory aria-hidden className="size-3.5 shrink-0" />
      ) : tab.kind === 'variables' ? (
        <SEMANTIC_ICONS.variables aria-hidden className="size-3.5 shrink-0" />
      ) : tab.kind === 'workflow' ? (
        <SEMANTIC_ICONS.workflow aria-hidden className="size-3.5 shrink-0" />
      ) : (
        method && <MethodBadge method={method} />
      )}
      {/* 预览态＝标题去强调，不靠斜体——中文无真斜体，合成倾斜会在 13px 汉字上
          挤靠笔画；悬停提示同时承担「完整标题」与「为什么这条是灰的」。
          flex-1 把关闭钮恒定推到 Tab 右缘；超长标题右端 mask 渐隐（替代省略
          号截断、12px 窄带贴右缘）——关闭钮收起时不占位，标题右缘即 Tab
          内容缘；悬停 / 激活钮展开时标题同步收缩，渐隐点随百分比端点自动
          左移至按钮左侧 */}
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className={cn(
                'min-w-0 flex-1 overflow-hidden [mask-image:linear-gradient(to_right,#000_calc(100%_-_12px),transparent_100%)] whitespace-nowrap',
                tab.preview && 'text-muted-foreground',
              )}
            />
          }
        >
          {title}
        </TooltipTrigger>
        <TooltipContent>
          {tab.preview ? `${title} · ${t('tabs.previewHint')}` : title}
        </TooltipContent>
      </Tooltip>
      {/* 在途发送指示：标题旁小 spinner（固定占位不参与标题截断；终态由
          store 落定自然摘除）。无文字伴随，语义经 role=status＋字典标签
          交给读屏器 */}
      {busy && (
        <span
          role="status"
          aria-label={t('response.sending')}
          data-testid="tabbar-tab-spinner"
          className="flex shrink-0 items-center text-muted-foreground"
        >
          <Loader2Icon aria-hidden className="size-3 animate-spin" />
        </span>
      )}
      {active && <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-primary" />}
      <button
        type="button"
        aria-label={closeLabel}
        // 关闭钮：激活常显；非激活隐藏且不占位（width 归零）——标题用满
        // Tab 宽、淡出贴右缘；悬停 / 键盘聚焦时按钮显隐只走淡入淡出
        // （width 切换无过渡，不做展开动画）。收起态 overflow-hidden 裁掉
        // 图标溢出，展开态图标无裁剪
        className={cn(
          'ml-1 grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-sm transition-opacity duration-150 outline-none hover:bg-foreground/10 focus-visible:ring-[2px] focus-visible:ring-ring/50',
          active
            ? 'opacity-100'
            : 'pointer-events-none w-0 opacity-0 group-focus-within/tab:pointer-events-auto group-focus-within/tab:w-6 group-focus-within/tab:opacity-100 group-hover/tab:pointer-events-auto group-hover/tab:w-6 group-hover/tab:opacity-100',
        )}
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
      >
        <XIcon className="size-3" aria-hidden />
      </button>
    </div>
  )
}
