import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSettingsStore } from '@/stores/settings.store'

import type { ResponseSnapshotPayload } from '../snapshot-api'
import { SnapshotWindowApp } from '../snapshot-window-app'

// —— IPC 替换：get_response_snapshot 按用例灌载荷；set_setting 记忆写回走桩 ——
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

// —— Monaco 底座替换（拦截懒加载 import）：记录最新 props 供语言 / 编辑
// 断言，值渲染进 DOM 供文本断言 ——
const monacoProps = vi.hoisted(() => ({
  value: '',
  language: '',
  change: null as ((next: string) => void) | null,
}))
vi.mock('@/features/http/monaco-text-editor', async () => {
  const React = await import('react')
  return {
    MonacoTextEditor: (props: {
      value: string
      language: string
      onChange?: (next: string) => void
    }) => {
      monacoProps.value = props.value
      monacoProps.language = props.language
      monacoProps.change = props.onChange ?? null
      return React.createElement('div', { 'data-testid': 'monaco-mock' }, props.value)
    },
  }
})

// —— 窗口 API 替换：几何常量（scaleFactor 1.5：物理 150/75/900/600 → 逻辑
// 100/50/600/400）；onMoved / onResized 登记回调供测试手动触发，unlisten
// 桩供卸载清理断言 ——
const winMock = vi.hoisted(() => {
  const base = {
    onMovedHandlers: [] as Array<() => void>,
    onResizedHandlers: [] as Array<() => void>,
    focusHandlers: [] as Array<(event: { payload: boolean }) => void>,
    unlistenMoved: vi.fn(),
    unlistenResized: vi.fn(),
    unlistenFocus: vi.fn(),
    setAlwaysOnTop: vi.fn((): Promise<void> => Promise.resolve()),
    close: vi.fn((): Promise<void> => Promise.resolve()),
    show: vi.fn((): Promise<void> => Promise.resolve()),
    innerPosition: vi.fn((): Promise<{ x: number; y: number }> =>
      Promise.resolve({ x: 150, y: 75 }),
    ),
    innerSize: vi.fn((): Promise<{ width: number; height: number }> =>
      Promise.resolve({ width: 900, height: 600 }),
    ),
    scaleFactor: vi.fn((): Promise<number> => Promise.resolve(1.5)),
  }
  return {
    ...base,
    onMoved: vi.fn((handler: () => void): Promise<() => void> => {
      base.onMovedHandlers.push(handler)
      return Promise.resolve(base.unlistenMoved)
    }),
    onResized: vi.fn((handler: () => void): Promise<() => void> => {
      base.onResizedHandlers.push(handler)
      return Promise.resolve(base.unlistenResized)
    }),
    onFocusChanged: vi.fn((handler: (event: { payload: boolean }) => void): Promise<() => void> => {
      base.focusHandlers.push(handler)
      return Promise.resolve(base.unlistenFocus)
    }),
  }
})
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => winMock }))

/** 防抖后的期望记忆值（物理几何 ÷ 1.5 的逻辑像素，四舍五入） */
const EXPECTED_RECT = { x: 100, y: 50, width: 600, height: 400 }

/** 定格载荷解析形态（jsdom 下 Promise 断言需要显式类型收紧） */
function payloadOf(value: ResponseSnapshotPayload | null): Promise<ResponseSnapshotPayload | null> {
  return Promise.resolve(value)
}

