import { fireEvent, render, screen, within } from '@testing-library/react'
import { act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Toaster, toast, toastStore } from '@workspace/ui/components'

import type { SseStreamState } from '../response.store'

import { SsePanel } from '../sse-panel'

// —— IPC 替换：停止按钮经 store 走 http.cancel ——
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

// —— 剪贴板 spy（jsdom 无 navigator.clipboard，Proxy 全局 stub、其余透传） ——
const clipboardState = vi.hoisted(() => ({
  current: { writeText: vi.fn() },
}))

import { useResponseStore } from '../response.store'

const TAB_ID = 'endpoint:s1:e1'

function makeStream(overrides?: Partial<SseStreamState>): SseStreamState {
  return {
    streamId: 'stream-1',
    phase: 'streaming',
    text: '',
    receivedChars: 0,
    meta: null,
    error: null,
    ...overrides,
  }
}

function renderPanel(stream: SseStreamState) {
  return render(
    <>
      <SsePanel tabId={TAB_ID} stream={stream} />
      <Toaster />
    </>,
  )
}

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(true)
  useResponseStore.setState({ entries: {}, streams: {} })
  // 模块级 toast store 的用例间隔离
  for (const item of toastStore.getSnapshot()) toast.dismiss(item.id)
  clipboardState.current = { writeText: vi.fn().mockResolvedValue(undefined) }
  vi.stubGlobal(
    'navigator',
    new Proxy(navigator, {
      get: (target, key) =>
        key === 'clipboard' ? clipboardState.current : Reflect.get(target, key),
    }),
  )
})

describe('SSE 渐进渲染面板', () => {
  it('流式中：增量文本等宽渲染、已接收量、停止按钮＝http.cancel', () => {
    renderPanel(makeStream({ text: 'data: hello\n\ndata: world\n\n', receivedChars: 26 }))
    const text = screen.getByTestId('sse-text')
    expect(text).toHaveTextContent('data: hello')
    expect(text).toHaveTextContent('data: world')
    expect(screen.getByTestId('sse-received')).toHaveTextContent('26 B')
    // 进行中状态指示归响应区头行（发送中＋计时），面板头部不重复
    expect(screen.queryByText('发送中…')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(invokeMock).toHaveBeenCalledWith('http.cancel', { tabId: TAB_ID })
  })

  it('done 终态：中性「流已结束」标记，无停止按钮', () => {
    renderPanel(makeStream({ phase: 'done', text: 'data: fin\n\n' }))
    expect(screen.getByText('流已结束')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '停止' })).not.toBeInTheDocument()
    // 已收部分保留展示
    expect(screen.getByTestId('sse-text')).toHaveTextContent('data: fin')
  })

  it('cancelled 终态：中性「流已取消」，已收部分保留', () => {
    renderPanel(makeStream({ phase: 'cancelled', text: 'partial' }))
    expect(screen.getByText('流已取消')).toBeInTheDocument()
    expect(screen.getByTestId('sse-text')).toHaveTextContent('partial')
  })

  it('error 终态：错误卡片显示稳定 code＋message', () => {
    renderPanel(
      makeStream({
        phase: 'error',
        error: { code: 'HTTP_REQUEST_FAILED', message: 'reset by peer' },
      }),
    )
    const card = screen.getByTestId('sse-error')
    expect(card).toHaveTextContent('流式接收失败')
    expect(card).toHaveTextContent('HTTP_REQUEST_FAILED · reset by peer')
  })

  it('流文本可选中＋悬浮复制：口径＝已接收的流缓冲全文', async () => {
    renderPanel(makeStream({ text: 'data: hello\n\ndata: world\n\n' }))
    const surface = screen.getByTestId('sse-text').parentElement
    expect(surface).toHaveAttribute('data-slot', 'copy-surface')
    expect(surface).toHaveClass('select-text')
    fireEvent.click(within(surface!).getByRole('button', { name: '复制' }))
    expect(await screen.findByText('已复制')).toBeInTheDocument()
    expect(clipboardState.current.writeText).toHaveBeenCalledWith('data: hello\n\ndata: world\n\n')
  })
})

