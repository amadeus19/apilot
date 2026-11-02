import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ResizeObserverMock } from '@/test/setup'
import { createQueryWrapper } from '@/test/render-providers'

import type { TreeDto } from '@/services/workbench-api'
import { useSyncWizardStore } from '@/stores/sync.store'
import { useTabsStore } from '@/stores/tabs.store'
import { useTreeExpandedStore } from '../tree-state.store'

import { ApiTreePanel } from '../api-tree-panel'

// —— IPC invoke 替换：按命令名分派 ——
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

function makeTree(extraServices: TreeDto['services'] = []): TreeDto {
  return {
    workspaceId: 'w1',
    services: [
      {
        id: 's1',
        name: '用户服务',
        docUrl: 'https://docs.example.com/openapi.json',
        docType: 'openapi',
        sortOrder: 0,
        categories: [{ id: 'c1', name: '账号管理', sortOrder: 1 }],
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
          {
            serviceId: 's1',
            key: 'e2',
            title: '健康检查',
            categoryId: null,
            definition: { method: 'GET', pathTemplate: '/health' },
            isManual: true,
            pinned: true,
          },
        ],
      },
      ...extraServices,
    ],
  }
}

/** 渲染树面板并模拟虚拟化视口（jsdom 无布局：offsetHeight + 手动触发 ResizeObserver） */
async function renderPanel(searchQuery = '', treeData?: TreeDto) {
  if (treeData) {
    stubTree['tree.get'] = treeData
  }
  const view = render(<ApiTreePanel searchQuery={searchQuery} onSearchChange={() => {}} />, {
    wrapper: createQueryWrapper(),
  })
  // 等树 query 解析进索引（数据驱动的重建完成）
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

const stubTree = { 'tree.get': makeTree() }

beforeEach(() => {
  vi.clearAllMocks()
  stubTree['tree.get'] = makeTree()
  useTabsStore.setState({ tabs: [], activeTabId: null })
  // 预设展开（模拟会话恢复后的树：服务与置顶组展开）
  useTreeExpandedStore.getState().restore(['service:s1', 'category:c1', 'pinned'])
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === 'workspace.list') {
      return Promise.resolve({
        items: [{ id: 'w1', name: '默认工作空间', baseUrl: null, isCurrent: true }],
        currentId: 'w1',
      })
    }
    if (cmd === 'tree.get') return Promise.resolve(stubTree['tree.get'])
    // 引用反查（删除接口确认框）：空结果＝无引用（不呈现清单）
    if (cmd === 'workflow.endpoint_usage') return Promise.resolve({})
    return Promise.resolve(undefined)
  })
})

