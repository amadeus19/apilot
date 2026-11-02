import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SseEventDto, SseUpgradeDto } from '../http-api'
import type { RunResultDto } from '../http-api'
import { makeEndpointNodeId } from '@/lib/tree-identity'
import { useTabsStore } from '@/stores/tabs.store'

import { runSend } from '../send-bridge'
import { useResponseStore } from '../response.store'

// —— IPC 与事件监听替换：sse.start / http.send 走 invoke 桩，listen 桩捕获
// 事件处理器供测试手动发流 ——
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const listenMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

/** 最近注册的事件处理器（listen 桩捕获；unlisten 后摘除） */
let activeListener: ((event: { payload: unknown }) => void) | null = null
/** 按事件名注册的处理器表（升级链路：sse-upgrade 与 sse:// 两类并存） */
const listenersByName = new Map<string, (event: { payload: unknown }) => void>()
let lastUnlisten = vi.fn()

beforeEach(() => {
  invokeMock.mockReset()
  listenMock.mockReset()
  activeListener = null
  listenersByName.clear()
  lastUnlisten = vi.fn()
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === 'sse.start') return Promise.resolve({ streamId: 'stream-1' })
    if (cmd === 'http.cancel') return Promise.resolve(true)
    if (cmd === 'http.tab_closed') return Promise.resolve(false)
    return Promise.resolve(undefined)
  })
  listenMock.mockImplementation(
    async (event: string, handler: (e: { payload: unknown }) => void) => {
      activeListener = handler
      listenersByName.set(event, handler)
      return lastUnlisten
    },
  )
  useResponseStore.setState({ entries: {}, streams: {}, bodyModes: {} })
  useTabsStore.setState({ tabs: [], activeTabId: null, editorTabs: {} })
})

function openTab(tabId = makeEndpointNodeId('s1', 'e1')): string {
  useTabsStore.setState({
    tabs: [
      { id: tabId, kind: 'endpoint', title: '接口', serviceId: 's1', key: 'e1', preview: false },
    ],
    activeTabId: tabId,
  })
  return tabId
}

function emitSse(payload: Partial<SseEventDto> & { text: string }): void {
  activeListener?.({
    payload: { seq: 0, done: false, cancelled: false, error: null, meta: null, ...payload },
  })
}

/** 触发 tab 作用域的升级告知（普通发送命中事件流响应时后端推送） */
function emitUpgrade(tabId: string, payload: SseUpgradeDto): void {
  listenersByName.get(`sse-upgrade://${tabId}`)?.({ payload })
}

function makeResult(overrides?: Partial<RunResultDto>): RunResultDto {
  return {
    runId: 'run-1',
    state: 'passed',
    statusCode: 200,
    durationMs: 120,
    errorCode: null,
    errorMessage: null,
    request: {
      method: 'GET',
      url: 'http://localhost/orders',
      headers: [],
      body: null,
      redactions: { headerNames: [], queryKeys: [], secretValues: [] },
    },
    response: {
      status: 200,
      headers: [['content-type', 'application/json']],
      contentType: 'application/json',
      body: { excerpt: '{}', truncated: false, totalSize: 2 },
    },
    responseId: null,
    resolved: { url: 'http://localhost/orders', hits: [], secretValues: [] },
    ...overrides,
  }
}

const SEND_ARGS = {
  serviceId: 's1',
  key: 'e1',
  tabId: 'endpoint:s1:e1',
  body: null,
  params: '[]',
  headers: '[]',
  timeoutSeconds: null,
  auth: null,
  pathOverride: null,
  methodOverride: null,
  baseUrlOverride: null,
}

