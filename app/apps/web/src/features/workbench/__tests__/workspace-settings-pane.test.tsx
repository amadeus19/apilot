import { fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryWrapper } from '@/test/render-providers'
import { useIpcQuery } from '@/services/ipc-query'
import { workbenchKeys } from '@/services/workbench-api'
import { useWorkspacesStore } from '@/features/workspaces/workspaces.store'
import { variableEffective, variableKeys } from '@/features/variables/variable-api'

import { WorkspaceSettingsPane } from '../workspace-settings-pane'

// —— IPC invoke 替换：rename / set_auth / set_current 更新桩存储，list 回读；
// 服务清单按 workspaceId 过滤返回 ——
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

interface StubWorkspace {
  id: string
  name: string
  baseUrl: string | null
  auth: string | null
}

interface StubService {
  id: string
  workspaceId: string
  name: string
  docUrl: string | null
}

let workspaces: StubWorkspace[]
let currentId: string
let services: StubService[]

function stubInvokes() {
  invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'workspace.list') {
      return Promise.resolve({
        items: workspaces.map((workspace) => ({
          ...workspace,
          isCurrent: workspace.id === currentId,
        })),
        currentId,
      })
    }
    if (cmd === 'workspace.rename') {
      const payload = args?.args as { id: string; name: string; baseUrl: string | null }
      workspaces = workspaces.map((workspace) =>
        workspace.id === payload.id
          ? { ...workspace, name: payload.name, baseUrl: payload.baseUrl }
          : workspace,
      )
      return Promise.resolve({
        items: workspaces.map((workspace) => ({
          ...workspace,
          isCurrent: workspace.id === currentId,
        })),
        currentId,
      })
    }
    if (cmd === 'workspace.set_auth') {
      const payload = args as { id: string; auth: string | null }
      workspaces = workspaces.map((workspace) =>
        workspace.id === payload.id ? { ...workspace, auth: payload.auth } : workspace,
      )
      return Promise.resolve(undefined)
    }
    if (cmd === 'workspace.set_current') {
      currentId = args?.id as string
      return Promise.resolve(undefined)
    }
    if (cmd === 'service.list_by_workspace') {
      const workspaceId = args?.workspaceId as string
      return Promise.resolve(services.filter((service) => service.workspaceId === workspaceId))
    }
    if (cmd === 'variable.effective') {
      return Promise.resolve({ items: [] })
    }
    if (cmd === 'variable.list_base_urls') {
      return Promise.resolve({ items: [] })
    }
    return Promise.resolve(undefined)
  })
}

/** 生效集探针：与生效集右栏同参数订阅 effective 键（staleTime 30s——
 *  无显式失效就不会重拉，重拉次数即失效证据） */
function EffectiveProbe({ workspaceId }: { workspaceId: string }) {
  useIpcQuery({
    queryKey: variableKeys.effective(workspaceId),
    queryFn: () => variableEffective(workspaceId),
    staleTime: 30_000,
  })
  return null
}

/** 渲染详情页并等清单返回（表单与认证播种完成） */
async function renderPane(workspaceId = 'w1') {
  const view = render(<WorkspaceSettingsPane workspaceId={workspaceId} />, {
    wrapper: createQueryWrapper(),
  })
  await vi.waitFor(() => {
    expect(screen.getByTestId('workspace-settings')).toBeInTheDocument()
  })
  return view
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  currentId = 'w2'
  workspaces = [
    { id: 'w1', name: '查看空间', baseUrl: null, auth: null },
    { id: 'w2', name: '当前空间', baseUrl: null, auth: null },
  ]
  services = []
  stubInvokes()
  useWorkspacesStore.setState({ dialog: null })
})

