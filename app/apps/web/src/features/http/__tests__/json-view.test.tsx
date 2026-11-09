import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { JsonView } from '../json-view'

/**
 * 共享 JsonView 直测：两空格缩进＋着色呈现、字符串值直用、32KB 体量护栏
 * 退纯 pre 不着色、区域放行划选与复制口径（显示什么就复制什么）。
 */

// —— 剪贴板替换（jsdom 无 navigator.clipboard；复制口径消费） ——
const writeTextMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))

beforeEach(() => {
  writeTextMock.mockClear()
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: writeTextMock },
  })
})

describe('共享 JsonView', () => {
  it('对象值两空格缩进＋着色 token 呈现', () => {
    render(<JsonView value={{ a: 1 }} />)
    const view = screen.getByTestId('json-view')
    expect(view.textContent).toBe('{\n  "a": 1\n}')
    expect(view.querySelectorAll('pre span').length).toBeGreaterThan(0)
  })

  it('字符串值直用不二次序列化（格式化口径由调用方决定）', () => {
    render(<JsonView value={'{"raw":1}'} />)
    expect(screen.getByTestId('json-view').textContent).toBe('{"raw":1}')
  })

  it('超体量护栏（32KB）退纯 pre 不着色，区域仍可选可复制', () => {
    const big = `{"pad":"${'x'.repeat(40 * 1024)}"}`
    render(<JsonView value={big} />)
    const view = screen.getByTestId('json-view')
    // 护栏内不着色：无 token span，文本原样呈现
    expect(view.querySelectorAll('pre span')).toHaveLength(0)
    expect(view.textContent).toBe(big)
    expect(view).toHaveClass('select-text')
    expect(within(view).getByRole('button', { name: '复制' })).toBeInTheDocument()
  })

  it('区域放行划选（select-text）且复制口径与显示同源', async () => {
    render(<JsonView value={{ a: 1 }} />)
    const view = screen.getByTestId('json-view')
    expect(view).toHaveClass('select-text')
    fireEvent.click(within(view).getByRole('button', { name: '复制' }))
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith('{\n  "a": 1\n}')
    })
  })
})
