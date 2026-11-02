import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSyncWizardStore, type ServiceRunState } from '@/stores/sync.store'
import { createQueryWrapper } from '@/test/render-providers'

import type { DiffOutcome, EndpointDiff } from '../diff-contract'
import { CompareStep } from '../wizard-compare'

// IPC 桩：应用载荷与重试编排是本测试对象
const syncApply = vi.fn()
const syncFetch = vi.fn()
const syncDiff = vi.fn()
const endpointUsage = vi.fn()
vi.mock('@/features/sync/sync-api', () => ({
  syncApply: (...args: unknown[]) => syncApply(...args),
  syncFetch: (...args: unknown[]) => syncFetch(...args),
  syncDiff: (...args: unknown[]) => syncDiff(...args),
}))

// 引用反查桩（「将删除」行计数徽章的数据源）
vi.mock('@/features/workflow/workflow-api', () => ({
  workflowEndpointUsage: (...args: unknown[]) => endpointUsage(...args),
  workflowKeys: {
    endpointUsage: (workspaceId: string, keys: readonly string[]) => [
      'workflow',
      'endpointUsage',
      workspaceId,
      [...keys].sort().join('\n'),
    ],
  },
}))

// 服务名面桩（useSyncServiceOptions 走工作空间树查询）
vi.mock('@/features/workspaces/api', () => ({
  useCurrentWorkspaceTreeQuery: () => ({
    data: {
      services: [
        { id: 's1', name: '服务一', docUrl: 'http://a' },
        { id: 's2', name: '服务二', docUrl: 'http://b' },
      ],
    },
    workspaceId: 'w1',
  }),
}))

function rowOf(key: string, kind: EndpointDiff['kind']): EndpointDiff {
  return {
    key,
    kind,
    title: 't',
    category: '',
    params: [],
    bodyKeys: [],
    responses: [],
  }
}

function diffOf(diffs: EndpointDiff[]): DiffOutcome {
  const summary = { added: 0, changed: 0, removed: 0, unchanged: 0 }
  for (const d of diffs) summary[d.kind] += 1
  return { serviceId: 's1', generation: 1, summary, diffs }
}

const OK_RUN: ServiceRunState = {
  status: 'ok',
  diff: diffOf([rowOf('GET /users', 'added'), rowOf('GET /orders', 'removed')]),
}

function seed(runs: Record<string, ServiceRunState>) {
  useSyncWizardStore.setState({ open: true, phase: 'compare', runs })
}

/** 按稳定键定位其行内勾选框（勾选与展开按钮不嵌套，交互互不干扰） */
function rowCheck(container: HTMLElement, key: string): Element {
  const row = container.querySelector(`[data-endpoint-key="${key}"]`)
  expect(row).not.toBeNull()
  return row!.querySelector('[data-testid="wizard-row-check"]')!
}