describe('工作空间详情页（按查看对象参数化）', () => {
  it('查看非激活空间：名称与 BaseUrl 播种自查看对象（非当前空间）', async () => {
    workspaces = [
      { id: 'w1', name: '查看空间', baseUrl: 'http://10.0.0.1:8000', auth: null },
      { id: 'w2', name: '当前空间', baseUrl: null, auth: null },
    ]
    stubInvokes()
    await renderPane('w1')
    expect(screen.getByLabelText('工作空间名称')).toHaveValue('查看空间')
    expect(screen.getByLabelText('BaseUrl')).toHaveValue('http://10.0.0.1:8000')
    // 页头标题＝查看对象名
    expect(screen.getByRole('heading', { name: '查看空间' })).toBeInTheDocument()
  })

  it('编辑防抖整包写 workspace.rename，落库目标＝查看对象（可为非当前空间）', async () => {
    const { act } = await import('@testing-library/react')
    await renderPane('w1')
    const listCallsBefore = invokeMock.mock.calls.filter(([cmd]) => cmd === 'workspace.list').length
    fireEvent.change(screen.getByLabelText('工作空间名称'), { target: { value: '改名空间' } })
    fireEvent.change(screen.getByLabelText('BaseUrl'), { target: { value: 'http://new:1' } })
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    const renames = invokeMock.mock.calls.filter(([cmd]) => cmd === 'workspace.rename')
    expect(renames).toHaveLength(1)
    const payload = (
      renames[0]![1] as { args: { id: string; name: string; baseUrl: string | null } }
    ).args
    expect(payload.id).toBe('w1')
    expect(payload.name).toBe('改名空间')
    expect(payload.baseUrl).toBe('http://new:1')
    // 清单键失效后重拉：list 调用数增加
    await vi.waitFor(() => {
      const listCallsAfter = invokeMock.mock.calls.filter(
        ([cmd]) => cmd === 'workspace.list',
      ).length
      expect(listCallsAfter).toBeGreaterThan(listCallsBefore)
    })
  })

  it('BaseUrl 变更后失效该空间生效变量集（内置 {{baseUrl}} 条目随重算，不残留陈旧缓存）', async () => {
    const { act } = await import('@testing-library/react')
    render(
      <>
        <WorkspaceSettingsPane workspaceId="w1" />
        <EffectiveProbe workspaceId="w1" />
      </>,
      { wrapper: createQueryWrapper() },
    )
    await vi.waitFor(() => {
      expect(screen.getByTestId('workspace-settings')).toBeInTheDocument()
    })
    // 探针首拉完成（effective 已进缓存且新鲜——staleTime 内不会自动重拉）
    await vi.waitFor(() => {
      expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.effective')).toHaveLength(1)
    })
    fireEvent.change(screen.getByLabelText('BaseUrl'), { target: { value: 'http://new:1' } })
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    // 防抖 rename 成功 → effective 键失效 → 探针重拉
    await vi.waitFor(() => {
      expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.effective')).toHaveLength(2)
    })
  })

  it('BaseUrl 清空＝写 null；名称空白不落库且保存态回落 idle', async () => {
    workspaces = [
      { id: 'w1', name: '查看空间', baseUrl: 'http://old:1', auth: null },
      { id: 'w2', name: '当前空间', baseUrl: null, auth: null },
    ]
    stubInvokes()
    const { act } = await import('@testing-library/react')
    await renderPane('w1')
    fireEvent.change(screen.getByLabelText('BaseUrl'), { target: { value: '  ' } })
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(
      (
        invokeMock.mock.calls.filter(([cmd]) => cmd === 'workspace.rename')[0]![1] as {
          args: { baseUrl: string | null }
        }
      ).args.baseUrl,
    ).toBeNull()
    fireEvent.change(screen.getByLabelText('工作空间名称'), { target: { value: '   ' } })
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(workspaces.find((workspace) => workspace.id === 'w1')?.name).toBe('查看空间')
    // 空名没有要保存的内容，保存态回落 idle（不留在「保存中」）
    expect(screen.getByTestId('workspace-settings-save-state')).toHaveAttribute(
      'data-status',
      'idle',
    )
  })

  it('保存态回显：编辑置「保存中」，写出后转「已保存」', async () => {
    const { act } = await import('@testing-library/react')
    await renderPane('w1')
    const saveState = screen.getByTestId('workspace-settings-save-state')
    expect(saveState).toHaveAttribute('data-status', 'idle')

    fireEvent.change(screen.getByLabelText('工作空间名称'), { target: { value: '改名空间' } })
    expect(saveState).toHaveAttribute('data-status', 'saving')
    expect(screen.getByText('保存中…')).toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await vi.waitFor(() => {
      expect(saveState).toHaveAttribute('data-status', 'saved')
    })
    expect(screen.getByText('已保存')).toBeInTheDocument()
  })

  it('写入失败＝失败态带重试；重试重新写出当前表单值', async () => {
    const { act } = await import('@testing-library/react')
    let renameAttempts = 0
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'workspace.list') {
        return Promise.resolve({
          items: workspaces.map((workspace) => ({
            ...workspace,
            isCurrent: workspace.id === currentId,
          })),
          currentId,
        })
      }
      if (cmd === 'workspace.rename') {
        renameAttempts += 1
        if (renameAttempts === 1) return Promise.reject(new Error('写入失败'))
        const payload = args?.args as { id: string; name: string; baseUrl: string | null }
        workspaces = workspaces.map((workspace) =>
          workspace.id === payload.id
            ? { ...workspace, name: payload.name, baseUrl: payload.baseUrl }
            : workspace,
        )
        return Promise.resolve({
          items: workspaces.map((workspace) => ({
            ...workspace,
            isCurrent: workspace.id === currentId,
          })),
          currentId,
        })
      }
      return Promise.resolve(undefined)
    })

    await renderPane('w1')
    fireEvent.change(screen.getByLabelText('工作空间名称'), { target: { value: '失败重试空间' } })
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await vi.waitFor(() => {
      expect(screen.getByTestId('workspace-settings-save-state')).toHaveAttribute(
        'data-status',
        'failed',
      )
    })
    expect(screen.getByText('保存失败')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await vi.waitFor(() => {
      expect(renameAttempts).toBe(2)
    })
    await vi.waitFor(() => {
      expect(screen.getByTestId('workspace-settings-save-state')).toHaveAttribute(
        'data-status',
        'saved',
      )
    })
    expect(workspaces.find((workspace) => workspace.id === 'w1')?.name).toBe('失败重试空间')
  })

  it('写目标防串：切换查看对象（组件重挂载）时旧实例卸载即 flush，剩余编辑落回原空间', async () => {
    const { act } = await import('@testing-library/react')
    const view = render(<WorkspaceSettingsPane workspaceId="w1" />, {
      wrapper: createQueryWrapper(),
    })
    await vi.waitFor(() => {
      expect(screen.getByTestId('workspace-settings')).toBeInTheDocument()
    })
    fireEvent.change(screen.getByLabelText('工作空间名称'), { target: { value: 'W1改名' } })
    // 未到防抖窗口即切换查看对象（Tab 内容指针变更 → React key 重挂载，
    // 测试以卸载等价模拟）：旧 writer 实例 dispose 立即补写且目标是 w1
    view.unmount()
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    const renames = invokeMock.mock.calls.filter(([cmd]) => cmd === 'workspace.rename')
    expect(renames).toHaveLength(1)
    const payload = (renames[0]![1] as { args: { id: string; name: string } }).args
    expect(payload.id).toBe('w1')
    expect(payload.name).toBe('W1改名')
  })

  it('设为当前：查看非当前空间时显示按钮，点击写 workspace.set_current 并联动转当前徽章', async () => {
    await renderPane('w1')
    const button = screen.getByTestId('workspace-set-current')
    expect(screen.queryByTestId('workspace-current-badge')).not.toBeInTheDocument()
    fireEvent.click(button)
    await vi.waitFor(() => {
      const call = invokeMock.mock.calls.find(([cmd]) => cmd === 'workspace.set_current')
      expect(call?.[1]).toEqual({ id: 'w1' })
    })
    // set_current 更新清单（桩存储 currentId 随之）→ 失效重拉 → 徽章替换按钮
    await vi.waitFor(() => {
      expect(screen.queryByTestId('workspace-set-current')).not.toBeInTheDocument()
      expect(screen.getByTestId('workspace-current-badge')).toBeInTheDocument()
    })
  })

  it('查看对象已是当前空间：显示「当前」徽章（禁用按钮不做状态指示）', async () => {
    currentId = 'w1'
    stubInvokes()
    await renderPane('w1')
    expect(screen.getByTestId('workspace-current-badge')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-set-current')).not.toBeInTheDocument()
  })

  it('查看对象已被删除：明示空态（不渲染表单）', async () => {
    render(<WorkspaceSettingsPane workspaceId="w-missing" />, { wrapper: createQueryWrapper() })
    await vi.waitFor(() => {
      expect(screen.getByText('工作空间不存在或已删除')).toBeInTheDocument()
    })
    expect(screen.queryByLabelText('工作空间名称')).not.toBeInTheDocument()
  })

  it('拍板版式（三卡分节）：基本信息 / 认证 / 服务 卡标题呈现，说明性赘述不回归', async () => {
    await renderPane('w1')
    // 16 号拍板（变体 D）：居中限宽三卡——分节卡标题是版式的结构锚点
    expect(screen.getByRole('heading', { name: '基本信息' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '认证' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /服务/ })).toBeInTheDocument()
    // 无说明性赘述（字段标签即语义锚点纪律不随版式变化回归）
    expect(screen.queryByText('工作空间级配置，编辑后自动保存')).not.toBeInTheDocument()
    expect(screen.queryByText('请求默认值')).not.toBeInTheDocument()
    expect(screen.queryByText('接口请求的默认基地址，可留空')).not.toBeInTheDocument()
    expect(
      screen.queryByText('认证继承链的根，同源接口共享；接口 Auth 页签默认继承此处配置'),
    ).not.toBeInTheDocument()
  })

  it('横幅 meta 摘要行：BaseUrl 等宽 · 认证方式 · 服务数', async () => {
    services = [{ id: 's1', workspaceId: 'w1', name: '订单服务', docUrl: '/swagger/v1.json' }]
    stubInvokes()
    await renderPane('w1')
    expect(screen.getByText('未设置 BaseUrl')).toBeInTheDocument()
    expect(screen.getByText('未配置认证')).toBeInTheDocument()
    expect(screen.getByText('1 个服务')).toBeInTheDocument()
  })

  it('外部 ws-rename 后表单跟随新名：此后动键不以旧名为基线写库（复现 B）', async () => {
    const { act } = await import('@testing-library/react')
    // 自建独立 QueryClient（渲染外创建，测试直接持有——缓存直写等价于
    // 全局对话框 ws-rename 成功后清单键回真值的消费路径）
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, refetchOnWindowFocus: false },
        mutations: { retry: false },
      },
    })
    render(<WorkspaceSettingsPane workspaceId="w1" />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    })
    await vi.waitFor(() => {
      expect(screen.getByTestId('workspace-settings')).toBeInTheDocument()
    })
    expect(screen.getByLabelText('工作空间名称')).toHaveValue('查看空间')

    workspaces = [
      { id: 'w1', name: '对话框改名', baseUrl: null, auth: null },
      { id: 'w2', name: '当前空间', baseUrl: null, auth: null },
    ]
    act(() => {
      queryClient.setQueryData(workbenchKeys.workspaces(), {
        items: workspaces.map((workspace) => ({
          ...workspace,
          isCurrent: workspace.id === currentId,
        })),
        currentId,
      })
    })
    // 未触碰的字段跟随新名（不再持旧值等一动键回滚）；observer 通知经
    // 微任务批处理送达，用 waitFor 等跟随到位
    await vi.waitFor(() => {
      expect(screen.getByLabelText('工作空间名称')).toHaveValue('对话框改名')
    })

    // 此后动键：整包写的 name 基线＝新名（不把对话框改名写回旧名）
    fireEvent.change(screen.getByLabelText('BaseUrl'), { target: { value: 'http://new:1' } })
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    const renames = invokeMock.mock.calls.filter(([cmd]) => cmd === 'workspace.rename')
    expect(renames).toHaveLength(1)
    expect((renames[0]![1] as { args: { name: string } }).args.name).toBe('对话框改名')
  })

  it('名称清空＝行内 destructive 校验（aria-invalid），保存态回落 idle 不误导', async () => {
    const { act } = await import('@testing-library/react')
    await renderPane('w1')
    const nameInput = screen.getByLabelText('工作空间名称')
    expect(screen.queryByTestId('workspace-name-empty-error')).not.toBeInTheDocument()

    fireEvent.change(nameInput, { target: { value: '' } })
    expect(nameInput).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByTestId('workspace-name-empty-error')).toHaveTextContent('名称不能为空')
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    // 空名不落库：无「已保存」误导
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'workspace.rename')).toHaveLength(0)
    expect(screen.getByTestId('workspace-settings-save-state')).toHaveAttribute(
      'data-status',
      'idle',
    )

    // 恢复输入：校验提示随之消失
    fireEvent.change(nameInput, { target: { value: '恢复名' } })
    expect(screen.queryByTestId('workspace-name-empty-error')).not.toBeInTheDocument()
    expect(nameInput).not.toHaveAttribute('aria-invalid')
  })
})

