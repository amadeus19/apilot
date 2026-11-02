import { fireEvent, render as rtlRender, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ReactElement } from 'react'

import { makeEndpointNodeId } from '@/lib/tree-identity'
import { useAppStore } from '@/stores/app.store'
import { useTabsStore } from '@/stores/tabs.store'

import type { RunResultDto, SseEventDto } from '../http-api'
import { useResponseStore } from '../response.store'
import { registerSendDraft } from '../send-bridge'

import { ResponsePane } from '@/components/layout/ResponsePane'
import { createQueryWrapper } from '@/test/render-providers'

/** ResponsePane 树含真实 MonacoTextEditor（底座带 IPC 查询），渲染统一包
 *  QueryClient（disabled 查询不触发 invoke）；rerender 不需重包 */
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: createQueryWrapper() })
}

// —— IPC 与事件监听替换：read_range / sse.start / http.cancel 走桩 ——
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const listenMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

// —— 折叠/展开几何通道 spy：收起键与折叠条带的链路断言锚点 ——
const { collapseResponsePanelMock, expandResponsePanelMock } = vi.hoisted(() => ({
  collapseResponsePanelMock: vi.fn(),
  expandResponsePanelMock: vi.fn(),
}))
vi.mock('@/components/layout/panel-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/layout/panel-bridge')>()),
  collapseResponsePanel: collapseResponsePanelMock,
  expandResponsePanel: expandResponsePanelMock,
}))

// —— 工作空间清单替换：ResponsePane 的「存为变量」写入目标空间（w1 当前）；
// Headers 行级弹层的交互行为在 header-variable-button.test.tsx 专测 ——
vi.mock('@/features/workspaces/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/workspaces/api')>()),
  useWorkspacesQuery: () => ({
    data: {
      items: [{ id: 'w1', name: '空间一', baseUrl: null, auth: null, isCurrent: true }],
    },
  }),
}))

// —— Monaco 依赖三件替换（jsdom 不真渲染编辑器；生命周期断言在
// response-body-pane.test.tsx 的假编辑器链路，此处只要分区呈现可见）——
vi.mock('monaco-editor', () => ({
  editor: {
    setTheme: vi.fn(),
    create: vi.fn(() => ({ setValue: vi.fn(), updateOptions: vi.fn(), dispose: vi.fn() })),
  },
}))
vi.mock('../monaco-env', () => ({}))
vi.mock('@monaco-editor/react', async () => {
  const React = await import('react')
  // 假 Editor：渲染 value 供分区断言（不模拟创建/销毁链路）
  function Editor(props: { value?: string }) {
    return React.createElement('div', { 'data-testid': 'monaco-editor-host' }, props.value ?? '')
  }
  return { default: Editor, loader: { config: vi.fn() } }
})

let activeListener: ((event: { payload: SseEventDto }) => void) | null = null

beforeEach(() => {
  invokeMock.mockReset()
  listenMock.mockReset()
  collapseResponsePanelMock.mockReset()
  expandResponsePanelMock.mockReset()
  activeListener = null
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === 'sse.start') return Promise.resolve({ streamId: 'stream-x' })
    if (cmd === 'http.cancel') return Promise.resolve(true)
    return Promise.resolve(undefined)
  })
  listenMock.mockImplementation(
    async (_event: string, handler: (e: { payload: SseEventDto }) => void) => {
      activeListener = handler
      return () => {
        activeListener = null
      }
    },
  )
  const tabId = makeEndpointNodeId('s1', 'e1')
  useTabsStore.setState({
    tabs: [
      { id: tabId, kind: 'endpoint', title: '接口', serviceId: 's1', key: 'e1', preview: false },
    ],
    activeTabId: tabId,
    editorTabs: {},
  })
  useResponseStore.setState({ entries: {}, streams: {}, bodyModes: {} })
  useAppStore.setState({ responseCollapsed: false, settingsOpen: false, settingsInitialNav: null })
})

