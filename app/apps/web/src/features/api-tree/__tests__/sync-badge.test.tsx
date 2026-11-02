import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { SyncBadgeChip } from '../sync-badge'

/**
 * 同步徽标：new / changed 两态语义浅底短标签——新增＝success、变更＝
 * warning，沿可达芯片与请求级徽标的浅底徽标体系（测试环境 locale 解析为
 * zh-CN，文案按 zh-CN 字典断言）。短词不自释义，悬停经统一 Tooltip 给出
 * 两态含义。锁定的是语义色契约与释义文案，不是布局细节。
 */
describe('SyncBadgeChip', () => {
  it('新增＝success 浅底圆角短词，悬停 Tooltip 释义', async () => {
    render(<SyncBadgeChip badge="new" />)
    const chip = screen.getByText('新增')
    expect(chip.className).toContain('bg-success/10')
    expect(chip.className).toContain('text-success')
    expect(chip.className).toContain('rounded-full')
    // 悬停触发器（徽标外层 span）出现释义 Tooltip。事件序列对齐底座
    // hover 交互：pointerEnter 登记指针形态（floating-ui 对无形态的合成
    // 事件按虚拟指针忽略）→ mouseenter → mousemove（rest 检测）
    const hover = (trigger: HTMLElement) => {
      fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
      fireEvent.mouseEnter(trigger)
      fireEvent.mouseMove(trigger, { movementX: 0, movementY: 0 })
    }
    hover(chip.closest('[data-slot="tooltip-trigger"]') as HTMLElement)
    expect(await screen.findByText('上次同步新增的接口，下次同步后清除标识')).toBeInTheDocument()
  })

  it('变更＝warning 浅底短词，悬停 Tooltip 释义', async () => {
    render(<SyncBadgeChip badge="changed" />)
    const chip = screen.getByText('变更')
    expect(chip.className).toContain('bg-warning/10')
    expect(chip.className).toContain('text-warning')
    fireEvent.pointerEnter(chip.parentElement!, { pointerType: 'mouse' })
    fireEvent.mouseEnter(chip.parentElement!)
    fireEvent.mouseMove(chip.parentElement!, { movementX: 0, movementY: 0 })
    expect(await screen.findByText('上次同步更新的接口，下次同步后清除标识')).toBeInTheDocument()
  })
})
