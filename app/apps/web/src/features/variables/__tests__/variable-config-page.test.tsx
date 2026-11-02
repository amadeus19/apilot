import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { toastStore } from '@workspace/ui/components'

import { ResizeObserverMock } from '@/test/setup'
import { createQueryWrapper } from '@/test/render-providers'
import { useTabsStore } from '@/stores/tabs.store'

import { VariableConfigPage } from '../variable-config-page'
import { variableKeys } from '../variable-api'

// —— IPC invoke 替换：分类 / 变量 / 生效集走桩存储，mutation 更新桩 ——
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

let stubCategories: { id: string; name: string; isGlobal: boolean; sortOrder: number }[]
let stubActiveId: string | null
let stubVariables: { key: string; value: string; secret: boolean }[]
/** 桩实现本体（锁窗测试在其上叠加 create_variable 门闸时复用） */
let baseInvoke: (cmd: string, args?: Record<string, unknown>) => unknown

function categoriesView() {
  return { items: stubCategories.map((c) => ({ ...c })), activeCategoryId: stubActiveId }
}

function variablesView() {
  return { items: stubVariables.map((v) => ({ ...v })) }
}

function stubInvokes() {
  const impl = (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'workspace.list') {
      return Promise.resolve({
        items: [{ id: 'w1', name: '空间一', baseUrl: null, auth: null, isCurrent: true }],
        currentId: 'w1',
      })
    }
    if (cmd === 'variable.list_categories') return Promise.resolve(categoriesView())
    if (cmd === 'variable.list_variables') return Promise.resolve(variablesView())
    if (cmd === 'variable.effective') {
      return Promise.resolve({
        items: [
          {
            key: 'baseUrl',
            value: 'https://builtin.example.com',
            secret: false,
            source: 'builtin',
          },
          { key: 'host', value: 'https://active.example.com', secret: false, source: 'active' },
          { key: 'token', value: 'plain-secret-value', secret: true, source: 'active' },
          { key: 'apiKey', value: 'global-key', secret: false, source: 'global' },
        ],
      })
    }
    if (cmd === 'variable.update_variable') {
      const target = stubVariables.find((v) => v.key === args?.key)
      if (target) {
        target.value = args?.value as string
        target.secret = args?.secret as boolean
      }
      return Promise.resolve(variablesView())
    }
    if (cmd === 'variable.rename_variable') {
      const target = stubVariables.find((v) => v.key === args?.key)
      if (target) target.key = args?.newKey as string
      return Promise.resolve(variablesView())
    }
    if (cmd === 'variable.create_variable') {
      stubVariables.push({
        key: args?.key as string,
        value: args?.value as string,
        secret: args?.secret as boolean,
      })
      return Promise.resolve(variablesView())
    }
    if (cmd === 'variable.delete_variable') {
      stubVariables = stubVariables.filter((v) => v.key !== args?.key)
      return Promise.resolve(variablesView())
    }
    if (cmd === 'variable.rename_category') {
      const target = stubCategories.find((c) => c.id === args?.id)
      if (target) target.name = args?.name as string
      return Promise.resolve(categoriesView())
    }
    if (cmd === 'variable.set_active_category') {
      stubActiveId = (args?.categoryId as string | null) ?? null
      return Promise.resolve(categoriesView())
    }
    if (cmd === 'variable.delete_category') {
      stubCategories = stubCategories.filter((c) => c.id !== args?.id)
      return Promise.resolve(categoriesView())
    }
    return Promise.resolve(undefined)
  }
  baseInvoke = impl
  invokeMock.mockImplementation(impl)
}

/** 门闸 create_variable（放行前挂起）：锁窗测试用于观测 running 窗口；
 *  返回放行函数。Esc / 遮罩 / 取消共用 requestClose 单点，用取消按钮路径
 *  断言即覆盖全部关闭通道 */
function gateCreateVariable(): () => void {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
    cmd === 'variable.create_variable'
      ? gate.then(() => baseInvoke(cmd, args))
      : baseInvoke(cmd, args),
  )
  return release
}

beforeEach(() => {
  vi.clearAllMocks()
  useTabsStore.setState({ tabs: [], activeTabId: null })
  stubCategories = [{ id: 'vc1', name: '开发', isGlobal: false, sortOrder: 0 }]
  stubActiveId = 'vc1'
  stubVariables = [
    { key: 'host', value: 'https://dev.example.com', secret: false },
    { key: 'token', value: 'plain-secret-value', secret: true },
  ]
  stubInvokes()
})

