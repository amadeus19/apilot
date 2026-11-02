import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// —— IPC 替换：run.get 走桩 ——
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

// —— 剪贴板替换（jsdom 无 navigator.clipboard；响应头行级复制消费） ——
const writeTextMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))

import { HistoryDetailPane } from '../history-detail-pane'
import type { RunDetailDto } from '../history-api'
import { createQueryWrapper } from '@/test/render-providers'
import { useTabsStore } from '@/stores/tabs.store'
import { useDraftStore } from '@/features/workbench/draft.store'

/** 详情夹具：passed＋完整请求 / 响应快照（含敏感头与 query 掩码提示） */
function makeDetail(overrides?: Partial<RunDetailDto>): RunDetailDto {
  return {
    runId: 'run-1',
    workspaceId: 'w1',
    serviceId: 's1',
    endpointKey: 'k1',
    method: 'GET',
    url: 'http://localhost/orders?page=1',
    statusCode: 200,
    durationMs: 340,
    state: 'passed',
    errorCode: null,
    errorMessage: null,
    source: 'gui',
    createdAt: '2026-10-02T07:30:00.000Z',
    request: {
      method: 'GET',
      url: 'http://localhost/orders?page=1&api_key=secret',
      headers: [
        ['accept', '*/*'],
        ['authorization', 'Bearer secret-token'],
        ['x-custom-key', 'my-api-key'],
      ],
      body: { excerpt: '{"query":"x"}', truncated: true, totalSize: 4096 },
      redactions: { headerNames: ['x-custom-key'], queryKeys: ['api_key'], secretValues: [] },
    },
    response: {
      status: 200,
      headers: [['content-type', 'application/json']],
      contentType: 'application/json',
      body: { excerpt: '{"ok":true}', truncated: true, totalSize: 3 * 1024 * 1024 },
    },
    ...overrides,
  }
}

beforeEach(() => {
  invokeMock.mockReset()
  writeTextMock.mockClear()
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: writeTextMock },
  })
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === 'run.get') return Promise.resolve(makeDetail())
    return Promise.resolve(undefined)
  })
  useTabsStore.setState({ tabs: [], activeTabId: null, editorTabs: {} })
  useDraftStore.setState({ drafts: {} })
})