describe('普通发送终态写入', () => {
  it('passed 覆盖 result 并置 done', () => {
    const tabId = openTab()
    const store = useResponseStore.getState()
    store.beginSend(tabId)
    store.finishSend(tabId, makeResult())
    const entry = useResponseStore.getState().entries[tabId]
    expect(entry?.phase).toBe('done')
    expect(entry?.result?.runId).toBe('run-1')
    expect(entry?.startedAt).toBeNull()
  })

  it('cancelled 保留旧 result（面板不被取消清空），phase=cancelled', () => {
    const tabId = openTab()
    const store = useResponseStore.getState()
    store.finishSend(tabId, makeResult({ runId: 'old' }))
    store.beginSend(tabId)
    store.finishSend(tabId, makeResult({ runId: 'new', state: 'cancelled' }))
    const entry = useResponseStore.getState().entries[tabId]
    expect(entry?.phase).toBe('cancelled')
    expect(entry?.result?.runId).toBe('old')
  })

  it('invoke 层失败：phase=failed＋错误信息，保留旧 result', () => {
    const tabId = openTab()
    const store = useResponseStore.getState()
    store.finishSend(tabId, makeResult({ runId: 'old' }))
    store.beginSend(tabId)
    store.failSend(tabId, { code: 'SHUTDOWN_IN_PROGRESS', message: 'busy' })
    const entry = useResponseStore.getState().entries[tabId]
    expect(entry?.phase).toBe('failed')
    expect(entry?.error?.code).toBe('SHUTDOWN_IN_PROGRESS')
    expect(entry?.result?.runId).toBe('old')
  })

  it('关 Tab 后到达的终态丢弃（写入守卫）', () => {
    const tabId = openTab()
    const store = useResponseStore.getState()
    store.beginSend(tabId)
    // 关闭全部 Tab：订阅清理移除条目
    useTabsStore.setState({ tabs: [], activeTabId: null })
    store.finishSend(tabId, makeResult())
    expect(useResponseStore.getState().entries[tabId]).toBeUndefined()
  })
})

describe('Body 视图偏好（per-tab）', () => {
  it('setBodyMode 按 Tab 写入，新请求（新 runId）不重置——偏好由 Tab 生命周期管理', () => {
    const tabId = openTab()
    const store = useResponseStore.getState()
    store.setBodyMode(tabId, 'raw')
    expect(useResponseStore.getState().bodyModes[tabId]).toBe('raw')
    // 新发送只覆盖 entries，不触碰 bodyModes
    store.beginSend(tabId)
    store.finishSend(tabId, makeResult({ runId: 'run-2' }))
    expect(useResponseStore.getState().bodyModes[tabId]).toBe('raw')
  })

  it('关 Tab：bodyModes 一并回收，且死 Tab 触发关 Tab 清理', () => {
    const tabId = openTab()
    useResponseStore.getState().setBodyMode(tabId, 'pretty')
    useTabsStore.setState({ tabs: [], activeTabId: null })
    expect(useResponseStore.getState().bodyModes[tabId]).toBeUndefined()
    const closedCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'http.tab_closed')
    expect(closedCalls).toHaveLength(1)
  })

  it('关 Tab 后迟到的 setBodyMode 不写入（活 Tab 守卫）', () => {
    const tabId = openTab()
    useTabsStore.setState({ tabs: [], activeTabId: null })
    useResponseStore.getState().setBodyMode(tabId, 'raw')
    expect(useResponseStore.getState().bodyModes[tabId]).toBeUndefined()
  })
})