describe('变量配置页：键值表与 Secret 掩码', () => {
  it('渲染键值表；Secret 值列默认掩码（password 形态），复制按钮就位', async () => {
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('variable-row')).toHaveLength(2)
    })
    const secretInput = screen.getByTestId('variable-value-token') as HTMLInputElement
    expect(secretInput.type).toBe('password')
    // 非 Secret 值列不掩码
    const plainInput = screen.getByTestId('variable-value-host') as HTMLInputElement
    expect(plainInput.type).toBe('text')
    // 复制入口（明文即得口径＝组件职责，这里断言就位与占位）
    expect(screen.getByTestId('variable-value-token-copy')).toBeInTheDocument()
  })

  it('眼睛切换临时明文：点击后 type=text，再点回 password', async () => {
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('variable-row')).toHaveLength(2)
    })
    const input = screen.getByTestId('variable-value-token') as HTMLInputElement
    fireEvent.click(screen.getByTestId('variable-value-token-reveal'))
    expect(input.type).toBe('text')
    fireEvent.click(screen.getByTestId('variable-value-token-reveal'))
    expect(input.type).toBe('password')
  })

  it('值列失焦落盘：编辑后 blur＝invoke update_variable', async () => {
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('variable-row')).toHaveLength(2)
    })
    const input = screen.getByTestId('variable-value-host')
    fireEvent.change(input, { target: { value: 'https://new.example.com' } })
    fireEvent.blur(input)
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.update_variable')
      expect(calls).toHaveLength(1)
    })
    const payload = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'variable.update_variable',
    )[0]![1] as { categoryId: string; key: string; value: string; secret: boolean }
    expect(payload).toEqual({
      categoryId: 'vc1',
      key: 'host',
      value: 'https://new.example.com',
      secret: false,
    })
  })

  it('Secret 开关切换即写（值不动，仅标记翻转）', async () => {
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('variable-row')).toHaveLength(2)
    })
    fireEvent.click(screen.getByTestId('variable-secret-host'))
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.update_variable')
      expect(calls).toHaveLength(1)
    })
    const payload = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'variable.update_variable',
    )[0]![1] as { value: string; secret: boolean }
    expect(payload.value).toBe('https://dev.example.com')
    expect(payload.secret).toBe(true)
  })

  it('新增变量（对话框）：key / value / secret 提交＝invoke create_variable', async () => {
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('variable-row')).toHaveLength(2)
    })
    fireEvent.click(screen.getByTestId('variable-add-button'))
    const keyInput = await screen.findByTestId('variable-add-key-input')
    fireEvent.change(keyInput, { target: { value: 'apiKey' } })
    fireEvent.change(screen.getByTestId('variable-add-value-input'), { target: { value: 'k-123' } })
    fireEvent.click(screen.getByTestId('variable-add-confirm'))
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.create_variable')
      expect(calls).toHaveLength(1)
    })
    const payload = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'variable.create_variable',
    )[0]![1] as { categoryId: string; key: string; value: string; secret: boolean }
    expect(payload).toEqual({ categoryId: 'vc1', key: 'apiKey', value: 'k-123', secret: false })
  })

  it('连续添加：确认后窗保持开、字段清空（可连录，不重复开窗）', async () => {
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('variable-row')).toHaveLength(2)
    })
    fireEvent.click(screen.getByTestId('variable-add-button'))
    const keyInput = await screen.findByTestId('variable-add-key-input')
    fireEvent.change(keyInput, { target: { value: 'a' } })
    fireEvent.click(screen.getByTestId('variable-add-confirm'))
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.create_variable'),
      ).toHaveLength(1)
    })
    // 窗保持开、key 输入已清空（连录下一对）
    expect(screen.getByTestId('variable-add-confirm')).toBeInTheDocument()
    expect((screen.getByTestId('variable-add-key-input') as HTMLInputElement).value).toBe('')
    fireEvent.change(screen.getByTestId('variable-add-key-input'), { target: { value: 'b' } })
    fireEvent.click(screen.getByTestId('variable-add-confirm'))
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.create_variable'),
      ).toHaveLength(2)
    })
    expect(screen.getByTestId('variable-add-confirm')).toBeInTheDocument()
  })

  it('删除撤销：删除轻量无确认，toast「撤销」原值重建', async () => {
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('variable-row')).toHaveLength(2)
    })
    fireEvent.click(screen.getByTestId('variable-delete-host'))
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.delete_variable'),
      ).toHaveLength(1)
    })
    // toast 携带撤销动作；点击＝原值原标记重建（key 仍空闲即恢复）
    const undoItem = toastStore.getSnapshot().find((item) => item.action?.label === '撤销')
    expect(undoItem).toBeDefined()
    undoItem!.action!.onClick()
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.create_variable')
      expect(calls).toHaveLength(1)
    })
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.create_variable')[0]![1],
    ).toEqual({ categoryId: 'vc1', key: 'host', value: 'https://dev.example.com', secret: false })
  })

  it('删除变量＝invoke delete_variable（轻操作无确认）', async () => {
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('variable-row')).toHaveLength(2)
    })
    fireEvent.click(screen.getByTestId('variable-delete-host'))
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.delete_variable')
      expect(calls).toHaveLength(1)
    })
    const payload = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'variable.delete_variable',
    )[0]![1] as { categoryId: string; key: string }
    expect(payload).toEqual({ categoryId: 'vc1', key: 'host' })
  })

  it('变量名行内编辑：点击才成为输入框，失焦提交＝invoke rename_variable', async () => {
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('variable-row')).toHaveLength(2)
    })
    // 静默态＝文本按钮；点击出现输入框（预选中原值）
    fireEvent.click(screen.getByTestId('variable-key-host'))
    const input = screen.getByTestId('variable-key-input-host') as HTMLInputElement
    expect(input.value).toBe('host')
    fireEvent.change(input, { target: { value: 'baseUrl' } })
    fireEvent.blur(input)
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.rename_variable')
      expect(calls).toHaveLength(1)
    })
    const payload = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'variable.rename_variable',
    )[0]![1] as { categoryId: string; key: string; newKey: string }
    expect(payload).toEqual({ categoryId: 'vc1', key: 'host', newKey: 'baseUrl' })

    // 空名 / 同名不发起写
    fireEvent.click(await screen.findByTestId('variable-key-baseUrl'))
    const again = screen.getByTestId('variable-key-input-baseUrl')
    fireEvent.change(again, { target: { value: '  ' } })
    fireEvent.blur(again)
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.rename_variable'),
    ).toHaveLength(1)
  })
})

