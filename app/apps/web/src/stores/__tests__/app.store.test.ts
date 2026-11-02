import { beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_LEFT_PANEL_WIDTH,
  MIN_LEFT_PANEL_WIDTH,
  REQUEST_PANEL_MIN_HEIGHT,
  RESPONSE_COLLAPSED_HEIGHT,
  RESPONSE_MIN_HEIGHT,
  useAppStore,
} from '../app.store'

// 模块级 store 用例间隔离：恢复初始状态
beforeEach(() => {
  useAppStore.setState({
    leftView: 'apis',
    leftPanelVisible: true,
    leftPanelWidth: DEFAULT_LEFT_PANEL_WIDTH,
    responseCollapsed: false,
    settingsOpen: false,
  })
})

describe('app.store（库管几何，store 管语义）', () => {
  it('左栏三视图切换', () => {
    useAppStore.getState().setLeftView('workspaces')
    expect(useAppStore.getState().leftView).toBe('workspaces')
    useAppStore.getState().setLeftView('apis')
    expect(useAppStore.getState().leftView).toBe('apis')
  })

  it('语义开关镜像：可见性与宽度镜像独立 setter（几何事实源在分栏库）', () => {
    useAppStore.getState().setLeftPanelVisible(false)
    expect(useAppStore.getState().leftPanelVisible).toBe(false)
    // 收起不清零宽度：镜像保留，再展开恢复原宽由库负责
    useAppStore.getState().setLeftPanelWidth(340)
    expect(useAppStore.getState().leftPanelWidth).toBe(340)
    useAppStore.getState().setLeftPanelVisible(true)
    expect(useAppStore.getState().leftPanelVisible).toBe(true)
  })

  it('响应区折叠态镜像', () => {
    useAppStore.getState().setResponseCollapsed(true)
    expect(useAppStore.getState().responseCollapsed).toBe(true)
    useAppStore.getState().setResponseCollapsed(false)
    expect(useAppStore.getState().responseCollapsed).toBe(false)
  })

  it('常量基线：左栏阈值 50px、默认 288px；请求 / 响应尺寸契约', () => {
    expect(MIN_LEFT_PANEL_WIDTH).toBe(50)
    expect(DEFAULT_LEFT_PANEL_WIDTH).toBe(288)
    expect(REQUEST_PANEL_MIN_HEIGHT).toBe(80)
    // 库的拖拽折叠契约：collapsedSize < minSize（折叠带＝两者之间）
    expect(RESPONSE_MIN_HEIGHT).toBe(64)
    expect(RESPONSE_COLLAPSED_HEIGHT).toBe(36)
  })

  it('设置面板开关', () => {
    useAppStore.getState().setSettingsOpen(true)
    expect(useAppStore.getState().settingsOpen).toBe(true)
  })
})
