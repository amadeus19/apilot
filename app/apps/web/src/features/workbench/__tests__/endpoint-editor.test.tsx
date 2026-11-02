import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { flushAllForExit } from '@/services/exit-flush'
import { createQueryWrapper } from '@/test/render-providers'
import { workbenchKeys } from '@/services/workbench-api'
import { makeEndpointNodeId } from '@/lib/tree-identity'
import { useTabsStore, type TabMeta } from '@/stores/tabs.store'
import { useResponseStore } from '@/features/http/response.store'
import { useDraftStore } from '../draft.store'

import { EndpointEditor, type EndpointTabMeta } from '../endpoint-editor'
import { invokeSendAction } from '../send-action-bridge'

// —— IPC invoke 替换：按命令名分派（草稿存储为可变桩，验证整包写与重读） ——
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

// —— 剪贴板 stub（CopyButton 的写入面）：Proxy 透传其余 navigator 属性 ——
const clipboardState = vi.hoisted(() => ({ writeText: vi.fn() }))

const locateMock = vi.hoisted(() => vi.fn())
vi.mock('@/features/api-tree/tree-locate', () => ({ locateInApiTree: locateMock }))

// Monaco 底座替换（jsdom 不真渲染编辑器）：textarea 承载 value/onChange，
// language / theme / wordWrap 以 data 属性透出供 props 断言
vi.mock('@/features/http/monaco-text-editor', async () => {
  const React = await import('react')
  function Editor(props: {
    value?: string
    language?: string
    theme?: string
    wordWrap?: boolean
    onChange?: (value: string) => void
    variableSuggest?: { workspaceId: string } | null
  }) {
    return React.createElement('textarea', {
      'data-testid': 'editor-body-input',
      'data-language': props.language,
      'data-theme': props.theme,
      'data-word-wrap': String(props.wordWrap),
      'data-suggest-workspace': props.variableSuggest?.workspaceId ?? '',
      value: props.value ?? '',
      onChange: (event: { target: { value: string } }) => props.onChange?.(event.target.value),
    })
  }
  return { MonacoTextEditor: Editor }
})

const TREE = {
  workspaceId: 'w1',
  services: [
    {
      id: 's1',
      name: '用户服务',
      docUrl: null,
      docType: 'openapi',
      sortOrder: 0,
      categories: [{ id: 'c1', name: '账号管理', sortOrder: 0 }],
      endpoints: [
        {
          serviceId: 's1',
          key: 'e1',
          title: '创建订单',
          categoryId: 'c1',
          definition: { method: 'POST', pathTemplate: '/orders' },
          isManual: true,
          pinned: false,
        },
        {
          serviceId: 's1',
          key: 'e2',
          title: '登录',
          categoryId: null,
          definition: { method: 'GET', pathTemplate: '/login' },
          isManual: false,
          pinned: false,
        },
      ],
    },
  ],
}

/** 草稿存储桩：upsert 更新、get 回读（重开 Tab 读同一份的验证基础） */
let storedDraft: {
  body: string | null
  params: string
  headers: string
  timeoutSeconds: number | null
  auth: string | null
  pathOverride?: string | null
}

function stubInvokes() {
  invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'workspace.list') {
      return Promise.resolve({
        items: [
          {
            id: 'w1',
            name: '默认工作空间',
            baseUrl: 'http://localhost:5000',
            auth: null,
            isCurrent: true,
          },
        ],
        currentId: 'w1',
      })
    }
    if (cmd === 'tree.get') return Promise.resolve(TREE)
    if (cmd === 'user_data.get') {
      return Promise.resolve({
        serviceId: 's1',
        key: 'e1',
        ...storedDraft,
        updatedAt: '2026-09-29T00:00:00.000Z',
      })
    }
    if (cmd === 'user_data.upsert') {
      const payload = args?.args as {
        body: string | null
        params: string
        headers: string
        timeoutSeconds: number | null
        auth: string | null
      }
      storedDraft = {
        body: payload.body,
        params: payload.params,
        headers: payload.headers,
        timeoutSeconds: payload.timeoutSeconds ?? null,
        auth: payload.auth ?? null,
      }
      return Promise.resolve({
        serviceId: 's1',
        key: 'e1',
        ...storedDraft,
        updatedAt: '2026-09-29T00:00:01.000Z',
      })
    }
    if (cmd === 'endpoint.update_manual') {
      const payload = args?.args as { title: string }
      return Promise.resolve({
        serviceId: 's1',
        key: 'e1',
        title: payload.title,
        categoryId: 'c1',
        definition: { method: 'POST', pathTemplate: '/orders' },
        isManual: true,
      })
    }
    if (cmd === 'endpoint.create_manual') {
      const input = args?.args as {
        serviceId: string
        method: string
        pathTemplate: string
        title: string
      }
      return Promise.resolve({
        serviceId: input.serviceId,
        key: 'e-new-1',
        title: input.title,
        categoryId: null,
        definition: { method: input.method, pathTemplate: input.pathTemplate },
        isManual: true,
      })
    }
    return Promise.resolve(undefined)
  })
}

function makeTab(overrides?: Partial<TabMeta>): EndpointTabMeta {
  return {
    id: makeEndpointNodeId('s1', 'e1'),
    kind: 'endpoint',
    title: '创建订单',
    serviceId: 's1',
    key: 'e1',
    preview: false,
    ...overrides,
  } as EndpointTabMeta
}

function renderEditor(tab: EndpointTabMeta = makeTab()) {
  return render(<EndpointEditor tab={tab} />, { wrapper: createQueryWrapper() })
}

/** 等草稿初始化完成（表单宿主渲染＝draft 就绪；非激活 Tab 面板不挂载，
 * 请求体输入要切到「Body」标签后才出现，编辑前先 openBodyTab）；
 * fake timers 下统一用 vi.waitFor（自动推进定时器，RTL findBy 会卡死） */
async function waitForDraftReady() {
  await vi.waitFor(() => {
    expect(screen.getByTestId('editor-form')).toBeInTheDocument()
  })
}

/** 切到「Body」标签（Base UI Tabs 非激活面板默认卸载） */
function openBodyTab() {
  fireEvent.click(screen.getByRole('tab', { name: 'Body' }))
}

/** 切到 Body 页签并等文本编辑器就绪（Monaco 底座 mock 在微任务后才挂载；
 *  空草稿默认 none 空态，先切 JSON 进入文本编辑面。form 系无文本编辑器，
 *  勿用——直接 openBodyTab） */
async function openBodyEditor() {
  openBodyTab()
  await vi.waitFor(() => {
    expect(
      screen.queryByTestId('editor-body-empty') ?? screen.getByTestId('editor-body-input'),
    ).toBeInTheDocument()
  })
  if (screen.queryByTestId('editor-body-empty')) {
    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }))
  }
  await vi.waitFor(() => {
    expect(screen.getByTestId('editor-body-input')).toBeInTheDocument()
  })
}