describe('变量配置页：生效预览 Popover（恒掩码）', () => {
  /** 展开卡头「生效预览」并返回面板（内容在 Popover 层，展开后才挂载） */
  async function openPreview() {
    fireEvent.click(await screen.findByTestId('variable-effective-preview-button'))
    return screen.findByTestId('effective-variables-panel')
  }

  it('按来源徽标呈现，Secret 值恒掩码不出现明文', async () => {
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    const panel = await openPreview()
    const rows = await within(panel).findAllByTestId('effective-variable-row')
    expect(rows).toHaveLength(4)
    // 来源分层：active → global → builtin
    expect(rows[0]).toHaveAttribute('data-source', 'active')
    expect(rows[1]).toHaveAttribute('data-source', 'active')
    expect(rows[2]).toHaveAttribute('data-source', 'global')
    expect(rows[3]).toHaveAttribute('data-source', 'builtin')
    // 恒掩码：预览内不出现明文（也无明文切换与复制入口）
    expect(within(panel).queryByText('plain-secret-value')).toBeNull()
    expect(within(panel).getByText('••••••••')).toBeInTheDocument()
  })

  it('优先级链呈现当前激活分类名', async () => {
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    const panel = await openPreview()
    expect(within(panel).getByText(/生效优先级/)).toBeInTheDocument()
    expect(within(panel).getByText('开发')).toBeInTheDocument()
  })
})

describe('变量配置页：横幅 meta 摘要行', () => {
  it('激活分类：变量计数＋最高优先级参与生效集', async () => {
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('variable-row')).toHaveLength(2)
    })
    expect(screen.getByText('2 个变量')).toBeInTheDocument()
    expect(screen.getByText('参与生效集（最高优先级）')).toBeInTheDocument()
  })

  it('未激活分类：不参与生效集', async () => {
    stubActiveId = null
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('variable-row')).toHaveLength(2)
    })
    expect(screen.getByText('未激活，不参与生效集')).toBeInTheDocument()
  })

  it('全局分类：恒兜底参与生效集且无激活入口', async () => {
    stubCategories = [{ id: 'vg', name: '全局变量', isGlobal: true, sortOrder: -1 }]
    render(<VariableConfigPage categoryId="vg" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('variable-row')).toHaveLength(2)
    })
    expect(screen.getByText('全局兜底参与生效集')).toBeInTheDocument()
    expect(screen.queryByTestId('variable-activate-button')).not.toBeInTheDocument()
  })
})