describe('CompareStep（接口粒度勾选与失败重试）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSyncWizardStore.getState().closeWizard()
    syncApply.mockResolvedValue({ added: 0, changed: 0, removed: 0, unchanged: 0 })
    endpointUsage.mockResolvedValue({})
  })

  it('默认全选：按钮计数为全部行数，应用按服务携带全部稳定键', () => {
    seed({ s1: OK_RUN })
    const { container } = render(<CompareStep />, { wrapper: createQueryWrapper() })
    expect(screen.getByText('确认应用 · 2 项变更')).toBeDefined()
    fireEvent.click(screen.getByText('确认应用 · 2 项变更'))
    expect(syncApply).toHaveBeenCalledWith('s1', ['GET /users', 'GET /orders'])
    void container
  })

  it('取消勾选行后应用：载荷只含勾选键、按钮计数随勾选集收敛', () => {
    seed({ s1: OK_RUN })
    const { container } = render(<CompareStep />, { wrapper: createQueryWrapper() })
    fireEvent.click(rowCheck(container, 'GET /users'))
    expect(screen.getByText('确认应用 · 1 项变更')).toBeDefined()
    fireEvent.click(screen.getByText('确认应用 · 1 项变更'))
    expect(syncApply).toHaveBeenCalledWith('s1', ['GET /orders'])
  })

  it('全部取消勾选：应用按钮禁用（空载荷不出手）', () => {
    seed({ s1: OK_RUN })
    const { container } = render(<CompareStep />, { wrapper: createQueryWrapper() })
    fireEvent.click(rowCheck(container, 'GET /users'))
    // 已移除行在另一页签（统计页签＝一次一组）：切组后再取消勾选
    fireEvent.click(screen.getByTestId('wizard-tab-removed'))
    fireEvent.click(rowCheck(container, 'GET /orders'))
    const button = screen.getByText('确认应用 · 0 项变更').closest('button')!
    expect(button).toHaveProperty('disabled', true)
    fireEvent.click(button)
    expect(syncApply).not.toHaveBeenCalled()
  })

  it('「将删除」行呈现引用计数徽章（反查命中；无引用行无徽章）', async () => {
    endpointUsage.mockResolvedValue({
      'GET /orders': [{ workflowId: 'wf1', workflowName: '登录链' }],
    })
    seed({ s1: OK_RUN })
    render(<CompareStep />, { wrapper: createQueryWrapper() })
    expect(endpointUsage).toHaveBeenCalledWith('w1', ['GET /orders'])
    fireEvent.click(screen.getByTestId('wizard-tab-removed'))
    await waitFor(() => {
      expect(screen.getByTestId('wizard-removed-usage')).toHaveTextContent('1 个工作流引用')
    })
  })

  it('无变化终态：底部呈现完成按钮，点击关闭向导', () => {
    seed({ s1: { status: 'ok', diff: diffOf([]) } })
    render(<CompareStep />, { wrapper: createQueryWrapper() })
    fireEvent.click(screen.getByText('完成'))
    expect(useSyncWizardStore.getState().open).toBe(false)
  })

  it('部分跳过：清单后呈现失败小节，行级重试重走单服务拉取→对比', async () => {
    syncFetch.mockResolvedValue({})
    syncDiff.mockResolvedValue({ ...diffOf([rowOf('GET /fresh', 'added')]), serviceId: 's2' })
    seed({ s1: OK_RUN, s2: { status: 'skipped', errorMessage: 'unreachable' } })
    render(<CompareStep />, { wrapper: createQueryWrapper() })

    const section = screen.getByTestId('wizard-skipped-section')
    expect(section.textContent).toContain('unreachable')
    fireEvent.click(screen.getByText('重试'))
    expect(syncFetch).toHaveBeenCalledWith('s2')
    // 重试成功：run 转 ok，失败小节收敛、新行入清单
    await waitFor(() => {
      expect(screen.queryByTestId('wizard-skipped-section')).toBeNull()
    })
    expect(screen.getByText('确认应用 · 3 项变更')).toBeDefined()
  })

  it('全跳过面：失败明细行带重试按钮，点击后转入拉取态', async () => {
    syncFetch.mockRejectedValue(new Error('timeout'))
    seed({ s1: { status: 'skipped', errorMessage: 'unreachable' } })
    render(<CompareStep />, { wrapper: createQueryWrapper() })
    expect(screen.getByTestId('wizard-all-skipped')).toBeDefined()
    fireEvent.click(screen.getByText('重试'))
    expect(syncFetch).toHaveBeenCalledWith('s1')
    // 失败回 skipped：错误信息行内刷新（面保持全跳过态）
    await waitFor(() => {
      expect(screen.getByText('timeout')).toBeDefined()
    })
  })

  it('混合终态：成功服务全部无变化且有拉取失败——区分文案外呈现失败清单与重试入口', () => {
    // s1 拉取成功但 diff 全空（零变更行）＝无变化；s2 拉取失败
    seed({
      s1: { status: 'ok', diff: diffOf([]) },
      s2: { status: 'skipped', errorMessage: 'unreachable' },
    })
    render(<CompareStep />, { wrapper: createQueryWrapper() })

    // 不再被「无变化」分支吞掉：独立终态面＋失败明细＋行级重试
    expect(screen.getByTestId('wizard-no-changes-skipped')).toBeDefined()
    expect(screen.getByText('1 个服务无变化 · 1 个服务拉取失败')).toBeDefined()
    expect(screen.getByText('unreachable')).toBeDefined()
    expect(screen.getByText('重试')).toBeDefined()
  })

  it('重试中按钮禁用保留占位（行尾宽度不跳动）', async () => {
    // 拉取挂起：点击重试后停在 fetching 态，断言按钮在且禁用
    let resolveFetch: (v: unknown) => void = () => {}
    syncFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        }),
    )
    seed({ s1: { status: 'skipped', errorMessage: 'unreachable' } })
    render(<CompareStep />, { wrapper: createQueryWrapper() })

    fireEvent.click(screen.getByText('重试'))
    expect(syncFetch).toHaveBeenCalledWith('s1')
    const button = screen.getByText('重试').closest('button')!
    expect(button).toBeDefined()
    expect(button).toHaveProperty('disabled', true)
    resolveFetch({})
  })

  it('统计页签用语义 token（success/warning，无 emerald/amber 硬编码）', () => {
    seed({ s1: OK_RUN })
    const { container } = render(<CompareStep />, { wrapper: createQueryWrapper() })

    // 选中组（默认新增页签）＝success 语义 token（浅色值经 WCAG AA 校验）
    expect(screen.getByTestId('wizard-tab-added').className).toContain('text-success')
    // 未选组为灰字；切到变更组后承载 warning token（计数单点：页签即汇总）
    expect(screen.getByTestId('wizard-tab-changed').className).not.toContain('text-warning')
    fireEvent.click(screen.getByTestId('wizard-tab-changed'))
    expect(screen.getByTestId('wizard-tab-changed').className).toContain('text-warning')
    // emerald/amber 硬编码不再出现（明暗主题等价由 token 承担）
    expect(
      container.querySelector(
        '.text-emerald-600, .text-emerald-400, .text-amber-600, .text-amber-400',
      ),
    ).toBeNull()
  })
})