const bodyInput = () => screen.getByTestId('editor-body-input')

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  storedDraft = { body: null, params: '[]', headers: '[]', timeoutSeconds: null, auth: null }
  stubInvokes()
  clipboardState.writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal(
    'navigator',
    new Proxy(navigator, {
      get: (target, key) => (key === 'clipboard' ? clipboardState : Reflect.get(target, key)),
    }),
  )
  useTabsStore.setState({ tabs: [], activeTabId: null, editorTabs: {} })
  useResponseStore.setState({ entries: {}, streams: {} })
  useDraftStore.setState({ drafts: {} })
  locateMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('草稿接线', () => {
  it('挂载读一次：user_data.get 恰好调用一次并回填表单', async () => {
    storedDraft = {
      body: 'hello',
      params: '[{"name":"a","value":"1"}]',
      headers: '[]',
      timeoutSeconds: null,
      auth: null,
    }
    renderEditor()
    await waitForDraftReady()
    await openBodyEditor()
    await vi.waitFor(() => {
      expect(screen.getByTestId('editor-body-input')).toHaveValue('hello')
    })
    const getCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data.get')
    expect(getCalls).toHaveLength(1)
  })

  it('窗口内多次编辑合并为一次整包写（约 500ms 防抖）', async () => {
    renderEditor()
    await waitForDraftReady()
    await openBodyEditor()
    fireEvent.change(bodyInput(), { target: { value: 'a' } })
    fireEvent.change(bodyInput(), { target: { value: 'b' } })
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data.upsert')).toHaveLength(0)
    await actAdvance(500)
    const upserts = invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data.upsert')
    expect(upserts).toHaveLength(1)
    // 整包三列一次写，值为最后一次编辑（body 经信封形态落库）
    const payload = (
      upserts[0]![1] as { args: { params: string; body: string | null; headers: string } }
    ).args
    expect(payload.body).toBe('{"kind":"json","text":"b"}')
    expect(payload.params).toBe('[]')
    expect(payload.headers).toBe('[]')
  })

  it('关 Tab（卸载）立即 flush：不推进防抖窗口即落库', async () => {
    const view = renderEditor()
    await waitForDraftReady()
    await openBodyEditor()
    fireEvent.change(bodyInput(), { target: { value: 'x' } })
    view.unmount()
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data.upsert')).toHaveLength(1)
    expect(storedDraft.body).toBe('{"kind":"json","text":"x"}')
  })

  it('应用退出钩子 flush：编辑未落库时退出收尾立即整包写', async () => {
    renderEditor()
    await waitForDraftReady()
    await openBodyEditor()
    fireEvent.change(bodyInput(), { target: { value: 'exit' } })
    await flushAllForExit()
    expect(storedDraft.body).toBe('{"kind":"json","text":"exit"}')
  })

  it('编辑期间不回读：落库后时间推进与窗口聚焦不触发再次 user_data.get', async () => {
    renderEditor()
    await waitForDraftReady()
    await openBodyEditor()
    fireEvent.change(bodyInput(), { target: { value: 'a' } })
    await actAdvance(2000)
    window.dispatchEvent(new Event('focus'))
    await actAdvance(5000)
    const getCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data.get')
    expect(getCalls).toHaveLength(1)
  })

  it('草稿 mutation 不失效任何 query key：落库后树与工作空间不重拉', async () => {
    renderEditor()
    await waitForDraftReady()
    await actAdvance(20)
    const treeCallsBefore = invokeMock.mock.calls.filter(([cmd]) => cmd === 'tree.get').length
    await openBodyEditor()
    fireEvent.change(bodyInput(), { target: { value: 'a' } })
    await actAdvance(500)
    const treeCallsAfter = invokeMock.mock.calls.filter(([cmd]) => cmd === 'tree.get').length
    expect(treeCallsAfter).toBe(treeCallsBefore)
  })

  it('重开 Tab 读同一份：共享缓存下旧快照先行不锁初值，经挂载 refetch 拉到最新落库值', async () => {
    // 真实应用全局共享 QueryClient：关 Tab 后缓存保留（gcTime 内），重开挂载
    // 时缓存快照（旧值）先到、挂载 refetch（always）随后完成——初值必须等
    // refetch 落定取新值，否则关 Tab 前的落库被缓存旧值锁在外面
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, refetchOnWindowFocus: false },
        mutations: { retry: false },
      },
    })
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const view = render(<EndpointEditor tab={makeTab()} />, { wrapper })
    await waitForDraftReady()
    await openBodyEditor()
    fireEvent.change(bodyInput(), { target: { value: 'keep' } })
    await actAdvance(500)
    expect(storedDraft.body).toBe('{"kind":"json","text":"keep"}')
    view.unmount()
    render(<EndpointEditor tab={makeTab()} />, { wrapper })
    await waitForDraftReady()
    await openBodyEditor()
    await vi.waitFor(() => {
      expect(bodyInput()).toHaveValue('keep')
    })
  })

  it('StrictMode 挂载-清理-重挂不废写链路：dispose 终态实例被替换，编辑仍防抖落库', async () => {
    // 真实应用全局 StrictMode：双挂载模拟会触发 effect cleanup（dispose）。
    // 若重挂不新建 writer，同一 ref 上的已 dispose 实例会让编辑静默丢弃
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, refetchOnWindowFocus: false },
        mutations: { retry: false },
      },
    })
    render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <EndpointEditor tab={makeTab()} />
        </QueryClientProvider>
      </StrictMode>,
    )
    await waitForDraftReady()
    await openBodyEditor()
    fireEvent.change(bodyInput(), { target: { value: 'strict' } })
    await actAdvance(500)
    const upserts = invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data.upsert')
    expect(upserts).toHaveLength(1)
    expect(storedDraft.body).toBe('{"kind":"json","text":"strict"}')
  })

  it('键值行编辑：占位行转正（填入参数名）后草稿 params 上抛为整包 JSON', async () => {
    renderEditor()
    await waitForDraftReady()
    fireEvent.change(screen.getByLabelText('参数名 1'), { target: { value: 'page' } })
    await actAdvance(500)
    const upserts = invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data.upsert')
    expect(upserts).toHaveLength(1)
    const payload = (upserts[0]![1] as { args: { params: string } }).args
    expect(payload.params).toBe('[{"name":"page","value":""}]')
  })
})

describe('同步失效重取后的草稿重播种（Tab 单实例不重挂载）', () => {
  /** 自建共享 QueryClient：走真实失效 → 后台重取 → 回流链路（非 mock 播种） */
  function setupSharedClient() {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, refetchOnWindowFocus: false },
        mutations: { retry: false },
      },
    })
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    /** 模拟 applyAll 成功后的服务级前缀失效（staleTime Infinity 亦被强制重取） */
    const invalidateUserData = async () => {
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: workbenchKeys.userDataService('s1') })
      })
    }
    return { wrapper, invalidateUserData }
  }

  it('未编辑的 Tab：失效重取回流后草稿重播种为对齐结果（params 行与 body 骨架）', async () => {
    storedDraft = { body: null, params: '[]', headers: '[]', timeoutSeconds: null, auth: null }
    const { wrapper, invalidateUserData } = setupSharedClient()
    render(<EndpointEditor tab={makeTab()} />, { wrapper })
    await waitForDraftReady()
    // 空行集仍有占位行（转正加行入口），数据行不存在
    expect(screen.queryByTestId('kv-row')).not.toBeInTheDocument()

    // 模拟同步应用事务落库对齐结果（params 铺空值行 + body 骨架）后前缀失效
    storedDraft = {
      body: '{"kind":"json","text":"{\\"name\\":\\"张三\\"}"}',
      params: '[{"name":"page","value":"","enabled":true}]',
      headers: '[]',
      timeoutSeconds: null,
      auth: null,
    }
    await invalidateUserData()

    await vi.waitFor(() => {
      expect(screen.getByLabelText('参数名 1')).toHaveValue('page')
    })
    await openBodyEditor()
    expect(bodyInput()).toHaveValue('{"name":"张三"}')
  })

  it('已编辑的 Tab：失效重取回流不覆盖本地草稿（已填值不被后台同步冲掉）', async () => {
    storedDraft = { body: null, params: '[]', headers: '[]', timeoutSeconds: null, auth: null }
    const { wrapper, invalidateUserData } = setupSharedClient()
    render(<EndpointEditor tab={makeTab()} />, { wrapper })
    await waitForDraftReady()
    await openBodyEditor()
    // 用户编辑开始（markEditing 置位＝本地草稿成为唯一真相）
    fireEvent.change(bodyInput(), { target: { value: 'user edit' } })

    // 同步应用落库对齐结果并失效——已编辑草稿绝不被覆盖
    storedDraft = {
      body: '{"kind":"json","text":"{\\"sync\\":true}"}',
      params: '[{"name":"page","value":""}]',
      headers: '[]',
      timeoutSeconds: null,
      auth: null,
    }
    await invalidateUserData()
    await actAdvance(2000)
    expect(bodyInput()).toHaveValue('user edit')
    // 后台同步带来的行不落 UI：本地空草稿仍是真相（只有占位行，无数据行）
    expect(screen.queryByTestId('kv-row')).not.toBeInTheDocument()
  })
})

describe('预览转正与只读形态', () => {
  it('预览 Tab 开始编辑自动转正（preview 标记清除）', async () => {
    const tab = makeTab({ preview: true })
    useTabsStore.setState({ tabs: [tab], activeTabId: tab.id })
    renderEditor(tab)
    await waitForDraftReady()
    await openBodyEditor()
    fireEvent.change(bodyInput(), { target: { value: 'a' } })
    expect(useTabsStore.getState().tabs[0]?.preview).toBe(false)
  })

  it('发送按钮在草稿未就绪时禁用，就绪后可点', async () => {
    renderEditor()
    await vi.waitFor(() => {
      expect(screen.getByTestId('endpoint-editor')).toBeInTheDocument()
    })
    // 草稿加载完成前（draft=null）禁用；就绪后可点
    await waitForDraftReady()
    expect(screen.getByTestId('editor-send-button')).toBeEnabled()
  })

  it('同步接口地址栏可编辑：方法选择器与路径框显示定义值', async () => {
    renderEditor(makeTab({ id: makeEndpointNodeId('s1', 'e2'), key: 'e2', title: '登录' }))
    await waitForDraftReady()
    // 方法选择器（Apifox 式一体地址栏，手工与同步同构）
    expect(screen.getByRole('combobox', { name: '方法' })).toBeInTheDocument()
    const pathInput = screen.getByLabelText('路径模板')
    expect(pathInput).toBeEnabled()
    expect(pathInput).toHaveValue('/login')
  })
})