describe('SSE 流（store 层生命周期）', () => {
  it('startStream：sse.start 携带发送参数，seq=0 meta 与增量文本累计渲染', async () => {
    const tabId = openTab()
    await useResponseStore.getState().startStream(tabId, { ...SEND_ARGS, tabId })
    expect(invokeMock).toHaveBeenCalledWith('sse.start', { ...SEND_ARGS, tabId })
    expect(listenMock).toHaveBeenCalledWith('sse://stream-1', expect.any(Function))
    expect(useResponseStore.getState().entries[tabId]?.phase).toBe('sending')

    emitSse({ text: '', meta: { status: 200, headers: [], contentType: 'text/event-stream' } })
    emitSse({ text: 'data: a\n\n' })
    emitSse({ text: 'data: b\n\n' })
    const stream = useResponseStore.getState().streams[tabId]
    expect(stream?.streamId).toBe('stream-1')
    expect(stream?.text).toBe('data: a\n\ndata: b\n\n')
    expect(stream?.receivedChars).toBe('data: a\n\ndata: b\n\n'.length)
    expect(stream?.meta?.status).toBe(200)
  })

  it('done 终态：流标记结束、发送位回终态、监听器 unlisten', async () => {
    const tabId = openTab()
    await useResponseStore.getState().startStream(tabId, { ...SEND_ARGS, tabId })
    emitSse({ text: 'chunk', done: true })
    const state = useResponseStore.getState()
    expect(state.streams[tabId]?.phase).toBe('done')
    expect(state.entries[tabId]?.phase).toBe('done')
    expect(lastUnlisten).toHaveBeenCalled()
    // 终态后到达的迟到事件不再累计（监听已摘，防线为流身份判定）
    activeListener?.({
      payload: { seq: 9, text: 'late', done: false, cancelled: false, error: null, meta: null },
    })
    expect(useResponseStore.getState().streams[tabId]?.text).toBe('chunk')
  })

  it('cancelled 终态：流标记取消（已收部分保留），发送位回 cancelled', async () => {
    const tabId = openTab()
    await useResponseStore.getState().startStream(tabId, { ...SEND_ARGS, tabId })
    emitSse({ text: 'partial' })
    emitSse({ text: '', cancelled: true })
    const state = useResponseStore.getState()
    expect(state.streams[tabId]?.phase).toBe('cancelled')
    expect(state.streams[tabId]?.text).toBe('partial')
    expect(state.entries[tabId]?.phase).toBe('cancelled')
  })

  it('error 终态：错误体入流条目，发送位回 failed', async () => {
    const tabId = openTab()
    await useResponseStore.getState().startStream(tabId, { ...SEND_ARGS, tabId })
    emitSse({ text: '', error: { code: 'HTTP_REQUEST_FAILED', message: 'connect refused' } })
    const state = useResponseStore.getState()
    expect(state.streams[tabId]?.phase).toBe('error')
    expect(state.streams[tabId]?.error?.code).toBe('HTTP_REQUEST_FAILED')
    expect(state.entries[tabId]?.phase).toBe('failed')
  })

  it('前端缓冲有界：累计文本超上限裁掉头部，只保留尾部', async () => {
    const tabId = openTab()
    await useResponseStore.getState().startStream(tabId, { ...SEND_ARGS, tabId })
    // 两段各 200K 字符：累计 400K 超过 256K 上限，保留尾部 256K
    const head = 'a'.repeat(200 * 1024)
    const tail = 'b'.repeat(200 * 1024)
    emitSse({ text: head })
    emitSse({ text: tail })
    const stream = useResponseStore.getState().streams[tabId]
    expect(stream?.text.length).toBe(256 * 1024)
    expect(stream?.text.startsWith('a')).toBe(true)
    expect(stream?.text.endsWith('b')).toBe(true)
    // 已收计数不受裁剪影响
    expect(stream?.receivedChars).toBe(400 * 1024)
  })

  it('旧流迟到事件按流身份丢弃：新流启动后旧 streamId 事件不写入', async () => {
    const tabId = openTab()
    await useResponseStore.getState().startStream(tabId, { ...SEND_ARGS, tabId })
    const staleListener = activeListener
    // 第二次启动（新流）：旧监听被摘除、条目重置
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'sse.start' ? Promise.resolve({ streamId: 'stream-2' }) : Promise.resolve(true),
    )
    await useResponseStore.getState().startStream(tabId, { ...SEND_ARGS, tabId })
    expect(lastUnlisten).toHaveBeenCalled()
    // 旧流事件（stream-1）到达：身份不符丢弃
    staleListener?.({
      payload: { seq: 1, text: 'stale', done: false, cancelled: false, error: null, meta: null },
    })
    expect(useResponseStore.getState().streams[tabId]?.text).toBe('')
  })

  it('stopStream＝http.cancel（终态经 cancelled 事件回写）', async () => {
    const tabId = openTab()
    await useResponseStore.getState().startStream(tabId, { ...SEND_ARGS, tabId })
    useResponseStore.getState().stopStream(tabId)
    const cancelCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'http.cancel')
    expect(cancelCalls).toHaveLength(1)
    expect(cancelCalls[0]?.[1]).toEqual({ tabId })
  })

  it('sse.start 失败：终态 failed＋错误信息，流条目清场', async () => {
    const tabId = openTab()
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'sse.start') {
        return Promise.reject({
          kind: 'apilot_error',
          code: 'HTTP_REQUEST_FAILED',
          message: 'boom',
        })
      }
      return Promise.resolve(true)
    })
    await useResponseStore.getState().startStream(tabId, { ...SEND_ARGS, tabId })
    const state = useResponseStore.getState()
    expect(state.streams[tabId]).toBeUndefined()
    expect(state.entries[tabId]?.phase).toBe('failed')
    expect(state.entries[tabId]?.error?.code).toBe('HTTP_REQUEST_FAILED')
  })

  it('关 Tab：流条目与终态条目一并清理，在途流触发关 Tab 清理', async () => {
    const tabId = openTab()
    await useResponseStore.getState().startStream(tabId, { ...SEND_ARGS, tabId })
    emitSse({ text: 'chunk' })
    useTabsStore.setState({ tabs: [], activeTabId: null })
    const state = useResponseStore.getState()
    expect(state.streams[tabId]).toBeUndefined()
    expect(state.entries[tabId]).toBeUndefined()
    expect(lastUnlisten).toHaveBeenCalled()
    const closedCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'http.tab_closed')
    expect(closedCalls).toHaveLength(1)
    expect(closedCalls[0]?.[1]).toEqual({ tabId })
  })

  it('关 Tab：在途普通发送（无流条目）也触发关 Tab 清理（取消＋删临时文件）', () => {
    const tabId = openTab()
    useResponseStore.getState().beginSend(tabId)
    useTabsStore.setState({ tabs: [], activeTabId: null })
    expect(useResponseStore.getState().entries[tabId]).toBeUndefined()
    const closedCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'http.tab_closed')
    expect(closedCalls).toHaveLength(1)
    expect(closedCalls[0]?.[1]).toEqual({ tabId })
  })

  it('切工作空间（restore 整体替换 tabs）：逐死 Tab 触发关 Tab 清理', () => {
    const tabA = openTab(makeEndpointNodeId('s1', 'e1'))
    const tabB = makeEndpointNodeId('s1', 'e2')
    useTabsStore.setState({
      tabs: [
        { id: tabA, kind: 'endpoint', title: '接口A', serviceId: 's1', key: 'e1', preview: false },
        { id: tabB, kind: 'endpoint', title: '接口B', serviceId: 's1', key: 'e2', preview: false },
      ],
      activeTabId: tabA,
    })
    useResponseStore.getState().beginSend(tabA)
    useResponseStore.getState().beginSend(tabB)
    // 切工作空间：会话恢复整体替换 tabs（新空间的 Tab id 互异——serviceId
    // 按工作空间隔离，旧 Tab 全部死亡）
    useTabsStore.setState({
      tabs: [
        {
          id: makeEndpointNodeId('s9', 'e1'),
          kind: 'endpoint',
          title: '新空间',
          serviceId: 's9',
          key: 'e1',
          preview: false,
        },
      ],
      activeTabId: makeEndpointNodeId('s9', 'e1'),
    })
    const closedIds = invokeMock.mock.calls
      .filter(([cmd]) => cmd === 'http.tab_closed')
      .map(([, args]) => (args as { tabId: string }).tabId)
    expect(closedIds).toEqual([tabA, tabB])
  })
})