describe('接口树行渲染', () => {
  it('方法徽章 + 手工 Pen 标识 + 服务行文档标识按语义渲染', async () => {
    await renderPanel()
    expect(await screen.findByRole('tree', { name: '接口树' })).toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: '用户服务' })).toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: '登录' })).toBeInTheDocument()
    // 置顶接口提升到顶层置顶组
    expect(screen.getByRole('treeitem', { name: '置顶' })).toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: '健康检查' })).toBeInTheDocument()
    // 手工标识（笔）只在服务内来源混存时呈现；同步接口行不呈现
    const manualRow = screen.getByRole('treeitem', { name: '健康检查' })
    expect(manualRow.querySelector('svg.lucide-square-pen')).not.toBeNull()
    expect(
      screen.getByRole('treeitem', { name: '登录' }).querySelector('svg.lucide-square-pen'),
    ).toBeNull()
    // 有文档地址服务行带 BookOpen
    expect(
      screen.getByRole('treeitem', { name: '用户服务' }).querySelector('svg.lucide-book-open'),
    ).not.toBeNull()
    // 容器行类型图标：服务＝Server、分类展开态＝FolderOpen、置顶组＝Pin
    expect(
      screen.getByRole('treeitem', { name: '用户服务' }).querySelector('svg.lucide-server'),
    ).not.toBeNull()
    expect(
      screen.getByRole('treeitem', { name: '账号管理' }).querySelector('svg.lucide-folder-open'),
    ).not.toBeNull()
    expect(
      screen.getByRole('treeitem', { name: '置顶' }).querySelector('svg.lucide-pin'),
    ).not.toBeNull()
    // 方法徽章文案
    expect(screen.getByText('POST')).toBeInTheDocument()
    expect(screen.getByText('GET')).toBeInTheDocument()
    // 底部计数行
    expect(screen.getByTestId('api-tree-counts')).toHaveTextContent('1 个服务 · 2 个接口')
  })

  it('缩进参考线随层级生成；来源不混存的服务不给接口挂手工标识', async () => {
    // 展开新增服务，使其接口进入可见子图
    useTreeExpandedStore.getState().restore(['service:s1', 'category:c1', 'pinned', 'service:s2'])
    await renderPanel(
      '',
      makeTree([
        {
          id: 's2',
          name: '全手工服务',
          docUrl: null,
          docType: 'openapi',
          sortOrder: 1,
          categories: [],
          endpoints: [
            {
              serviceId: 's2',
              key: 'm1',
              title: '手工接口',
              categoryId: null,
              definition: { method: 'GET', pathTemplate: '/manual' },
              isManual: true,
              pinned: false,
            },
          ],
        },
      ]),
    )
    // 全手工服务里该标识恒真、不承载信息，故不呈现
    expect(
      screen.getByRole('treeitem', { name: '手工接口' }).querySelector('svg.lucide-square-pen'),
    ).toBeNull()
    // 缩进参考线＝层级数：顶层服务 0 条、分类内接口 2 条
    expect(
      screen
        .getByRole('treeitem', { name: '用户服务' })
        .querySelectorAll('[data-slot="tree-indent-guide"]'),
    ).toHaveLength(0)
    expect(
      screen
        .getByRole('treeitem', { name: '登录' })
        .querySelectorAll('[data-slot="tree-indent-guide"]'),
    ).toHaveLength(2)
  })
})

describe('打开语义（单击预览 / 双击与 Enter 常驻）', () => {
  it('单击接口行＝预览打开；双击同一行＝原地转正', async () => {
    const user = userEvent.setup()
    await renderPanel()
    const row = await screen.findByRole('treeitem', { name: '登录' })
    await user.click(row)
    expect(useTabsStore.getState().tabs).toHaveLength(1)
    expect(useTabsStore.getState().tabs[0]).toMatchObject({ preview: true })
    await user.dblClick(row)
    expect(useTabsStore.getState().tabs).toHaveLength(1)
    expect(useTabsStore.getState().tabs[0]).toMatchObject({ preview: false })
  })
})