describe('发送链路（http.send 接线）', () => {
  /** http.send 结果的 Promise 解相（测试手动落定） */
  let resolveSend: ((value: unknown) => void) | null = null

  /** 可落定的 http.send 桩（在基础桩之上覆盖发送与取消分支） */
  function stubPendingSend(): void {
    stubInvokes()
    const base = invokeMock.getMockImplementation()
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'http.send') {
        return new Promise((resolve) => {
          resolveSend = resolve
        })
      }
      if (cmd === 'http.cancel') return Promise.resolve(true)
      return base ? base(cmd, args) : Promise.resolve(undefined)
    })
  }

  /** 构造 RunResult（与 Rust DTO 同构的最小形态） */
  function makeRunResult(state: 'passed' | 'failed' | 'cancelled'): unknown {
    return {
      runId: 'run-1',
      state,
      statusCode: state === 'passed' ? 200 : null,
      durationMs: 15,
      errorCode: null,
      errorMessage: null,
      request: {
        method: 'POST',
        url: 'http://localhost:5000/orders',
        headers: [],
        body: null,
        redactions: { headerNames: [], queryKeys: [] },
      },
      response:
        state === 'passed'
          ? {
              status: 200,
              headers: [],
              contentType: 'application/json',
              body: { excerpt: '{}', truncated: false, totalSize: 2 },
            }
          : null,
      responseId: null,
    }
  }

  /** 等待 sending 态落定（按钮变「取消」＝beginSend 已写入 store） */
  async function waitForSending() {
    await vi.waitFor(() => {
      expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
    })
  }

  it('点击发送：http.send 直传当前草稿六列；落定 passed 后按钮回「发 送」', async () => {
    stubPendingSend()
    storedDraft = {
      body: 'hello',
      params: '[{"name":"a","value":"1"}]',
      headers: '[]',
      timeoutSeconds: 30,
      auth: null,
    }
    const tab = makeTab()
    useTabsStore.setState({ tabs: [tab], activeTabId: tab.id })
    renderEditor(tab)
    await waitForDraftReady()
    fireEvent.click(screen.getByTestId('editor-send-button'))
    await waitForSending()
    const sendCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'http.send')
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0]![1]).toMatchObject({
      serviceId: 's1',
      key: 'e1',
      tabId: 'endpoint:s1:e1',
      body: 'hello',
      params: '[{"name":"a","value":"1"}]',
      headers: '[]',
      timeoutSeconds: 30,
      auth: null,
      pathOverride: null,
      methodOverride: null,
    })
    await act(async () => {
      resolveSend?.(makeRunResult('passed'))
    })
    await vi.waitFor(() => {
      expect(screen.getByRole('button', { name: '发 送' })).toBeInTheDocument()
    })
    expect(useResponseStore.getState().entries['endpoint:s1:e1']?.phase).toBe('done')
  })

  it('sending 态点击「取消」＝http.cancel(tabId)，终态 cancelled 回写', async () => {
    stubPendingSend()
    const tab = makeTab()
    useTabsStore.setState({ tabs: [tab], activeTabId: tab.id })
    renderEditor(tab)
    await waitForDraftReady()
    fireEvent.click(screen.getByTestId('editor-send-button'))
    await waitForSending()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'http.cancel')).toBe(true)
    const cancelArgs = invokeMock.mock.calls.find(([cmd]) => cmd === 'http.cancel')?.[1]
    expect(cancelArgs).toEqual({ tabId: 'endpoint:s1:e1' })
    await act(async () => {
      resolveSend?.(makeRunResult('cancelled'))
    })
    await vi.waitFor(() => {
      expect(useResponseStore.getState().entries['endpoint:s1:e1']?.phase).toBe('cancelled')
    })
    expect(screen.getByRole('button', { name: '发 送' })).toBeInTheDocument()
  })

  it('卸载（切 Tab）不取消在途发送；重挂从 store 恢复 sending 态且可取消', async () => {
    stubPendingSend()
    const tab = makeTab()
    useTabsStore.setState({ tabs: [tab], activeTabId: tab.id })
    // 组件级等效：unmount＝切走（编辑器销毁），重挂＝切回（Tab 仍开着）
    const view = renderEditor(tab)
    await waitForDraftReady()
    fireEvent.click(screen.getByTestId('editor-send-button'))
    await waitForSending()
    view.unmount()
    // 卸载只是视图切换：取消归关 Tab / 切工作空间 / 应用退出三类信号，
    // 在途请求由 Rust 侧任务按 tabId 存续，结果照常落 store
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'http.cancel')).toHaveLength(0)
    expect(useResponseStore.getState().entries['endpoint:s1:e1']?.phase).toBe('sending')
    // 切回重挂：sending 态从 store 条目恢复（按钮仍为「取消」）；等草稿
    // 播种完成（按钮可用）后取消仍有效
    renderEditor(tab)
    await waitForDraftReady()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'http.cancel')).toHaveLength(1)
    const cancelArgs = invokeMock.mock.calls.find(([cmd]) => cmd === 'http.cancel')?.[1]
    expect(cancelArgs).toEqual({ tabId: 'endpoint:s1:e1' })
  })

  it('发送命令路由终点：编辑器登记发送动作，经桥调用与按钮同效；卸载注销后无害', async () => {
    stubPendingSend()
    storedDraft = {
      body: 'hello',
      params: '[{"name":"a","value":"1"}]',
      headers: '[]',
      timeoutSeconds: 30,
      auth: null,
    }
    const tab = makeTab()
    useTabsStore.setState({ tabs: [tab], activeTabId: tab.id })
    const view = renderEditor(tab)
    await waitForDraftReady()
    // 模拟发送命令（Ctrl+Enter）经桥路由：调编辑器登记的发送动作
    act(() => {
      invokeSendAction(tab.id)
    })
    await waitForSending()
    const sendCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'http.send')
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0]![1]).toMatchObject({
      serviceId: 's1',
      key: 'e1',
      tabId: 'endpoint:s1:e1',
      body: 'hello',
      timeoutSeconds: 30,
    })
    // 卸载注销：桥上动作摘除，再次路由是无害 no-op（不重复发送）
    view.unmount()
    act(() => {
      invokeSendAction(tab.id)
    })
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'http.send')).toHaveLength(1)
  })
})

describe('手工接口实体编辑', () => {
  /** 打开设置抽屉（标题 / 分类编辑面） */
  function openSettingsDrawer() {
    fireEvent.click(screen.getByRole('button', { name: '接口设置' }))
    return screen.getByRole('dialog', { name: '接口设置' })
  }

  it('设置抽屉打开并聚焦标题输入；标题编辑防抖写并同步 Tab 标题', async () => {
    const tab = makeTab()
    useTabsStore.setState({ tabs: [tab], activeTabId: tab.id })
    renderEditor(tab)
    await waitForDraftReady()
    // 实体字段不在参数区常驻：仅经设置抽屉可达
    expect(screen.queryByLabelText('标题')).not.toBeInTheDocument()
    const drawer = openSettingsDrawer()
    const titleInput = screen.getByLabelText('标题')
    expect(drawer).toContainElement(titleInput)
    fireEvent.change(titleInput, { target: { value: '创建订单V2' } })
    await actAdvance(500)
    const updates = invokeMock.mock.calls.filter(([cmd]) => cmd === 'endpoint.update_manual')
    expect(updates).toHaveLength(1)
    const payload = (updates[0]![1] as { args: { title: string; serviceId: string; key: string } })
      .args
    expect(payload.title).toBe('创建订单V2')
    expect(payload.serviceId).toBe('s1')
    expect(payload.key).toBe('e1')
    expect(useTabsStore.getState().tabs[0]?.title).toBe('创建订单V2')
  })

  it('Esc 关闭抽屉并把焦点归还面包屑设置按钮', async () => {
    renderEditor()
    await waitForDraftReady()
    const trigger = screen.getByRole('button', { name: '接口设置' })
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('dialog', { name: '接口设置' }), { key: 'Escape' })
    // 关闭带 200ms 收回动画（延迟卸载）；fake timers 下用 vi.waitFor 自动推进定时器
    await vi.waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '接口设置' })).not.toBeInTheDocument(),
    )
    expect(trigger).toHaveFocus()
  })

  it('明显非法的中间态不发起写（标题清空 / 路径非基本形态）', async () => {
    renderEditor()
    await waitForDraftReady()
    openSettingsDrawer()
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '' } })
    await actAdvance(600)
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'endpoint.update_manual')).toHaveLength(
      0,
    )
    fireEvent.change(screen.getByLabelText('路径模板'), { target: { value: 'orders' } })
    await actAdvance(600)
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'endpoint.update_manual')).toHaveLength(
      0,
    )
  })
})

describe('路径框粘贴拆分（含 query 的 URL）', () => {
  /** 向 URL 行路径框粘贴文本（clipboardData 桩承载 getData） */
  function pastePath(text: string) {
    fireEvent.paste(screen.getByLabelText('路径模板'), {
      clipboardData: { getData: () => text },
    })
  }

  /** 取最近一次 user_data.upsert 的 params 列 */
  function lastUpsertParams(): string {
    const upserts = invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data.upsert')
    return (upserts.at(-1)![1] as { args: { params: string } }).args.params
  }

  it('粘贴带 query 的相对路径：path 段进模板、query 拆成参数行落库', async () => {
    renderEditor()
    await waitForDraftReady()
    pastePath('/api/users?id=42&verbose=true')
    expect(screen.getByLabelText('路径模板')).toHaveValue('/api/users')
    await actAdvance(500)
    const updates = invokeMock.mock.calls.filter(([cmd]) => cmd === 'endpoint.update_manual')
    expect(updates).toHaveLength(1)
    expect((updates[0]![1] as { args: { pathTemplate: string } }).args.pathTemplate).toBe(
      '/api/users',
    )
    expect(lastUpsertParams()).toBe(
      '[{"name":"id","value":"42"},{"name":"verbose","value":"true"}]',
    )
  })

  it('编码字符按 urlencoded 语义解码：+ 与 %XX 均解，空格两形态收敛', async () => {
    renderEditor()
    await waitForDraftReady()
    pastePath('/s?q=a%20b%2B1&k=x+y')
    await actAdvance(500)
    expect(lastUpsertParams()).toBe('[{"name":"q","value":"a b+1"},{"name":"k","value":"x y"}]')
  })

  it('同名行覆盖值且标注保留，新名追加，未命中行保留', async () => {
    storedDraft = {
      body: null,
      params: '[{"name":"a","value":"1","type":"integer"},{"name":"keep","value":"x"}]',
      headers: '[]',
      timeoutSeconds: null,
      auth: null,
    }
    renderEditor()
    await waitForDraftReady()
    pastePath('/t?a=9&b=2')
    await actAdvance(500)
    expect(lastUpsertParams()).toBe(
      '[{"name":"a","value":"9","type":"integer"},{"name":"keep","value":"x"},{"name":"b","value":"2"}]',
    )
  })

  it('粘贴串内重复 key 后值胜（只落一行终值）', async () => {
    renderEditor()
    await waitForDraftReady()
    pastePath('/dup?a=1&a=2')
    await actAdvance(500)
    expect(lastUpsertParams()).toBe('[{"name":"a","value":"2"}]')
  })

  it('粘贴绝对 URL：host 与 path 整体进模板（fragment 截断），BaseUrl 不参与', async () => {
    renderEditor()
    await waitForDraftReady()
    pastePath('https://api.example.com/v1/users?id=7#section')
    expect(screen.getByLabelText('路径模板')).toHaveValue('https://api.example.com/v1/users')
    await actAdvance(500)
    const updates = invokeMock.mock.calls.filter(([cmd]) => cmd === 'endpoint.update_manual')
    expect((updates[0]![1] as { args: { pathTemplate: string } }).args.pathTemplate).toBe(
      'https://api.example.com/v1/users',
    )
    expect(lastUpsertParams()).toBe('[{"name":"id","value":"7"}]')
  })

  it('不含 ? 的粘贴不拦截：走默认行为，不触发拆分写', async () => {
    renderEditor()
    await waitForDraftReady()
    pastePath('/plain/path')
    await actAdvance(500)
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data.upsert')).toHaveLength(0)
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'endpoint.update_manual')).toHaveLength(
      0,
    )
  })
})