describe('SSE 升级（普通发送的事件流即时视图）', () => {
  it('升级告知即时建立流条目（meta 落地）、增量实时累计；http.send 落定后收场回终态', async () => {
    const tabId = openTab()
    let resolveSend: (result: RunResultDto) => void = () => undefined
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'http.send') {
        return new Promise<RunResultDto>((resolve) => {
          resolveSend = resolve
        })
      }
      return Promise.resolve(true)
    })

    const sending = runSend({ ...SEND_ARGS, tabId })
    // 升级监听在 invoke 发起前注册（时序前提）；http.send 挂起中
    // （pending promise 即 invoke 已发出）
    await vi.waitFor(() => expect(listenersByName.has(`sse-upgrade://${tabId}`)).toBe(true))

    // 响应头到达（升级告知）：流条目立即建立，发送中即有流式视图
    emitUpgrade(tabId, {
      streamId: 'run-9',
      meta: { status: 200, headers: [], contentType: 'text/event-stream; charset=utf-8' },
    })
    await vi.waitFor(() => {
      const stream = useResponseStore.getState().streams[tabId]
      expect(stream?.streamId).toBe('run-9')
      expect(stream?.phase).toBe('streaming')
      expect(stream?.meta?.status).toBe(200)
    })
    // 增量经 sse://run-9 累计渲染
    emitSse({ text: 'data: a\n\n' })
    emitSse({ text: 'data: b\n\n' })
    expect(useResponseStore.getState().streams[tabId]?.text).toBe('data: a\n\ndata: b\n\n')

    // 流结束（http.send 返回）：升级态收场，终态展示回 result
    resolveSend(makeResult({ runId: 'run-9', state: 'passed' }))
    await sending
    const state = useResponseStore.getState()
    expect(state.streams[tabId]).toBeUndefined()
    expect(state.entries[tabId]?.phase).toBe('done')
    expect(state.entries[tabId]?.result?.runId).toBe('run-9')
    expect(lastUnlisten).toHaveBeenCalled()
  })

  it('升级流终态事件先行落 phase，http.send 落定后覆盖 result 并收场', async () => {
    const tabId = openTab()
    let resolveSend: (result: RunResultDto) => void = () => undefined
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'http.send') {
        return new Promise<RunResultDto>((resolve) => {
          resolveSend = resolve
        })
      }
      return Promise.resolve(true)
    })
    const sending = runSend({ ...SEND_ARGS, tabId })
    await vi.waitFor(() => expect(listenersByName.has(`sse-upgrade://${tabId}`)).toBe(true))
    emitUpgrade(tabId, {
      streamId: 'run-10',
      meta: { status: 200, headers: [], contentType: 'text/event-stream' },
    })
    await vi.waitFor(() =>
      expect(useResponseStore.getState().streams[tabId]?.streamId).toBe('run-10'),
    )

    // 终态事件先于 invoke 返回到达：发送位先落 done（保留旧 result），流条目留存
    emitSse({ text: 'chunk', done: true })
    expect(useResponseStore.getState().entries[tabId]?.phase).toBe('done')
    expect(useResponseStore.getState().streams[tabId]?.phase).toBe('done')

    resolveSend(makeResult({ runId: 'run-10', state: 'passed' }))
    await sending
    const state = useResponseStore.getState()
    expect(state.streams[tabId]).toBeUndefined()
    expect(state.entries[tabId]?.result?.runId).toBe('run-10')
  })

  it('新发送清场使旧预登记失效：迟到的升级告知不建条目', async () => {
    const tabId = openTab()
    await useResponseStore.getState().armSseUpgrade(tabId)
    // 用户再次发送：beginSend 清场（旧代回调失效）
    useResponseStore.getState().beginSend(tabId)
    emitUpgrade(tabId, {
      streamId: 'run-late',
      meta: { status: 200, headers: [], contentType: 'text/event-stream' },
    })
    await vi.waitFor(() =>
      expect(useResponseStore.getState().entries[tabId]?.phase).toBe('sending'),
    )
    expect(useResponseStore.getState().streams[tabId]).toBeUndefined()
  })

  it('invoke 失败（升级在途）：升级态随 failSend 收场，终态 failed 保留旧 result', async () => {
    const tabId = openTab()
    useResponseStore.getState().finishSend(tabId, makeResult({ runId: 'old' }))
    let rejectSend: (err: unknown) => void = () => undefined
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'http.send') {
        return new Promise<RunResultDto>((_resolve, reject) => {
          rejectSend = reject
        })
      }
      return Promise.resolve(true)
    })
    const sending = runSend({ ...SEND_ARGS, tabId })
    await vi.waitFor(() => expect(listenersByName.has(`sse-upgrade://${tabId}`)).toBe(true))
    emitUpgrade(tabId, {
      streamId: 'run-11',
      meta: { status: 200, headers: [], contentType: 'text/event-stream' },
    })
    await vi.waitFor(() =>
      expect(useResponseStore.getState().streams[tabId]?.streamId).toBe('run-11'),
    )

    rejectSend({ kind: 'apilot_error', code: 'SHUTDOWN_IN_PROGRESS', message: 'busy' })
    await sending
    const state = useResponseStore.getState()
    expect(state.streams[tabId]).toBeUndefined()
    expect(state.entries[tabId]?.phase).toBe('failed')
    expect(state.entries[tabId]?.error?.code).toBe('SHUTDOWN_IN_PROGRESS')
    expect(state.entries[tabId]?.result?.runId).toBe('old')
  })
})