beforeEach(() => {
  invokeMock.mockReset().mockImplementation(() => Promise.resolve(undefined))
  winMock.onMovedHandlers.length = 0
  winMock.onResizedHandlers.length = 0
  winMock.focusHandlers.length = 0
  winMock.unlistenMoved.mockClear()
  winMock.unlistenResized.mockClear()
  winMock.unlistenFocus.mockClear()
  winMock.setAlwaysOnTop.mockClear()
  winMock.close.mockClear()
  winMock.show.mockClear()
  monacoProps.value = ''
  monacoProps.language = ''
  monacoProps.change = null
  useSettingsStore.setState({ responseSnapshotWindow: null })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('定格载荷拉取与渲染', () => {
  it('json 档：Monaco 只读视图（json 语言）呈现 pretty 文本与标题，载荷经 get_response_snapshot 拉取', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_response_snapshot')
        return payloadOf({ title: '订单接口', content: '{\n  "ok": true\n}', contentType: 'json' })
      return Promise.resolve(undefined)
    })
    render(<SnapshotWindowApp />)
    const view = await screen.findByTestId('snapshot-json')
    await waitFor(() => {
      expect(view).toHaveTextContent('"ok": true')
    })
    expect(monacoProps.language).toBe('json')
    expect(screen.getByTestId('snapshot-title')).toHaveTextContent('订单接口')
    expect(invokeMock).toHaveBeenCalledWith('get_response_snapshot')
  })

  it('text 档：Monaco 只读视图按 plaintext 语言渲染', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_response_snapshot')
        return payloadOf({ title: '纯文本', content: 'hello body', contentType: 'text' })
      return Promise.resolve(undefined)
    })
    render(<SnapshotWindowApp />)
    const view = await screen.findByTestId('snapshot-text')
    await waitFor(() => {
      expect(view).toHaveTextContent('hello body')
    })
    expect(monacoProps.language).toBe('plaintext')
  })

  it('null 载荷：渲染空态文案，不出现内容区', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_response_snapshot') return payloadOf(null)
      return Promise.resolve(undefined)
    })
    render(<SnapshotWindowApp />)
    expect(await screen.findByTestId('snapshot-empty')).toHaveTextContent('快照窗暂无响应内容')
    expect(screen.queryByTestId('snapshot-json')).not.toBeInTheDocument()
    expect(screen.queryByTestId('snapshot-text')).not.toBeInTheDocument()
  })

  it('首帧显示收口：载荷拉取落定后才调窗口 show（隐藏创建的防闪协议闭合点）', async () => {
    winMock.show.mockClear()
    let release: ((value: null) => void) | null = null
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_response_snapshot')
        return new Promise((resolve) => {
          release = resolve
        })
      return Promise.resolve(undefined)
    })
    render(<SnapshotWindowApp />)
    await act(async () => {})
    expect(winMock.show).not.toHaveBeenCalled()
    act(() => release?.(null))
    await waitFor(() => {
      expect(winMock.show).toHaveBeenCalledTimes(1)
    })
  })
})

describe('置顶开关', () => {
  it('切换调 setAlwaysOnTop 并把实测几何与置顶整体写入记忆键（无记忆时起点＝默认置顶）', async () => {
    const user = userEvent.setup()
    render(<SnapshotWindowApp />)
    const toggle = await screen.findByTestId('snapshot-always-on-top')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')

    await user.click(toggle)

    expect(winMock.setAlwaysOnTop).toHaveBeenCalledWith(false)
    await waitFor(() => {
      expect(useSettingsStore.getState().responseSnapshotWindow).toEqual({
        ...EXPECTED_RECT,
        alwaysOnTop: false,
      })
    })
    // 记忆键经既有 settings 通道落库（set_setting 整键写）
    expect(invokeMock).toHaveBeenCalledWith('set_setting', {
      key: 'responseSnapshotWindow',
      value: { ...EXPECTED_RECT, alwaysOnTop: false },
    })
    expect(screen.getByTestId('snapshot-always-on-top')).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('自绘标题栏', () => {
  it('标题栏为 deep 拖拽区，控制键容器豁免；关闭钮调窗口 close', async () => {
    const user = userEvent.setup()
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_response_snapshot')
        return payloadOf({ title: '订单接口', content: '{}', contentType: 'json' })
      return Promise.resolve(undefined)
    })
    render(<SnapshotWindowApp />)
    await screen.findByTestId('snapshot-json')

    const header = screen.getByTestId('snapshot-title').closest('header')
    expect(header).toHaveAttribute('data-tauri-drag-region', 'deep')
    expect(screen.getByTestId('snapshot-close').parentElement).toHaveAttribute(
      'data-tauri-drag-region',
      'false',
    )

    await user.click(screen.getByTestId('snapshot-close'))
    expect(winMock.close).toHaveBeenCalledTimes(1)
  })

  it('置顶图标双态：置顶时钉住、取消后斜钉', async () => {
    const user = userEvent.setup()
    render(<SnapshotWindowApp />)
    const toggle = await screen.findByTestId('snapshot-always-on-top')

    // 无记忆回退默认置顶：钉住图标在场
    expect(toggle.querySelector('svg.lucide-pin')).toBeInTheDocument()
    expect(toggle.querySelector('svg.lucide-pin-off')).not.toBeInTheDocument()

    await user.click(toggle)
    await waitFor(() => {
      expect(toggle.querySelector('svg.lucide-pin-off')).toBeInTheDocument()
    })
    expect(toggle.querySelector('svg.lucide-pin')).not.toBeInTheDocument()
  })

  it('标题栏左端为窗口语义图标（AppWindow）', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_response_snapshot')
        return payloadOf({ title: 't', content: '{}', contentType: 'json' })
      return Promise.resolve(undefined)
    })
    render(<SnapshotWindowApp />)
    const header = (await screen.findByTestId('snapshot-title')).closest('header')
    expect(header?.querySelector('svg.lucide-app-window')).toBeInTheDocument()
  })
})