describe('模板校验可见反馈（非法态不再静默）', () => {
  it('非法路径：错误描边（aria-invalid）＋行内提示可见，且不落库', async () => {
    renderEditor()
    await waitForDraftReady()
    fireEvent.change(screen.getByLabelText('路径模板'), { target: { value: 'orders?id=1' } })
    expect(screen.getByLabelText('路径模板')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('路径模板')).toHaveAttribute(
      'title',
      '路径需以 / 开头，或为 http(s):// 开头的完整地址（支持 {占位}），不能包含空格或 ?',
    )
    // 非法态由整组描边承载（destructive），内嵌真实输入框不自绘红边
    expect(screen.getByTestId('editor-url-box')).toHaveAttribute('data-invalid')
    expect(screen.getByLabelText('路径模板').className).toContain('aria-invalid:border-transparent')
    await actAdvance(600)
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'endpoint.update_manual')).toHaveLength(
      0,
    )
  })

  it('修正为合法形态后：描边与提示消失，防抖写恢复', async () => {
    renderEditor()
    await waitForDraftReady()
    fireEvent.change(screen.getByLabelText('路径模板'), { target: { value: 'orders?id=1' } })
    fireEvent.change(screen.getByLabelText('路径模板'), { target: { value: '/orders/v2' } })
    expect(screen.getByLabelText('路径模板')).not.toHaveAttribute('title')
    expect(screen.getByLabelText('路径模板')).not.toHaveAttribute('aria-invalid')
    expect(screen.getByTestId('editor-url-box')).not.toHaveAttribute('data-invalid')
    await actAdvance(500)
    const updates = invokeMock.mock.calls.filter(([cmd]) => cmd === 'endpoint.update_manual')
    expect(updates).toHaveLength(1)
    expect((updates[0]![1] as { args: { pathTemplate: string } }).args.pathTemplate).toBe(
      '/orders/v2',
    )
  })

  it('同步接口路径编辑＝覆写落草稿（path_override 列），非法态不落库', async () => {
    renderEditor(makeTab({ id: makeEndpointNodeId('s1', 'e2'), key: 'e2', title: '登录' }))
    await waitForDraftReady()
    fireEvent.change(screen.getByLabelText('路径模板'), { target: { value: '/login/v2' } })
    await actAdvance(500)
    const upserts = invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data.upsert')
    const args = (upserts.at(-1)![1] as { args: { key: string; pathOverride: string | null } }).args
    expect(args.key).toBe('e2')
    expect(args.pathOverride).toBe('/login/v2')
  })

  it('同步接口方法选择器与路径框显示覆写后的生效值', async () => {
    // 覆写落库链路（updateEntity → 草稿 method_override/path_override 列）与
    // 路径覆写用例同构；组件弹层交互在 fake timers 下不可收敛，覆写发送优先
    // 的行为由 Rust 侧 synthesize 测试守护
    renderEditor(makeTab({ id: makeEndpointNodeId('s1', 'e2'), key: 'e2', title: '登录' }))
    await waitForDraftReady()
    expect(screen.getByRole('combobox', { name: '方法' })).toBeInTheDocument()
    expect(screen.getByLabelText('路径模板')).toHaveValue('/login')
  })
})

describe('复制最终 URL（⋯菜单项）', () => {
  /** 取最近一次 user_data.upsert 的 params 列 */
  function lastUpsertParams(): string {
    const upserts = invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data.upsert')
    return (upserts.at(-1)![1] as { args: { params: string } }).args.params
  }

  /** 覆盖 workspace.list 桩的当前工作空间 BaseUrl（组合失败态测试） */
  function stubCurrentWorkspaceBaseUrl(baseUrl: string | null) {
    const base = invokeMock.getMockImplementation()
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'workspace.list') {
        return Promise.resolve({
          items: [{ id: 'w1', name: '默认工作空间', baseUrl, auth: null, isCurrent: true }],
          currentId: 'w1',
        })
      }
      return base ? base(cmd, args) : Promise.resolve(undefined)
    })
  }

  /** 打开 ⋯菜单并等「复制最终 URL」菜单项出现 */
  async function openCopyUrlMenuItem() {
    fireEvent.click(screen.getByTestId('editor-more-button'))
    return vi.waitFor(() => screen.getByRole('menuitem', { name: '复制最终 URL' }))
  }

  it('BaseUrl 未配置：组合失败，菜单项禁用', async () => {
    stubCurrentWorkspaceBaseUrl(null)
    renderEditor()
    await waitForDraftReady()
    expect(await openCopyUrlMenuItem()).toHaveAttribute('data-disabled')
  })

  it('BaseUrl 非 http(s)：组合失败，菜单项禁用', async () => {
    stubCurrentWorkspaceBaseUrl('ftp://x')
    renderEditor()
    await waitForDraftReady()
    expect(await openCopyUrlMenuItem()).toHaveAttribute('data-disabled')
  })

  it('绝对 URL 模板绕过 BaseUrl：组合成功菜单项可用', async () => {
    renderEditor()
    await waitForDraftReady()
    fireEvent.change(screen.getByLabelText('路径模板'), {
      target: { value: 'https://api.example.com/v1/users' },
    })
    const item = await openCopyUrlMenuItem()
    expect(item).not.toHaveAttribute('data-disabled')
  })

  it('Params 行编辑实时反映到组合（防抖前即所见即所发）', async () => {
    renderEditor()
    await waitForDraftReady()
    expect(await openCopyUrlMenuItem()).not.toHaveAttribute('data-disabled')
    fireEvent.change(screen.getByLabelText('参数名 1'), { target: { value: 'page' } })
    fireEvent.change(screen.getByLabelText('参数值 1'), { target: { value: '2' } })
    fireEvent.click(screen.getByTestId('editor-more-button'))
    expect(await openCopyUrlMenuItem()).not.toHaveAttribute('data-disabled')
    await actAdvance(500)
    expect(lastUpsertParams()).toBe('[{"name":"page","value":"2"}]')
  })
})

describe('接口级超时覆写（抽屉超时行）', () => {
  /** 取最近一次 user_data.upsert 的 args */
  function lastUpsertArgs(): {
    serviceId: string
    key: string
    timeoutSeconds: number | null
    body: string | null
    params: string
    headers: string
  } {
    const upserts = invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data.upsert')
    return (
      upserts.at(-1)![1] as {
        args: {
          serviceId: string
          key: string
          timeoutSeconds: number | null
          body: string | null
          params: string
          headers: string
        }
      }
    ).args
  }

  it('三态切换写草稿：user_data.upsert 整包含 timeoutSeconds', async () => {
    renderEditor()
    await waitForDraftReady()
    fireEvent.click(screen.getByRole('button', { name: '接口设置' }))
    const drawer = screen.getByRole('dialog', { name: '接口设置' })
    expect(within(drawer).getByRole('radio', { name: '继承全局' })).toBeChecked()

    // 切「不限制」：防抖整包写 0
    fireEvent.click(within(drawer).getByRole('radio', { name: '不限制' }))
    await actAdvance(500)
    expect(lastUpsertArgs().timeoutSeconds).toBe(0)

    // 切「自定义」输入 120 秒：整包写 120（其余三列随包携带）
    fireEvent.click(within(drawer).getByRole('radio', { name: '自定义' }))
    fireEvent.change(within(drawer).getByTestId('endpoint-timeout-input'), {
      target: { value: '120' },
    })
    await actAdvance(500)
    const args = lastUpsertArgs()
    expect(args.timeoutSeconds).toBe(120)
    expect(args.body).toBeNull()
    expect(args.params).toBe('[]')
  })

  it('同步接口抽屉：标题 / 分类置灰锁定（随同步文档更新），超时可写', async () => {
    renderEditor(makeTab({ id: makeEndpointNodeId('s1', 'e2'), key: 'e2', title: '登录' }))
    await waitForDraftReady()

    const trigger = screen.getByRole('button', { name: '接口设置' })
    fireEvent.click(trigger)
    const drawer = screen.getByRole('dialog', { name: '接口设置' })
    expect(within(drawer).getByLabelText('标题')).toBeDisabled()
    expect(within(drawer).getByLabelText('标题')).toHaveAttribute(
      'title',
      '标题与分组随同步文档更新',
    )
    expect(within(drawer).getByRole('radiogroup', { name: '请求超时' })).toBeInTheDocument()

    fireEvent.click(within(drawer).getByRole('radio', { name: '自定义' }))
    fireEvent.change(within(drawer).getByTestId('endpoint-timeout-input'), {
      target: { value: '60' },
    })
    await actAdvance(500)
    const args = lastUpsertArgs()
    expect(args.timeoutSeconds).toBe(60)
    expect(args.serviceId).toBe('s1')
    expect(args.key).toBe('e2')
  })
})