describe('变量配置页：标题行动作', () => {
  it('横幅标题只读大标题；改名走弹窗＝invoke rename_category＋Tab 标题同步', async () => {
    useTabsStore.getState().openVariables({ categoryId: 'vc1', name: '开发' })
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    // 标题＝只读大标题（heading 语义，无行内输入框）
    expect(await screen.findByRole('heading', { name: '开发' })).toBeInTheDocument()
    expect(screen.queryByLabelText('分类名称')).toBeNull()
    // 改名入口开弹窗：输入新名确认＝invoke rename_category，成功关窗
    fireEvent.click(screen.getByTestId('variable-rename-category'))
    const dialogInput = (await screen.findByLabelText('分类名称')) as HTMLInputElement
    expect(dialogInput.value).toBe('开发')
    fireEvent.change(dialogInput, { target: { value: '开发环境' } })
    fireEvent.click(screen.getByTestId('variables-rename-confirm'))
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.rename_category')
      expect(calls).toHaveLength(1)
    })
    const payload = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'variable.rename_category',
    )[0]![1] as { workspaceId: string; id: string; name: string }
    expect(payload).toEqual({ workspaceId: 'w1', id: 'vc1', name: '开发环境' })
    await waitFor(() => {
      expect(screen.queryByTestId('variables-rename-confirm')).not.toBeInTheDocument()
    })
    // Tab 标题随清单视图同步；横幅跟随新名
    const tab = useTabsStore.getState().tabs.find((t) => t.id === 'variables:vc1')
    expect(tab?.title).toBe('开发环境')
    expect(screen.getByRole('heading', { name: '开发环境' })).toBeInTheDocument()
  })

  it('激活分类横幅呈现「已激活」徽章（工作空间「当前」同款浅底样式）', async () => {
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    const badge = await screen.findByTestId('variable-active-badge')
    expect(badge).toHaveTextContent('已激活')
    expect(badge.className).toContain('bg-selection')
    expect(badge.className).toContain('text-primary')
  })

  it('激活中分类点「取消激活」＝传 null（全不激活可达成）', async () => {
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    const button = await screen.findByTestId('variable-activate-button')
    expect(button).toHaveTextContent('取消激活')
    fireEvent.click(button)
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.set_active_category')
      expect(calls).toHaveLength(1)
    })
    const payload = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'variable.set_active_category',
    )[0]![1] as { workspaceId: string; categoryId: string | null }
    expect(payload.categoryId).toBeNull()
  })

  it('删除分类走确认弹窗，确认后＝invoke delete_category 并关闭 Tab', async () => {
    useTabsStore.getState().openVariables({ categoryId: 'vc1', name: '开发' })
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    fireEvent.click(await screen.findByTestId('variable-delete-category'))
    // 未确认不发起删除
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.delete_category'),
    ).toHaveLength(0)
    fireEvent.click(await screen.findByTestId('variable-delete-category-confirm'))
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.delete_category')
      expect(calls).toHaveLength(1)
    })
    expect(useTabsStore.getState().tabs).toHaveLength(0)
  })

  it('分类不存在（已被删）＝空态提示', async () => {
    render(<VariableConfigPage categoryId="nope" />, { wrapper: createQueryWrapper() })
    expect(await screen.findByTestId('variable-config-missing')).toBeInTheDocument()
  })
})

describe('变量配置页：生效预览搜索', () => {
  it('键过滤命中行减少；无匹配给空提示；清空恢复全量', async () => {
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    fireEvent.click(await screen.findByTestId('variable-effective-preview-button'))
    const panel = await screen.findByTestId('effective-variables-panel')
    expect((await within(panel).findAllByTestId('effective-variable-row')).length).toBe(4)
    const input = within(panel).getByTestId('effective-search') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'TOKEN' } })
    expect(within(panel).getAllByTestId('effective-variable-row')).toHaveLength(1)
    fireEvent.change(input, { target: { value: 'nomatch' } })
    expect(within(panel).getByTestId('effective-search-empty')).toBeInTheDocument()
    fireEvent.change(input, { target: { value: '' } })
    expect(within(panel).getAllByTestId('effective-variable-row')).toHaveLength(4)
  })
})