describe('格式化与编辑（复用窗口改稿）', () => {
  const compactPayload = {
    title: 't',
    content: '{"b":1,"a":[1,2]}',
    contentType: 'json' as const,
  }

  it('json 档标题栏有格式化按钮：点击缩进重排展示内容（仅本地态，不回写暂存）', async () => {
    const user = userEvent.setup()
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_response_snapshot') return payloadOf(compactPayload)
      return Promise.resolve(undefined)
    })
    render(<SnapshotWindowApp />)
    await screen.findByTestId('snapshot-json')
    // 展示值先就位为原始紧凑文本
    await waitFor(() => {
      expect(monacoProps.value).toBe(compactPayload.content)
    })

    await user.click(screen.getByTestId('snapshot-format'))

    // 缩进重排后的形态进编辑器展示值；get_response_snapshot 未被再次调用
    // （格式化只动本地展示态，不回写 Rust 暂存）
    expect(monacoProps.value).toBe('{\n  "b": 1,\n  "a": [\n    1,\n    2\n  ]\n}')
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  it('非法 JSON：短提示出现后自动消退，内容保持原样', async () => {
    // 点击走 fireEvent（同步），无 userEvent 依赖
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_response_snapshot')
        return payloadOf({ title: 't', content: '{oops', contentType: 'json' })
      return Promise.resolve(undefined)
    })
    render(<SnapshotWindowApp />)
    // 挂载等待用真实计时器（fake 下 waitFor 会卡死），随后再切 fake 控时；
    // 点击用 fireEvent（同步，不依赖计时器推进）
    await screen.findByTestId('snapshot-json')
    vi.useFakeTimers()

    fireEvent.click(screen.getByTestId('snapshot-format'))
    expect(screen.getByTestId('snapshot-format-invalid')).toBeInTheDocument()
    expect(monacoProps.value).toBe('{oops')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(screen.queryByTestId('snapshot-format-invalid')).not.toBeInTheDocument()
  })

  it('text 档不渲染格式化按钮；编辑内容经 onChange 回写展示态', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_response_snapshot')
        return payloadOf({ title: 't', content: 'hello', contentType: 'text' })
      return Promise.resolve(undefined)
    })
    render(<SnapshotWindowApp />)
    await screen.findByTestId('snapshot-text')
    expect(screen.queryByTestId('snapshot-format')).not.toBeInTheDocument()

    expect(monacoProps.change).not.toBeNull()
    act(() => monacoProps.change?.('pasted content'))
    expect(monacoProps.value).toBe('pasted content')
  })

  it('窗口聚焦重拉：复用语义闭合——主窗重新触发后聚焦本窗即替换内容', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_response_snapshot')
        return payloadOf({ title: '第一份', content: '{"v":1}', contentType: 'json' })
      return Promise.resolve(undefined)
    })
    render(<SnapshotWindowApp />)
    await waitFor(() => {
      expect(monacoProps.value).toBe('{"v":1}')
    })

    // 主窗重新触发：Rust 暂存替换为新 payload，随后聚焦本窗
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_response_snapshot')
        return payloadOf({ title: '第二份', content: '{"v":2}', contentType: 'json' })
      return Promise.resolve(undefined)
    })
    act(() => {
      for (const fire of winMock.focusHandlers) fire({ payload: true })
    })
    await waitFor(() => {
      expect(monacoProps.value).toBe('{"v":2}')
    })
    expect(screen.getByTestId('snapshot-title')).toHaveTextContent('第二份')
  })

  it('失焦事件不触发重拉', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_response_snapshot')
        return payloadOf({ title: 't', content: '{"v":1}', contentType: 'json' })
      return Promise.resolve(undefined)
    })
    render(<SnapshotWindowApp />)
    await waitFor(() => {
      expect(monacoProps.value).toBe('{"v":1}')
    })
    act(() => {
      for (const fire of winMock.focusHandlers) fire({ payload: false })
    })
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  it('聚焦重拉判变更：暂存未变（同 title/content）不动展示——本地编辑稿保留', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_response_snapshot')
        return payloadOf({ title: 't', content: '{"v":1}', contentType: 'json' })
      return Promise.resolve(undefined)
    })
    render(<SnapshotWindowApp />)
    await waitFor(() => {
      expect(monacoProps.value).toBe('{"v":1}')
    })
    // 用户粘贴改稿
    act(() => monacoProps.change?.('{"edited":true}'))
    expect(monacoProps.value).toBe('{"edited":true}')

    // 暂存未变（与最近注入同 title/content）：聚焦不覆写编辑稿
    act(() => {
      for (const fire of winMock.focusHandlers) fire({ payload: true })
    })
    await act(async () => {})
    expect(monacoProps.value).toBe('{"edited":true}')
  })

  it('聚焦重拉失败（invoke reject）不动展示态', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_response_snapshot')
        return payloadOf({ title: 't', content: '{"v":1}', contentType: 'json' })
      return Promise.resolve(undefined)
    })
    render(<SnapshotWindowApp />)
    await waitFor(() => {
      expect(monacoProps.value).toBe('{"v":1}')
    })

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_response_snapshot') return Promise.reject(new Error('ipc down'))
      return Promise.resolve(undefined)
    })
    act(() => {
      for (const fire of winMock.focusHandlers) fire({ payload: true })
    })
    await act(async () => {})
    expect(monacoProps.value).toBe('{"v":1}')
  })

  it('同 title 不同 content 的暂存变更：聚焦后替换（同接口重发新响应）', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_response_snapshot')
        return payloadOf({ title: '订单', content: '{"v":1}', contentType: 'json' })
      return Promise.resolve(undefined)
    })
    render(<SnapshotWindowApp />)
    await waitFor(() => {
      expect(monacoProps.value).toBe('{"v":1}')
    })

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_response_snapshot')
        return payloadOf({ title: '订单', content: '{"v":2}', contentType: 'json' })
      return Promise.resolve(undefined)
    })
    act(() => {
      for (const fire of winMock.focusHandlers) fire({ payload: true })
    })
    await waitFor(() => {
      expect(monacoProps.value).toBe('{"v":2}')
    })
  })
})

