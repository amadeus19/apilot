import { create } from 'zustand'

/**
 * App Shell UI 状态——左栏视图、面板语义开关与宽度镜像、临时主题内存态。
 * 仅短生命周期 UI 状态；持久偏好（theme/locale 等）归 settings.store。
 *
 * 分栏模型（ADR-0005「库管几何，store 管语义」）：面板尺寸的运行时事实源
 * 在 react-resizable-panels（非受控 + imperative api），本 store 只持语义
 * 开关（收起/展开）与宽度镜像（持久化与消费方读取用）；外部动作经
 * panel-bridge 向库下发分步 resize 动画，几何变化经 onResize 上提镜像。
 * 图标栏常驻永不折叠；可收展的只有面板区域。
 */

/** 左栏视图：接口树 / 请求历史 / 变量树 / 工作空间清单 / 工作流清单 */
export type LeftPanelView = 'apis' | 'history' | 'variables' | 'workspaces' | 'workflows'

/** 左栏面板可展开的最小宽度（px）：拖到此宽度以下库自动收起（单一阈值） */
export const MIN_LEFT_PANEL_WIDTH = 50
/** 默认宽度（px）：未持久化定制时首启动的 defaultSize */
export const DEFAULT_LEFT_PANEL_WIDTH = 288
/** 主区垂直分栏：请求编辑区最小保底高度（px，防被响应区拖没） */
export const REQUEST_PANEL_MIN_HEIGHT = 80
/** 响应区折叠态条带高度（px，即状态行） */
export const RESPONSE_COLLAPSED_HEIGHT = 36
/** 响应区默认占比（请求 55 / 响应 45；会话态不持久化） */
export const RESPONSE_DEFAULT_PERCENT = 45
/**
 * 响应区可展开的最小高度（px）：拖到折叠带以下库自动折叠为条带。
 * 须大于折叠条带高度——库的拖拽折叠契约是 collapsedSize < minSize
 * （折叠带＝(collapsedSize, minSize) 区间，拖动越过带内阈值即 snap 折叠）。
 */
export const RESPONSE_MIN_HEIGHT = 64

interface AppShellState {
  leftView: LeftPanelView
  /** 左栏面板可见性（语义开关）：由库 onResize 上提镜像，控制类动作走 panel-bridge */
  leftPanelVisible: boolean
  /** 左栏宽度镜像（px，仅展开态更新）：持久化写入与测试观察用 */
  leftPanelWidth: number
  /** 响应区折叠态镜像：折叠＝仅剩状态行条带 */
  responseCollapsed: boolean
  /** 设置面板开关：标题栏设置按钮 / Ctrl+, 打开 */
  settingsOpen: boolean
  /** 打开设置时的初始定位组（合法组 id 由 SettingsDialog 校验；null＝默认外观组） */
  settingsInitialNav: string | null
  /** 左栏搜索聚焦信号（Ctrl+K 命令 → LeftPanel 订阅聚焦；nonce 防同值不重放） */
  searchFocusNonce: number

  setLeftView: (view: LeftPanelView) => void
  setLeftPanelVisible: (visible: boolean) => void
  setLeftPanelWidth: (width: number) => void
  setResponseCollapsed: (collapsed: boolean) => void
  setSettingsOpen: (open: boolean, initialNav?: string) => void
  focusSearch: () => void
}

export const useAppStore = create<AppShellState>((set) => ({
  leftView: 'apis',
  leftPanelVisible: true,
  leftPanelWidth: DEFAULT_LEFT_PANEL_WIDTH,
  responseCollapsed: false,
  settingsOpen: false,
  settingsInitialNav: null,
  searchFocusNonce: 0,

  setLeftView: (view) => set({ leftView: view }),
  setLeftPanelVisible: (visible) => set({ leftPanelVisible: visible }),
  setLeftPanelWidth: (width) => set({ leftPanelWidth: width }),
  setResponseCollapsed: (collapsed) => set({ responseCollapsed: collapsed }),
  // initialNav 仅在打开时生效（如超时卡链接设置 HTTP 组）；关闭恒清空
  setSettingsOpen: (open, initialNav) =>
    set({ settingsOpen: open, settingsInitialNav: open ? (initialNav ?? null) : null }),
  focusSearch: () => set((state) => ({ searchFocusNonce: state.searchFocusNonce + 1 })),
}))