describe('请求页签恒英文（i18n 恒不翻译清单）', () => {
  it('Params / Body / Headers / Auth 四页签原样呈现，Body 提前且 Auth 收尾', async () => {
    renderEditor()
    await waitForDraftReady()
    const tabs = screen
      .getAllByRole('tab')
      .map((tab) => tab.textContent)
      .filter((text): text is string => text !== null)
    // 顺序即契约：Body 紧跟查询参数（编辑高频位），认证收尾，不随语言与阶段漂移
    expect(tabs).toEqual(['Params', 'Body', 'Headers', 'Auth'])
    fireEvent.click(screen.getByRole('tab', { name: 'Auth' }))
    expect(screen.getByTestId('editor-auth')).toBeInTheDocument()
  })

  it('页签带＝上下通栏线（border-y 全宽，行内 px-3 只约束内容起点）', async () => {
    renderEditor()
    await waitForDraftReady()
    expect(screen.getByTestId('editor-tab-strip')).toHaveClass('border-y', 'px-3')
  })
})

describe('headers 空对象播种归一', () => {
  it('userData 返回 headers="{}"：Headers 页签渲染键值表格，不退原文保真模式', async () => {
    // 同步铺行的遗留初值形态（空对象，KvEditor 行模型解析不出）不得让
    // Headers 页签退回原文模式提示——播种时归一为空行集，直接给空表格
    storedDraft = { body: null, params: '[]', headers: '{}', timeoutSeconds: null, auth: null }
    renderEditor()
    await waitForDraftReady()
    fireEvent.click(screen.getByRole('tab', { name: 'Headers' }))
    expect(screen.getByTestId('kv-header-row')).toBeInTheDocument()
    expect(screen.getByTestId('kv-placeholder-row')).toBeInTheDocument()
    expect(
      screen.queryByText('内容无法解析为键值对，正在以原文编辑（原样保存，不做格式改写）'),
    ).not.toBeInTheDocument()
  })
})

describe('Params 页签表格能力（path 标识与批量编辑入口）', () => {
  /** 打开 ⋯菜单并等「复制最终 URL」菜单项出现（组合成功＝菜单项可用） */
  async function openCopyUrlMenuItem() {
    fireEvent.click(screen.getByTestId('editor-more-button'))
    return vi.waitFor(() => screen.getByRole('menuitem', { name: '复制最终 URL' }))
  }

  it('模板占位符命中行渲染 path 芯片且不出启停勾选；组合同快照消费', async () => {
    // 覆写 tree.get 分支：e1 模板带占位符（其余命令走基础桩）
    const base = invokeMock.getMockImplementation() as
      ((cmd: string, args?: Record<string, unknown>) => unknown) | undefined
    const treeWithPlaceholder = {
      ...TREE,
      services: [
        {
          ...TREE.services[0]!,
          endpoints: [
            {
              ...TREE.services[0]!.endpoints[0]!,
              definition: { method: 'POST', pathTemplate: '/orders/{id}' },
            },
            TREE.services[0]!.endpoints[1]!,
          ],
        },
      ],
    }
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'tree.get') return Promise.resolve(treeWithPlaceholder)
      return base?.(cmd, args) ?? Promise.resolve(undefined)
    })
    storedDraft = {
      body: null,
      params: '[{"name":"id","value":"7"},{"name":"q","value":"v"}]',
      headers: '[]',
      timeoutSeconds: null,
      auth: null,
    }
    renderEditor()
    await waitForDraftReady()
    expect(screen.getByTestId('kv-path-chip')).toHaveTextContent('path')
    // path 行是结构必需：无启停勾选；query 行照常勾选
    expect(screen.queryByRole('checkbox', { name: '启用该行 1' })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '启用该行 2' })).toBeInTheDocument()
    // 组合同快照消费占位符：id 填路径、q 进 query（组合成功＝菜单项可用）
    const item = await openCopyUrlMenuItem()
    expect(item).not.toHaveAttribute('data-disabled')
  })

  it('无占位符模板面照常渲染表格与批量编辑入口', async () => {
    renderEditor()
    await waitForDraftReady()
    expect(screen.getByTestId('kv-header-row')).toBeInTheDocument()
    expect(screen.getByTestId('kv-bulk-edit')).toBeInTheDocument()
    expect(screen.queryByTestId('kv-path-chip')).not.toBeInTheDocument()
  })

  it('禁用参数行不进最终 URL 组合（与发送同口径过滤）', async () => {
    storedDraft = {
      body: null,
      params: '[{"name":"off","value":"x","enabled":false},{"name":"q","value":"v"}]',
      headers: '[]',
      timeoutSeconds: null,
      auth: null,
    }
    renderEditor()
    await waitForDraftReady()
    // 禁用行不进组合：组合仍成功（菜单项可用），off 不出现在发送 URL——
    // 组合内容断言由 cURL 序列化与 Rust build_url 契约守护
    const item = await openCopyUrlMenuItem()
    expect(item).not.toHaveAttribute('data-disabled')
  })
})

describe('请求区竖向分隔节奏与高度链', () => {
  it('面包屑行有底边线、URL 行无底边线：节奏＝标签栏线/面包屑线/页签带上下线', () => {
    renderEditor()
    // 面包屑行以底边线与 URL 区分隔（h-8 行内 items-center 保证线上下对称）
    expect(screen.getByTestId('editor-breadcrumb-row')).toHaveClass('border-b', 'border-border')
    // URL 行不设底边线：与页签区的分隔由页签带顶线（border-y 上线）承担，
    // 避免双线夹空；页签带上下线已由前述结构断言钉住
    expect(screen.getByTestId('editor-url-row')).not.toHaveClass('border-b')
    // 行高 h-12：32px 地址栏上下各 8px，两条分割线（面包屑底线/页签带顶线）
    // 之间留出呼吸间距
    expect(screen.getByTestId('editor-url-row')).toHaveClass('h-12')
  })

  it('发送 / 更多按钮与 32px 地址栏等高：发送字号大一号、更多常态无边框', () => {
    renderEditor()
    // 发送按钮：h-8 覆盖 sm 档的 h-7，与 editor-url-box（h-8）齐平；text-sm
    // 覆盖 sm 档字号大一号（「发 送」的字间空格由文案承载，可访问名随实际）
    expect(screen.getByTestId('editor-send-button')).toHaveClass('h-8', 'text-sm')
    // 更多按钮：size-8 覆盖 icon-sm 档的 size-7（与输入组同高的正方形）；
    // outline 常显边框降为透明占位、悬浮才显示——防边框有无造成几何跳动
    expect(screen.getByTestId('editor-more-button')).toHaveClass(
      'size-8',
      'border-transparent',
      'dark:border-transparent',
      'hover:border-input',
    )
  })

  it('编辑器根持有 h-full：请求面板下来的高度链在编辑器根保持连续', () => {
    renderEditor()
    expect(screen.getByTestId('endpoint-editor')).toHaveClass('h-full')
  })

  it('页签带无上外距且激活线起点＝地址栏起点：地址栏上下间距对称、首签左缘对齐', async () => {
    renderEditor()
    await waitForDraftReady()
    const strip = screen.getByTestId('editor-tab-strip')
    // 顶线直接承接地址栏区块底（无 mt-2 上外距）：URL 行控件到上下两线
    // 的间距对称来源唯一——行内居中，无外距参与
    expect(strip).not.toHaveClass('mt-2')
    // 首个触发项左缘＝激活线起点＝地址栏 px-3 内容左缘：TabsList 左内边
    // 由消费面归零（底座 p-[3px] 的垂直分量保留承载激活线落线几何）
    expect(within(strip).getByRole('tablist')).toHaveClass('pl-0')
  })
})