function makeResult(overrides?: Partial<RunResultDto>): RunResultDto {
  return {
    runId: 'run-1',
    state: 'passed',
    statusCode: 200,
    durationMs: 340,
    errorCode: null,
    errorMessage: null,
    request: {
      method: 'GET',
      url: 'http://localhost/orders?page=1',
      headers: [
        ['accept', '*/*'],
        ['authorization', 'Bearer secret-token'],
        ['x-custom-key', 'my-api-key'],
      ],
      body: null,
      redactions: { headerNames: ['x-custom-key'], queryKeys: ['api_key'], secretValues: [] },
    },
    response: {
      status: 200,
      headers: [['content-type', 'application/json']],
      contentType: 'application/json',
      body: { excerpt: '{"ok":true}', truncated: false, totalSize: 11 },
    },
    responseId: null,
    resolved: { url: 'http://localhost/orders', hits: [], secretValues: [] },
    ...overrides,
  }
}

function seedEntry(
  result: RunResultDto | null,
  phase: 'done' | 'failed' | 'cancelled' | 'sending' = 'done',
) {
  const tabId = makeEndpointNodeId('s1', 'e1')
  useResponseStore.setState({
    entries: { [tabId]: { phase, result, error: null, startedAt: null } },
  })
}

describe('空态与状态行', () => {
  it('未发送：空态占位（发送后响应在此显示）', () => {
    render(<ResponsePane />)
    expect(screen.getByText('发送请求后，响应将在此显示')).toBeInTheDocument()
  })

  it('空态「发送请求」：草稿桥未登记时不发起；登记后经桥发送并落结果', async () => {
    const tabId = makeEndpointNodeId('s1', 'e1')
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'http.send') return Promise.resolve(makeResult())
      if (cmd === 'sse.start') return Promise.resolve({ streamId: 'stream-x' })
      return Promise.resolve(true)
    })
    render(<ResponsePane />)

    // 草稿桥未登记（编辑器未挂载草稿）：点击无操作，不发起发送
    fireEvent.click(screen.getByTestId('response-empty-send'))
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'http.send')).toBe(false)

    // 登记草稿：点击发起发送（参数取自草稿桥），结果落地后空态让位三分区
    const unregister = registerSendDraft(tabId, () => ({
      body: null,
      params: '[]',
      headers: '[]',
      timeoutSeconds: null,
      auth: null,
      pathOverride: null,
      methodOverride: null,
    }))
    fireEvent.click(screen.getByTestId('response-empty-send'))
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'http.send',
        expect.objectContaining({ serviceId: 's1', key: 'e1', tabId }),
      )
    })
    await waitFor(() => {
      expect(screen.getByTestId('response-body')).toBeInTheDocument()
    })
    unregister()
  })

  it('状态码着色：2xx 绿、4xx 琥珀、5xx 红，附耗时与大小', () => {
    const { rerender } = render(<ResponsePane />)
    seedEntry(makeResult({ statusCode: 200 }))
    rerender(<ResponsePane />)
    const status = screen.getByTestId('response-status-code')
    expect(status).toHaveTextContent('200')
    expect(status.className).toContain('text-success')

    seedEntry(makeResult({ statusCode: 404 }))
    rerender(<ResponsePane />)
    expect(screen.getByTestId('response-status-code').className).toContain('text-warning')

    seedEntry(makeResult({ statusCode: 502 }))
    rerender(<ResponsePane />)
    expect(screen.getByTestId('response-status-code').className).toContain('text-destructive')

    expect(screen.getByText('340ms')).toBeInTheDocument()
    expect(screen.getByText('11 B')).toBeInTheDocument()
  })

  it('分级徽标：全文（内存）/ 全文（文件）（responseId）', () => {
    const { rerender } = render(<ResponsePane />)
    // 内存档凭据＝DTO 携带 rawBase64（全量字节在手），徽标显示全文（内存）
    seedEntry(
      makeResult({
        response: {
          status: 200,
          headers: [['content-type', 'application/json']],
          contentType: 'application/json',
          body: {
            excerpt: '{"ok":true}',
            truncated: false,
            totalSize: 11,
            rawBase64: btoa('{"ok":true}'),
          },
        },
      }),
    )
    rerender(<ResponsePane />)
    expect(screen.getByText('全文（内存）')).toBeInTheDocument()

    seedEntry(
      makeResult({
        responseId: 'http:tab:endpoint:s1:e1',
        response: {
          status: 200,
          headers: [],
          contentType: 'text/plain',
          body: { excerpt: 'x'.repeat(100), truncated: true, totalSize: 3 * 1024 * 1024 },
        },
      }),
    )
    rerender(<ResponsePane />)
    expect(screen.getByText('全文（文件）')).toBeInTheDocument()
  })
})