describe('变量配置页：新增批量页签', () => {
  it('批量文本逐条落库；解析错误行内定位（不关窗）', async () => {
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('variable-row')).toHaveLength(2)
    })
    fireEvent.click(screen.getByTestId('variable-add-button'))
    fireEvent.click(await screen.findByRole('tab', { name: '批量' }))
    fireEvent.change(screen.getByTestId('variable-add-bulk-input'), {
      target: { value: 'a: 1\nbad line\nb: two' },
    })
    fireEvent.click(screen.getByTestId('variable-add-bulk-confirm'))
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.create_variable')
      expect(calls).toHaveLength(2)
    })
    const keys = invokeMock.mock.calls
      .filter(([cmd]) => cmd === 'variable.create_variable')
      .map(([, args]) => (args as { key: string }).key)
    expect(keys).toEqual(['a', 'b'])
    expect(screen.getByTestId('variable-add-bulk-errors')).toHaveTextContent('第 2 行')
    // 窗保持开（有失败不关）
    expect(screen.getByTestId('variable-add-bulk-confirm')).toBeInTheDocument()
  })

  it('批次内重复键报行号；全成功后关窗', async () => {
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('variable-row')).toHaveLength(2)
    })
    fireEvent.click(screen.getByTestId('variable-add-button'))
    fireEvent.click(await screen.findByRole('tab', { name: '批量' }))
    fireEvent.change(screen.getByTestId('variable-add-bulk-input'), {
      target: { value: 'a: 1\na: 2' },
    })
    fireEvent.click(screen.getByTestId('variable-add-bulk-confirm'))
    await waitFor(() => {
      expect(screen.getByTestId('variable-add-bulk-errors')).toHaveTextContent('重复')
    })
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.create_variable'),
    ).toHaveLength(1)
    fireEvent.change(screen.getByTestId('variable-add-bulk-input'), { target: { value: 'c: 3' } })
    fireEvent.click(screen.getByTestId('variable-add-bulk-confirm'))
    await waitFor(() => {
      expect(screen.queryByTestId('variable-add-bulk-confirm')).not.toBeInTheDocument()
    })
  })
})

describe('变量配置页：导出 JSON（默认脱敏）', () => {
  const writeText = vi.fn()

  beforeEach(() => {
    writeText.mockReset()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
  })

  it('默认掩码导出：剪贴板不含 Secret 明文；勾选后含真值', async () => {
    writeText.mockResolvedValue(undefined)
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('variable-row')).toHaveLength(2)
    })
    fireEvent.click(screen.getByTestId('variable-export-button'))
    fireEvent.click(await screen.findByTestId('variable-export-copy'))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1)
    })
    const masked = writeText.mock.calls[0]![0] as string
    expect(masked).toContain('"category": "开发"')
    expect(masked).toContain('"secret": true')
    expect(masked).toContain('***')
    expect(masked).not.toContain('plain-secret-value')

    // 勾选含明文后导出：真值进剪贴板
    fireEvent.click(screen.getByTestId('variable-export-button'))
    fireEvent.click(await screen.findByTestId('variable-export-secret-switch'))
    fireEvent.click(await screen.findByTestId('variable-export-copy'))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(2)
    })
    expect(writeText.mock.calls[1]![0] as string).toContain('plain-secret-value')
  })
})