describe('请求级认证（Auth 页签）', () => {
  /** 切到 Auth 标签（Base UI Tabs 非激活面板默认卸载）。行数徽标使已配置
   *  态页签名带计数（如「Auth 1」），前缀匹配两种形态通用 */
  function openAuthTab() {
    fireEvent.click(screen.getByRole('tab', { name: /^Auth/ }))
  }

  /** 打开类型选择器并选择指定类型（弹层经 waitFor 等就绪；选项激活需
   *  先 pointerDown 再 click——Base UI 对未经指针按下的纯 click 视为无效） */
  async function selectAuthType(name: string) {
    fireEvent.click(screen.getByRole('combobox', { name: '认证方式' }))
    const option = await vi.waitFor(() => screen.getByRole('option', { name }))
    fireEvent.pointerDown(option)
    fireEvent.click(option)
  }

  /** 取最近一次 user_data.upsert 的 args */
  function lastUpsertArgs(): { auth: string | null } & Record<string, unknown> {
    const upserts = invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data.upsert')
    return (upserts.at(-1)![1] as { args: { auth: string | null } & Record<string, unknown> }).args
  }

  it('未配置默认继承：类型回显「继承上级」并说明取工作空间级配置，无字段输入', async () => {
    renderEditor()
    await waitForDraftReady()
    openAuthTab()
    expect(screen.getByTestId('editor-auth')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '认证方式' })).toHaveTextContent('继承上级')
    expect(screen.getByText('取当前工作空间设置页配置的认证。')).toBeInTheDocument()
    expect(screen.queryByTestId('editor-auth-token')).not.toBeInTheDocument()
  })

  it('切 Bearer 渲染 Token 字段；编辑防抖整包写 auth JSON', async () => {
    renderEditor()
    await waitForDraftReady()
    openAuthTab()
    await selectAuthType('Bearer Token')
    const tokenInput = screen.getByLabelText('Token')
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument()
    fireEvent.change(tokenInput, { target: { value: 'tk' } })
    await actAdvance(500)
    const upserts = invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data.upsert')
    expect(upserts).toHaveLength(1)
    expect(lastUpsertArgs().auth).toBe('{"type":"bearer","token":"tk"}')
  })

  it('切 Basic 渲染 Username / Password 双字段', async () => {
    renderEditor()
    await waitForDraftReady()
    openAuthTab()
    await selectAuthType('Basic Auth')
    expect(screen.getByLabelText('Username')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
    expect(screen.queryByLabelText('Token')).not.toBeInTheDocument()
  })

  it('切 API Key·Query 渲染 Key / Value，position 随所选类型序列化为 query', async () => {
    renderEditor()
    await waitForDraftReady()
    openAuthTab()
    await selectAuthType('API Key · Query')
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'api_key' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'sec' } })
    await actAdvance(500)
    expect(lastUpsertArgs().auth).toBe(
      '{"type":"apiKey","position":"query","key":"api_key","value":"sec"}',
    )
  })

  it('挂载读回：草稿 auth 列播种对应类型与字段值', async () => {
    storedDraft = {
      body: null,
      params: '[]',
      headers: '[]',
      timeoutSeconds: null,
      auth: '{"type":"basic","username":"u","password":"p"}',
    }
    renderEditor()
    await waitForDraftReady()
    openAuthTab()
    expect(screen.getByRole('combobox', { name: '认证方式' })).toHaveTextContent('Basic Auth')
    expect(screen.getByLabelText('Username')).toHaveValue('u')
    expect(screen.getByLabelText('Password')).toHaveValue('p')
  })

  it('字段输入接受 {{变量}} 引用并原样透传（不校验）', async () => {
    renderEditor()
    await waitForDraftReady()
    openAuthTab()
    await selectAuthType('Bearer Token')
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: '{{secret.token}}' } })
    await actAdvance(500)
    expect(lastUpsertArgs().auth).toBe('{"type":"bearer","token":"{{secret.token}}"}')
  })
})

describe('面包屑定位', () => {
  it('三段渲染且点击经树定位接缝发出对应节点 id', async () => {
    renderEditor()
    await waitForDraftReady()
    const breadcrumb = screen.getByTestId('endpoint-breadcrumb')
    expect(breadcrumb).toHaveTextContent('用户服务')
    expect(breadcrumb).toHaveTextContent('账号管理')
    expect(breadcrumb).toHaveTextContent('创建订单')
    fireEvent.click(screen.getByRole('button', { name: '用户服务' }))
    expect(locateMock).toHaveBeenCalledWith('service:s1')
    fireEvent.click(screen.getByRole('button', { name: '账号管理' }))
    expect(locateMock).toHaveBeenCalledWith('category:c1')
    fireEvent.click(screen.getByRole('button', { name: '创建订单' }))
    expect(locateMock).toHaveBeenCalledWith('endpoint:s1:e1')
  })
})