describe('三分区', () => {
  it('Body：JSON Pretty 进 Monaco 编辑器（格式化文本），Raw 切回等宽原文', async () => {
    seedEntry(
      makeResult({
        response: {
          status: 200,
          headers: [],
          contentType: 'application/json',
          body: { excerpt: '{"a":1}', truncated: false, totalSize: 7 },
        },
      }),
    )
    render(<ResponsePane />)
    // Pretty 默认：Monaco 编辑器承载，值为 JSON.stringify(obj, null, 2) 的两空格缩进
    // （jest-dom 文本断言按空白归一化，取「冒号后带空格」锚定格式化形态）
    const host = await screen.findByTestId('monaco-editor-host')
    expect(host).toHaveTextContent('"a": 1')
    expect(screen.getByTestId('response-body-monaco')).toBeInTheDocument()
    // Raw 切换：原文直出（等宽 pre 顶替，编辑器层隐藏）
    fireEvent.click(screen.getByRole('tab', { name: 'Raw' }))
    const pre = screen.getByTestId('response-body-pre')
    expect(pre).toHaveTextContent('{"a":1}')
    expect(screen.getByTestId('response-body-monaco')).toHaveClass('hidden')
  })

  it('Headers：键值行列表', () => {
    seedEntry(makeResult())
    render(<ResponsePane />)
    fireEvent.click(screen.getByRole('tab', { name: /Headers/ }))
    const headers = screen.getByTestId('response-headers')
    expect(headers).toHaveTextContent('content-type')
    expect(headers).toHaveTextContent('application/json')
  })

  it('Headers：重名头（Set-Cookie 多值）逐行渲染不丢行，敏感值默认掩码、放行后可见', () => {
    seedEntry(
      makeResult({
        response: {
          status: 200,
          headers: [
            ['set-cookie', 'a=1; Path=/'],
            ['set-cookie', 'b=2; Path=/'],
            ['content-type', 'application/json'],
          ],
          contentType: 'application/json',
          body: { excerpt: '{}', truncated: false, totalSize: 2 },
        },
      }),
    )
    render(<ResponsePane />)
    fireEvent.click(screen.getByRole('tab', { name: /Headers/ }))
    const headers = screen.getByTestId('response-headers')
    expect(within(headers).getAllByText('set-cookie')).toHaveLength(2)
    // 展示默认脱敏（全路径脱敏纪律）：敏感头值渲染 *** 且不挂 title 全文
    expect(headers).not.toHaveTextContent('a=1; Path=/')
    expect(within(headers).getAllByText('***')).toHaveLength(2)
    expect(screen.getByTestId('response-headers-reveal')).toHaveAttribute('aria-pressed', 'false')
    // 「显示敏感值」仅放行本面板展示
    fireEvent.click(screen.getByTestId('response-headers-reveal'))
    expect(headers).toHaveTextContent('a=1; Path=/')
    expect(headers).toHaveTextContent('b=2; Path=/')
  })

  it('已发送请求：标准敏感头与 redactions 自定义头脱敏、URL query 掩码', () => {
    seedEntry(
      makeResult({
        request: {
          method: 'GET',
          url: 'http://localhost/orders?page=1&api_key=sekrit',
          headers: [
            ['accept', '*/*'],
            ['authorization', 'Bearer secret-token'],
            ['x-custom-key', 'my-api-key'],
          ],
          body: null,
          redactions: { headerNames: ['x-custom-key'], queryKeys: ['api_key'], secretValues: [] },
        },
      }),
    )
    render(<ResponsePane />)
    fireEvent.click(screen.getByRole('tab', { name: '已发送请求' }))
    const sent = screen.getByTestId('response-sent-request')
    expect(sent).toHaveTextContent('http://localhost/orders?page=1&api_key=***')
    expect(sent).not.toHaveTextContent('sekrit')
    expect(sent).toHaveTextContent('***')
    expect(sent).not.toHaveTextContent('secret-token')
    expect(sent).not.toHaveTextContent('my-api-key')
    expect(sent).toHaveTextContent('*/*')

    // 显示敏感值（开发调试放行）：原值与原 URL 回显
    fireEvent.click(screen.getByRole('button', { name: '显示敏感值' }))
    expect(screen.getByTestId('response-sent-request')).toHaveTextContent('Bearer secret-token')
    expect(screen.getByTestId('response-sent-request')).toHaveTextContent('my-api-key')
    expect(screen.getByTestId('response-sent-url')).toHaveTextContent('api_key=sekrit')
    fireEvent.click(screen.getByRole('button', { name: '隐藏敏感值' }))
    expect(screen.getByTestId('response-sent-request')).not.toHaveTextContent('secret-token')
  })
})

