import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'

import { ResizeObserverMock } from '@/test/setup'
import { createQueryWrapper } from '@/test/render-providers'
import { useTabsStore } from '@/stores/tabs.store'
import { useVariableStore } from '@/stores/variable.store'

import { VariablesView } from '../variables-view'

// —— IPC invoke 替换：分类 / 变量清单走桩存储，激活 / 改名 / 删除更新桩 ——
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

interface StubCategory {
  id: string
  name: string
  isGlobal: boolean
  sortOrder: number
}

let stubCategories: StubCategory[]
let stubActiveId: string | null
let stubVariables: Record<string, { key: string; value: string; secret: boolean }[]>

function categoriesView() {
  return {
    items: stubCategories.map((c) => ({ ...c })),
    activeCategoryId: stubActiveId,
  }
}

function stubInvokes() {
  invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'workspace.list') {
      return Promise.resolve({
        items: [{ id: 'w1', name: '空间一', baseUrl: null, auth: null, isCurrent: true }],
        currentId: 'w1',
      })
    }
    if (cmd === 'variable.list_categories') return Promise.resolve(categoriesView())
    if (cmd === 'variable.list_variables') {
      const categoryId = args?.categoryId as string
      return Promise.resolve({ items: stubVariables[categoryId] ?? [] })
    }
    if (cmd === 'variable.set_active_category') {
      stubActiveId = (args?.categoryId as string | null) ?? null
      return Promise.resolve(categoriesView())
    }
    if (cmd === 'variable.create_category') {
      stubCategories.push({
        id: `new-${stubCategories.length + 1}`,
        name: args?.name as string,
        isGlobal: args?.global === true,
        sortOrder: stubCategories.length,
      })
      return Promise.resolve(categoriesView())
    }
    if (cmd === 'variable.rename_category') {
      const target = stubCategories.find((c) => c.id === args?.id)
      if (target) target.name = args?.name as string
      return Promise.resolve(categoriesView())
    }
    if (cmd === 'variable.delete_category') {
      stubCategories = stubCategories.filter((c) => c.id !== args?.id)
      return Promise.resolve(categoriesView())
    }
    if (cmd === 'variable.move_category') {
      // 桩按「摘除自身后在同区插入 index 位」重排（与后端 move 语义一致；
      // 树序＝全局区在前、本空间区在后）
      const id = args?.categoryId as string
      const at = stubCategories.findIndex((c) => c.id === id)
      if (at >= 0) {
        const [moved] = stubCategories.splice(at, 1)
        const scope = moved!.isGlobal
        const group = stubCategories.filter((c) => c.isGlobal === scope)
        const rest = stubCategories.filter((c) => c.isGlobal !== scope)
        const insertAt = Math.max(0, Math.min(args?.index as number, group.length))
        group.splice(insertAt, 0, moved!)
        stubCategories = scope ? [...group, ...rest] : [...rest, ...group]
      }
      return Promise.resolve(categoriesView())
    }
    return Promise.resolve(undefined)
  })
}

/** 渲染树视图并模拟虚拟化视口（jsdom 无布局：offsetHeight + 手动触发 ResizeObserver） */
async function renderView(props?: ComponentProps<typeof VariablesView>) {
  const view = render(<VariablesView {...props} />, { wrapper: createQueryWrapper() })
  await screen.findByRole('tree', { name: '变量树' })
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
  useTabsStore.setState({ tabs: [], activeTabId: null })
  useVariableStore.setState({
    treeExpandedIds: [],
    treeSelectedNodeId: null,
    baseUrlOverrides: {},
  })
  stubCategories = [
    { id: 'vc1', name: '开发', isGlobal: false, sortOrder: 0 },
    { id: 'vc2', name: '测试', isGlobal: false, sortOrder: 1 },
    { id: 'g1', name: '公共', isGlobal: true, sortOrder: 2 },
  ]
  stubActiveId = 'vc1'
  stubVariables = {
    vc1: [
      { key: 'host', value: 'https://dev.example.com', secret: false },
      { key: 'token', value: 'secret-value', secret: true },
    ],
    vc2: [],
    g1: [],
  }
  stubInvokes()
})