describe('历史详情：只读全量留痕', () => {
  it('状态行（大号状态码＋state 徽标＋runId）＋只读声明＋元信息表', async () => {
    render(<HistoryDetailPane runId="run-1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getByTestId('history-detail')).toBeInTheDocument()
    })

    expect(screen.getByText('只读留痕：仅展示该次请求的完整记录，可恢复为草稿')).toBeInTheDocument()
    const status = screen.getByTestId('history-detail-status')
    expect(status).toHaveTextContent('200')
    expect(status.className).toContain('text-success')
    expect(screen.getByText('成功')).toBeInTheDocument()
    expect(screen.getByText('run-1')).toBeInTheDocument()

    // 元信息行：耗时 / 时间 / 来源收拢一行（方法与 URL 只在「已发送请求」呈现）
    expect(screen.getByText('340ms')).toBeInTheDocument()
    expect(screen.getByText('GUI')).toBeInTheDocument()
    expect(screen.getByText('时间')).toBeInTheDocument()
    expect(screen.queryByText('方法')).not.toBeInTheDocument()
    expect(screen.queryByText('URL')).not.toBeInTheDocument()
    // passed 无错误码
    expect(screen.queryByText('错误码')).not.toBeInTheDocument()
  })

  it('已发送请求分区：敏感头与 query 默认脱敏，显式放行后还原', async () => {
    render(<HistoryDetailPane runId="run-1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getByTestId('response-sent-request')).toBeInTheDocument()
    })

    // 标准敏感头（authorization）与 redactions 提示的自定义头（x-custom-key）掩码；
    // 普通头原样
    expect(screen.getAllByText('***')).toHaveLength(2)
    expect(screen.getByText('*/*')).toBeInTheDocument()
    // URL 中命中 redactions 的 query 值掩码
    expect(screen.getByText('http://localhost/orders?page=1&api_key=***')).toBeInTheDocument()

    // 「显示敏感值」显式放行（开发调试通道，只读语义不变）；作用域限已发送
    // 请求分区——响应快照节有自己的同名开关
    fireEvent.click(
      within(screen.getByTestId('response-sent-request')).getByRole('button', {
        name: '显示敏感值',
      }),
    )
    expect(screen.getByText('Bearer secret-token')).toBeInTheDocument()
    expect(screen.getByText('my-api-key')).toBeInTheDocument()
    expect(screen.getByText('http://localhost/orders?page=1&api_key=secret')).toBeInTheDocument()
  })

  it('truncated 徽标：请求体与响应快照均带「已截断」＋总量', async () => {
    render(<HistoryDetailPane runId="run-1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getByTestId('history-detail-response')).toBeInTheDocument()
    })
    expect(screen.getAllByText('已截断')).toHaveLength(2)
    expect(screen.getByText('4.0 KB')).toBeInTheDocument() /* 请求体总量 */
    expect(screen.getByText('3.0 MB')).toBeInTheDocument() /* 响应总量 */
    // 响应快照：contentType（头部行）与响应头列表各呈现一次 / 摘要 body
    expect(screen.getAllByText('application/json')).toHaveLength(2)
    expect(screen.getByText('{"ok":true}')).toBeInTheDocument()
    expect(screen.getByText('{"query":"x"}')).toBeInTheDocument()
  })

  it('响应快照重名头（Set-Cookie 多值）逐行渲染不丢行；敏感值默认掩码、放行后还原', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'run.get') {
        return Promise.resolve(
          makeDetail({
            response: {
              status: 200,
              headers: [
                ['set-cookie', 'a=1; Path=/'],
                ['set-cookie', 'b=2; Path=/'],
              ],
              contentType: 'application/json',
              body: { excerpt: '{}', truncated: false, totalSize: 2 },
            },
          }),
        )
      }
      return Promise.resolve(undefined)
    })
    render(<HistoryDetailPane runId="run-1" />, { wrapper: createQueryWrapper() })
    const section = await screen.findByTestId('history-detail-response')
    expect(within(section).getAllByText('set-cookie')).toHaveLength(2)
    // 全路径脱敏：set-cookie 命中标准名单，默认 ***（两行都不露值）
    expect(within(section).getAllByText('***')).toHaveLength(2)
    expect(section).not.toHaveTextContent('a=1; Path=/')

    // 「显示敏感值」放行（作用域限响应快照节）：原值还原、行数不丢
    fireEvent.click(within(section).getByRole('button', { name: '显示敏感值' }))
    expect(within(section).getAllByText('set-cookie')).toHaveLength(2)
    expect(section).toHaveTextContent('a=1; Path=/')
    expect(section).toHaveTextContent('b=2; Path=/')
  })

  it('响应快照敏感头行级复制恒掩码（不随「显示敏感值」放行）', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'run.get') {
        return Promise.resolve(
          makeDetail({
            response: {
              status: 200,
              headers: [
                ['set-cookie', 'sid=secret'],
                ['content-type', 'application/json'],
              ],
              contentType: 'application/json',
              body: { excerpt: '{}', truncated: false, totalSize: 2 },
            },
          }),
        )
      }
      return Promise.resolve(undefined)
    })
    render(<HistoryDetailPane runId="run-1" />, { wrapper: createQueryWrapper() })
    const section = await screen.findByTestId('history-detail-response')

    // 放行敏感值后，行级复制仍以掩码口径写剪贴板（不给泄露通道）
    fireEvent.click(within(section).getByRole('button', { name: '显示敏感值' }))
    expect(within(section).getByText('sid=secret')).toBeInTheDocument()
    fireEvent.click(within(section).getAllByRole('button', { name: '复制' })[0]!)
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith('set-cookie: ***')
    })

    // 非敏感头复制原值
    fireEvent.click(within(section).getAllByRole('button', { name: '复制' })[1]!)
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith('content-type: application/json')
    })
  })

  it('快照缺失（request 为解析失败的 null / 空对象）：分区降级为「快照缺失」', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'run.get') return Promise.resolve(makeDetail({ request: null }))
      return Promise.resolve(undefined)
    })
    render(<HistoryDetailPane runId="run-1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getByText('快照缺失')).toBeInTheDocument()
    })
  })
})