describe('错误三分', () => {
  it('TIMEOUT：超时卡文案＋链接打开设置 HTTP 组', () => {
    seedEntry(
      makeResult({
        state: 'failed',
        statusCode: null,
        durationMs: 5000,
        errorCode: 'TIMEOUT',
        errorMessage: 'timeout',
        response: null,
      }),
      'failed',
    )
    render(<ResponsePane />)
    const card = screen.getByTestId('response-timeout-card')
    expect(card).toHaveTextContent('请求超时')
    expect(card).toHaveTextContent('已按超时设置终止')
    fireEvent.click(screen.getByRole('button', { name: '调整超时设置' }))
    expect(useAppStore.getState().settingsOpen).toBe(true)
    expect(useAppStore.getState().settingsInitialNav).toBe('http')
  })

  it('其他失败：错误卡显示稳定 code＋message', () => {
    seedEntry(
      makeResult({
        state: 'failed',
        statusCode: null,
        errorCode: 'HTTP_REQUEST_FAILED',
        errorMessage: 'connect refused',
        response: null,
      }),
      'failed',
    )
    render(<ResponsePane />)
    const card = screen.getByTestId('response-error-card')
    expect(card).toHaveTextContent('请求失败')
    expect(card).toHaveTextContent('HTTP_REQUEST_FAILED · connect refused')
  })

  it('invoke 层失败（请求未发出）：错误卡显示 IPC 错误', () => {
    const tabId = makeEndpointNodeId('s1', 'e1')
    useResponseStore.setState({
      entries: {
        [tabId]: {
          phase: 'failed',
          result: null,
          error: { code: 'SHUTDOWN_IN_PROGRESS', message: 'busy' },
          startedAt: null,
        },
      },
    })
    render(<ResponsePane />)
    expect(screen.getByTestId('response-error-card')).toHaveTextContent('SHUTDOWN_IN_PROGRESS')
  })

  it('cancelled 无历史结果：状态行与内容区中性提示', () => {
    seedEntry(null, 'cancelled')
    render(<ResponsePane />)
    expect(screen.getAllByText('已取消').length).toBe(2)
  })

  it('cancelled 保留上次结果：Body 区照旧、状态行回显已取消', () => {
    seedEntry(makeResult(), 'cancelled')
    render(<ResponsePane />)
    expect(screen.getByText('已取消')).toBeInTheDocument()
    expect(screen.getByTestId('response-body')).toBeInTheDocument()
  })
})

