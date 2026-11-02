import * as React from 'react'

import { Panel, Group as PanelGroup, type PanelImperativeHandle } from 'react-resizable-panels'

import { TooltipProvider } from '@workspace/ui/components'

import { TitleBar } from '@/components/layout/TitleBar'
import { IconRail } from '@/components/layout/IconRail'
import { LeftPanel } from '@/components/layout/LeftPanel'
import { PanelSeparator } from '@/components/layout/panel-separator'
import { TabBar } from '@/components/layout/TabBar'
import { ResponsePane } from '@/components/layout/ResponsePane'
import { WorkbenchContent } from '@/components/layout/WorkbenchContent'
import { StatusBar } from '@/components/layout/StatusBar'
import {
  setLeftPanelApi,
  setResponsePanelApi,
  rememberResponseHeight,
  notifyResponseCollapsed,
  initResponseRestoreMemory,
} from '@/components/layout/panel-bridge'
import { useWorkspaceSession } from '@/features/workbench/session-persistence'
import { useTreeExpandedStore } from '@/features/api-tree/tree-state.store'
import { makeEndpointNodeId } from '@/lib/tree-identity'
import { selectActiveTab, useTabsStore } from '@/stores/tabs.store'
import { useGlobalCommands } from '@/features/commands/global-commands'
import { useCommandDispatcher } from '@/features/commands/use-command-dispatcher'
import { useWorkflowEvents } from '@/features/workflow/use-workflow-events'
import { CommandPaletteDialog } from '@/features/commands/command-palette'
import { useWorkspacesQuery } from '@/features/workspaces/api'
import { WorkspacesDialogHost } from '@/features/workspaces/workspaces-dialogs'
import { SyncWizard } from '@/features/sync/sync-wizard'
import { useI18n } from '@/i18n'
import { reportError } from '@/services/error-center'
import { useDebouncedWriter } from '@/services/debounced-writer'
import { useSettingsStore } from '@/stores/settings.store'
import {
  DEFAULT_LEFT_PANEL_WIDTH,
  MIN_LEFT_PANEL_WIDTH,
  REQUEST_PANEL_MIN_HEIGHT,
  RESPONSE_COLLAPSED_HEIGHT,
  RESPONSE_DEFAULT_PERCENT,
  RESPONSE_MIN_HEIGHT,
  useAppStore,
} from '@/stores/app.store'

/** 库 onResize 高频触发：宽度持久化防抖窗口 */
const LEFT_WIDTH_PERSIST_DEBOUNCE_MS = 300

/** PanelSize 的结构类型（库未导出该类型，按字段结构声明） */
interface PanelSizeLike {
  inPixels: number
  asPercentage: number
}

/**
 * App Shell 布局根：标题栏 / 左栏（图标栏＋面板）/ 工作台主区 / 状态栏。
 *
 * 分栏体系（ADR-0005）：内容区完全由 react-resizable-panels 划分——
 * 外层左右 Group（左栏 | 主区）；标签栏是主区顶部固定 chrome（分栏结构外），
 * 主区上下两段 Panel：请求编辑区（不可折叠、minSize 保底）、响应区
 * （可折叠为状态行条带）。标题栏 / 状态栏是固定 chrome，不在分栏结构内。
 *
 * 「库管几何，store 管语义」：控制动作（Ctrl+B / 标题栏图标）经
 * panel-bridge 向库下发；几何变化经 onResize 上提镜像到 store；
 * 左栏宽度防抖持久化（settings 键 shell.leftPanelWidth），启动经
 * defaultSize 注入恢复；响应区尺寸会话态不持久化（重启回默认占比）。
 */