describe('左栏变量视图：两层树渲染', () => {
  it('分类行直挂根层：全局分类置顶，展开见变量键行，激活分类图标点亮主题色', async () => {
    await renderView()
    // 初始收起：全局分类（置顶）＋本空间分类同层直挂，无分组层
    const rootRows = screen.getAllByRole('treeitem')
    expect(rootRows.map((row) => row.getAttribute('aria-label'))).toEqual(['公共', '开发', '测试'])
    expect(screen.queryByRole('treeitem', { name: '工作空间分类' })).not.toBeInTheDocument()

    // 受控展开 vc1（形态同工作空间树测试的展开手法）
    act(() => {
      useVariableStore.getState().setTreeExpandedIds(['vc1'])
    })
    const rows = await screen.findAllByTestId('variables-item-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]).not.toHaveAttribute('data-secret')
    expect(rows[1]).toHaveAttribute('data-secret', 'true')

    // 分类图标与接口树同形（文件夹收 / 开两态）；激活分类（vc1）图标点亮
    // 主题色＋名称加粗，全局分类与未激活分类保持弱化色；行尾无激活开关
    const categories = screen.getAllByTestId('variables-category')
    expect(categories[0]!.querySelector('svg.lucide-folder')).not.toBeNull() // 公共（收起）
    expect(categories[1]!.querySelector('svg.lucide-folder-open')).not.toBeNull() // 开发（展开）
    expect(categories[1]!.querySelector('svg.text-primary')).not.toBeNull()
    expect(categories[0]!.querySelector('svg.text-primary')).toBeNull()
    expect(categories[2]!.querySelector('svg.text-primary')).toBeNull()
    expect(screen.queryByTestId('variables-activate-dot')).not.toBeInTheDocument()
    // 全局分类行尾呈现「全局」标识
    expect(screen.getByText('全局')).toBeInTheDocument()
  })

  it('点击分类行＝打开配置 Tab 不展开；行首箭头＝唯一展开入口（单实例）', async () => {
    const user = userEvent.setup()
    await renderView()
    await user.click(screen.getByRole('treeitem', { name: '开发' }))
    // 行点击只打开配置 Tab，不触碰展开态（变量行不出现）
    const tabs = useTabsStore.getState().tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ id: 'variables:vc1', kind: 'variables', key: 'vc1' })
    expect(screen.queryAllByTestId('variables-item-row')).toHaveLength(0)

    // 再点另一分类：两 Tab 并存（每分类单实例）
    await user.click(screen.getByRole('treeitem', { name: '测试' }))
    expect(useTabsStore.getState().tabs).toHaveLength(2)

    // 点击「开发」行首箭头＝展开（变量行出现），箭头 title 提示随态切换
    const devChevron = screen
      .getByRole('treeitem', { name: '开发' })
      .querySelector<HTMLElement>('[data-tree-chevron]')!
    expect(devChevron).toHaveAttribute('title', '展开')
    await user.click(devChevron)
    expect(await screen.findAllByTestId('variables-item-row')).toHaveLength(2)
    expect(useVariableStore.getState().treeExpandedIds).toEqual(['vc1'])
    expect(devChevron).toHaveAttribute('title', '收起')
  })

  it('空分类＝空态引导（不闪「加载中」）', async () => {
    stubCategories = []
    render(<VariablesView />, { wrapper: createQueryWrapper() })
    expect(await screen.findByText('暂无变量分类')).toBeInTheDocument()
  })
})

