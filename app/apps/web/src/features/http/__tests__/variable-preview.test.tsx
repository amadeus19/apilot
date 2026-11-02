import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Toaster } from '@workspace/ui/components'

import type { ResolvedPreviewDto } from '../http-api'
import { VariablePreview } from '../variable-preview'

/**
 * 变量解析预览（Variable Preview）：发送响应附带 resolved 信息的消费面。
 * 测外部行为：命中 / 未命中标示、Secret 值默认掩码与「显示明文」放行、
 * 复制口径恒掩码、空消费态。
 */

// 剪贴板 spy（jsdom 无 navigator.clipboard，Proxy 全局 stub、其余透传）
const clipboardState = vi.hoisted(() => ({
  current: { writeText: vi.fn() },
}))

beforeEach(() => {
  clipboardState.current = { writeText: vi.fn().mockResolvedValue(undefined) }
  vi.stubGlobal(
    'navigator',
    new Proxy(navigator, {
      get: (target, key) =>
        key === 'clipboard' ? clipboardState.current : Reflect.get(target, key),
    }),
  )
})

function makeResolved(overrides?: Partial<ResolvedPreviewDto>): ResolvedPreviewDto {
  return {
    url: 'http://x.test/v1/orders?env=smoke&key=sk-live-123',
    hits: [
      { template: '{{host}}', key: 'host', resolved: 'http://x.test', hit: true, secret: false },
      { template: '{{apiKey}}', key: 'apiKey', resolved: 'sk-live-123', hit: true, secret: true },
      { template: '{{miss}}', key: 'miss', resolved: '{{miss}}', hit: false, secret: false },
    ],
    // 与镜像 redactions 同源的后端消费清单（含空值防御用例由夹具覆盖）
    secretValues: ['sk-live-123'],
    ...overrides,
  }
}

function renderPreview(resolved: ResolvedPreviewDto) {
  return render(
    <>
      <VariablePreview resolved={resolved} />
      <Toaster />
    </>,
  )
}

describe('变量解析预览（发送响应附带的 resolved 消费面）', () => {
  it('解析后 URL 行呈现；Secret 值在 URL 中默认掩码', () => {
    renderPreview(makeResolved())
    const urlRow = screen.getByTestId('variable-preview-url')
    // sk-live-123（Secret 消费值）掩码，非 Secret 段原样
    expect(urlRow).toHaveTextContent('http://x.test/v1/orders?env=smoke&key=***')
  })

  it('命中明细：命中行呈解析值、Secret 行默认掩码＋徽标、未命中行带标示', () => {
    renderPreview(makeResolved())
    const hits = screen.getByTestId('variable-preview-hits')
    const values = within(hits).getAllByTestId('variable-preview-hit-value')
    expect(values[0]).toHaveTextContent('http://x.test')
    expect(values[1]).toHaveTextContent('***')
    expect(values[2]).toHaveTextContent('未命中 · {{miss}}')
    expect(within(hits).getByText('Secret')).toBeInTheDocument()
  })

  it('「显示明文」放行 Secret 行的展示（仅本面板）', async () => {
    const user = userEvent.setup()
    renderPreview(makeResolved())
    await user.click(screen.getByRole('button', { name: '显示明文' }))
    const values = within(screen.getByTestId('variable-preview-hits')).getAllByTestId(
      'variable-preview-hit-value',
    )
    expect(values[1]).toHaveTextContent('sk-live-123')
    // URL 行的 Secret 掩码同样放行
    expect(screen.getByTestId('variable-preview-url')).toHaveTextContent('key=sk-live-123')
  })

  it('复制解析后 URL：恒掩码（不随「显示明文」放行泄露）', async () => {
    const user = userEvent.setup()
    renderPreview(makeResolved())
    await user.click(screen.getByRole('button', { name: '显示明文' }))
    await user.click(screen.getByRole('button', { name: '复制解析后 URL' }))
    expect(await screen.findByText('已复制')).toBeInTheDocument()
    expect(clipboardState.current.writeText).toHaveBeenCalledWith(
      'http://x.test/v1/orders?env=smoke&key=***',
    )
  })

  it('空消费态：无命中明细行，呈现空文案', () => {
    renderPreview(makeResolved({ url: 'http://x.test/a', hits: [] }))
    expect(screen.queryByTestId('variable-preview-hits')).not.toBeInTheDocument()
    expect(screen.getByText('本次发送未消费变量')).toBeInTheDocument()
    // 无 Secret 行则不渲染放行入口
    expect(screen.queryByRole('button', { name: '显示明文' })).not.toBeInTheDocument()
  })
})