describe('大响应分级', () => {
  it('文件档「加载全量」：range-read 分段拼接后切换全量视图，可回到预览', async () => {
    // 全文 = 'head;' + 1MB 填充 + 'tail!'（跨过单段 1MB 上限，验证分段循环）
    const fullText = `head;${'a'.repeat(1024 * 1024)}tail!`
    seedEntry(
      makeResult({
        responseId: 'http:tab:endpoint:s1:e1',
        response: {
          status: 200,
          headers: [],
          contentType: 'text/plain',
          body: { excerpt: 'head;', truncated: true, totalSize: fullText.length },
        },
      }),
    )
    const fullBytes = new TextEncoder().encode(fullText)
    invokeMock.mockImplementation((cmd: string, args?: { offset: number; len: number }) => {
      if (cmd !== 'http.read_range') return Promise.resolve(undefined)
      return Promise.resolve(
        fullBytes.slice(args?.offset ?? 0, (args?.offset ?? 0) + (args?.len ?? 0)).buffer,
      )
    })
    render(<ResponsePane />)
    expect(screen.getByText('已截断')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '加载全量' }))
    // 全文超编辑器上限（1MB+6）：全量态回落等宽 pre 呈现原文
    await waitFor(() => {
      expect(screen.getByTestId('response-body-pre')).toBeInTheDocument()
    })
    expect(screen.getByTestId('response-body-pre')).toHaveTextContent('head;')
    expect(screen.getByTestId('response-body-pre')).toHaveTextContent('tail!')
    // 分段调用：首段 offset=0 len=1MB，次段续读至读满
    const rangeCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'http.read_range')
    expect(rangeCalls).toHaveLength(2)
    expect(rangeCalls[0]?.[1]).toMatchObject({
      responseId: 'http:tab:endpoint:s1:e1',
      offset: 0,
      len: 1024 * 1024,
    })
    expect(rangeCalls[1]?.[1]).toMatchObject({ offset: 1024 * 1024 })

    fireEvent.click(screen.getByRole('button', { name: '回到预览' }))
    expect(screen.getByTestId('response-body-pre')).toHaveTextContent('head;')
  })

  it('>50MB：只读 Preview＋大小限制提示（无加载全量入口）', () => {
    seedEntry(
      makeResult({
        response: {
          status: 200,
          headers: [],
          contentType: 'application/octet-stream',
          body: { excerpt: 'x', truncated: true, totalSize: 60 * 1024 * 1024 },
        },
      }),
    )
    render(<ResponsePane />)
    expect(screen.getByText('全量查看受大小限制')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '加载全量' })).not.toBeInTheDocument()
  })
})