describe('三通道菜单与 IPC 接线', () => {
  it('右键接口行开菜单（打开 / 重命名 / 置顶 / 删除），删除确认后调 endpoint.delete', async () => {
    const user = userEvent.setup()
    await renderPanel()
    const row = await screen.findByRole('treeitem', { name: '健康检查' })
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))

    const menu = await screen.findByRole('menu')
    expect(menu).toHaveTextContent('打开')
    expect(menu).toHaveTextContent('取消置顶')
    await user.click(screen.getByRole('menuitem', { name: '删除' }))
    // 确认弹窗明示连带用户数据
    expect(
      await screen.findByText(/其用户数据（请求体、参数、请求头）与置顶状态一并清除/),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '删除' }))
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('endpoint.delete', { serviceId: 's1', key: 'e2' })
    })
  })

  it('删除被工作流引用的接口：确认框列出引用清单，提示不阻断确认', async () => {
    const user = userEvent.setup()
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'workspace.list') {
        return Promise.resolve({
          items: [{ id: 'w1', name: '默认工作空间', baseUrl: null, isCurrent: true }],
          currentId: 'w1',
        })
      }
      if (cmd === 'tree.get') return Promise.resolve(stubTree['tree.get'])
      // 引用反查命中：登录链引用了待删接口
      if (cmd === 'workflow.endpoint_usage') {
        return Promise.resolve({
          e2: [{ workflowId: 'wf1', workflowName: '登录链' }],
        })
      }
      return Promise.resolve(undefined)
    })
    await renderPanel()
    const row = await screen.findByRole('treeitem', { name: '健康检查' })
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await user.click(await screen.findByRole('menuitem', { name: '删除' }))
    const usage = await screen.findByTestId('delete-endpoint-usage')
    expect(usage).toHaveTextContent('被 1 个工作流引用')
    expect(usage).toHaveTextContent('登录链')
    // 提示不阻断：确认钮照常可用，确认后照删
    await user.click(screen.getByRole('button', { name: '删除' }))
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('endpoint.delete', { serviceId: 's1', key: 'e2' })
    })
  })

  it('同步接口行的重命名入口不出现（仅手工可重命名）；菜单打开走常驻', async () => {
    const user = userEvent.setup()
    await renderPanel()
    const row = await screen.findByRole('treeitem', { name: '登录' })
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    const menu = await screen.findByRole('menu')
    expect(menu).not.toHaveTextContent('重命名')
    await user.click(screen.getByRole('menuitem', { name: '打开' }))
    expect(useTabsStore.getState().tabs[0]).toMatchObject({ preview: false })
  })

  it('服务行菜单：新建分类 / 上移 / 级联删除确认走对应 IPC', async () => {
    const user = userEvent.setup()
    await renderPanel()
    const row = await screen.findByRole('treeitem', { name: '用户服务' })
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await screen.findByRole('menu')
    await user.click(screen.getByRole('menuitem', { name: '上移' }))
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('service.move', { id: 's1', direction: 'up' })
    })

    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await screen.findByRole('menu')
    await user.click(screen.getByRole('menuitem', { name: '新建分类' }))
    await user.type(await screen.findByLabelText('分类名称'), '新分类')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('category.create', {
        serviceId: 's1',
        name: '新分类',
      })
    })
  })

  it('服务行菜单「同步此服务」＝向导打开并预勾选；无文档地址服务置灰＋徽标说明', async () => {
    const user = userEvent.setup()
    useSyncWizardStore.setState({ open: false, selectedServiceIds: [] })
    await renderPanel(
      '',
      makeTree([
        {
          id: 's2',
          name: '无文档服务',
          docUrl: null,
          docType: '',
          sortOrder: 1,
          categories: [],
          endpoints: [],
        },
      ]),
    )
    const row = await screen.findByRole('treeitem', { name: '用户服务' })
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    const item = await screen.findByRole('menuitem', { name: '同步此服务' })
    expect(item).not.toHaveAttribute('data-disabled')
    await user.click(item)
    // 单服务直达＝向导打开、保留选择段、预勾选该服务
    expect(useSyncWizardStore.getState().open).toBe(true)
    expect(useSyncWizardStore.getState().phase).toBe('select')
    expect(useSyncWizardStore.getState().selectedServiceIds).toEqual(['s1'])

    // 无文档地址服务不可参与同步：菜单项置灰＋行尾「无文档地址」徽标
    // 说明原因（徽标入可访问名，菜单项匹配用子串）
    const row2 = screen.getByRole('treeitem', { name: '无文档服务' })
    row2.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    const item2 = await screen.findByRole('menuitem', { name: /同步此服务/ })
    expect(item2).toHaveAttribute('data-disabled')
    expect(within(item2).getByText('无文档地址')).toBeInTheDocument()
    await user.click(item2)
    expect(useSyncWizardStore.getState().selectedServiceIds).toEqual(['s1'])
  })

  it('空白区右键＝根上下文：仅「新建服务」，提交走 service.create', async () => {
    const user = userEvent.setup()
    await renderPanel()
    const body = screen.getByTestId('api-tree-body')
    body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    const menu = await screen.findByRole('menu')
    // 根级唯一可建节点是服务（分类 / 接口必须挂具体父级）
    expect(menu).toHaveTextContent('新建服务')
    expect(menu).not.toHaveTextContent('新建接口')
    expect(menu).not.toHaveTextContent('新建分类')
    await user.click(screen.getByRole('menuitem', { name: '新建服务' }))
    await user.type(await screen.findByLabelText('服务名称'), '第二个服务')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('service.create', {
        workspaceId: 'w1',
        name: '第二个服务',
        docUrl: null,
      })
    })
  })

  it('行内右键冒泡到容器不触发空白菜单（treeitem 判定放行行菜单）', async () => {
    await renderPanel()
    const row = await screen.findByRole('treeitem', { name: '健康检查' })
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    const menu = await screen.findByRole('menu')
    // 行菜单照常（非空白菜单的「新建服务」单项形态）
    expect(menu).toHaveTextContent('打开')
  })

  it('计数行「刷新全部可达性」＝invoke probe.refresh_all', async () => {
    await renderPanel()
    fireEvent.click(await screen.findByTestId('api-tree-probe-refresh-all'))
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('probe.refresh_all')
    })
  })

  it('键盘三通道等价：Shift+F10 对焦点行开菜单', async () => {
    const user = userEvent.setup()
    await renderPanel()
    const row = await screen.findByRole('treeitem', { name: '健康检查' })
    await user.click(row)
    const tree = screen.getByRole('tree')
    tree.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'F10',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(await screen.findByRole('menu')).toBeInTheDocument()
  })

  it('F2 对选中手工接口打开重命名对话框并提交 endpoint.update_manual', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'workspace.list') {
        return Promise.resolve({
          items: [{ id: 'w1', name: '默认工作空间', baseUrl: null, isCurrent: true }],
          currentId: 'w1',
        })
      }
      if (cmd === 'tree.get') return Promise.resolve(stubTree['tree.get'])
      if (cmd === 'endpoint.update_manual') {
        return Promise.resolve({
          serviceId: 's1',
          key: 'e2',
          title: '存活探测',
          categoryId: null,
          definition: { method: 'GET', pathTemplate: '/health' },
          isManual: true,
        })
      }
      return Promise.resolve(undefined)
    })
    const user = userEvent.setup()
    await renderPanel()
    const row = await screen.findByRole('treeitem', { name: '健康检查' })
    await user.click(row)
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }),
      )
    })
    const input = await screen.findByLabelText('接口标题')
    await user.clear(input)
    await user.type(input, '存活探测')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('endpoint.update_manual', {
        args: expect.objectContaining({ serviceId: 's1', key: 'e2', title: '存活探测' }),
      })
    })
  })

  it('F2 的 isComposing 守卫：输入法合成期间不触发对话框', async () => {
    const user = userEvent.setup()
    await renderPanel()
    const row = await screen.findByRole('treeitem', { name: '健康检查' })
    await user.click(row)
    const event = new KeyboardEvent('keydown', {
      key: 'F2',
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(event, 'isComposing', { value: true })
    act(() => {
      document.activeElement?.dispatchEvent(event)
    })
    expect(screen.queryByLabelText('接口标题')).not.toBeInTheDocument()
  })
})