describe('SSE 滚动贴底跟随（条件贴底）', () => {
  /**
   * jsdom 不实现布局，scrollHeight / clientHeight 恒 0——用可配置属性
   * 覆写注入确定几何（scrollHeight=1000 / clientHeight=200，可滚区 800），
   * scrollTop 为真实可写属性。
   */
  function stubGeometry(el: Element, scrollHeight = 1000, clientHeight = 200): void {
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
  }

  /** 回到最新按钮（常驻挂载、opacity 控可见；隐藏态 aria-hidden） */
  const backButton = () => screen.getByTestId('sse-back-to-latest')
  const backVisible = () => backButton().getAttribute('aria-hidden') === 'false'

  it('在底时新文本到达跟随贴底；上翻后停止跟随（阅读位置不被拽走）', () => {
    const { rerender } = renderPanel(makeStream({ text: 'data: 1\n\n' }))
    const el = screen.getByTestId('sse-text')
    stubGeometry(el)

    // 初始在底：增量到达即贴底
    rerender(
      <>
        <SsePanel tabId={TAB_ID} stream={makeStream({ text: 'data: 1\n\ndata: 2\n\n' })} />
        <Toaster />
      </>,
    )
    expect(el.scrollTop).toBe(1000)

    // 用户上翻（距底 300 > 40 阈值）：停止跟随
    el.scrollTop = 500
    fireEvent.scroll(el)
    rerender(
      <>
        <SsePanel
          tabId={TAB_ID}
          stream={makeStream({ text: 'data: 1\n\ndata: 2\n\ndata: 3\n\n' })}
        />
        <Toaster />
      </>,
    )
    expect(el.scrollTop).toBe(500)
  })

  it('上翻出「回到最新」按钮；点击回底并恢复跟随、按钮隐藏', () => {
    const { rerender } = renderPanel(makeStream({ text: 'data: 1\n\n' }))
    const el = screen.getByTestId('sse-text')
    stubGeometry(el)
    expect(backButton()).toHaveAttribute('aria-hidden', 'true')

    // 上翻 → 按钮可见且键盘可达
    el.scrollTop = 500
    fireEvent.scroll(el)
    expect(backVisible()).toBe(true)
    expect(backButton().tabIndex).toBe(0)

    // 流终态后按钮保留（回看历史仍可一键回尾）
    rerender(
      <>
        <SsePanel tabId={TAB_ID} stream={makeStream({ phase: 'done', text: 'data: 1\n\n' })} />
        <Toaster />
      </>,
    )
    expect(backVisible()).toBe(true)

    // 点击：贴底＋恢复跟随＋按钮隐藏
    fireEvent.click(backButton())
    expect(el.scrollTop).toBe(1000)
    expect(backVisible()).toBe(false)
    // 恢复跟随后的增量继续贴底
    rerender(
      <>
        <SsePanel
          tabId={TAB_ID}
          stream={makeStream({ phase: 'done', text: 'data: 1\n\ndata: 2\n\n' })}
        />
        <Toaster />
      </>,
    )
    expect(el.scrollTop).toBe(1000)
  })

  it('自行滚回底部（距底 < 40px）：跟随恢复、按钮消失', () => {
    renderPanel(makeStream({ text: 'data: 1\n\n' }))
    const el = screen.getByTestId('sse-text')
    stubGeometry(el)

    // 上翻出按钮
    el.scrollTop = 500
    fireEvent.scroll(el)
    expect(backVisible()).toBe(true)

    // 滚回贴底（距底 0 < 40）
    act(() => {
      el.scrollTop = 1000
      fireEvent.scroll(el)
    })
    expect(backVisible()).toBe(false)
    // 阈值内（距底 30）同样视为在底
    el.scrollTop = 500
    fireEvent.scroll(el)
    expect(backVisible()).toBe(true)
    act(() => {
      el.scrollTop = 970
      fireEvent.scroll(el)
    })
    expect(backVisible()).toBe(false)
  })
})