describe('SSE 流式入口', () => {
  it('事件流响应出现「流式」按钮；无编辑器草稿（桥未登记）时放弃启动', async () => {
    seedEntry(
      makeResult({
        response: {
          status: 200,
          headers: [['content-type', 'text/event-stream']],
          contentType: 'text/event-stream; charset=utf-8',
          body: { excerpt: 'data: done\n\n', truncated: false, totalSize: 12 },
        },
      }),
    )
    render(<ResponsePane />)
    fireEvent.click(screen.getByTestId('response-stream-button'))
    await waitFor(() => {
      expect(screen.queryByTestId('response-stream-button')).toBeInTheDocument()
    })
    // 发送参数经草稿桥取编辑器登记值：未登记（无编辑器挂载）不发起 sse.start
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'sse.start')).toBe(false)
    expect(screen.queryByTestId('sse-panel')).not.toBeInTheDocument()
  })

  it('草稿桥就绪时重放：携带当前草稿启动并渲染渐进文本', async () => {
    const { registerSendDraft } = await import('../send-bridge')
    const tabId = makeEndpointNodeId('s1', 'e1')
    const unregister = registerSendDraft(tabId, () => ({
      body: 'payload',
      params: '[{"name":"a","value":"1"}]',
      headers: '[]',
      timeoutSeconds: 30,
      auth: null,
      pathOverride: null,
      methodOverride: null,
    }))
    seedEntry(
      makeResult({
        response: {
          status: 200,
          headers: [['content-type', 'text/event-stream']],
          contentType: 'text/event-stream',
          body: { excerpt: '', truncated: false, totalSize: 0 },
        },
      }),
    )
    render(<ResponsePane />)
    fireEvent.click(screen.getByTestId('response-stream-button'))
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('sse.start', {
        serviceId: 's1',
        key: 'e1',
        tabId,
        body: 'payload',
        params: '[{"name":"a","value":"1"}]',
        headers: '[]',
        timeoutSeconds: 30,
        auth: null,
        pathOverride: null,
        methodOverride: null,
        baseUrlOverride: null,
      })
    })
    // 渐进渲染：增量事件到达即渲染（等宽 pre）
    activeListener?.({
      payload: {
        seq: 1,
        text: 'data: hello\n\n',
        done: false,
        cancelled: false,
        error: null,
        meta: null,
      },
    })
    await waitFor(() => {
      expect(screen.getByTestId('sse-text')).toHaveTextContent('data: hello')
    })
    // 停止按钮＝http.cancel
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'http.cancel')).toBe(true)
    unregister()
  })

  it('非事件流响应不出现流式按钮', () => {
    seedEntry(makeResult())
    render(<ResponsePane />)
    expect(screen.queryByTestId('response-stream-button')).not.toBeInTheDocument()
  })
})

// —— result 态状态并入页签带（无独立头行）；其余态保留头行 ——

describe('版式：result 态页签带与三态头行', () => {
  it('result 态：无独立头行，状态摘要与线型页签同排', () => {
    seedEntry(makeResult())
    render(<ResponsePane />)
    expect(screen.queryByTestId('response-header')).not.toBeInTheDocument()
    const strip = screen.getByTestId('response-tab-strip')
    expect(strip).toBeInTheDocument()
    // 状态摘要在页签带内（与 Body / Headers / 已发送请求同排）
    expect(within(strip).getByTestId('response-status-code')).toHaveTextContent('200')
    expect(within(strip).getByRole('tab', { name: 'Body' })).toBeInTheDocument()
  })

  it('视图行对齐口径：底线全宽通栏、行内 px-3、TabsList 左内边归零', () => {
    seedEntry(makeResult())
    render(<ResponsePane />)
    const strip = screen.getByTestId('response-tab-strip')
    // 底线挂行容器且无水平缩进（通栏）；行内 px-3 只约束内容起点，
    // 与请求区页签带同基准——激活线起点＝行内容左缘＝地址栏起点口径
    expect(strip).toHaveClass('border-b', 'px-3')
    expect(strip).not.toHaveClass('mx-3')
    expect(within(strip).getByRole('tablist')).toHaveClass('pl-0')
  })

  it('sending 态：保留头行（发送中指示＋实时耗时）', () => {
    const tabId = makeEndpointNodeId('s1', 'e1')
    useResponseStore.setState({
      entries: {
        [tabId]: { phase: 'sending', result: null, error: null, startedAt: Date.now() },
      },
    })
    render(<ResponsePane />)
    expect(screen.getByTestId('response-header')).toBeInTheDocument()
    expect(screen.getByText('发送中…')).toBeInTheDocument()
  })

  it('重发（sending 保留旧 result）：状态行让位发送头，旧结果的页签带不渲染', () => {
    // 第二次发送：store 进入 sending 但旧 result 仍在（发送完成才替换）——
    // 页签带不得借旧 result 复活，状态行恒为「发送中＋计时」（与首发一致）
    seedEntry(makeResult(), 'sending')
    render(<ResponsePane />)
    expect(screen.queryByTestId('response-tab-strip')).not.toBeInTheDocument()
    expect(screen.getByTestId('response-header')).toBeInTheDocument()
    expect(screen.getByText('发送中…')).toBeInTheDocument()
  })

  it('sending 态内容区：安静占位，不出现「发送请求」CTA（取消入口在地址栏）', () => {
    seedEntry(null, 'sending')
    render(<ResponsePane />)
    expect(screen.getByTestId('response-waiting')).toHaveTextContent('正在等待响应…')
    expect(screen.queryByTestId('response-empty-send')).not.toBeInTheDocument()
  })

  it('failed 态：保留头行（错误卡在内容区）', () => {
    seedEntry(
      makeResult({
        state: 'failed',
        statusCode: null,
        errorCode: 'HTTP_REQUEST_FAILED',
        errorMessage: 'connect refused',
        response: null,
      }),
      'failed',
    )
    render(<ResponsePane />)
    expect(screen.getByTestId('response-header')).toBeInTheDocument()
    expect(screen.getByTestId('response-error-card')).toBeInTheDocument()
  })

  it('empty 态：单行标题＋收起键右端常显（无 revealOnHover 透明）', () => {
    render(<ResponsePane />)
    const header = screen.getByTestId('response-empty-header')
    expect(header).toBeInTheDocument()
    expect(header).toHaveTextContent('响应')
    const button = within(header).getByTestId('response-collapse-button')
    // 右端常显：ml-auto 推至行尾，无常态透明与悬浮显形类
    expect(button).toHaveClass('ml-auto')
    expect(button).not.toHaveClass('opacity-0')
    expect(button).not.toHaveClass('group-hover/restabs:opacity-100')
  })

  it('Headers 计数：随响应头数量渲染', () => {
    seedEntry(makeResult())
    render(<ResponsePane />)
    const tab = screen.getByRole('tab', { name: /^Headers/ })
    expect(tab).toHaveTextContent('1')
  })

  it('Headers 计数：无响应头也显示 0', () => {
    seedEntry(
      makeResult({
        response: {
          status: 200,
          headers: [],
          contentType: 'application/json',
          body: { excerpt: '{}', truncated: false, totalSize: 2 },
        },
      }),
    )
    render(<ResponsePane />)
    const tab = screen.getByRole('tab', { name: /^Headers/ })
    expect(tab).toHaveTextContent('0')
  })
})