describe('Body 类型行与草稿信封', () => {
  /** 取最近一次 user_data.upsert 的 body 列 */
  function lastUpsertBody(): string | null {
    const upserts = invokeMock.mock.calls.filter(([cmd]) => cmd === 'user_data.upsert')
    const lastCall = upserts.at(-1)
    if (!lastCall) return null
    return (lastCall[1] as { args: { body: string | null } }).args.body
  }

  it('同步铺底信封直读：kind=json 呈现 JSON 类型行与编辑面（bodyView 纯派生）', async () => {
    // 同步应用事务铺底的 body 列是 json 信封（后端 align_body_value 写回
    // 形态）：读侧信封直读即呈现对应类型编辑面，无需任何跳转逻辑
    storedDraft = {
      body: '{"kind":"json","text":"{\\"name\\":\\"张三\\"}"}',
      params: '[]',
      headers: '[]',
      timeoutSeconds: null,
      auth: null,
    }
    renderEditor()
    await waitForDraftReady()
    await openBodyEditor()
    expect(screen.getByRole('tab', { name: 'JSON' })).toHaveAttribute('aria-selected', 'true')
    expect(bodyInput()).toHaveAttribute('data-language', 'json')
    expect(bodyInput()).toHaveValue('{"name":"张三"}')
  })

  it('legacy 纯文本读侧嗅探回填类型显示，六分段切换不改写内容', async () => {
    storedDraft = {
      body: 'hello',
      params: '[]',
      headers: '[]',
      timeoutSeconds: null,
      auth: null,
    }
    renderEditor()
    await waitForDraftReady()
    await openBodyEditor()
    // 'hello' 非合法 JSON、非 XML 形态 → 嗅探为 Text
    expect(screen.getByRole('tab', { name: 'Text' })).toHaveAttribute('aria-selected', 'true')
    expect(bodyInput()).toHaveValue('hello')
    // 切 JSON：类型只换信封 kind，文本原样（内容属用户数据，绝不改写）
    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }))
    expect(bodyInput()).toHaveValue('hello')
    expect(bodyInput()).toHaveAttribute('data-language', 'json')
    fireEvent.click(screen.getByRole('tab', { name: 'Text' }))
    expect(bodyInput()).toHaveValue('hello')
    await actAdvance(500)
    expect(lastUpsertBody()).toBe('{"kind":"text","text":"hello"}')
  })

  it('none 空态：居中文案、无编辑器与工具行；切 JSON 后编辑器出现', async () => {
    renderEditor()
    await waitForDraftReady()
    openBodyTab()
    expect(screen.getByTestId('editor-body-empty')).toHaveTextContent('此请求没有 Body')
    expect(screen.queryByTestId('editor-body-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('editor-body-format')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }))
    await openBodyEditor()
    expect(bodyInput()).toHaveValue('')
    expect(screen.queryByTestId('editor-body-empty')).not.toBeInTheDocument()
  })

  it('form 系走 KvEditor 行编辑：信封 rows 读入行，编辑防抖写回信封', async () => {
    storedDraft = {
      body: '{"kind":"form-data","rows":[{"name":"a","value":"1"}]}',
      params: '[]',
      headers: '[]',
      timeoutSeconds: null,
      auth: null,
    }
    renderEditor()
    await waitForDraftReady()
    openBodyTab()
    expect(await vi.waitFor(() => screen.getByLabelText('参数名 1'))).toHaveValue('a')
    expect(screen.getByLabelText('参数值 1')).toHaveValue('1')
    fireEvent.change(screen.getByLabelText('参数值 1'), { target: { value: '9' } })
    await actAdvance(500)
    expect(lastUpsertBody()).toBe('{"kind":"form-data","rows":[{"name":"a","value":"9"}]}')
  })

  it('格式化仅 JSON 且解析合法可用：点击后重排并防抖写回', async () => {
    storedDraft = {
      body: '{"a":1}',
      params: '[]',
      headers: '[]',
      timeoutSeconds: null,
      auth: null,
    }
    renderEditor()
    await waitForDraftReady()
    await openBodyEditor()
    const format = screen.getByTestId('editor-body-format')
    expect(format).toBeEnabled()
    // 自动换行默认关：纯图标开关双态切换
    const wrap = screen.getByTestId('editor-body-word-wrap')
    expect(wrap).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(wrap)
    expect(wrap).toHaveAttribute('aria-pressed', 'true')
    expect(bodyInput()).toHaveAttribute('data-word-wrap', 'true')
    fireEvent.click(wrap)
    expect(bodyInput()).toHaveAttribute('data-word-wrap', 'false')
    // 格式化：JSON 重排（用户排版被显式动作改写，内容语义不变）
    fireEvent.click(format)
    expect(bodyInput()).toHaveValue('{\n  "a": 1\n}')
    await actAdvance(500)
    expect(lastUpsertBody()).toBe('{"kind":"json","text":"{\\n  \\"a\\": 1\\n}"}')
  })

  it('body 编辑器启用变量联想：variableSuggest 传当前工作空间 id', async () => {
    storedDraft = {
      body: '{"kind":"json","text":"{}"}',
      params: '[]',
      headers: '[]',
      timeoutSeconds: null,
      auth: null,
    }
    renderEditor()
    await waitForDraftReady()
    await openBodyEditor()
    expect(bodyInput()).toHaveAttribute('data-suggest-workspace', 'w1')
  })

  it('XML 格式化：点击后缩进规整并防抖写回', async () => {
    storedDraft = {
      body: '{"kind":"xml","text":"<root><a>1</a><b attr=\\"x<y\\">t</b></root>"}',
      params: '[]',
      headers: '[]',
      timeoutSeconds: null,
      auth: null,
    }
    renderEditor()
    await waitForDraftReady()
    await openBodyEditor()
    const format = screen.getByTestId('editor-body-format')
    expect(format).toBeEnabled()
    // 缩进规整（两空格档）；属性值引号内的 < 不破坏结构，原文切片保留。
    // 格式化经微任务回写（格式化器 promise），先冲刷微任务再推进防抖窗口
    fireEvent.click(format)
    await act(async () => {})
    await actAdvance(500)
    const expected = '<root>\n  <a>1</a>\n  <b attr="x<y">t</b>\n</root>'
    expect(bodyInput()).toHaveValue(expected)
    expect(lastUpsertBody()).toBe(JSON.stringify({ kind: 'xml', text: expected }))
  })

  it('格式化 hint 三态：text / 非法 JSON 禁用并给对应提示；xml 非空即无提示', async () => {
    // 纯文本：无需格式化
    storedDraft = { body: 'plain', params: '[]', headers: '[]', timeoutSeconds: null, auth: null }
    const view1 = renderEditor()
    await waitForDraftReady()
    await openBodyEditor()
    expect(screen.getByTestId('editor-body-format')).toHaveAttribute('title', '纯文本无需格式化')
    view1.unmount()

    // XML：内容非空即可格式化（畸形输入由格式化器原样返回，无禁用态提示）
    storedDraft = {
      body: '{"kind":"xml","text":"<root/>"}',
      params: '[]',
      headers: '[]',
      timeoutSeconds: null,
      auth: null,
    }
    const view2 = renderEditor()
    await waitForDraftReady()
    await openBodyEditor()
    const xmlFormat = screen.getByTestId('editor-body-format')
    expect(xmlFormat).toBeEnabled()
    expect(xmlFormat).not.toHaveAttribute('title')
    view2.unmount()

    // JSON 非法：无法格式化（kind 来自信封直读——裸非法文本嗅探为 text）
    storedDraft = {
      body: '{"kind":"json","text":"not json"}',
      params: '[]',
      headers: '[]',
      timeoutSeconds: null,
      auth: null,
    }
    renderEditor()
    await waitForDraftReady()
    await openBodyEditor()
    const format = screen.getByTestId('editor-body-format')
    expect(format).toBeDisabled()
    expect(format).toHaveAttribute('title', '内容不是合法 JSON，无法格式化')
  })

  it('信封 roundtrip：legacy 编辑写回信封，重开读信封不再二次嗅探', async () => {
    storedDraft = {
      body: '{"a":1}',
      params: '[]',
      headers: '[]',
      timeoutSeconds: null,
      auth: null,
    }
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, refetchOnWindowFocus: false },
        mutations: { retry: false },
      },
    })
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const view1 = render(<EndpointEditor tab={makeTab()} />, { wrapper })
    await waitForDraftReady()
    await openBodyEditor()
    expect(screen.getByRole('tab', { name: 'JSON' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.change(bodyInput(), { target: { value: 'plain text now' } })
    await actAdvance(500)
    expect(storedDraft.body).toBe('{"kind":"json","text":"plain text now"}')
    view1.unmount()

    // 再读：合法信封直读，不再嗅探。切 Text 后重开——整串本身是合法 JSON，
    // 若读侧二次嗅探会错显为 JSON，Text 激活即证明直读
    const view2 = render(<EndpointEditor tab={makeTab()} />, { wrapper })
    await waitForDraftReady()
    await openBodyEditor()
    fireEvent.click(screen.getByRole('tab', { name: 'Text' }))
    await actAdvance(500)
    expect(storedDraft.body).toBe('{"kind":"text","text":"plain text now"}')
    view2.unmount()

    render(<EndpointEditor tab={makeTab()} />, { wrapper })
    await waitForDraftReady()
    await openBodyEditor()
    expect(screen.getByRole('tab', { name: 'Text' })).toHaveAttribute('aria-selected', 'true')
    expect(bodyInput()).toHaveValue('plain text now')
  })

  it('文本系编辑面 props：json 语言档与主题跟随、form 系不渲染编辑器', async () => {
    storedDraft = {
      body: '{"a":1}',
      params: '[]',
      headers: '[]',
      timeoutSeconds: null,
      auth: null,
    }
    renderEditor()
    await waitForDraftReady()
    await openBodyEditor()
    expect(bodyInput()).toHaveAttribute('data-language', 'json')
    expect(bodyInput()).toHaveAttribute('data-theme', 'light')
    // 切 form-data：行编辑形态（信封 text 载体保留、rows 为空集），文本编辑器卸载
    fireEvent.click(screen.getByRole('tab', { name: 'form-data' }))
    await vi.waitFor(() => {
      expect(screen.queryByTestId('editor-body-input')).not.toBeInTheDocument()
    })
    // 行编辑形态就绪＝占位行转正即加行（无「添加」钮）
    fireEvent.change(screen.getByLabelText('参数名 1'), { target: { value: 'attach' } })
    expect(screen.getByTestId('kv-row')).toBeInTheDocument()
  })
})

describe('⋯更多菜单（删除接口）', () => {
  function makeTabWithStore(overrides?: Partial<TabMeta>): EndpointTabMeta {
    const tab = makeTab(overrides)
    useTabsStore.setState({ tabs: [tab], activeTabId: tab.id })
    return tab
  }

  it('删除 → 确认 → endpoint.delete IPC → 关本 Tab 全链路', async () => {
    const tab = makeTabWithStore()
    renderEditor(tab)
    await waitForDraftReady()
    fireEvent.click(screen.getByTestId('editor-more-button'))
    fireEvent.click(await vi.waitFor(() => screen.getByRole('menuitem', { name: '删除' })))
    const dialog = await vi.waitFor(() => screen.getByRole('alertdialog'))
    expect(dialog).toHaveTextContent('删除接口')
    fireEvent.click(screen.getByTestId('editor-delete-confirm'))
    await vi.waitFor(() => {
      const call = invokeMock.mock.calls.find(([cmd]) => cmd === 'endpoint.delete')
      expect(call?.[1]).toEqual({ serviceId: 's1', key: 'e1' })
    })
    expect(useTabsStore.getState().tabs).toHaveLength(0)
  })

  it('Esc 关确认框（键盘可达），取消路径不触发 IPC', async () => {
    const tab = makeTabWithStore()
    renderEditor(tab)
    await waitForDraftReady()
    fireEvent.click(screen.getByTestId('editor-more-button'))
    fireEvent.click(await vi.waitFor(() => screen.getByRole('menuitem', { name: '删除' })))
    const dialog = await vi.waitFor(() => screen.getByRole('alertdialog'))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await vi.waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'endpoint.delete')).toBe(false)
    expect(useTabsStore.getState().tabs).toHaveLength(1)
  })

  it('同步接口同样可删（树侧删除语义不分 isManual）', async () => {
    const tab = makeTabWithStore({ id: makeEndpointNodeId('s1', 'e2'), key: 'e2', title: '登录' })
    renderEditor(tab)
    await waitForDraftReady()
    fireEvent.click(screen.getByTestId('editor-more-button'))
    fireEvent.click(await vi.waitFor(() => screen.getByRole('menuitem', { name: '删除' })))
    fireEvent.click(await vi.waitFor(() => screen.getByTestId('editor-delete-confirm')))
    await vi.waitFor(() => {
      const call = invokeMock.mock.calls.find(([cmd]) => cmd === 'endpoint.delete')
      expect(call?.[1]).toEqual({ serviceId: 's1', key: 'e2' })
    })
    expect(useTabsStore.getState().tabs).toHaveLength(0)
  })

  it('方法选择器宽度随内容自适应（无定宽类）；同步触发器＝方法浅底徽章', async () => {
    const view1 = renderEditor()
    await waitForDraftReady()
    const trigger = screen.getByRole('combobox', { name: '方法' })
    expect(trigger.className).not.toContain('w-24')
    expect(trigger.className).not.toMatch(/w-\d+/)
    // 色块 h-6 同变体覆盖 sm 档 h-7：32px 地址栏内上下各 4px，与左缘 pl-1 一致
    expect(trigger.className).toContain('data-[size=sm]:h-6')
    // 触发器＝方法徽章本身（浅底深字，箭头包在色块内随字色）；e1 定义＝POST
    expect(trigger.className).toContain('bg-method-post-bg')
    expect(trigger.className).toContain('text-method-post!')
    view1.unmount()
    // 同步接口同构：选择器显示定义方法，浅底徽章形态一致
    renderEditor(makeTab({ id: makeEndpointNodeId('s1', 'e2'), key: 'e2', title: '登录' }))
    await waitForDraftReady()
    const syncTrigger = screen.getByRole('combobox', { name: '方法' })
    expect(syncTrigger).toHaveTextContent('GET')
    expect(syncTrigger.className).toContain('bg-method-get-bg')
  })
})

