import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ResizeObserverMock } from '@/test/setup'
import { createQueryWrapper } from '@/test/render-providers'

import type { TreeDto } from '@/services/workbench-api'
import { useAppStore } from '@/stores/app.store'

import { ApiTreePanel } from '../api-tree-panel'
import { useTreeExpandedStore } from '../tree-state.store'
import { locateInApiTree } from '../tree-locate'

// —— panel-bridge 替换：定位的「左栏展开」通道观察 ——
const expandLeftPanelMock = vi.hoisted(() => vi.fn())
vi.mock('@/components/layout/panel-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/layout/panel-bridge')>()),
  expandLeftPanel: expandLeftPanelMock,
}))

// —— IPC invoke 替换 ——
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const TREE: TreeDto = {
  workspaceId: 'w1',
  services: [
    {
      id: 's1',
      name: '用户服务',
      docUrl: null,
      docType: 'openapi',
      sortOrder: 0,
      categories: [{ id: 'c1', name: '账号管理', sortOrder: 0 }],
      endpoints: [
        {
          serviceId: 's1',
          key: 'e1',
          title: '登录',
          categoryId: 'c1',
          definition: { method: 'POST', pathTemplate: '/auth/login' },
          isManual: false,
          pinned: false,
        },
      ],
    },
  ],
}

/** 渲染树面板并驱动虚拟化视口（jsdom 无布局） */
async function renderPanel() {
  const view = render(<ApiTreePanel searchQuery="" onSearchChange={() => {}} />, {
    wrapper: createQueryWrapper(),
  })
  await screen.findByRole('tree', { name: '接口树' })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const scrollEl = view.container.querySelector<HTMLElement>('[data-slot="tree-scroll"]')
  if (scrollEl) {
    Object.defineProperty(scrollEl, 'offsetHeight', { configurable: true, value: 300 })
  }
  act(() => {
    for (const observer of ResizeObserverMock.instances) {
      observer.callback([] as ResizeObserverEntry[], observer as unknown as ResizeObserver)
    }
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  return view
}

beforeEach(() => {
  vi.clearAllMocks()
  useTreeExpandedStore.getState().clear()
  useAppStore.setState({ leftView: 'apis' })
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === 'workspace.list') {
      return Promise.resolve({
        items: [{ id: 'w1', name: '默认工作空间', baseUrl: null, isCurrent: true }],
        currentId: 'w1',
      })
    }
    if (cmd === 'tree.get') return Promise.resolve(TREE)
    return Promise.resolve(undefined)
  })
})

describe('树定位接缝', () => {
  it('定位接口节点：请求左栏展开 + 选中行 + 展开祖先链', async () => {
    await renderPanel()
    // 深缩进的接口行：祖先（服务、分类）未展开时定位必须带出全链
    act(() => {
      locateInApiTree('endpoint:s1:e1')
    })
    expect(expandLeftPanelMock).toHaveBeenCalledTimes(1)
    const state = useTreeExpandedStore.getState()
    expect(state.activeNodeId).toBe('endpoint:s1:e1')
    expect(state.expandedIds).toContain('service:s1')
    expect(state.expandedIds).toContain('category:c1')
  })

  it('定位服务节点：只选中不额外展开祖先', async () => {
    await renderPanel()
    act(() => {
      locateInApiTree('service:s1')
    })
    const state = useTreeExpandedStore.getState()
    expect(state.activeNodeId).toBe('service:s1')
    expect(state.expandedIds).not.toContain('service:s1')
  })

  it('树中不存在的节点（已删 / 数据未到）静默忽略', async () => {
    await renderPanel()
    act(() => {
      locateInApiTree('endpoint:gone:missing')
    })
    expect(useTreeExpandedStore.getState().activeNodeId).toBeNull()
  })

  it('树未挂载（左栏在别的视图）：前置自保证切回视图，请求挂起、随挂载即刻消费', async () => {
    // 模拟左栏停在别的视图（ApiTreePanel 未挂载、处理器未注册）
    act(() => {
      useAppStore.setState({ leftView: 'workspaces' })
    })
    act(() => {
      locateInApiTree('service:s1')
    })
    // 前置自保证：视图切回接口树；树未挂载先不定位
    expect(useAppStore.getState().leftView).toBe('apis')
    expect(useTreeExpandedStore.getState().activeNodeId).toBeNull()
    // 视图切换后的真实时序＝面板挂载登记处理器：挂起请求即刻消费
    await renderPanel()
    expect(useTreeExpandedStore.getState().activeNodeId).toBe('service:s1')
  })

  it('面板卸载后定位请求不炸：前置照常执行，挂起请求随后续挂载消费', async () => {
    const view = await renderPanel()
    view.unmount()
    act(() => {
      useAppStore.setState({ leftView: 'variables' })
      locateInApiTree('service:s1')
    })
    expect(useAppStore.getState().leftView).toBe('apis')
    expect(useTreeExpandedStore.getState().activeNodeId).toBeNull()
    await renderPanel()
    expect(useTreeExpandedStore.getState().activeNodeId).toBe('service:s1')
  })

  it('重复定位同一节点：代次推进重放滚动（revealId 值不变也要滚）', async () => {
    const view = await renderPanel()
    const scrollEl = view.container.querySelector<HTMLElement>('[data-slot="tree-scroll"]')!
    scrollEl.scrollTo = vi.fn()
    act(() => {
      locateInApiTree('service:s1')
    })
    expect(useTreeExpandedStore.getState().activeNodeId).toBe('service:s1')
    // jsdom 无布局（clientHeight=0）：行必判定为视口外，定位必触发滚动
    expect(scrollEl.scrollTo).toHaveBeenCalledTimes(1)
    act(() => {
      locateInApiTree('service:s1')
    })
    expect(scrollEl.scrollTo).toHaveBeenCalledTimes(2)
  })
})
