import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 分栏库与 imperative 桥都换替身：本文件只验布局组装与入口接线，
// 几何/镜像/持久化细节在 LeftPanel.test.tsx（接线测试）覆盖
vi.mock('react-resizable-panels', async () => await import('@/test/panels-double'))
vi.mock('../layout/panel-bridge', () => ({
  setLeftPanelApi: vi.fn(),
  setResponsePanelApi: vi.fn(),
  setPanelGroupElement: vi.fn(),
  toggleLeftPanelGeometry: vi.fn(),
  expandLeftPanel: vi.fn(),
  expandResponsePanel: vi.fn(),
  collapseResponsePanel: vi.fn(),
  rememberResponseHeight: vi.fn(),
  notifyResponseCollapsed: vi.fn(),
  initResponseRestoreMemory: vi.fn(() => () => {}),
}))
// 会话恢复挂载即整体替换 tabs（无工作空间数据时清空）：把手形态测试需要预置
// 接口 Tab 挂载响应区，替身置为 no-op 让预置态存活
vi.mock('@/features/workbench/session-persistence', () => ({
  useWorkspaceSession: () => undefined,
}))

import { toggleLeftPanelGeometry } from '../layout/panel-bridge'
import { AppShell } from '../layout/AppShell'
import { resetPanelsDouble } from '@/test/panels-double'
import { createQueryWrapper } from '@/test/render-providers'
import { DEFAULT_LEFT_PANEL_WIDTH, useAppStore } from '@/stores/app.store'
import { useSettingsStore } from '@/stores/settings.store'
import { useTabsStore } from '@/stores/tabs.store'

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    onResized: vi.fn().mockResolvedValue(() => {}),
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn().mockResolvedValue('0.1.0'),
}))

beforeEach(() => {
  vi.clearAllMocks()
  resetPanelsDouble()
  useTabsStore.setState({ tabs: [], activeTabId: null })
  useAppStore.setState({
    leftView: 'apis',
    leftPanelVisible: true,
    leftPanelWidth: DEFAULT_LEFT_PANEL_WIDTH,
    responseCollapsed: false,
    settingsOpen: false,
  })
  useSettingsStore.getState().hydrateFromBoot(null, null)
  document.documentElement.className = ''
})

describe('AppShell 布局', () => {
  it('五大区域齐备：标题栏 / 图标栏 / 左栏 / 标签栏 / 状态栏（响应区随接口 Tab 挂载）', () => {
    render(<AppShell />, { wrapper: createQueryWrapper() })
    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: '左栏视图' })).toBeInTheDocument()
    expect(screen.getByRole('tablist', { name: '标签栏' })).toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).toBeInTheDocument()
    // 接口树视图体在场（空树 / 加载态都渲染树容器）
    expect(screen.getByTestId('api-tree-body')).toBeInTheDocument()
    // 无 Tab＝欢迎屏独占主区，响应区不渲染（不与工作空间设置页 / 欢迎屏混排）
    expect(screen.queryByText('响应内容将在后续版本提供')).not.toBeInTheDocument()
  })

  it('请求面板高度链：内容宿主与 Panel 内包裹层都持 h-full（Panel div 非 flex 容器）', () => {
    // 预置接口 Tab 挂载 EndpointEditor，检视从请求 Panel 到编辑器根的完整链
    useTabsStore.setState({
      tabs: [
        {
          id: 'endpoint:s1:k1',
          kind: 'endpoint',
          title: '接口',
          serviceId: 's1',
          key: 'k1',
          preview: false,
        },
      ],
      activeTabId: 'endpoint:s1:k1',
    })
    render(<AppShell />, { wrapper: createQueryWrapper() })
    // 链路＝Panel div（库定主轴尺寸）→ 包裹层 → tab-content → 编辑器根，
    // 中间两层 h-full 缺一即高度塌成 auto（Panel div 是普通 flex item，
    // 子元素上的 flex-1 不解析）
    const editorRoot = screen.getByTestId('endpoint-editor')
    expect(editorRoot).toHaveClass('h-full')
    expect(editorRoot.parentElement).toHaveClass('h-full')
    const panelWrapper = editorRoot.parentElement?.parentElement
    expect(panelWrapper).toHaveClass('h-full')
    // 包裹层确实是请求 Panel 的直接子级（高度解析基准为 Panel div）
    expect(panelWrapper?.parentElement).toHaveAttribute('data-testid', 'panel-request-panel')
  })

  it('标题栏应用图标点击：经 imperative 桥下发（不改 store 几何）', async () => {
    const user = userEvent.setup()
    render(<AppShell />, { wrapper: createQueryWrapper() })
    await user.click(screen.getByRole('button', { name: '收展左栏面板' }))
    expect(toggleLeftPanelGeometry).toHaveBeenCalledOnce()
  })

  it('Ctrl+B 键盘通道同样经 imperative 桥下发', () => {
    render(<AppShell />, { wrapper: createQueryWrapper() })
    window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, key: 'b' }))
    expect(toggleLeftPanelGeometry).toHaveBeenCalledOnce()
  })

  it('Ctrl+B 须为纯 Ctrl 组合：Shift/Alt 修饰的组合键不吞（Ctrl+Shift+B 等）', () => {
    render(<AppShell />, { wrapper: createQueryWrapper() })
    window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, key: 'b' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, altKey: true, key: 'b' }))
    expect(toggleLeftPanelGeometry).not.toHaveBeenCalled()
  })
})