export function AppShell() {
  const { t } = useI18n()
  const storedLeftPanelWidth = useSettingsStore((s) => s.shell.width)
  // 当前工作空间（Rust 侧解析真值）：驱动 Tab 会话的按空间保存 / 恢复
  const workspacesQuery = useWorkspacesQuery()
  const currentWorkspaceId = workspacesQuery.data?.currentId ?? null
  useWorkspaceSession(currentWorkspaceId)
  // 命令面板体系：全局命令注册（含 Ctrl+B 左栏收展 / Ctrl+T 新建接口）
  // + 统一 keydown 分发器（命令键位唯一分发点）
  useGlobalCommands()
  useCommandDispatcher()
  // 工作流执行事件流订阅（AppShell 单点常驻；执行态 store 归约）
  useWorkflowEvents()

  // imperative 句柄本地留存（onResize 内读 isCollapsed 做语义镜像判定）
  const leftPanelApiRef = React.useRef<PanelImperativeHandle | null>(null)
  const responsePanelApiRef = React.useRef<PanelImperativeHandle | null>(null)

  // Tab 激活 → 接口树行高亮（聚焦跟随激活的编辑对象）：
  // 接口 Tab 高亮同身份树行——节点 id 经身份构造器显式构造（Tab id ≡
  // 树节点 id 的等价关系单点在 lib/tree-identity，不靠两串恰好相等）；
  // 非接口 Tab 清空树选中
  const activeTab = useTabsStore(selectActiveTab)
  const activeTabKind = activeTab?.kind ?? null
  React.useEffect(() => {
    const treeState = useTreeExpandedStore.getState()
    if (activeTab?.kind === 'endpoint' && activeTab.serviceId && activeTab.key) {
      treeState.setActiveNode(makeEndpointNodeId(activeTab.serviceId, activeTab.key))
    } else {
      treeState.setActiveNode(null)
    }
  }, [activeTab])
  // 响应区挂载条件：仅接口 Tab（工作空间设置页 / 欢迎屏 / 预留类型独占主区）
  const showResponsePanel = activeTabKind === 'endpoint'

  // 响应区挂载即初始化折叠恢复记忆：库对初始布局不触发 onResize，
  // 初始高度经 bridge 的双 rAF 补偿入记忆（折叠记忆的单一 owner 在
  // panel-bridge，本组件只发起初始化）
  React.useEffect(() => {
    if (!showResponsePanel) return
    return initResponseRestoreMemory()
  }, [showResponsePanel])

  // 宽度持久化防抖写（统一 DebouncedWriter：单槽覆盖 + 卸载 dispose 补写 +
  // 退出 flush 注册，与编辑器草稿写同一资源纪律，不再手写定时器管理）
  const widthWriter = useDebouncedWriter<number>({
    flusherId: 'left-panel-width',
    write: (width) => Promise.resolve(useSettingsStore.getState().setShellLeftPanelWidth(width)),
    onError: reportError,
    debounceMs: LEFT_WIDTH_PERSIST_DEBOUNCE_MS,
  })

  const handleLeftPanelResize = (size: PanelSizeLike): void => {
    const visible = leftPanelApiRef.current ? !leftPanelApiRef.current.isCollapsed() : true
    const store = useAppStore.getState()
    if (store.leftPanelVisible !== visible) store.setLeftPanelVisible(visible)
    const width = Math.round(size.inPixels)
    if (!visible || width <= 0 || store.leftPanelWidth === width) return
    store.setLeftPanelWidth(width)
    widthWriter.schedule(width)
  }

  const handleResponseResize = (size: PanelSizeLike): void => {
    const collapsed = responsePanelApiRef.current?.isCollapsed() ?? false
    const store = useAppStore.getState()
    if (store.responseCollapsed !== collapsed) {
      store.setResponseCollapsed(collapsed)
      // 折叠翻转沿：拖拽 snap 折叠时把恢复目标回滚到拖拽前高度
      if (collapsed) notifyResponseCollapsed()
    }
    // 展开态高度持续镜像：按钮折叠与拖拽折叠共用同一恢复记忆
    if (!collapsed) rememberResponseHeight(Math.round(size.inPixels))
  }

  // Ctrl+B 左栏收展已归命令注册表（view.toggleLeftPanel，经统一分发器；
  // 纯 Ctrl 组合的修饰键排除与 isComposing 守卫由分发器承担）

  return (
    <TooltipProvider delay={300}>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground select-none">
        <TitleBar />
        {/* 图标栏常驻：固定 chrome 在分栏结构之外（永不折叠语义） */}
        <div className="flex min-h-0 flex-1">
          <IconRail />
          <PanelGroup orientation="horizontal" id="workbench-horizontal" className="min-w-0 flex-1">
            <Panel
              id="left-panel"
              defaultSize={`${storedLeftPanelWidth ?? DEFAULT_LEFT_PANEL_WIDTH}px`}
              minSize={MIN_LEFT_PANEL_WIDTH}
              maxSize="50%"
              // 窗口最大化 / 全屏时左栏保持像素宽度：库默认 preserve-relative-size
              // 会把挂载时折算出的百分比随组宽度一起放大（左栏越全屏越宽），
              // 像素语义才与宽度持久化、拖拽调整的口径一致
              groupResizeBehavior="preserve-pixel-size"
              collapsible
              collapsedSize={0}
              panelRef={(api) => {
                leftPanelApiRef.current = api
                setLeftPanelApi(api)
              }}
              onResize={handleLeftPanelResize}
            >
              <div className="h-full">
                <LeftPanel />
              </div>
            </Panel>
            <PanelSeparator orientation="vertical" aria-label={t('shell.panelResizeLabel')} />
            <Panel id="main-panel">
              <div className="flex h-full min-h-0 flex-col">
                <TabBar />
                {/* 竖向分栏容器：设置抽屉的 portal 宿主（覆盖参数区与响应区，
                      不遮标签栏；relative 是抽屉 absolute 锚定的必要条件；
                      overflow-clip 纯裁切：hidden 是可滚动容器，程序化滚动
                      （如焦点 scrollIntoView）会把主区内容拉出横向位移，
                      clip 从机制上禁止任何滚动，只裁掉抽屉滑入动画的越界帧） */}
                <div className="relative min-h-0 flex-1 overflow-clip" data-slot="workbench-main">
                  <PanelGroup orientation="vertical" id="workbench-vertical" className="h-full">
                    <Panel id="request-panel" minSize={REQUEST_PANEL_MIN_HEIGHT}>
                      {/* Panel div 是普通 flex item、自身非 flex 容器，子元素上的
                          flex-1 不解析（高度塌成 auto）；h-full 从 Panel 由库确定
                          的主轴尺寸解析，WorkbenchContent 起的 h-full/flex-1
                          高度链由此接通（min-h-0 保证内容不反撑 Panel 分配高度） */}
                      <div className="h-full min-h-0">
                        <WorkbenchContent />
                      </div>
                    </Panel>
                    {/* 响应区只在接口 Tab 激活时存在：工作空间设置页与
                        欢迎屏独占主区，不与响应区混排 */}
                    {showResponsePanel && (
                      <PanelSeparator
                        orientation="horizontal"
                        aria-label={t('shell.responseResizeLabel')}
                      />
                    )}
                    {showResponsePanel && (
                      <Panel
                        id="response-panel"
                        defaultSize={`${RESPONSE_DEFAULT_PERCENT}%`}
                        minSize={RESPONSE_MIN_HEIGHT}
                        collapsible
                        collapsedSize={`${RESPONSE_COLLAPSED_HEIGHT}px`}
                        panelRef={(api) => {
                          responsePanelApiRef.current = api
                          setResponsePanelApi(api)
                        }}
                        onResize={handleResponseResize}
                      >
                        <ResponsePane />
                      </Panel>
                    )}
                  </PanelGroup>
                </div>
              </div>
            </Panel>
          </PanelGroup>
        </div>
        <StatusBar />
        <CommandPaletteDialog />
        <SyncWizard />
        {/* 工作空间域对话框宿主（唯一挂载）：左栏树视图与工作空间详情页
            都只发 store 信号，宿主全局在场——对话框不随左栏视图切换丢失 */}
        <WorkspacesDialogHost />
      </div>
    </TooltipProvider>
  )
}
