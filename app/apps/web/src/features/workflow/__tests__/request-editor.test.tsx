import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RequestEditor } from '../canvas/request-editor'
import { WorkflowIdContext } from '../canvas/workflow-id-context'
import { InvalidRefContext } from '../canvas/validation-context'
import { useWorkflowEditorStore } from '../workflow-editor.store'
import { emptyWriteback, type RequestNodeConfig, type WorkflowGraph } from '../workflow-model'

// 测试环境无 IPC：默认统一拒绝（预填数据源静默降级为不预填，值候选的
// 最近执行查询回落图结构顶层）；预填用例经 invokeStub 按命令播种返回值
const { invokeStub } = vi.hoisted(() => ({ invokeStub: vi.fn() }))
vi.mock('@/services/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ipc')>()
  return {
    ...actual,
    invoke: invokeStub,
  }
})

/**
 * 请求节点编辑器（入参面深化）：值候选下拉与上游提取产物同源（含实测深层
 * 展开，引用模板为裸键）、无上游产物退化为纯输入框、path 模板参数字段化
 * （值空＝不填充）、query 定义参数预填（值空＝不覆写、必填标记）、body 预填
 * 与清空不回灌（null＝未编辑显示预填、空串＝显式清空）。
 */

const config: RequestNodeConfig = {
  type: 'request',
  endpointKey: null,
  query: [{ name: 'q', value: '' }],
  pathParams: [],
  body: null,
  timeoutMs: null,
}

/**
 * 深层展开用图：提取产物 token 为对象（实测根展开其键名）；提取节点书写名
 * 保留非空值仅为覆盖「节点名不参与候选拼装」的现行口径
 */
const graphWithDeepProduct: WorkflowGraph = {
  schemaVersion: 3,
  nodes: [
    {
      id: 'req0',
      name: '登录接口',
      position: { x: 0, y: 0 },
      config: {
        type: 'request',
        endpointKey: null,
        query: [],
        pathParams: [],
        body: null,
        timeoutMs: null,
      },
    },
    {
      id: 'ext1',
      name: '登录',
      position: { x: 0, y: 0 },
      config: {
        type: 'extract',
        source: 'jsonPath',
        rules: [{ path: '$.token', name: 'token' }],
        writeback: emptyWriteback(),
      },
    },
    {
      id: 'req1',
      name: '查询',
      position: { x: 0, y: 0 },
      config,
    },
  ],
  edges: [
    { id: 'e1', source: 'req0', target: 'ext1', label: null },
    { id: 'e2', source: 'ext1', target: 'req1', label: null },
  ],
}

/** 最近执行记录播种（掩码响应体＝对象产物实测字段的展开源） */
function stubLastExecution(body: string) {
  invokeStub.mockImplementation((cmd: string) => {
    if (cmd === 'workflow.last_execution') {
      return Promise.resolve({
        id: 'exec1',
        workflowId: 'wf1',
        status: 'passed',
        startedAt: '',
        completedAt: '',
        durationMs: 1,
        errorCode: null,
        errorMessage: null,
        nodes: [
          {
            nodeId: 'req0',
            status: 'passed',
            startedAt: null,
            completedAt: null,
            durationMs: 1,
            errorCode: null,
            errorMessage: null,
            response: { status: 200, body },
          },
        ],
      })
    }
    return Promise.reject(new Error(`no IPC in component tests: ${cmd}`))
  })
}