describe('历史详情：错误 / 取消 / 缺记录', () => {
  it('failed＋TIMEOUT：错误卡用与响应面板同款超时文案', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'run.get') {
        return Promise.resolve(
          makeDetail({
            state: 'failed',
            statusCode: null,
            errorCode: 'TIMEOUT',
            errorMessage: 'request timed out',
            response: null,
          }),
        )
      }
      return Promise.resolve(undefined)
    })
    render(<HistoryDetailPane runId="run-1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getByTestId('history-detail-error-card')).toBeInTheDocument()
    })
    expect(screen.getByText('请求超时')).toBeInTheDocument()
    expect(screen.getByText('已按超时设置终止')).toBeInTheDocument()
    expect(screen.getByText('失败')).toBeInTheDocument()
    // 错误码只在错误卡呈现（等宽；元信息行不再单列错误码）
    expect(screen.getAllByText('TIMEOUT')).toHaveLength(1)
    // 无响应快照的显式说明
    expect(screen.getByText('无响应快照')).toBeInTheDocument()
  })

  it('failed＋非 TIMEOUT：错误卡展示通用失败标题与 errorMessage', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'run.get') {
        return Promise.resolve(
          makeDetail({
            state: 'failed',
            statusCode: 502,
            errorCode: 'HTTP_REQUEST_FAILED',
            errorMessage: 'connection refused',
            response: null,
          }),
        )
      }
      return Promise.resolve(undefined)
    })
    render(<HistoryDetailPane runId="run-1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getByTestId('history-detail-error-card')).toBeInTheDocument()
    })
    expect(screen.getByText('请求失败')).toBeInTheDocument()
    expect(screen.getByText('connection refused')).toBeInTheDocument()
  })

  it('cancelled：中性卡＋无响应快照', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'run.get') {
        return Promise.resolve(makeDetail({ state: 'cancelled', statusCode: null, response: null }))
      }
      return Promise.resolve(undefined)
    })
    render(<HistoryDetailPane runId="run-1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getByTestId('history-detail-cancelled-card')).toBeInTheDocument()
    })
    // 「已取消」在 state 徽标与中性卡标题两处呈现
    expect(screen.getAllByText('已取消')).toHaveLength(2)
    expect(screen.getByText('该请求在完成前被取消，未留存响应快照')).toBeInTheDocument()
  })

  it('记录不存在（已被封顶修剪）：终态空态', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'run.get') return Promise.resolve(null)
      return Promise.resolve(undefined)
    })
    render(<HistoryDetailPane runId="run-gone" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getByTestId('history-detail-missing')).toBeInTheDocument()
    })
    expect(screen.getByText('记录不存在')).toBeInTheDocument()
    expect(screen.getByText('该执行记录可能已被清理')).toBeInTheDocument()
  })
})

describe('历史详情：恢复为草稿（以历史为模板的新草稿）', () => {
  it('点击恢复：开新草稿 Tab 并播种内存草稿（URL 绝对形态＋query 拆行＋headers 真值保留）', async () => {
    render(<HistoryDetailPane runId="run-1" />, { wrapper: createQueryWrapper() })
    const button = await screen.findByTestId('history-restore-draft-button')
    expect(button).toBeEnabled()

    fireEvent.click(button)
    const state = useTabsStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]).toMatchObject({ kind: 'draft', title: 'GET http://localhost/orders' })
    expect(state.activeTabId).toBe(state.tabs[0]!.id)

    // 草稿内容＝快照副本：无 BaseUrl（workspace.list 未 mock）→ 完整 URL 模板；
    // query 拆参数行；敏感头真值保留、名单随行
    const data = useDraftStore.getState().drafts[state.tabs[0]!.id]
    expect(data).toMatchObject({
      method: 'GET',
      pathTemplate: 'http://localhost/orders',
      bodyTruncated: true,
      sensitiveHeaderNames: ['x-custom-key'],
      sourceServiceId: 's1',
    })
    expect(JSON.parse(data!.paramsJson)).toEqual([
      { name: 'page', value: '1' },
      { name: 'api_key', value: 'secret' },
    ])
    expect(JSON.parse(data!.headersJson)).toEqual([
      { name: 'accept', value: '*/*' },
      { name: 'authorization', value: 'Bearer secret-token' },
      { name: 'x-custom-key', value: 'my-api-key' },
    ])
    // body 信封嗅探（JSON→json，excerpt 原文不改写）
    expect(JSON.parse(data!.body!)).toEqual({ kind: 'json', text: '{"query":"x"}' })

    // 历史记录零改动：无任何写命令被调用
    const calledCommands = invokeMock.mock.calls.map(([cmd]) => cmd)
    expect(calledCommands).not.toContain('run.delete')
    expect(calledCommands).not.toContain('user_data.upsert')
  })

  it('BaseUrl 命中当前工作空间：host 剥离，path＋query 进草稿', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'run.get') return Promise.resolve(makeDetail())
      if (cmd === 'workspace.list') {
        return Promise.resolve({
          items: [
            {
              id: 'w1',
              name: '默认工作空间',
              baseUrl: 'http://localhost',
              auth: null,
              isCurrent: true,
            },
          ],
          currentId: 'w1',
        })
      }
      return Promise.resolve(undefined)
    })
    render(<HistoryDetailPane runId="run-1" />, { wrapper: createQueryWrapper() })
    fireEvent.click(await screen.findByTestId('history-restore-draft-button'))

    const state = useTabsStore.getState()
    const data = useDraftStore.getState().drafts[state.tabs[0]!.id]
    expect(data?.pathTemplate).toBe('/orders')
    expect(state.tabs[0]?.title).toBe('GET /orders')
  })

  it('快照缺失：恢复按钮禁用（无从构造草稿）', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'run.get') return Promise.resolve(makeDetail({ request: null }))
      return Promise.resolve(undefined)
    })
    render(<HistoryDetailPane runId="run-1" />, { wrapper: createQueryWrapper() })
    const button = await screen.findByTestId('history-restore-draft-button')
    expect(button).toBeDisabled()
    expect(useTabsStore.getState().tabs).toHaveLength(0)
  })
})