describe('详情页服务列表', () => {
  it('渲染本空间服务行：名称 / 文档地址 / 状态徽标 / 操作', async () => {
    services = [
      { id: 's1', workspaceId: 'w1', name: '订单服务', docUrl: '/swagger/v1/swagger.json' },
      { id: 's2', workspaceId: 'w1', name: '手工容器服务', docUrl: null },
    ]
    stubInvokes()
    await renderPane('w1')
    const rows = screen.getAllByTestId('workspace-service-row')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByText('订单服务')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('/swagger/v1/swagger.json')).toBeInTheDocument()
    // 无文档地址＝状态列「手工容器」徽标；有文档＝状态列空（不监听连通状态）
    expect(within(rows[1]!).getByText('无文档地址')).toBeInTheDocument()
    expect(within(rows[0]!).queryByText('无文档地址')).not.toBeInTheDocument()
    // 行内操作：编辑 / 删除
    expect(within(rows[0]!).getByRole('button', { name: '编辑' })).toBeInTheDocument()
    expect(within(rows[0]!).getByRole('button', { name: '删除' })).toBeInTheDocument()
  })

  it('空态文案与列表头入口：新建服务 / 批量导入发 store 信号（目标＝查看对象）', async () => {
    await renderPane('w1')
    expect(screen.getByText('尚无服务，可新建或从文档批量导入。')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('workspace-service-new'))
    expect(useWorkspacesStore.getState().dialog).toEqual({ type: 'service-new', workspaceId: 'w1' })
    fireEvent.click(screen.getByTestId('workspace-service-import'))
    expect(useWorkspacesStore.getState().dialog).toEqual({ type: 'import', workspaceId: 'w1' })
  })

  it('服务清单加载期渲染骨架行占位（不闪空）', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'workspace.list') {
        return Promise.resolve({
          items: workspaces.map((workspace) => ({
            ...workspace,
            isCurrent: workspace.id === currentId,
          })),
          currentId,
        })
      }
      // 服务清单挂起不落地：停在 pending 骨架态
      if (cmd === 'service.list_by_workspace') return new Promise(() => {})
      return Promise.resolve(undefined)
    })
    render(<WorkspaceSettingsPane workspaceId="w1" />, { wrapper: createQueryWrapper() })
    await vi.waitFor(() => {
      expect(screen.getByTestId('workspace-settings')).toBeInTheDocument()
    })
    expect(screen.getByTestId('workspace-service-skeleton')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-service-row')).not.toBeInTheDocument()
  })

  it('行内编辑 / 删除发 store 信号（携带服务身份）', async () => {
    services = [{ id: 's1', workspaceId: 'w1', name: '订单服务', docUrl: '/swagger/doc.json' }]
    stubInvokes()
    await renderPane('w1')
    const row = screen.getAllByTestId('workspace-service-row')[0]!
    fireEvent.click(within(row).getByRole('button', { name: '编辑' }))
    expect(useWorkspacesStore.getState().dialog).toEqual({
      type: 'service-edit',
      id: 's1',
      name: '订单服务',
      docUrl: '/swagger/doc.json',
    })
    fireEvent.click(within(row).getByRole('button', { name: '删除' }))
    expect(useWorkspacesStore.getState().dialog).toEqual({
      type: 'service-delete',
      id: 's1',
      name: '订单服务',
    })
  })

  it('行内渲染拖拽手柄（按住才解锁该行拖拽）', async () => {
    services = [{ id: 's1', workspaceId: 'w1', name: '订单服务', docUrl: null }]
    stubInvokes()
    await renderPane('w1')
    expect(
      screen.getByTestId('workspace-service-row').querySelector('[data-drag-handle]'),
    ).not.toBeNull()
  })

  it('拖拽放下＝service.move_to 携摘除自身插入位；缓存失效重拉回真值', async () => {
    services = [
      { id: 's1', workspaceId: 'w1', name: '订单服务', docUrl: null },
      { id: 's2', workspaceId: 'w1', name: '手工容器服务', docUrl: null },
      { id: 's3', workspaceId: 'w1', name: '库存服务', docUrl: null },
    ]
    stubInvokes()
    // move_to 桩：摘除自身后插入 index 位（与 Rust 口径一致），返回后靠
    // 失效重拉让行序回流；其余命令沿用基础桩
    const baseImpl = invokeMock.getMockImplementation()
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'service.move_to') {
        const { id, index } = args as { id: string; index: number }
        const rest = services.filter((service) => service.id !== id)
        rest.splice(
          index,
          0,
          services.find((service) => service.id === id)!,
        )
        services = rest
        return Promise.resolve(undefined)
      }
      return baseImpl!(cmd, args)
    })

    const { act } = await import('@testing-library/react')
    await renderPane('w1')
    const rows = screen.getAllByTestId('workspace-service-row')
    // jsdom 无布局（rect 高 0 → 比例折半 → after）：s3 拖到 s1 行放下
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() }
    fireEvent.dragStart(rows[2]!, { dataTransfer })
    fireEvent.dragOver(rows[0]!, { dataTransfer })
    fireEvent.drop(rows[0]!, { dataTransfer })
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(invokeMock).toHaveBeenCalledWith('service.move_to', { id: 's3', index: 1 })
    // 失效重拉后行序回流：订单服务之后是库存服务
    await vi.waitFor(() => {
      const refreshed = screen.getAllByTestId('workspace-service-row')
      expect(within(refreshed[0]!).getByText('订单服务')).toBeInTheDocument()
      expect(within(refreshed[1]!).getByText('库存服务')).toBeInTheDocument()
      expect(within(refreshed[2]!).getByText('手工容器服务')).toBeInTheDocument()
    })
  })

  it('右键行上移/下移：首行禁上、末行禁下；点击走 service.move', async () => {
    services = [
      { id: 's1', workspaceId: 'w1', name: '订单服务', docUrl: null },
      { id: 's2', workspaceId: 'w1', name: '手工容器服务', docUrl: null },
    ]
    stubInvokes()
    await renderPane('w1')
    const rows = screen.getAllByTestId('workspace-service-row')

    fireEvent.contextMenu(rows[0]!)
    expect(screen.getByRole('menuitem', { name: '上移' })).toHaveAttribute('data-disabled')
    const { act } = await import('@testing-library/react')
    fireEvent.click(screen.getByRole('menuitem', { name: '下移' }))
    // Base UI 菜单项激活经内部时序（fake timers 下需手动推进）
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(invokeMock).toHaveBeenCalledWith('service.move', { id: 's1', direction: 'down' })
    await vi.waitFor(() => {
      expect(
        invokeMock.mock.calls.filter(([cmd]) => cmd === 'service.list_by_workspace').length,
      ).toBeGreaterThan(1)
    })

    fireEvent.contextMenu(rows[1]!)
    expect(screen.getByRole('menuitem', { name: '下移' })).toHaveAttribute('data-disabled')
    expect(screen.getByRole('menuitem', { name: '上移' })).not.toHaveAttribute('data-disabled')
  })
})