/** 树返回（预填数据源定位面：稳定键 → 服务内接口行） */
function stubEndpointDataWithTree(
  endpoints: Array<{ key: string; pathTemplate: string }>,
  doc: unknown,
  userData: unknown,
) {
  invokeStub.mockImplementation((cmd: string) => {
    if (cmd === 'workspace.list') {
      return Promise.resolve({
        items: [{ id: 'w1', name: '空间', baseUrl: null, auth: null, isCurrent: true }],
        currentId: 'w1',
      })
    }
    if (cmd === 'tree.get') {
      return Promise.resolve({
        workspaceId: 'w1',
        services: [
          {
            id: 's1',
            name: '服务',
            docUrl: null,
            docType: 'openapi',
            sortOrder: 0,
            categories: [],
            endpoints: endpoints.map((endpoint) => ({
              serviceId: 's1',
              key: endpoint.key,
              title: '标题',
              categoryId: null,
              definition: { method: 'GET', pathTemplate: endpoint.pathTemplate },
              isManual: false,
              pinned: false,
            })),
          },
        ],
      })
    }
    if (cmd === 'endpoint.doc') return Promise.resolve(doc)
    if (cmd === 'user_data.get') return Promise.resolve(userData)
    return Promise.reject(new Error(`no IPC in component tests: ${cmd}`))
  })
}

/** doc / 用户数据播种（树固定命中 GET /users） */
function stubEndpointData(doc: unknown, userData: unknown) {
  stubEndpointDataWithTree([{ key: 'GET /users', pathTemplate: '/users' }], doc, userData)
}

function seedSession(graph: WorkflowGraph | null) {
  useWorkflowEditorStore.setState({
    sessions:
      graph == null
        ? {}
        : {
            wf1: {
              workflowId: 'wf1',
              name: 'W',
              graph,
              dirty: false,
              past: [],
              future: [],
              lastCommit: null,
            },
          },
  })
}

function renderEditor(next: RequestNodeConfig, onUpdate?: (config: RequestNodeConfig) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <WorkflowIdContext.Provider value="wf1">
        <RequestEditor nodeId="req1" config={next} onChange={onUpdate ?? (() => {})} />
      </WorkflowIdContext.Provider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  seedSession(null)
  invokeStub.mockRejectedValue(new Error('no IPC in component tests'))
})

describe('request-editor：值候选下拉（上游提取产物引用）', () => {
  it('候选含实测深层展开字段，引用模板为裸键形态（{{产物名}} / {{产物名.字段}}）', async () => {
    stubLastExecution('{"token":{"secret":"x"}}')
    seedSession(graphWithDeepProduct)
    renderEditor(config)
    // 值输入下拉候选：候选集随最近执行记录解析后出现（含深层展开字段）
    const candidatesButton = await waitFor(() =>
      // 查询行值输入的候选展开钮（无候选时不渲染）
      screen.getByTestId('workflow-override-value-candidates'),
    )
    expect(candidatesButton).toBeInTheDocument()
    fireEvent.click(candidatesButton)
    await waitFor(() => expect(screen.getByText('{{token}}')).toBeInTheDocument())
    expect(screen.getByText('{{token.secret}}')).toBeInTheDocument()
  })

  it('无上游提取节点＝值输入退化为纯输入框（候选下拉钮不渲染）', () => {
    renderEditor(config)
    expect(screen.queryByTestId('workflow-override-value-candidates')).not.toBeInTheDocument()
  })
})

describe('request-editor：path 模板参数字段化', () => {
  it('稳定键路径含 {param} 段＝逐参数填值行', () => {
    const { unmount } = renderEditor({ ...config, endpointKey: 'GET /users/{id}/posts/{postId}' })
    expect(screen.getByTestId('workflow-override-path')).toBeInTheDocument()
    expect(screen.getByText('id')).toBeInTheDocument()
    expect(screen.getByText('postId')).toBeInTheDocument()
    unmount()
  })

  it('无模板参数＝整区不渲染', () => {
    renderEditor({ ...config, endpointKey: 'GET /users' })
    expect(screen.queryByTestId('workflow-override-path')).not.toBeInTheDocument()
  })

  it('{{变量}} 双括号是变量引用不是模板参数（与引擎占位识别同口径）', () => {
    renderEditor({ ...config, endpointKey: 'GET /items/{{env}}/{id}' })
    expect(screen.getByText('id')).toBeInTheDocument()
    expect(screen.queryByText('env')).not.toBeInTheDocument()
  })

  it('填值经 upsert 落库；清空＝移除落库行（值空＝不填充）', () => {
    const onUpdate = vi.fn()
    const { unmount } = renderEditor(
      { ...config, endpointKey: 'GET /users/{id}', query: [] },
      onUpdate,
    )
    fireEvent.change(screen.getByPlaceholderText('值'), { target: { value: '42' } })
    expect(onUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ pathParams: [{ name: 'id', value: '42' }] }),
    )
    unmount()
    // 已有落库行后清空：同名行移除
    const onUpdate2 = vi.fn()
    renderEditor(
      {
        ...config,
        endpointKey: 'GET /users/{id}',
        query: [],
        pathParams: [{ name: 'id', value: '42' }],
      },
      onUpdate2,
    )
    fireEvent.change(screen.getByPlaceholderText('值'), { target: { value: '' } })
    expect(onUpdate2).toHaveBeenLastCalledWith(expect.objectContaining({ pathParams: [] }))
  })
})