describe('变量配置页：导入变量', () => {
  it('非法 JSON 行内报错不落库；合法 JSON 跳过策略只建新键', async () => {
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('variable-row')).toHaveLength(2)
    })
    fireEvent.click(screen.getByTestId('variable-import-button'))
    const input = await screen.findByTestId('variable-import-input')
    fireEvent.change(input, { target: { value: 'not json' } })
    fireEvent.click(screen.getByTestId('variable-import-confirm'))
    expect(await screen.findByTestId('variable-import-parse-error')).toBeInTheDocument()
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.create_variable'),
    ).toHaveLength(0)

    fireEvent.change(input, {
      target: {
        value: '{"variables":[{"key":"newKey","value":"v1"},{"key":"host","value":"overwritten"}]}',
      },
    })
    fireEvent.click(screen.getByTestId('variable-import-confirm'))
    await waitFor(() => {
      expect(screen.queryByTestId('variable-import-confirm')).not.toBeInTheDocument()
    })
    const created = invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.create_variable')
    expect(created).toHaveLength(1)
    expect((created[0]![1] as { key: string }).key).toBe('newKey')
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.update_variable'),
    ).toHaveLength(0)
  })

  it('覆盖策略：同名键走 update_variable 且导入值胜', async () => {
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('variable-row')).toHaveLength(2)
    })
    fireEvent.click(screen.getByTestId('variable-import-button'))
    fireEvent.change(await screen.findByTestId('variable-import-input'), {
      target: { value: '[{"key":"host","value":"https://imported.example.com"}]' },
    })
    fireEvent.click(screen.getByTestId('variable-import-strategy-overwrite'))
    fireEvent.click(screen.getByTestId('variable-import-confirm'))
    await waitFor(() => {
      expect(screen.queryByTestId('variable-import-confirm')).not.toBeInTheDocument()
    })
    const updated = invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.update_variable')
    expect(updated).toHaveLength(1)
    expect(updated[0]![1]).toMatchObject({ key: 'host', value: 'https://imported.example.com' })
  })
})

describe('变量配置页：导入掩码回灌防御', () => {
  it('secret 掩码行不落库，警示清单呈现且窗保持开；正常行照常导入', async () => {
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('variable-row')).toHaveLength(2)
    })
    fireEvent.click(screen.getByTestId('variable-import-button'))
    fireEvent.change(await screen.findByTestId('variable-import-input'), {
      target: {
        value:
          '{"variables":[{"key":"newKey","value":"v1"},{"key":"token2","value":"***","secret":true}]}',
      },
    })
    fireEvent.click(screen.getByTestId('variable-import-confirm'))
    await waitFor(() => {
      expect(screen.getByTestId('variable-import-failures')).toHaveTextContent(
        '值疑似导出掩码，未导入',
      )
    })
    // 掩码行未落库：只建了 newKey，假值 *** 不进任何 create / update
    const created = invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.create_variable')
    expect(created).toHaveLength(1)
    expect((created[0]![1] as { key: string }).key).toBe('newKey')
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.update_variable'),
    ).toHaveLength(0)
    expect(screen.getByTestId('variable-import-failures')).toHaveTextContent('token2')
    // 有警示不自动关窗
    expect(screen.getByTestId('variable-import-confirm')).toBeInTheDocument()
  })

  it('全部行都是掩码：零落库、警示全量呈现', async () => {
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('variable-row')).toHaveLength(2)
    })
    fireEvent.click(screen.getByTestId('variable-import-button'))
    fireEvent.change(await screen.findByTestId('variable-import-input'), {
      target: { value: '[{"key":"t1","value":"***","secret":true}]' },
    })
    fireEvent.click(screen.getByTestId('variable-import-confirm'))
    await waitFor(() => {
      expect(screen.getByTestId('variable-import-failures')).toHaveTextContent('t1')
    })
    expect(
      invokeMock.mock.calls.filter(
        ([cmd]) => cmd === 'variable.create_variable' || cmd === 'variable.update_variable',
      ),
    ).toHaveLength(0)
  })
})

describe('变量配置页：导入 JSON 行级定位', () => {
  it('行级形态错误定位到条目序号（第 N 条）', async () => {
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('variable-row')).toHaveLength(2)
    })
    fireEvent.click(screen.getByTestId('variable-import-button'))
    fireEvent.change(await screen.findByTestId('variable-import-input'), {
      target: { value: '[{"key":"ok"},{"value":"no-key"}]' },
    })
    fireEvent.click(screen.getByTestId('variable-import-confirm'))
    expect(await screen.findByTestId('variable-import-parse-error')).toHaveTextContent('第 2 条')
  })
})