describe('分栏把手形态（两处统一实现）', () => {
  it('左右分栏：命中区零占位＋居中竖直短把手，悬浮/拖拽转主题色', () => {
    render(<AppShell />, { wrapper: createQueryWrapper() })
    const hit = screen.getByRole('separator', { name: '调整左栏宽度' })
    // 命中区：状态机 group 挂点＋inset 焦点环；无宽高类（布局零占位，命中带宽
    // 由库的命中扩展托底，不随可见形态收窄）
    expect(hit.className).toContain('group/sep')
    expect(hit.className).toContain('focus-visible:ring-inset')
    // 可见把手：绝对居中、竖直短线（h-6 w-0.5）、事件穿透归命中区
    const grip = hit.querySelector('[data-slot="panel-grip"]')
    expect(grip).toHaveAttribute('data-orientation', 'vertical')
    expect(grip?.className).toContain('absolute')
    expect(grip?.className).toContain('pointer-events-none')
    expect(grip?.className).toContain('h-6 w-0.5')
    // 常态淡显：把手与相邻 1px 结构线同色（bg-border），深色只在交互态出现
    expect(grip?.className).toContain('bg-border')
    expect(grip?.className).toContain('group-data-[separator=hover]/sep:bg-primary')
    expect(grip?.className).toContain('group-data-[separator=active]/sep:bg-primary')
  })

  it('上下分栏：同一把手形态，仅线走向随分隔线走向翻转（横向短线）', () => {
    useTabsStore.setState({
      tabs: [
        {
          id: 'endpoint:s1:k1',
          kind: 'endpoint',
          title: '接口',
          serviceId: 's1',
          key: 'k1',
          preview: false,
        },
      ],
      activeTabId: 'endpoint:s1:k1',
    })
    render(<AppShell />, { wrapper: createQueryWrapper() })
    const horizontalHit = screen.getByRole('separator', { name: '调整响应区高度' })
    const grip = horizontalHit.querySelector('[data-slot="panel-grip"]')
    expect(grip).toHaveAttribute('data-orientation', 'horizontal')
    expect(grip?.className).toContain('h-0.5 w-6')
    // 单一实现源：两处命中区形态类完全一致
    expect(horizontalHit.className).toBe(
      screen.getByRole('separator', { name: '调整左栏宽度' }).className,
    )
  })
})