describe('收起键与折叠展开链路', () => {
  it('result 态收起键：页签带右端常显（ChevronDown，无 revealOnHover 透明）', () => {
    seedEntry(makeResult())
    render(<ResponsePane />)
    const strip = screen.getByTestId('response-tab-strip')
    const button = within(strip).getByTestId('response-collapse-button')
    // 右端：与状态摘要同组，整组由 ml-auto 推至页签带最右
    expect(button.parentElement).toHaveClass('ml-auto')
    // 常显：无常态透明与悬浮显形类；图标为单箭头 ChevronDown
    expect(button).not.toHaveClass('opacity-0')
    expect(button).not.toHaveClass('group-hover/restabs:opacity-100')
    expect(button.querySelector('svg.lucide-chevron-down')).not.toBeNull()
  })

  it('页签带收起键点击＝经 panel-bridge 通道折叠', () => {
    seedEntry(makeResult())
    render(<ResponsePane />)
    fireEvent.click(screen.getByTestId('response-collapse-button'))
    expect(collapseResponsePanelMock).toHaveBeenCalledTimes(1)
  })

  it('空态收起键点击＝经 panel-bridge 通道折叠', () => {
    render(<ResponsePane />)
    fireEvent.click(screen.getByTestId('response-collapse-button'))
    expect(collapseResponsePanelMock).toHaveBeenCalledTimes(1)
  })

  it('折叠条带点击＝经 panel-bridge 通道展开', () => {
    useAppStore.setState({ responseCollapsed: true })
    render(<ResponsePane />)
    fireEvent.click(screen.getByLabelText('展开响应区'))
    expect(expandResponsePanelMock).toHaveBeenCalledTimes(1)
  })
})
