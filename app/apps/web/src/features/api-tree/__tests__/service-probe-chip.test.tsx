import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProbeStore } from '@/stores/probe.store'

import { ServiceProbeChip } from '../service-probe-chip'

/**
 * 服务可达性徽标（非交互展示件）：探测中 / 不可达 / 未知呈图标＋标签＋
 * 语义浅底（浅底在外层元素首子背景层 span 上）持续呈现；可达＝一次性
 * 宣告——完整徽标保持 3 秒（fake timers 断言），期满整体退场（背景透明、
 * padding 收缩、图标与标签 max-w／opacity／scale 收敛，DOM 恒渲染仅切
 * 类名），退场动画播完（+200ms）在探测 store 标记 reachShown 并整体
 * 卸载；重挂载（虚拟滚动）不重现，唯 probing 事件（新一轮探测）清标记
 * 后重新宣告。无点击刷新（刷新入口＝树底计数行全量刷新按钮）。测试环境
 * locale 解析为 zh-CN（system + 无 systemLocale 兜底），文案按 zh-CN
 * 字典断言。
 */
describe('ServiceProbeChip', () => {
  beforeEach(() => {
    useProbeStore.setState({ statuses: {}, reachShown: {} })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('缺状态记录回落「未知」：中性灰浅底＋减号图标；非交互（span 而非按钮）', () => {
    render(<ServiceProbeChip serviceId="s1" />)
    const chip = screen.getByTestId('service-probe-chip-unknown')
    expect(chip.tagName).toBe('SPAN')
    expect(chip.textContent).toBe('未知')
    expect(chip.className).toContain('text-muted-foreground')
    // 浅底在背景层（外层首子元素）而非外层自身
    expect(chip.children[0].getAttribute('class')).toContain('bg-muted-foreground/10')
    expect(chip.querySelector('svg')).toBeTruthy()
  })

  it('可达＝徽标保持 3 秒后整体退场（+200ms 卸载并标记 store），不再驻留圆点', () => {
    vi.useFakeTimers()
    useProbeStore.setState({ statuses: { s1: 'reachable' } })
    render(<ServiceProbeChip serviceId="s1" />)
    // 保持期内仍为完整浅底徽标：背景层浅底、展开态 padding、标签展开；
    // 行高 ≥1.4（leading-normal）防 CJK 竖向裁字
    const chip = screen.getByTestId('service-probe-chip-reachable')
    expect(chip.children[0].getAttribute('class')).toContain('bg-success/10')
    expect(chip.children[0].getAttribute('class')).toContain('rounded-full')
    expect(chip.className).toContain('px-1.5')
    expect(chip.className).not.toContain('cursor-pointer')
    expect(screen.getByText('可达').getAttribute('class')).toContain('max-w-[8rem]')
    expect(chip.className).toContain('leading-normal')
    // 保持期满：退场动画开始——背景层渐透明（bg-success/0）、外层收窄
    // （px-0），图标与标签收敛隐藏且 scale 归零；DOM 仍在（动画播放中）
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    const exiting = screen.getByTestId('service-probe-chip-reachable')
    expect(exiting.children[0].getAttribute('class')).toContain('bg-success/0')
    expect(exiting.className).toContain('px-0')
    expect(exiting.querySelector('svg')?.getAttribute('class')).toContain('max-w-0')
    expect(exiting.querySelector('svg')?.getAttribute('class')).toContain('scale-0')
    expect(screen.getByText('可达').getAttribute('class')).toContain('max-w-0')
    expect(screen.getByText('可达').getAttribute('class')).toContain('opacity-0')
    // 退场动画播完：整体卸载，store 标记「已展示」
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(screen.queryByTestId('service-probe-chip-reachable')).toBeNull()
    expect(useProbeStore.getState().reachShown).toEqual({ s1: true })
  })

  it('已展示后重挂载（虚拟滚动）不重现；唯 probing 事件清标记后重新宣告', () => {
    vi.useFakeTimers()
    useProbeStore.setState({ statuses: { s1: 'reachable' } })
    const first = render(<ServiceProbeChip serviceId="s1" />)
    // 保持期与退场动画分段推进（fake timers 下级联定时器须跨 act 边界调度）
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    first.unmount()
    // 重挂载：可达宣告已消费，不渲染徽标
    const second = render(<ServiceProbeChip serviceId="s1" />)
    expect(second.container.querySelector('[data-testid^="service-probe-chip-"]')).toBeNull()
    second.unmount()
    // 新一轮探测：probing 事件清标记，探测中徽标呈现
    act(() => {
      useProbeStore.getState().applyEvent({ serviceId: 's1', status: 'probing' })
    })
    const third = render(<ServiceProbeChip serviceId="s1" />)
    expect(screen.getByTestId('service-probe-chip-probing').textContent).toBe('探测中')
    // 探测结果可达：重新完整宣告一轮（保持期从头计）
    act(() => {
      useProbeStore.getState().applyEvent({ serviceId: 's1', status: 'reachable' })
    })
    expect(screen.getByTestId('service-probe-chip-reachable').textContent).toBe('可达')
    act(() => {
      vi.advanceTimersByTime(2999)
    })
    expect(screen.getByTestId('service-probe-chip-reachable')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(screen.queryByTestId('service-probe-chip-reachable')).toBeNull()
    third.unmount()
  })

  it('状态变离可达（重探回探测中）立即回完整徽标态', () => {
    vi.useFakeTimers()
    useProbeStore.setState({ statuses: { s1: 'reachable' } })
    render(<ServiceProbeChip serviceId="s1" />)
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.getByText('可达').getAttribute('class')).toContain('max-w-0')
    // 事件回流探测中：无需等待，立即展开徽标
    act(() => {
      useProbeStore.setState({ statuses: { s1: 'probing' } })
    })
    expect(screen.getByText('探测中').getAttribute('class')).toContain('max-w-[8rem]')
    expect(screen.getByTestId('service-probe-chip-probing').className).toContain('px-1.5')
  })

  it('不可达＝destructive 浅底＋云断开图标，持续呈现不消失', () => {
    useProbeStore.setState({ statuses: { s1: 'unreachable' } })
    render(<ServiceProbeChip serviceId="s1" />)
    const chip = screen.getByTestId('service-probe-chip-unreachable')
    expect(chip.textContent).toBe('不可达')
    expect(chip.className).toContain('text-destructive')
    // 浅底在背景层（外层首子元素）而非外层自身
    expect(chip.children[0].getAttribute('class')).toContain('bg-destructive/10')
  })

  it('探测中＝muted 浅底＋加载图标旋转（其余态不旋转）', () => {
    useProbeStore.setState({ statuses: { s1: 'probing', s2: 'unknown' } })
    const view = render(
      <>
        <ServiceProbeChip serviceId="s1" />
        <ServiceProbeChip serviceId="s2" />
      </>,
    )
    const probing = screen.getByTestId('service-probe-chip-probing')
    expect(probing.textContent).toBe('探测中')
    // 浅底在背景层（外层首子元素）而非外层自身
    expect(probing.children[0].getAttribute('class')).toContain('bg-muted-foreground/10')
    // SVG 的 className 是 SVGAnimatedString，断言走 class 属性字面量
    expect(probing.querySelector('svg')?.getAttribute('class')).toContain('animate-spin')
    expect(
      screen.getByTestId('service-probe-chip-unknown').querySelector('svg')?.getAttribute('class'),
    ).not.toContain('animate-spin')
    view.unmount()
  })
})