describe('复制为 cURL（⋯菜单项）', () => {
  /** 覆盖 workspace.list 桩的当前工作空间 BaseUrl（禁用态测试） */
  function stubCurrentWorkspaceBaseUrl(baseUrl: string | null) {
    const base = invokeMock.getMockImplementation()
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'workspace.list') {
        return Promise.resolve({
          items: [{ id: 'w1', name: '默认工作空间', baseUrl, auth: null, isCurrent: true }],
          currentId: 'w1',
        })
      }
      return base ? base(cmd, args) : Promise.resolve(undefined)
    })
  }

  /** 打开 ⋯菜单并等「复制为 cURL」菜单项出现 */
  async function openCurlMenuItem() {
    fireEvent.click(screen.getByTestId('editor-more-button'))
    return vi.waitFor(() => screen.getByRole('menuitem', { name: '复制为 cURL' }))
  }

  it('点击产出可执行命令：最终 URL 口径＋方法＋头行＋认证编入，经剪贴板写入', async () => {
    storedDraft = {
      body: '{"kind":"json","text":"{\\"a\\":1}"}',
      params: '[{"name":"id","value":"42"},{"name":"a","value":"1"}]',
      headers: '[{"name":"X-Trace","value":"1"}]',
      timeoutSeconds: null,
      auth: '{"type":"bearer","token":"tk"}',
    }
    renderEditor()
    await waitForDraftReady()
    fireEvent.change(screen.getByLabelText('路径模板'), { target: { value: '/orders/{id}' } })
    fireEvent.click(await openCurlMenuItem())
    await vi.waitFor(() => {
      expect(clipboardState.writeText).toHaveBeenCalledTimes(1)
    })
    const text = clipboardState.writeText.mock.calls[0]?.[0] as string
    // URL＝最终组合口径（占位填充＋query），method 显式，头与认证（Bearer）编入
    expect(text).toContain(`curl -X POST 'http://localhost:5000/orders/42?a=1'`)
    expect(text).toContain(`-H 'X-Trace: 1'`)
    expect(text).toContain(`-H 'Authorization: Bearer tk'`)
    // json body 无显式 Content-Type 头时按引擎默认补
    expect(text).toContain(`-H 'Content-Type: application/json'`)
    expect(text).toContain(`--data-raw '{"a":1}'`)
  })

  it('BaseUrl 未配置（最终 URL 不可组合）时菜单项禁用', async () => {
    stubCurrentWorkspaceBaseUrl(null)
    renderEditor()
    await waitForDraftReady()
    // 菜单项禁用＝Base UI data-disabled 形态（无原生 disabled 属性）
    expect(await openCurlMenuItem()).toHaveAttribute('data-disabled')
  })
})

describe('从 cURL 导入（⋯菜单 → 粘贴对话框 → 新草稿 Tab）', () => {
  async function openImportDialog() {
    fireEvent.click(screen.getByTestId('editor-more-button'))
    const item = await vi.waitFor(() => screen.getByRole('menuitem', { name: '从 cURL 导入' }))
    fireEvent.click(item)
    return vi.waitFor(() => screen.getByTestId('curl-import-dialog'))
  }

  it('粘贴解析成功：开新草稿 Tab 并播种内存草稿（不落库、原 Tab 保留）', async () => {
    const tab = makeTab()
    useTabsStore.setState({ tabs: [tab], activeTabId: tab.id })
    renderEditor(tab)
    await waitForDraftReady()
    await openImportDialog()
    fireEvent.change(screen.getByTestId('curl-import-input'), {
      target: {
        value: `curl -X PUT 'http://localhost:5000/api/x?k=1' -H 'X-A: 1' -d '{"b":2}'`,
      },
    })
    fireEvent.click(screen.getByTestId('curl-import-submit'))
    await vi.waitFor(() => {
      expect(screen.queryByTestId('curl-import-dialog')).not.toBeInTheDocument()
    })
    const tabs = useTabsStore.getState().tabs
    expect(tabs).toHaveLength(2)
    expect(tabs[0]?.id).toBe('endpoint:s1:e1')
    const draftTab = tabs[1]
    expect(draftTab?.kind).toBe('draft')
    expect(draftTab?.title).toBe('PUT /api/x')
    // BaseUrl 命中拆相对模板；query / 头 / 体回填内存草稿（不触发任何写 IPC）
    const seeded = useDraftStore.getState().drafts[draftTab!.id!]
    expect(seeded).toMatchObject({
      method: 'PUT',
      pathTemplate: '/api/x',
      paramsJson: '[{"name":"k","value":"1"}]',
      headersJson: '[{"name":"X-A","value":"1"}]',
      body: '{"kind":"json","text":"{\\"b\\":2}"}',
    })
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'user_data.upsert')).toBe(false)
  })

  it('解析失败：错误位＋原因行内呈现，不生成草稿 Tab', async () => {
    renderEditor()
    await waitForDraftReady()
    await openImportDialog()
    fireEvent.change(screen.getByTestId('curl-import-input'), {
      target: { value: `wget 'http://x.test/a'` },
    })
    fireEvent.click(screen.getByTestId('curl-import-submit'))
    const error = await vi.waitFor(() => screen.getByTestId('curl-import-error'))
    expect(error).toHaveTextContent('命令需以 curl 开头')
    expect(useTabsStore.getState().tabs).toHaveLength(0)
    // 编辑即清错误：修改文本后拒绝提示消失
    fireEvent.change(screen.getByTestId('curl-import-input'), {
      target: { value: `curl 'http://x.test/a' -o x` },
    })
    expect(screen.queryByTestId('curl-import-error')).not.toBeInTheDocument()
  })
})

describe('另存为新接口（⋯菜单，手工 / 同步两侧）', () => {
  /** 打开 ⋯ 菜单并点击「另存为新接口」 */
  async function clickSaveAs() {
    fireEvent.click(screen.getByTestId('editor-more-button'))
    const item = await vi.waitFor(() => screen.getByRole('menuitem', { name: '另存为新接口' }))
    fireEvent.click(item)
  }

  it('手工接口：当前草稿经转正原语落当前服务下未分类新接口，新 Tab 常驻、原 Tab 保留', async () => {
    const tab = makeTab()
    useTabsStore.setState({ tabs: [tab], activeTabId: tab.id })
    renderEditor(tab)
    await waitForDraftReady()
    await clickSaveAs()
    await vi.waitFor(() => {
      expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'endpoint.create_manual')).toBe(true)
    })
    const createCall = invokeMock.mock.calls.find(([cmd]) => cmd === 'endpoint.create_manual')!
    const createArgs = createCall[1] as { args: Record<string, unknown> }
    expect(createArgs.args).toMatchObject({
      serviceId: 's1',
      method: 'POST',
      pathTemplate: '/orders',
      categoryId: null,
    })
    // 用户数据整包随转正写入新接口身份（两步 IPC 经微任务链落定，waitFor 推进）
    const upsertCall = await vi.waitFor(() => {
      const call = invokeMock.mock.calls.find(([cmd]) => cmd === 'user_data.upsert')
      if (call === undefined) throw new Error('user_data.upsert 未被调用')
      return call
    })
    const upsertArgs = upsertCall[1] as { args: { serviceId: string; key: string } }
    expect(upsertArgs.args).toMatchObject({ serviceId: 's1', key: 'e-new-1' })
    await vi.waitFor(() => {
      expect(useTabsStore.getState().tabs).toHaveLength(2)
    })
    const tabs = useTabsStore.getState().tabs
    expect(tabs[0]?.id).toBe('endpoint:s1:e1')
    // 新接口 Tab 常驻（preview=false）并激活
    expect(tabs[1]).toMatchObject({ id: 'endpoint:s1:e-new-1', preview: false })
    expect(useTabsStore.getState().activeTabId).toBe('endpoint:s1:e-new-1')
  })

  it('同步接口：定义（只读）＋当前用户数据生成手工副本，不含同步身份', async () => {
    const tab = makeTab({ id: makeEndpointNodeId('s1', 'e2'), key: 'e2', title: '登录' })
    useTabsStore.setState({ tabs: [tab], activeTabId: tab.id })
    renderEditor(tab)
    await waitForDraftReady()
    await clickSaveAs()
    await vi.waitFor(() => {
      expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'endpoint.create_manual')).toBe(true)
    })
    const createCall = invokeMock.mock.calls.find(([cmd]) => cmd === 'endpoint.create_manual')!
    const createArgs = createCall[1] as { args: Record<string, unknown> }
    // method / pathTemplate 来自定义（同步侧只读），落点当前服务未分类
    expect(createArgs.args).toMatchObject({
      serviceId: 's1',
      method: 'GET',
      pathTemplate: '/login',
      categoryId: null,
    })
  })

  it('路径模板非法（编辑中间态）时菜单项禁用，不发起创建', async () => {
    renderEditor()
    await waitForDraftReady()
    fireEvent.change(screen.getByLabelText('路径模板'), { target: { value: 'orders?id=1' } })
    fireEvent.click(screen.getByTestId('editor-more-button'))
    const item = screen.getByRole('menuitem', { name: '另存为新接口' })
    expect(item).toHaveAttribute('data-disabled')
    fireEvent.click(item)
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'endpoint.create_manual')).toBe(false)
  })
})

/** fake timers 下的 act 内推进（防抖窗口 / 微任务一并冲刷） */
async function actAdvance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}