describe('位置尺寸记忆（移动 / 缩放防抖写回）', () => {
  it('窗口期内多次 moved / resized 合并为一次整键写回（≈500ms 防抖）', async () => {
    vi.useFakeTimers()
    render(<SnapshotWindowApp />)
    // flush mount 链路（载荷拉取与监听注册的 Promise）
    await act(async () => {})

    invokeMock.mockClear()
    act(() => {
      for (const fire of winMock.onMovedHandlers) fire()
      for (const fire of winMock.onResizedHandlers) fire()
      for (const fire of winMock.onMovedHandlers) fire()
    })
    // 防抖窗口内不写
    expect(invokeMock).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(useSettingsStore.getState().responseSnapshotWindow).toEqual({
      ...EXPECTED_RECT,
      alwaysOnTop: true,
    })
    const setCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'set_setting')
    expect(setCalls).toHaveLength(1)
  })

  it('卸载：取消 onMoved / onResized 监听并清除挂起防抖（卸载后不再写库）', async () => {
    vi.useFakeTimers()
    const { unmount } = render(<SnapshotWindowApp />)
    await act(async () => {})

    act(() => {
      for (const fire of winMock.onMovedHandlers) fire()
    })
    invokeMock.mockClear()
    unmount()

    expect(winMock.unlistenMoved).toHaveBeenCalled()
    expect(winMock.unlistenResized).toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