describe('request-editor：query 定义参数预填', () => {
  it('doc 定义 query 参数预填显示行（key 只读＋必填标记），输入值才落库', async () => {
    stubEndpointData(
      {
        title: '查询用户',
        parameters: [
          { name: 'page', location: 'query', required: true },
          { name: 'size', location: 'query', required: false },
          { name: 'X-Token', location: 'header', required: false },
        ],
        responses: [],
      },
      null,
    )
    const onUpdate = vi.fn()
    renderEditor({ ...config, endpointKey: 'GET /users', query: [] }, onUpdate)
    await waitFor(() => expect(screen.getByText('page')).toBeInTheDocument())
    // 必填标记（视觉呈现，不阻断保存）
    expect(screen.getAllByTestId('workflow-override-required-mark')).toHaveLength(1)
    // 定义行 key 只读（无名称输入框）
    expect(screen.queryByPlaceholderText('名称')).not.toBeInTheDocument()
    // 输入值落库；位置参数与 header 位置参数不预填
    const inputs = screen.getAllByPlaceholderText('值')
    fireEvent.change(inputs[0], { target: { value: '2' } })
    expect(onUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: [{ name: 'page', value: '2' }] }),
    )
  })

  it('定义行值空＝不覆写：清空已填值移除落库行', async () => {
    stubEndpointData(
      {
        title: '查询用户',
        parameters: [{ name: 'page', location: 'query', required: true }],
        responses: [],
      },
      null,
    )
    const onUpdate = vi.fn()
    renderEditor(
      { ...config, endpointKey: 'GET /users', query: [{ name: 'page', value: '2' }] },
      onUpdate,
    )
    // 等定义行形态出现（必填标记＝doc 投影独有），否则落库行先以自由行呈现
    await waitFor(() =>
      expect(screen.getByTestId('workflow-override-required-mark')).toBeInTheDocument(),
    )
    fireEvent.change(screen.getByDisplayValue('2'), { target: { value: '' } })
    expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ query: [] }))
  })

  it('自由覆写行可编辑可删（定义行删除语义＝清空值，恒显示）', async () => {
    stubEndpointData(
      {
        title: '查询用户',
        parameters: [{ name: 'page', location: 'query', required: false }],
        responses: [],
      },
      null,
    )
    const onUpdate = vi.fn()
    renderEditor(
      {
        ...config,
        endpointKey: 'GET /users',
        query: [
          { name: 'page', value: '' },
          { name: 'extra', value: '1' },
        ],
      },
      onUpdate,
    )
    await waitFor(() => expect(screen.getByText('page')).toBeInTheDocument())
    // 自由行：名称可编辑、行可删
    fireEvent.change(screen.getByDisplayValue('extra'), { target: { value: 'extra2' } })
    expect(onUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        query: [
          { name: 'page', value: '' },
          { name: 'extra2', value: '1' },
        ],
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: '移除行' }))
    expect(onUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: [{ name: 'page', value: '' }] }),
    )
    // 定义行无删除钮
    expect(screen.getAllByRole('button', { name: '移除行' })).toHaveLength(1)
  })

  it('失效引用态不预填（留痕展示不变）：树与 doc 数据在列也不出定义行', async () => {
    stubEndpointData(
      {
        title: '查询用户',
        parameters: [{ name: 'page', location: 'query', required: true }],
        responses: [],
      },
      null,
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <WorkflowIdContext.Provider value="wf1">
          <InvalidRefContext.Provider value={new Set(['req1'])}>
            <RequestEditor
              nodeId="req1"
              config={{ ...config, endpointKey: 'GET /users' }}
              onChange={() => {}}
            />
          </InvalidRefContext.Provider>
        </WorkflowIdContext.Provider>
      </QueryClientProvider>,
    )
    // 留痕恒可见（方法＋路径），预填静默不出现
    expect(screen.getByText('/users')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByTestId('workflow-override-required-mark')).not.toBeInTheDocument(),
    )
  })
})