describe('搜索过滤与展开快照', () => {
  it('过滤模式：命中行与祖先可见，未命中服务整体剔除', async () => {
    const twoServices = makeTree([
      {
        id: 's2',
        name: '订单服务',
        docUrl: null,
        docType: 'openapi',
        sortOrder: 1,
        categories: [],
        endpoints: [
          {
            serviceId: 's2',
            key: 'e3',
            title: '下单',
            categoryId: null,
            definition: { method: 'POST', pathTemplate: '/orders' },
            isManual: false,
            pinned: false,
          },
        ],
      },
    ])
    const view = await renderPanel('健康', twoServices)
    // 健康检查是置顶接口：可见父链＝置顶组（服务行不可见）
    expect(await screen.findByRole('treeitem', { name: '健康检查' })).toBeInTheDocument()
    expect(screen.queryByRole('treeitem', { name: '置顶' })).toBeInTheDocument()
    expect(screen.queryByRole('treeitem', { name: '用户服务' })).not.toBeInTheDocument()
    expect(screen.queryByRole('treeitem', { name: '订单服务' })).not.toBeInTheDocument()
    // 换搜索词：同一渲染器换受控查询
    await act(async () => {
      view.rerender(<ApiTreePanel searchQuery="下单" onSearchChange={() => {}} />)
    })
    await act(async () => {
      for (const observer of ResizeObserverMock.instances) {
        observer.callback([] as ResizeObserverEntry[], observer as unknown as ResizeObserver)
      }
    })
    expect(await screen.findByRole('treeitem', { name: '下单' })).toBeInTheDocument()
    expect(screen.queryByRole('treeitem', { name: '健康检查' })).not.toBeInTheDocument()
  })

  it('清除搜索恢复进入过滤前的展开快照', async () => {
    useTreeExpandedStore.getState().setExpanded(['service:s1', 'category:c1'])
    const view = await renderPanel('健康')
    // 进入过滤：命中祖先自动展开（含快照之外的服务行）
    await screen.findByRole('treeitem', { name: '健康检查' })
    expect(useTreeExpandedStore.getState().expandedIds).toContain('service:s1')
    // 清除搜索：恢复快照原值
    await act(async () => {
      view.rerender(<ApiTreePanel searchQuery="" onSearchChange={() => {}} />)
    })
    await screen.findByRole('treeitem', { name: '登录' })
    expect(useTreeExpandedStore.getState().expandedIds).toEqual(['service:s1', 'category:c1'])
  })
})

