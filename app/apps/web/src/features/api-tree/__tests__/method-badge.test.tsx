import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MethodBadge } from '../method-badge'

/**
 * 方法徽章：全项目方法展示的唯一实现（树行 / 标签栏 / 选择器值区与选项同源）。
 * 锁定的是「语义色恒定」这条契约本身，不是渲染细节。
 */
describe('MethodBadge', () => {
  it('七选各自带方法语义色，且颜色为 important（菜单项聚焦态不得压掉）', () => {
    const cases = [
      ['GET', 'text-method-get!'],
      ['POST', 'text-method-post!'],
      ['PUT', 'text-method-put!'],
      ['PATCH', 'text-method-patch!'],
      ['DELETE', 'text-method-delete!'],
      ['HEAD', 'text-method-misc!'],
      ['OPTIONS', 'text-method-misc!'],
    ] as const
    for (const [method, expected] of cases) {
      const view = render(<MethodBadge method={method} />)
      // important 是必要的：SelectItem 聚焦时以 **:text-accent-foreground（0-3-0）
      // 覆盖后代文字色，普通单类会被压掉、方法色在选项行悬浮瞬间消失
      expect(screen.getByLabelText(method)).toHaveClass(expected)
      view.unmount()
    }
  })

  it('未映射的方法回落灰档，不因缺映射丢样式', () => {
    render(<MethodBadge method="TRACE" />)
    expect(screen.getByLabelText('TRACE')).toHaveClass('text-method-misc!')
  })

  it('md 档（地址条）＝浅底深字 13px：底与字随方法语义色，无白字', () => {
    render(<MethodBadge method="GET" size="md" />)
    const badge = screen.getByLabelText('GET')
    expect(badge.className).toContain('bg-method-get-bg')
    expect(badge.className).toContain('text-method-get!')
    expect(badge.className).toContain('text-[13px]')
    expect(badge.className).not.toContain('text-white')
  })

  it('lg 档（下拉选项）＝无底彩字 13px：不带实底色类', () => {
    render(<MethodBadge method="DELETE" size="lg" />)
    const badge = screen.getByLabelText('DELETE')
    expect(badge.className).toContain('text-method-delete!')
    expect(badge.className).toContain('text-[13px]')
    expect(badge.className).not.toContain('bg-method')
  })
})
