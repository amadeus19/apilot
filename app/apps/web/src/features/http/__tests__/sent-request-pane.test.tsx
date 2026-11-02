import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Toaster, toast, toastStore } from '@workspace/ui/components'

import type { RequestSnapshotDto } from '../http-api'
import { SentRequestPane } from '../sent-request-pane'

// 剪贴板 spy 持有器（jsdom 无 navigator.clipboard，Proxy 全局 stub、其余透传）
const clipboardState = vi.hoisted(() => ({
  current: { writeText: vi.fn() },
}))

// 模块级 toast store 的用例间隔离（TTL 5s 内残留会与后续同名 toast 叠加）
function clearAllToasts(): void {
  for (const item of toastStore.getSnapshot()) toast.dismiss(item.id)
}

beforeEach(() => {
  clearAllToasts()
  clipboardState.current = { writeText: vi.fn().mockResolvedValue(undefined) }
  vi.stubGlobal(
    'navigator',
    new Proxy(navigator, {
      get: (target, key) =>
        key === 'clipboard' ? clipboardState.current : Reflect.get(target, key),
    }),
  )
})

function makeRequest(): RequestSnapshotDto {
  return {
    method: 'GET',
    url: 'http://localhost/orders?page=1&api_key=secret',
    headers: [
      ['accept', '*/*'],
      ['authorization', 'Bearer secret-token'],
      ['x-custom-key', 'my-api-key'],
    ],
    body: null,
    redactions: { headerNames: ['x-custom-key'], queryKeys: ['api_key'], secretValues: [] },
  }
}

function renderPane() {
  return render(
    <>
      <SentRequestPane request={makeRequest()} />
      <Toaster />
    </>,
  )
}

describe('已发送请求复制链路（Headers 脱敏口径）', () => {
  it('headers 列表区域可选中（CopySurface＋select-text）', () => {
    renderPane()
    expect(screen.getByTestId('response-sent-headers')).toHaveClass('select-text')
  })

  it('复制全部 Headers：每行 name: value、敏感头（标准＋自定义）掩码不泄露', async () => {
    const user = userEvent.setup()
    renderPane()
    await user.click(screen.getByRole('button', { name: '复制全部 Headers' }))
    expect(await screen.findByText('已复制')).toBeInTheDocument()
    expect(clipboardState.current.writeText).toHaveBeenCalledWith(
      'accept: */*\nauthorization: ***\nx-custom-key: ***',
    )
  })

  it('复制 URL：脱敏口径＝query 掩码后的 URL（敏感值不随放行泄露）', async () => {
    const user = userEvent.setup()
    renderPane()
    await user.click(screen.getByRole('button', { name: '复制 URL' }))
    expect(await screen.findByText('已复制')).toBeInTheDocument()
    expect(clipboardState.current.writeText).toHaveBeenCalledWith(
      'http://localhost/orders?page=1&api_key=***',
    )
    // 「显示敏感值」放行后复制口径仍脱敏
    await user.click(screen.getByRole('button', { name: '显示敏感值' }))
    await user.click(screen.getByRole('button', { name: '复制 URL' }))
    expect(clipboardState.current.writeText).toHaveBeenLastCalledWith(
      'http://localhost/orders?page=1&api_key=***',
    )
  })

  it('「显示敏感值」放行后复制口径仍脱敏（复制不随展示放行）', async () => {
    const user = userEvent.setup()
    renderPane()
    await user.click(screen.getByRole('button', { name: '显示敏感值' }))
    expect(screen.getByRole('button', { name: '隐藏敏感值' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '复制全部 Headers' }))
    expect(await screen.findByText('已复制')).toBeInTheDocument()
    expect(clipboardState.current.writeText).toHaveBeenCalledWith(
      'accept: */*\nauthorization: ***\nx-custom-key: ***',
    )
  })

  it('重名头（Set-Cookie 多值）逐行渲染不丢行', () => {
    render(
      <SentRequestPane
        request={{
          ...makeRequest(),
          headers: [
            ['set-cookie', 'a=1; Path=/'],
            ['set-cookie', 'b=2; Path=/'],
          ],
        }}
      />,
    )
    const headers = screen.getByTestId('response-sent-headers')
    expect(within(headers).getAllByText('set-cookie')).toHaveLength(2)
    // set-cookie 属标准敏感头：默认掩码，两行都在（不因重名 key 丢行）
    expect(within(headers).getAllByText('***')).toHaveLength(2)
    // 显式放行后两行原值可见
    fireEvent.click(screen.getByRole('button', { name: '显示敏感值' }))
    expect(headers).toHaveTextContent('a=1; Path=/')
    expect(headers).toHaveTextContent('b=2; Path=/')
  })
})