describe('详情页认证（继承链根）', () => {
  /** 打开认证类型选择器并选择指定类型（选项激活需先 pointerDown 再 click——
   *  Base UI 对未经指针按下的纯 click 视为无效） */
  async function selectAuthType(name: string) {
    fireEvent.click(screen.getByRole('combobox', { name: '认证方式' }))
    const option = await vi.waitFor(() => screen.getByRole('option', { name }))
    fireEvent.pointerDown(option)
    fireEvent.click(option)
  }

  it('认证渲染：未配置默认「不使用」，无「继承上级」项', async () => {
    await renderPane('w1')
    expect(screen.getByRole('combobox', { name: '认证方式' })).toHaveTextContent('不使用')
    // 类型集无「继承上级」（链根无上级可继承）
    fireEvent.click(screen.getByRole('combobox', { name: '认证方式' }))
    await vi.waitFor(() => {
      expect(screen.getByRole('option', { name: 'Bearer Token' })).toBeInTheDocument()
    })
    expect(screen.queryByRole('option', { name: '继承上级' })).not.toBeInTheDocument()
    expect(
      screen
        .getAllByRole('option')
        .map((option) => option.textContent)
        .filter((text): text is string => text !== null),
    ).toEqual([
      '不使用',
      'Bearer Token',
      'Basic Auth',
      'API Key · Header',
      'API Key · Query',
      'API Key · Cookie',
    ])
  })

  it('类型切换即时保存：workspace.set_auth 携带序列化 JSON（非防抖），落查看对象', async () => {
    await renderPane('w1')
    await selectAuthType('Bearer Token')
    await vi.waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'workspace.set_auth')
      expect(calls).toHaveLength(1)
      expect(calls[0]![1]).toEqual({ id: 'w1', auth: '{"type":"bearer","token":""}' })
    })
  })

  it('挂载读回：查看对象 auth 列播种类型与字段值', async () => {
    workspaces = [
      {
        id: 'w1',
        name: '查看空间',
        baseUrl: null,
        auth: '{"type":"apiKey","position":"header","key":"X-Key","value":"v"}',
      },
      { id: 'w2', name: '当前空间', baseUrl: null, auth: null },
    ]
    stubInvokes()
    await renderPane('w1')
    expect(screen.getByRole('combobox', { name: '认证方式' })).toHaveTextContent('API Key · Header')
    expect(screen.getByLabelText('Key')).toHaveValue('X-Key')
    expect(screen.getByLabelText('Value')).toHaveValue('v')
  })

  it('切回「不使用」清除配置面：写 none（显式阻断，等价未配置的合成语义）', async () => {
    workspaces = [
      { id: 'w1', name: '查看空间', baseUrl: null, auth: '{"type":"bearer","token":"t"}' },
      { id: 'w2', name: '当前空间', baseUrl: null, auth: null },
    ]
    stubInvokes()
    await renderPane('w1')
    await selectAuthType('不使用')
    await vi.waitFor(() => {
      const last = invokeMock.mock.calls.filter(([cmd]) => cmd === 'workspace.set_auth').at(-1)
      expect(last?.[1]).toEqual({ id: 'w1', auth: '{"type":"none"}' })
    })
    expect(screen.queryByLabelText('Token')).not.toBeInTheDocument()
  })

  it('认证文本字段防抖：窗口内多次键入合并一次 set_auth（不逐键打 IPC）', async () => {
    const { act } = await import('@testing-library/react')
    await renderPane('w1')
    await selectAuthType('Bearer Token')
    await vi.waitFor(() => {
      expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'workspace.set_auth')).toHaveLength(1)
    })

    const token = screen.getByLabelText('Token')
    fireEvent.change(token, { target: { value: 'a' } })
    fireEvent.change(token, { target: { value: 'ab' } })
    fireEvent.change(token, { target: { value: 'abc' } })
    // 防抖窗口内：合并不落
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'workspace.set_auth')).toHaveLength(1)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'workspace.set_auth')
    expect(calls).toHaveLength(2)
    expect(calls[1]![1]).toEqual({ id: 'w1', auth: '{"type":"bearer","token":"abc"}' })
  })

  it('认证文本字段失焦立即落盘（不等防抖窗口）', async () => {
    await renderPane('w1')
    await selectAuthType('Bearer Token')
    await vi.waitFor(() => {
      expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'workspace.set_auth')).toHaveLength(1)
    })

    const token = screen.getByLabelText('Token')
    fireEvent.change(token, { target: { value: 'root-tk' } })
    fireEvent.blur(token)
    await vi.waitFor(() => {
      const last = invokeMock.mock.calls.filter(([cmd]) => cmd === 'workspace.set_auth').at(-1)
      expect(last?.[1]).toEqual({ id: 'w1', auth: '{"type":"bearer","token":"root-tk"}' })
    })
  })

  it('认证写完成序：在途写未完成时新值排队补写，最终写＝最新草稿', async () => {
    // 挂载读回 bearer：直接编辑 Token，不经类型切换（隔离出纯字段写通道）
    workspaces = [
      { id: 'w1', name: '查看空间', baseUrl: null, auth: '{"type":"bearer","token":"t"}' },
      { id: 'w2', name: '当前空间', baseUrl: null, auth: null },
    ]
    stubInvokes()
    let setAuthCalls = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const base = invokeMock.getMockImplementation()
    if (base) {
      invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'workspace.set_auth') {
          setAuthCalls += 1
          // 首次字段写门闸挂起（在途写不完成的观测窗口）
          if (setAuthCalls === 1) return gate.then(() => base(cmd, args))
        }
        return base(cmd, args)
      })
    }

    const { act } = await import('@testing-library/react')
    await renderPane('w1')
    const token = screen.getByLabelText('Token')

    fireEvent.change(token, { target: { value: 'a' } })
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(setAuthCalls).toBe(1)

    // 在途写未完成时到达新值：排队补写，不并发第二写
    fireEvent.change(token, { target: { value: 'ab' } })
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(setAuthCalls).toBe(1)

    release()
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(setAuthCalls).toBe(2)
    const last = invokeMock.mock.calls.filter(([cmd]) => cmd === 'workspace.set_auth').at(-1)
    expect(last?.[1]).toEqual({ id: 'w1', auth: '{"type":"bearer","token":"ab"}' })
  })

  it('保存态聚合：认证写失败汇入页头单实例，重试只重发失败通道', async () => {
    const { act } = await import('@testing-library/react')
    let authAttempts = 0
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'workspace.list') {
        return Promise.resolve({
          items: workspaces.map((workspace) => ({
            ...workspace,
            isCurrent: workspace.id === currentId,
          })),
          currentId,
        })
      }
      if (cmd === 'service.list_by_workspace') return Promise.resolve([])
      if (cmd === 'workspace.set_auth') {
        authAttempts += 1
        if (authAttempts === 1) return Promise.reject(new Error('认证写入失败'))
        const payload = args as { id: string; auth: string }
        workspaces = workspaces.map((workspace) =>
          workspace.id === payload.id ? { ...workspace, auth: payload.auth } : workspace,
        )
        return Promise.resolve(undefined)
      }
      return Promise.resolve(undefined)
    })
    await renderPane('w1')
    // 字段旁不再各持保存态实例（两写通道聚合为页头单实例）
    expect(screen.queryByTestId('workspace-auth-save-state')).not.toBeInTheDocument()
    await selectAuthType('Bearer Token')
    await vi.waitFor(() => {
      expect(screen.getByTestId('workspace-settings-save-state')).toHaveAttribute(
        'data-status',
        'failed',
      )
    })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    await vi.waitFor(() => {
      expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'workspace.set_auth')).toHaveLength(2)
    })
    await vi.waitFor(() => {
      expect(screen.getByTestId('workspace-settings-save-state')).toHaveAttribute(
        'data-status',
        'saved',
      )
    })
  })
})