describe('左栏变量视图：激活切换', () => {
  // 取消激活方向由右键菜单 describe 的「取消激活」用例覆盖（同一 invoke 通道）
  it('菜单「激活」未激活分类＝invoke set_active_category 传该分类', async () => {
    await renderView()
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: '测试' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '激活' }))
    await waitFor(() => {
      const activateCalls = invokeMock.mock.calls.filter(
        ([cmd]) => cmd === 'variable.set_active_category',
      )
      expect(activateCalls).toHaveLength(1)
    })
    const payload = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'variable.set_active_category',
    )[0]![1] as { workspaceId: string; categoryId: string | null }
    expect(payload).toEqual({ workspaceId: 'w1', categoryId: 'vc2' })
  })
})

describe('左栏变量视图：右键菜单', () => {
  it('分类行菜单「取消激活」＝invoke set_active_category 传 null', async () => {
    await renderView()
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: '开发' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '取消激活' }))
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.set_active_category')
      expect(calls).toHaveLength(1)
    })
    const payload = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'variable.set_active_category',
    )[0]![1] as { categoryId: string | null }
    expect(payload.categoryId).toBeNull()
  })

  it('分类行菜单「重命名」：提交＝invoke rename_category', async () => {
    const user = userEvent.setup()
    await renderView()
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: '开发' }))
    // 菜单项带 F2 快捷键提示（可访问名含「F2」），用正则匹配
    fireEvent.click(await screen.findByRole('menuitem', { name: /重命名/ }))
    const nameInput = await screen.findByLabelText('分类名称')
    await user.clear(nameInput)
    await user.type(nameInput, '开发环境')
    fireEvent.click(screen.getByTestId('variables-rename-confirm'))
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.rename_category')
      expect(calls).toHaveLength(1)
    })
    const payload = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'variable.rename_category',
    )[0]![1] as { workspaceId: string; id: string; name: string }
    expect(payload).toEqual({ workspaceId: 'w1', id: 'vc1', name: '开发环境' })
  })

  it('全局分类菜单无激活项：打开 / 重命名 / 删除', async () => {
    await renderView()
    const globalRow = screen.getByRole('treeitem', { name: '公共' })
    fireEvent.contextMenu(globalRow)
    expect(await screen.findByRole('menuitem', { name: '打开' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /重命名/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '删除' })).toBeInTheDocument()
    // 全局分类不可激活：菜单无激活项，行尾只有「全局」标识
    expect(screen.queryByRole('menuitem', { name: '激活' })).not.toBeInTheDocument()
    expect(within(globalRow).getByText('全局')).toBeInTheDocument()
  })

  it('分类行菜单「上移 / 下移」＝invoke move_category；边界方向禁用（排序的键盘通道）', async () => {
    await renderView()
    // 树序＝公共（全局区）→ 开发 → 测试；「测试」在本空间区末位：上移可用、下移禁用
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: '测试' }))
    const up = await screen.findByRole('menuitem', { name: '上移' })
    expect(up).not.toHaveAttribute('data-disabled')
    expect(screen.getByRole('menuitem', { name: '下移' })).toHaveAttribute('data-disabled')
    fireEvent.click(up)
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.move_category')
      expect(calls).toHaveLength(1)
    })
    expect(invokeMock.mock.calls.find(([cmd]) => cmd === 'variable.move_category')![1]).toEqual({
      workspaceId: 'w1',
      categoryId: 'vc2',
      index: 0,
    })
    // 树序随清单视图刷新：测试行移到本空间区首位
    await waitFor(() => {
      const names = screen.getAllByTestId('variables-category').map((row) => row.textContent)
      expect(names.indexOf('测试')).toBeLessThan(names.indexOf('开发'))
    })

    // 全局分类（唯一全局行）：上下皆禁用
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: '公共' }))
    await screen.findByRole('menuitem', { name: '打开' })
    expect(screen.getByRole('menuitem', { name: '上移' })).toHaveAttribute('data-disabled')
    expect(screen.getByRole('menuitem', { name: '下移' })).toHaveAttribute('data-disabled')
  })

  it('变量行菜单「打开」＝打开所属分类配置页', async () => {
    await renderView()
    act(() => {
      useVariableStore.getState().setTreeExpandedIds(['vc1'])
    })
    fireEvent.contextMenu((await screen.findAllByTestId('variables-item-row'))[0]!)
    fireEvent.click(await screen.findByRole('menuitem', { name: '打开' }))
    const tabs = useTabsStore.getState().tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ id: 'variables:vc1', kind: 'variables' })
  })

  it('变量行菜单「复制变量」＝复制 {{键}} 引用到剪贴板（配合 Ctrl+V）', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    await renderView()
    act(() => {
      useVariableStore.getState().setTreeExpandedIds(['vc1'])
    })
    fireEvent.contextMenu((await screen.findAllByTestId('variables-item-row'))[0]!)
    // 复制的值落剪贴板，菜单项不再附带 {{键}} 提示
    const copyItem = await screen.findByRole('menuitem', { name: '复制变量' })
    expect(copyItem).not.toHaveTextContent('{{host}}')
    fireEvent.click(copyItem)
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('{{host}}')
    })
  })

  it('空白区右键＝新建分类（默认非全局，成功后入树）', async () => {
    const user = userEvent.setup()
    await renderView()

    fireEvent.contextMenu(document.querySelector('[data-testid="variables-tree-body"]')!)
    // 「新建分类」文案与底部动作条按钮同名，按菜单项 role 取
    fireEvent.click(await screen.findByRole('menuitem', { name: '新建分类' }))
    const nameInput = await screen.findByLabelText('分类名称')
    await user.type(nameInput, '预发')
    fireEvent.click(screen.getByTestId('variables-create-category-confirm'))
    await waitFor(() => {
      const createCalls = invokeMock.mock.calls.filter(
        ([cmd]) => cmd === 'variable.create_category',
      )
      expect(createCalls).toHaveLength(1)
    })
    const payload = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'variable.create_category',
    )[0]![1] as { workspaceId: string; global: boolean; name: string }
    expect(payload).toEqual({ workspaceId: 'w1', global: false, name: '预发' })
    // 成功后清单刷新（新分类入树）
    expect(await screen.findByRole('treeitem', { name: '预发' })).toBeInTheDocument()
  })

  it('菜单删除走确认弹窗：确认＝invoke delete_category 并关闭其 Tab', async () => {
    const user = userEvent.setup()
    await renderView()
    await user.click(screen.getByRole('treeitem', { name: '开发' }))
    expect(useTabsStore.getState().tabs).toHaveLength(1)

    fireEvent.contextMenu(screen.getByRole('treeitem', { name: '开发' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '删除' }))
    // 未确认不发起删除
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.delete_category'),
    ).toHaveLength(0)
    fireEvent.click(await screen.findByTestId('variables-delete-category-confirm'))
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.delete_category')
      expect(calls).toHaveLength(1)
    })
    expect(useTabsStore.getState().tabs).toHaveLength(0)
  })

  it('删除进行中确认钮禁用＋「删除中…」；失败保持弹窗可重试', async () => {
    const user = userEvent.setup()
    await renderView()
    await user.click(screen.getByRole('treeitem', { name: '开发' }))
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: '开发' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '删除' }))
    const confirm = await screen.findByTestId('variables-delete-category-confirm')

    // 门闸挂起首删（观测 pending 窗口），放行后首删失败、重试成功
    let attempts = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const baseImpl = invokeMock.getMockImplementation()
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'variable.delete_category') {
        attempts += 1
        if (attempts === 1) return gate.then(() => Promise.reject(new Error('删除失败')))
      }
      return baseImpl!(cmd, args)
    })
    fireEvent.click(confirm)
    await waitFor(() => {
      expect(attempts).toBe(1)
    })
    expect(confirm).toBeDisabled()
    expect(confirm).toHaveTextContent('删除中…')
    fireEvent.click(confirm)
    expect(attempts).toBe(1)

    release()
    // 失败后：弹窗在场、按钮恢复可点（对话框内可重试）
    await waitFor(() => {
      expect(confirm).toBeEnabled()
    })
    expect(confirm).toHaveTextContent('删除')
    fireEvent.click(confirm)
    await waitFor(() => {
      expect(attempts).toBe(2)
    })
    await waitFor(() => {
      expect(screen.queryByTestId('variables-delete-category-confirm')).not.toBeInTheDocument()
    })
  })
})