describe('切 Tab 跟随定位', () => {
  it('激活接口行时并入其祖先链（分类+服务），已有展开项保留', async () => {
    await renderPanel()
    // 模拟 AppShell 写入：接口 Tab 激活 → activeNodeId 置同构树行 id
    act(() => {
      useTreeExpandedStore.getState().setExpanded(['pinned'])
      useTreeExpandedStore.getState().setActiveNode('endpoint:s1:e1')
    })
    const expanded = useTreeExpandedStore.getState().expandedIds
    expect(expanded).toContain('category:c1')
    expect(expanded).toContain('service:s1')
    expect(expanded).toContain('pinned')
  })

  it('新建接口信号到达即开对话框并清信号（Ctrl+T 等外部入口的消费回归）', async () => {
    await renderPanel()
    act(() => {
      useTreeExpandedStore.getState().requestNewEndpoint('s1')
    })
    // 信号只消费一次：对话框开且信号即清（重放不叠加）
    expect(await screen.findByRole('dialog', { name: '新建接口' })).toBeInTheDocument()
    expect(useTreeExpandedStore.getState().newEndpointRequest).toBeNull()
  })

  it('激活行清空（非接口 Tab）不触发展开动作', async () => {
    await renderPanel()
    act(() => {
      useTreeExpandedStore.getState().setExpanded([])
      useTreeExpandedStore.getState().setActiveNode(null)
    })
    expect(useTreeExpandedStore.getState().expandedIds).toEqual([])
  })
})

describe('空态分支', () => {
  it('无服务：空态附「新建服务」动作，提交后调 service.create', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'workspace.list') {
        return Promise.resolve({
          items: [{ id: 'w1', name: '默认工作空间', baseUrl: null, isCurrent: true }],
          currentId: 'w1',
        })
      }
      if (cmd === 'tree.get') return Promise.resolve({ workspaceId: 'w1', services: [] })
      return Promise.resolve(undefined)
    })
    const user = userEvent.setup()
    await renderPanel()
    expect(await screen.findByText('尚无服务')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '新建服务' }))
    await user.type(await screen.findByLabelText('服务名称'), '新服务')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('service.create', {
        workspaceId: 'w1',
        name: '新服务',
        docUrl: null,
      })
    })
  })
})