describe('变量配置页：批量 / 导入运行中锁窗', () => {
  it('批量落库运行中取消不关窗，完成后全成功自动关窗', async () => {
    const finishCreate = gateCreateVariable()
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('variable-row')).toHaveLength(2)
    })
    fireEvent.click(screen.getByTestId('variable-add-button'))
    fireEvent.click(await screen.findByRole('tab', { name: '批量' }))
    fireEvent.change(screen.getByTestId('variable-add-bulk-input'), {
      target: { value: 'a: 1\nb: 2' },
    })
    fireEvent.click(screen.getByTestId('variable-add-bulk-confirm'))
    // 首条 create 已发起且被门闸挂起＝运行中窗口可观测
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.create_variable'),
      ).toHaveLength(1)
    })
    // 取消（Esc / 遮罩 / 取消共用 requestClose 单点）不关窗
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByTestId('variable-add-bulk-confirm')).toBeInTheDocument()
    finishCreate()
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.create_variable'),
      ).toHaveLength(2)
    })
    // 全部成功后自动关窗
    await waitFor(() => {
      expect(screen.queryByTestId('variable-add-bulk-confirm')).not.toBeInTheDocument()
    })
  })

  it('导入运行中取消不关窗，完成后自动关窗', async () => {
    const finishCreate = gateCreateVariable()
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('variable-row')).toHaveLength(2)
    })
    fireEvent.click(screen.getByTestId('variable-import-button'))
    fireEvent.change(await screen.findByTestId('variable-import-input'), {
      target: { value: '[{"key":"newKey","value":"v1"}]' },
    })
    fireEvent.click(screen.getByTestId('variable-import-confirm'))
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.create_variable'),
      ).toHaveLength(1)
    })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByTestId('variable-import-confirm')).toBeInTheDocument()
    finishCreate()
    await waitFor(() => {
      expect(screen.queryByTestId('variable-import-confirm')).not.toBeInTheDocument()
    })
  })
})

/** 渲染配置页并暴露同 Provider 的 queryClient（渲染外创建；缓存直写＝
 *  左栏 F2 改名 mutation 返回视图直写缓存的等价消费路径） */
function renderWithQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  })
  const view = render(<VariableConfigPage categoryId="vc1" />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  })
  return { view, queryClient }
}

/** 把桩分类改名并直写 categories 缓存，等 observer 通知送达（微任务批处理）；
 *  显示层是否跟随取决于草稿是否在场，由调用方各自断言 */
async function renameCategoryExternally(queryClient: QueryClient, newName: string) {
  stubCategories = [{ id: 'vc1', name: newName, isGlobal: false, sortOrder: 0 }]
  act(() => {
    queryClient.setQueryData(variableKeys.categories('w1'), categoriesView())
  })
  await waitFor(() => {
    expect(queryClient.getQueryData(variableKeys.categories('w1'))).toEqual(categoriesView())
  })
}

describe('变量配置页：标题跟随真值', () => {
  it('外部改名（左栏 F2 同款弹窗直写缓存）后横幅标题跟随新名', async () => {
    const { queryClient } = renderWithQueryClient()
    expect(await screen.findByRole('heading', { name: '开发' })).toBeInTheDocument()
    await renameCategoryExternally(queryClient, '开发环境')
    expect(await screen.findByRole('heading', { name: '开发环境' })).toBeInTheDocument()
  })
})

describe('变量配置页：删除分类确认 pending', () => {
  it('删除进行中：确认钮禁用＋「删除中…」文案，连点不重复发起', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === 'variable.delete_category'
        ? gate.then(() => baseInvoke(cmd, args))
        : baseInvoke(cmd, args),
    )
    useTabsStore.getState().openVariables({ categoryId: 'vc1', name: '开发' })
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    fireEvent.click(await screen.findByTestId('variable-delete-category'))
    const confirm = await screen.findByTestId('variable-delete-category-confirm')
    fireEvent.click(confirm)
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.delete_category'),
      ).toHaveLength(1)
    })
    // 进行中：禁用＋进行态文案
    expect(confirm).toBeDisabled()
    expect(confirm).toHaveTextContent('删除中…')
    fireEvent.click(confirm)
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.delete_category'),
    ).toHaveLength(1)
    release()
    await waitFor(() => {
      expect(useTabsStore.getState().tabs).toHaveLength(0)
    })
  })

  it('删除失败：确认弹窗保持在场，按钮恢复后可重试成功', async () => {
    let attempts = 0
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'variable.delete_category') {
        attempts += 1
        if (attempts === 1) return Promise.reject(new Error('删除失败'))
      }
      return baseInvoke(cmd, args)
    })
    useTabsStore.getState().openVariables({ categoryId: 'vc1', name: '开发' })
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    fireEvent.click(await screen.findByTestId('variable-delete-category'))
    const confirm = await screen.findByTestId('variable-delete-category-confirm')
    fireEvent.click(confirm)
    await waitFor(() => {
      expect(attempts).toBe(1)
    })
    // 失败：弹窗保持在场（可重试），按钮恢复可点、文案回落
    expect(confirm).toBeInTheDocument()
    await waitFor(() => {
      expect(confirm).toBeEnabled()
    })
    expect(confirm).toHaveTextContent('删除')
    fireEvent.click(confirm)
    await waitFor(() => {
      expect(useTabsStore.getState().tabs).toHaveLength(0)
    })
  })
})