describe('左栏变量视图：对话框表单纪律', () => {
  it('重命名对话框：名称未变确认钮禁用，改动后恢复可提交', async () => {
    const user = userEvent.setup()
    await renderView()
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: '开发' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /重命名/ }))
    const confirm = await screen.findByTestId('variables-rename-confirm')
    // 打开即旧名：未变＝禁用（静默 return 的按钮态化）
    expect(confirm).toBeDisabled()
    const nameInput = screen.getByLabelText('分类名称')
    await user.type(nameInput, '环境')
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.rename_category')
      expect(calls).toHaveLength(1)
    })
  })
})

describe('左栏变量视图：加载失败态', () => {
  it('分类清单加载失败＝错误空态＋重试', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'workspace.list') {
        return Promise.resolve({
          items: [{ id: 'w1', name: '空间一', baseUrl: null, auth: null, isCurrent: true }],
          currentId: 'w1',
        })
      }
      if (cmd === 'variable.list_categories') return Promise.reject(new Error('ipc down'))
      return Promise.resolve(undefined)
    })
    render(<VariablesView />, { wrapper: createQueryWrapper() })
    expect(await screen.findByText('变量分类加载失败')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })
})

describe('左栏变量视图：搜索过滤（视图接线）', () => {
  it('变量 key 命中：父分类保留且自动展开，命中行可见、其余分类隐藏', async () => {
    await renderView({ searchQuery: 'host' })
    // 命中变量的父分类（开发）保留并自动展开（进入过滤时快照空展开集 → 并集）
    expect(await screen.findAllByTestId('variables-item-row')).toHaveLength(1)
    expect(screen.getByTestId('variables-item-row')).toHaveTextContent('host')
    // 未命中分支整枝隐藏（全局「公共」与本空间「测试」）
    expect(screen.queryByRole('treeitem', { name: '公共' })).not.toBeInTheDocument()
    expect(screen.queryByRole('treeitem', { name: '测试' })).not.toBeInTheDocument()
  })

  it('分类名命中：命中分类行保留（根层直挂可见），其余分类隐藏', async () => {
    await renderView({ searchQuery: '开' })
    await screen.findByRole('treeitem', { name: '开发' })
    expect(screen.getAllByRole('treeitem').map((row) => row.getAttribute('aria-label'))).toEqual([
      '开发',
    ])
  })

  it('无命中＝搜索空态＋「清除搜索」按钮回调宿主清词', async () => {
    const onSearchChange = vi.fn<(value: string) => void>()
    // 过滤无命中走搜索空态（树不在场），直接渲染不等 tree role
    render(<VariablesView searchQuery="不存在的词" onSearchChange={onSearchChange} />, {
      wrapper: createQueryWrapper(),
    })
    expect(await screen.findByText('无匹配分类或变量')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }))
    expect(onSearchChange).toHaveBeenCalledWith('')
  })

  it('过滤中拖拽手柄隐藏；缺省（非过滤）手柄在场＝现状形态', async () => {
    const filtered = await renderView({ searchQuery: 'host' })
    await within(filtered.container).findAllByTestId('variables-item-row')
    expect(filtered.container.querySelector('[data-drag-handle]')).toBeNull()

    const plain = await renderView()
    await within(plain.container).findByRole('treeitem', { name: '开发' })
    expect(plain.container.querySelector('[data-drag-handle]')).not.toBeNull()
  })
})