describe('request-editor：body 预填与清空区分', () => {
  it('body 从未编辑（null）＝显示接口用户数据文本（信封 text 载体取原文）', async () => {
    stubEndpointData(
      { title: '更新用户', parameters: [], responses: [] },
      {
        serviceId: 's1',
        key: 'GET /users',
        body: '{"kind":"json","text":"{\\"name\\":\\"Ada\\"}"}',
        params: '[]',
        headers: '[]',
        timeoutSeconds: null,
        auth: null,
        pathOverride: null,
        methodOverride: null,
        updatedAt: '',
      },
    )
    renderEditor({ ...config, endpointKey: 'GET /users' })
    await waitFor(() => expect(screen.getByDisplayValue('{"name":"Ada"}')).toBeInTheDocument())
  })

  it('无用户数据 body 时回落定义侧 example 序列化文本', async () => {
    stubEndpointData(
      {
        title: '更新用户',
        parameters: [],
        requestBody: {
          contentType: 'application/json',
          required: true,
          schema: {
            schemaType: 'object',
            truncated: false,
            required: [],
            enumValues: [],
            properties: [],
          },
          example: { name: 'Ada' },
        },
        responses: [],
      },
      null,
    )
    renderEditor({ ...config, endpointKey: 'GET /users' })
    const area = screen.getByPlaceholderText('请求体原文，留空跟随接口') as HTMLTextAreaElement
    await waitFor(() => expect(area.value).toContain('Ada'))
  })

  it('用户编辑落字符串（含清空落空串）：清空后不再回灌预填', async () => {
    stubEndpointData(
      { title: '更新用户', parameters: [], responses: [] },
      {
        serviceId: 's1',
        key: 'GET /users',
        body: '{"kind":"text","text":"hello"}',
        params: '[]',
        headers: '[]',
        timeoutSeconds: null,
        auth: null,
        pathOverride: null,
        methodOverride: null,
        updatedAt: '',
      },
    )
    const onUpdate = vi.fn()
    renderEditor({ ...config, endpointKey: 'GET /users' }, onUpdate)
    await waitFor(() => expect(screen.getByDisplayValue('hello')).toBeInTheDocument())
    // 编辑 → 落库字符串
    fireEvent.change(screen.getByDisplayValue('hello'), { target: { value: 'mine' } })
    expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ body: 'mine' }))
    // 显式清空 → 落空串（不转 null，null 语义保留给「从未编辑」）
    renderEditor({ ...config, endpointKey: 'GET /users', body: 'mine' }, onUpdate)
    fireEvent.change(screen.getByDisplayValue('mine'), { target: { value: '' } })
    expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ body: '' }))
  })

  it('form 系用户数据 body 静默降级为不预填（空框）', async () => {
    stubEndpointData(
      { title: '上传', parameters: [], responses: [] },
      {
        serviceId: 's1',
        key: 'GET /users',
        body: '{"kind":"form-data","rows":[{"name":"f","value":"v"}]}',
        params: '[]',
        headers: '[]',
        timeoutSeconds: null,
        auth: null,
        pathOverride: null,
        methodOverride: null,
        updatedAt: '',
      },
    )
    renderEditor({ ...config, endpointKey: 'GET /users' })
    await waitFor(() =>
      expect(screen.getByPlaceholderText('请求体原文，留空跟随接口')).toHaveValue(''),
    )
  })
})