describe('变量配置页：新增变量对话框页签语义', () => {
  it('tablist/tab/tabpanel 关联齐全（id / aria-controls / aria-labelledby / roving tabindex）', async () => {
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('variable-row')).toHaveLength(2)
    })
    fireEvent.click(screen.getByTestId('variable-add-button'))
    const tablist = await screen.findByTestId('variable-add-mode-tabs')
    expect(tablist).toHaveAttribute('role', 'tablist')
    const single = screen.getByRole('tab', { name: '单条' })
    const bulk = screen.getByRole('tab', { name: '批量' })
    expect(single).toHaveAttribute('id', 'variable-add-tab-single')
    expect(single).toHaveAttribute('aria-controls', 'variable-add-panel-single')
    expect(single).toHaveAttribute('aria-selected', 'true')
    expect(single).toHaveAttribute('tabindex', '0')
    expect(bulk).toHaveAttribute('id', 'variable-add-tab-bulk')
    expect(bulk).toHaveAttribute('aria-controls', 'variable-add-panel-bulk')
    expect(bulk).toHaveAttribute('aria-selected', 'false')
    expect(bulk).toHaveAttribute('tabindex', '-1')
    // 当前面板与 tab 关联（仅激活面板在 DOM）
    const panel = screen.getByRole('tabpanel')
    expect(panel).toHaveAttribute('id', 'variable-add-panel-single')
    expect(panel).toHaveAttribute('aria-labelledby', 'variable-add-tab-single')
  })

  it('左右方向键切换页签（焦点跟随），两页签循环', async () => {
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('variable-row')).toHaveLength(2)
    })
    fireEvent.click(screen.getByTestId('variable-add-button'))
    await screen.findByTestId('variable-add-mode-tabs')
    const single = screen.getByRole('tab', { name: '单条' })
    const bulk = screen.getByRole('tab', { name: '批量' })
    fireEvent.keyDown(single, { key: 'ArrowRight' })
    expect(bulk).toHaveAttribute('aria-selected', 'true')
    expect(document.activeElement).toBe(bulk)
    expect(screen.getByTestId('variable-add-bulk-input')).toBeInTheDocument()
    fireEvent.keyDown(bulk, { key: 'ArrowLeft' })
    expect(single).toHaveAttribute('aria-selected', 'true')
    expect(document.activeElement).toBe(single)
    expect(screen.getByTestId('variable-add-key-input')).toBeInTheDocument()
  })
})

describe('变量配置页：键值表虚拟化阈值', () => {
  it('阈值边界（50 行）保持全量渲染', async () => {
    stubVariables = Array.from({ length: 50 }, (_, i) => ({
      key: `k${i}`,
      value: `v${i}`,
      secret: false,
    }))
    render(<VariableConfigPage categoryId="vc1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('variable-row')).toHaveLength(50)
    })
  })

  it('超阈值切换虚拟化：只渲染可视窗口行（导入大表场景）', async () => {
    stubVariables = Array.from({ length: 120 }, (_, i) => ({
      key: `k${i}`,
      value: `v${i}`,
      secret: false,
    }))
    const view = render(<VariableConfigPage categoryId="vc1" />, {
      wrapper: createQueryWrapper(),
    })
    const table = await screen.findByTestId('variable-table')
    // 模拟视口（jsdom 无布局：offsetHeight + 手动触发 ResizeObserver，同左栏树手法）
    Object.defineProperty(table, 'offsetHeight', { configurable: true, value: 600 })
    Object.defineProperty(table, 'offsetWidth', { configurable: true, value: 800 })
    act(() => {
      for (const observer of ResizeObserverMock.instances) {
        observer.callback([] as ResizeObserverEntry[], observer as unknown as ResizeObserver)
      }
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    const rendered = view.container.querySelectorAll('[data-testid="variable-row"]').length
    // 视口 600px / 行高 45px ≈ 14 行＋overscan 两侧，远小于全量 120
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThan(120)
  })
})
