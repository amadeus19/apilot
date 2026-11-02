import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSyncWizardStore } from '@/stores/sync.store'
import { createQueryWrapper } from '@/test/render-providers'

import { SyncWizard } from '../sync-wizard'

// 「上次同步」查询替换为可注入值：壳层只验证头部的呈现条件（真实查询
// 与格式化在 wizard-data 的单测覆盖），不引入 IPC / 工作空间查询接线
const lastSynced = vi.hoisted(() => ({ value: null as string | null }))
vi.mock('../wizard-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wizard-data')>()
  return { ...actual, useLastSyncedAt: () => lastSynced.value }
})

/** 壳层冒烟：段位分发与关闭重置＋compare 段终态（无变化 / 全跳过）；
 *  聚合 / 分组纯函数的表驱动测试在 diff-json.test.ts */
describe('SyncWizard（四段壳层分发）', () => {
  beforeEach(() => {
    lastSynced.value = null
    useSyncWizardStore.getState().closeWizard()
  })

  it('未打开时不渲染向导', () => {
    render(<SyncWizard />, { wrapper: createQueryWrapper() })
    expect(screen.queryByTestId('sync-wizard')).toBeNull()
  })

  it('select 段呈现服务选择面', () => {
    useSyncWizardStore.getState().openWizard()
    render(<SyncWizard />, { wrapper: createQueryWrapper() })
    expect(screen.getByTestId('wizard-select')).toBeDefined()
    expect(screen.getByText('同步')).toBeDefined()
  })

  it('compare 段无差异时呈现无变化终态（无应用按钮）', () => {
    useSyncWizardStore.setState({ open: true, phase: 'compare', runs: {} })
    render(<SyncWizard />, { wrapper: createQueryWrapper() })
    expect(screen.getByTestId('wizard-no-changes')).toBeDefined()
    expect(screen.getByText('所选项与快照一致 · 无变化')).toBeDefined()
  })

  it('compare 段全跳过时呈现失败明细而非误导性「无变化」', () => {
    useSyncWizardStore.setState({
      open: true,
      phase: 'compare',
      runs: { s1: { status: 'skipped', errorMessage: 'SYNC_BAD_SWAGGER: unsupported version' } },
    })
    render(<SyncWizard />, { wrapper: createQueryWrapper() })
    // 全跳过有自己的呈现面（曾误呈现「无变化」让首次同步看似无路可走）
    expect(screen.getByTestId('wizard-all-skipped')).toBeDefined()
    expect(screen.getByText('所选服务本次全部跳过')).toBeDefined()
    expect(screen.getByText('SYNC_BAD_SWAGGER: unsupported version')).toBeDefined()
    expect(screen.queryByText('所选项与快照一致 · 无变化')).toBeNull()
  })

  it('done 段呈现四格统计卡（数字与语义标签分列）', () => {
    useSyncWizardStore.setState({
      open: true,
      phase: 'done',
      lastSummary: {
        added: 2,
        changed: 1,
        removed: 0,
        unchanged: 3,
      },
    })
    render(<SyncWizard />, { wrapper: createQueryWrapper() })
    expect(screen.getByTestId('wizard-done')).toBeDefined()
    expect(screen.getByText('同步完成')).toBeDefined()
    const stats = screen.getByTestId('wizard-done-stats')
    // 四格顺序：新增 / 变更 / 已移除 / 无变化（计数与标签同格）
    const cells = within(stats).getAllByRole('paragraph')
    expect(cells.map((cell) => cell.textContent)).toEqual([
      '2',
      '新增',
      '1',
      '变更',
      '0',
      '已移除',
      '3',
      '无变化',
    ])
    for (const label of ['新增', '变更', '已移除', '无变化']) {
      expect(within(stats).getByText(label)).toBeDefined()
    }
    // 无已应用快照时不呈现「上次同步」（查询未启用，不得误渲染）
    expect(screen.queryByTestId('wizard-last-synced')).toBeNull()
  })

  it('头部呈现「上次同步」时间（有已应用快照时）', () => {
    lastSynced.value = '2026-10-18T14:02:00.000Z'
    useSyncWizardStore.getState().openWizard()
    render(<SyncWizard />, { wrapper: createQueryWrapper() })
    expect(screen.getByTestId('wizard-last-synced').textContent).toMatch(
      /^上次同步 \d{2}-\d{2} \d{2}:\d{2}$/,
    )
  })

  it('向导 Dialog 有 aria-describedby 概述（Description 补齐）', () => {
    useSyncWizardStore.getState().openWizard()
    render(<SyncWizard />, { wrapper: createQueryWrapper() })
    const dialog = screen.getByTestId('sync-wizard')
    expect(dialog.getAttribute('aria-describedby')).not.toBeNull()
    expect(screen.getByText('拉取服务文档并与快照对比，确认后应用变更')).toBeDefined()
  })

  it('applying 中点关闭钮与 Esc 均不关闭向导（应用链路保持）', () => {
    useSyncWizardStore.setState({ open: true, phase: 'compare', applying: true })
    render(<SyncWizard />, { wrapper: createQueryWrapper() })

    // 关闭请求被守卫忽略：store 不重置（applyAll 的落库循环与完成摘要
    // 呈现均依赖状态保持），与底部按钮 disabled={applying} 口径一致
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(useSyncWizardStore.getState().open).toBe(true)
    fireEvent.keyDown(screen.getByTestId('sync-wizard'), { key: 'Escape' })
    expect(useSyncWizardStore.getState().open).toBe(true)
  })

  it('非 applying 期 Esc 照常关闭（守卫不误伤既有取消链路）', () => {
    useSyncWizardStore.setState({ open: true, phase: 'compare', applying: false })
    render(<SyncWizard />, { wrapper: createQueryWrapper() })
    fireEvent.keyDown(screen.getByTestId('sync-wizard'), { key: 'Escape' })
    expect(useSyncWizardStore.getState().open).toBe(false)
  })
})
