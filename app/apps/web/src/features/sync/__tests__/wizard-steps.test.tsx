import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useProbeStore } from '@/stores/probe.store'
import { useSyncWizardStore } from '@/stores/sync.store'
import { createQueryWrapper } from '@/test/render-providers'

import { RunningStep, SelectStep } from '../wizard-steps'

// 服务名面桩（useSyncServiceOptions 走工作空间树查询）：s3 无文档地址不可选
vi.mock('@/features/workspaces/api', () => ({
  useCurrentWorkspaceTreeQuery: () => ({
    data: {
      services: [
        { id: 's1', name: '服务一', docUrl: 'http://a' },
        { id: 's2', name: '服务二', docUrl: 'http://b' },
        { id: 's3', name: '服务三', docUrl: null },
      ],
    },
  }),
}))

describe('SelectStep（全选切换与运行态 token）', () => {
  beforeEach(() => {
    useSyncWizardStore.getState().closeWizard()
    useProbeStore.setState({ statuses: {} })
  })

  it('全选钮：未全选时点选全部可选服务（无文档地址者除外）；已全选再点切换全不选', () => {
    render(<SelectStep />, { wrapper: createQueryWrapper() })
    const button = screen.getByRole('button', { name: '全选' })

    expect(button.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(button)
    expect(useSyncWizardStore.getState().selectedServiceIds).toEqual(['s1', 's2'])
    expect(button.getAttribute('aria-pressed')).toBe('true')

    // 已全选再点＝全不选（此前重复点击仍是全选，无退出路径）
    fireEvent.click(button)
    expect(useSyncWizardStore.getState().selectedServiceIds).toEqual([])
    expect(button.getAttribute('aria-pressed')).toBe('false')
  })

  it('可达芯片与运行 ok 图标用语义 token（无 emerald/amber 硬编码）', () => {
    useProbeStore.setState({ statuses: { s1: 'reachable' } })
    useSyncWizardStore.setState({
      open: true,
      phase: 'running',
      runs: { s1: { status: 'ok' } },
    })
    const { container } = render(
      <>
        <SelectStep />
        <RunningStep />
      </>,
      { wrapper: createQueryWrapper() },
    )

    // 可达＝success 语义 token（明暗主题等价由 token 承担）
    const probeChip = screen.getByText('服务可达').closest('span')!
    expect(probeChip.className).toContain('text-success')
    expect(
      container.querySelector(
        '.text-emerald-600, .text-emerald-400, .text-amber-600, .text-amber-400',
      ),
    ).toBeNull()
  })

  it('活动面板呈现文档地址与已用时读秒；完成行带运行耗时', () => {
    useSyncWizardStore.setState({
      open: true,
      phase: 'running',
      runs: {
        s1: { status: 'fetching', startedAt: Date.now() - 1200 },
        s2: { status: 'ok', durationMs: 800 },
      },
    })
    render(<RunningStep />, { wrapper: createQueryWrapper() })

    // 活动面板：文档地址（mono 副行）＋已用时读秒（0.1s 粒度格式）
    const activityLine = screen.getByText(/已用时/).closest('p')!
    expect(activityLine.textContent).toContain('http://a')
    expect(activityLine.textContent).toMatch(/已用时 \d+(\.\d+)?s/)
    // 完成行：运行耗时随行呈现
    expect(screen.getByText('完成 · 0.8s')).toBeDefined()
  })

  it('拉取中行内出取消按钮（仅 fetching 行）；取消落定行呈中性「已取消」', () => {
    useSyncWizardStore.setState({
      open: true,
      phase: 'running',
      runs: {
        s1: { status: 'fetching' },
        s2: { status: 'ok' },
        s3: { status: 'skipped', cancelled: true },
      },
    })
    const cancelSpy = vi.spyOn(useSyncWizardStore.getState(), 'cancelService')
    render(<RunningStep />, { wrapper: createQueryWrapper() })

    // 仅拉取中的行有取消按钮；点击调 cancelService
    const buttons = screen.getAllByTestId('wizard-cancel-fetch')
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0]!)
    expect(cancelSpy).toHaveBeenCalledWith('s1')

    // 取消落定＝中性「已取消」文案（非失败红色错误）
    const cancelledText = screen.getByText('已取消')
    expect(cancelledText.className).not.toContain('text-destructive')
  })
})
