import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkflowExecutionStore } from '../execution.store'
import { WorkflowIdContext } from '../canvas/workflow-id-context'
import { InvalidRefContext } from '../canvas/validation-context'
import {
  NodeUpdateContext,
  RenameRequestContext,
  type RenameRequest,
} from '../canvas/node-editing-context'
import { WorkflowNodeCard } from '../canvas/node-card'
import type { WorkflowNode } from '../workflow-model'

// Handle 依赖画布节点注册上下文，组件测试只看请求节点的引用态视觉面，
// 置空渲染（拓扑正确性属画布集成面）
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  return { ...actual, Handle: () => null }
})

// 提取编辑器的写回分支挂查询 hook（空间清单 / 分类 / 最近执行）：测试环境
// 无 IPC，invoke 拒绝即查询错误态（写回关闭时查询不启动，不影响断言）
vi.mock('@/services/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ipc')>()
  return {
    ...actual,
    invoke: vi.fn().mockRejectedValue(new Error('no IPC in component tests')),
  }
})

/**
 * 节点卡片：引用态视觉三态（待绑定 / 已绑定稳定键 / 手工 UUID 键）、执行期
 * 视觉、配置编辑面内联（Postman Flow 式「配置即节点内容」）、标题条双击
 * 改名与外部重命名请求聚焦、终端胶囊形态。
 */

beforeEach(() => {
  useWorkflowExecutionStore.setState({ executions: {}, executionIndex: {} })
})

function requestNode(endpointKey: string | null): WorkflowNode {
  return {
    id: 'n1',
    name: '',
    position: { x: 0, y: 0 },
    config: {
      type: 'request',
      endpointKey,
      query: [],
      pathParams: [],
      body: null,
      timeoutMs: null,
    },
  }
}

function renderCard(
  node: WorkflowNode,
  options?: {
    execution?: 'failed' | 'skipped'
    invalidRefs?: ReadonlySet<string>
    onUpdateNode?: (nodeId: string, next: WorkflowNode) => void
    renameRequest?: RenameRequest
  },
) {
  if (options?.execution) {
    useWorkflowExecutionStore.setState({
      executions: {
        wf1: {
          executionId: 'e1',
          workflowId: 'wf1',
          status: 'failed',
          nodes: {
            n1: {
              status: options.execution,
              ...(options.execution === 'failed' ? { errorCode: 'X', errorMessage: 'boom' } : {}),
            },
          },
          order: ['n1'],
          activeEdgeIds: new Set(),
        },
      },
      executionIndex: { e1: 'wf1' },
    })
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <WorkflowIdContext.Provider value="wf1">
        <InvalidRefContext.Provider value={options?.invalidRefs ?? new Set()}>
          <NodeUpdateContext.Provider value={options?.onUpdateNode ?? (() => {})}>
            <RenameRequestContext.Provider value={options?.renameRequest ?? null}>
              <WorkflowNodeCard
                id={node.id}
                data={{ node }}
                type="request"
                draggable
                selectable
                deletable
                selected={false}
                dragging={false}
                zIndex={0}
                isConnectable
                positionAbsoluteX={0}
                positionAbsoluteY={0}
              />
            </RenameRequestContext.Provider>
          </NodeUpdateContext.Provider>
        </InvalidRefContext.Provider>
      </WorkflowIdContext.Provider>
    </QueryClientProvider>,
  )
}

describe('node-card：请求节点引用态视觉面', () => {
  it('待绑定占位：虚线边＋待绑定提示，data-bound=false', () => {
    renderCard(requestNode(null))
    const card = screen.getByTestId('workflow-node-request')
    expect(card).toHaveAttribute('data-bound', 'false')
    expect(card.className).toContain('border-dashed')
    expect(screen.getByText('待绑定')).toBeInTheDocument()
  })

  it('已绑定稳定键：方法徽标＋路径模板，实线边，data-bound=true', () => {
    renderCard(requestNode('GET /api/users/{id}'))
    const card = screen.getByTestId('workflow-node-request')
    expect(card).toHaveAttribute('data-bound', 'true')
    expect(card.className).not.toContain('border-dashed')
    expect(screen.getByText('GET')).toBeInTheDocument()
    expect(screen.getByText('/api/users/{id}')).toBeInTheDocument()
    expect(screen.queryByText('待绑定')).not.toBeInTheDocument()
  })

  it('手工 UUID 键：已绑定标记但无徽标行（无方法路径语义可拆）', () => {
    renderCard(requestNode('3fa85f64-5717-4562-b3fc-2c963f66afa6'))
    const card = screen.getByTestId('workflow-node-request')
    expect(card).toHaveAttribute('data-bound', 'true')
    expect(card.className).not.toContain('border-dashed')
    expect(screen.queryByText('待绑定')).not.toBeInTheDocument()
  })
})

describe('node-card：失效引用视觉面（警示实线边区别于待绑定虚线）', () => {
  it('失效引用：警示边＋警示图标，方法与路径留痕恒可见', () => {
    renderCard(requestNode('GET /api/gone'), { invalidRefs: new Set(['n1']) })
    const card = screen.getByTestId('workflow-node-request')
    expect(card).toHaveAttribute('data-invalid', 'true')
    expect(card.className).toContain('border-destructive')
    expect(card.className).not.toContain('border-dashed')
    expect(screen.getByText('GET')).toBeInTheDocument()
    expect(screen.getByText('/api/gone')).toBeInTheDocument()
    expect(card.querySelector('svg.lucide-triangle-alert')).not.toBeNull()
  })

  it('已绑定未失效：无警示边与图标（data-invalid=false）', () => {
    renderCard(requestNode('GET /api/users'))
    const card = screen.getByTestId('workflow-node-request')
    expect(card).toHaveAttribute('data-invalid', 'false')
    expect(card.className).not.toContain('border-destructive')
    expect(card.querySelector('svg.lucide-triangle-alert')).toBeNull()
  })

  it('未绑定占位不判失效（待绑定与失效互斥，context 命中也不标）', () => {
    renderCard(requestNode(null), { invalidRefs: new Set(['n1']) })
    expect(screen.getByTestId('workflow-node-request')).toHaveAttribute('data-invalid', 'false')
  })
})

describe('node-card：执行态视觉面', () => {
  it('失败执行态：错误色边＋失败徽标（错误详情在执行面板，不在卡片）', () => {
    renderCard(requestNode(null), { execution: 'failed' })
    const card = screen.getByTestId('workflow-node-request')
    expect(card.className).toContain('border-destructive')
    const badge = screen.getByTestId('workflow-node-execution-badge')
    expect(badge).toHaveAttribute('data-status', 'failed')
  })

  it('skipped 执行态：整卡弱化＋弱化族徽标', () => {
    renderCard(requestNode(null), { execution: 'skipped' })
    const card = screen.getByTestId('workflow-node-request')
    expect(card.className).toContain('opacity-55')
    expect(screen.getByTestId('workflow-node-execution-badge')).toHaveAttribute(
      'data-status',
      'skipped',
    )
  })

  it('无执行态：无徽标、无执行着色（纯编辑态）', () => {
    renderCard(requestNode('GET /api/users'))
    expect(screen.queryByTestId('workflow-node-execution-badge')).not.toBeInTheDocument()
    expect(screen.getByTestId('workflow-node-request').className).not.toContain('destructive')
  })
})

describe('node-card：请求节点响应状态码', () => {
  /** 注入含请求 / 响应明细的执行态（终态记录播种形态，明细已在 Rust 侧掩码） */
  function seedWithResponse(status: 'passed' | 'failed', responseStatus: number) {
    useWorkflowExecutionStore.setState({
      executions: {
        wf1: {
          executionId: 'e1',
          workflowId: 'wf1',
          status,
          nodes: {
            n1: {
              status,
              request: { method: 'POST', url: 'https://api.example.com/login?token=***' },
              response: { status: responseStatus, body: '{"code":***}' },
            },
          },
          order: ['n1'],
          activeEdgeIds: new Set(),
        },
      },
      executionIndex: { e1: 'wf1' },
    })
  }

  it('终态有响应：方法徽标行行尾显示状态码数字', () => {
    seedWithResponse('passed', 200)
    renderCard(requestNode('POST /api/login'))
    expect(screen.getByTestId('workflow-node-request-status')).toHaveTextContent('200')
  })

  it('2xx 状态码走成功色（与执行通过语义同色）', () => {
    seedWithResponse('passed', 204)
    renderCard(requestNode('POST /api/login'))
    expect(screen.getByTestId('workflow-node-request-status').className).toContain('text-success')
  })

  it('非 2xx 状态码走警示色（500 视觉可区分于 200，数字本身即非色彩通道）', () => {
    seedWithResponse('failed', 500)
    renderCard(requestNode('POST /api/login'))
    const statusEl = screen.getByTestId('workflow-node-request-status')
    expect(statusEl).toHaveTextContent('500')
    expect(statusEl.className).toContain('text-destructive')
  })

  it('无响应明细（传输失败 / 过程态）：不显示状态码', () => {
    useWorkflowExecutionStore.setState({
      executions: {
        wf1: {
          executionId: 'e1',
          workflowId: 'wf1',
          status: 'failed',
          nodes: { n1: { status: 'failed', errorCode: 'X', errorMessage: 'boom' } },
          order: ['n1'],
          activeEdgeIds: new Set(),
        },
      },
      executionIndex: { e1: 'wf1' },
    })
    renderCard(requestNode('POST /api/login'))
    expect(screen.queryByTestId('workflow-node-request-status')).not.toBeInTheDocument()
  })
})

describe('node-card：请求节点内联配置面（Postman Flow 式）', () => {
  /** 带超时覆写的请求节点（null＝继承） */
  function requestNodeWithTimeout(timeoutMs: number | null): WorkflowNode {
    return {
      id: 'n1',
      name: '',
      position: { x: 0, y: 0 },
      config: {
        type: 'request',
        endpointKey: 'GET /api/users',
        query: [],
        pathParams: [],
        body: null,
        timeoutMs,
      },
    }
  }

  it('配置编辑面直接铺在节点内：接口行 / 覆写行 / Body / 超时', () => {
    renderCard(requestNodeWithTimeout(null))
    expect(screen.getByTestId('workflow-request-editor')).toBeInTheDocument()
    expect(screen.getByTestId('workflow-override-query')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('请求体原文，留空跟随接口')).toBeInTheDocument()
    expect(screen.getByTestId('workflow-request-timeout-input')).toHaveValue(null)
  })

  it('超时覆写输入落通道：数值转毫秒写回 config', () => {
    const onUpdateNode = vi.fn()
    renderCard(requestNodeWithTimeout(null), { onUpdateNode })
    fireEvent.change(screen.getByTestId('workflow-request-timeout-input'), {
      target: { value: '30000' },
    })
    expect(onUpdateNode).toHaveBeenCalledWith(
      'n1',
      expect.objectContaining({ config: expect.objectContaining({ timeoutMs: 30000 }) }),
    )
  })

  it('清空输入＝清除覆写（null＝继承）', () => {
    const onUpdateNode = vi.fn()
    renderCard(requestNodeWithTimeout(500), { onUpdateNode })
    fireEvent.change(screen.getByTestId('workflow-request-timeout-input'), {
      target: { value: '' },
    })
    expect(onUpdateNode).toHaveBeenCalledWith(
      'n1',
      expect.objectContaining({ config: expect.objectContaining({ timeoutMs: null }) }),
    )
  })

  it('非法数值（负数 / 零）不落库：回落当前覆写值', () => {
    const onUpdateNode = vi.fn()
    renderCard(requestNodeWithTimeout(500), { onUpdateNode })
    fireEvent.change(screen.getByTestId('workflow-request-timeout-input'), {
      target: { value: '-5' },
    })
    fireEvent.change(screen.getByTestId('workflow-request-timeout-input'), {
      target: { value: '0' },
    })
    expect(onUpdateNode).toHaveBeenNthCalledWith(
      1,
      'n1',
      expect.objectContaining({ config: expect.objectContaining({ timeoutMs: 500 }) }),
    )
    expect(onUpdateNode).toHaveBeenNthCalledWith(
      2,
      'n1',
      expect.objectContaining({ config: expect.objectContaining({ timeoutMs: 500 }) }),
    )
  })
})

describe('node-card：终端节点形态（开始 / 结束）', () => {
  function terminalNode(kind: 'start' | 'end'): WorkflowNode {
    return {
      id: 'n1',
      name: '',
      position: { x: 0, y: 0 },
      config: { type: kind },
    }
  }

  it('开始节点＝胶囊终端节点：无配置面，data-testid 不变', () => {
    renderCard(terminalNode('start'))
    const card = screen.getByTestId('workflow-node-start')
    expect(card.className).toContain('rounded-full')
    expect(card.className).not.toContain('w-64')
    expect(screen.getByText('开始')).toBeInTheDocument()
    expect(screen.queryByTestId('workflow-node-config-start')).not.toBeInTheDocument()
  })

  it('结束节点同样按胶囊渲染', () => {
    renderCard(terminalNode('end'))
    const card = screen.getByTestId('workflow-node-end')
    expect(card.className).toContain('rounded-full')
    expect(screen.getByText('结束')).toBeInTheDocument()
  })
})

describe('node-card：标题条改名（双击 / 外部重命名请求）', () => {
  it('节点名非空显示自定义名（改名后卡片跟随）', () => {
    renderCard({ ...requestNode('GET /api/users'), name: '登录后再下单' })
    expect(screen.getByText('登录后再下单')).toBeInTheDocument()
    expect(screen.queryByText('请求')).not.toBeInTheDocument()
  })

  it('节点名为空回落 kind 名（自动命名口径）', () => {
    renderCard(requestNode('GET /api/users'))
    expect(screen.getByText('请求')).toBeInTheDocument()
  })

  it('双击标题进入编辑：输入值经统一更新通道落 name，id 与 config 原样保留', () => {
    const onUpdateNode = vi.fn()
    const base = { ...requestNode('GET /api/users'), name: '登录' }
    renderCard(base, { onUpdateNode })
    fireEvent.doubleClick(screen.getByText('登录'))
    const input = screen.getByTestId('workflow-node-name-input')
    expect(input).toHaveValue('登录')
    fireEvent.change(input, { target: { value: '登录 V2' } })
    expect(onUpdateNode).toHaveBeenCalledTimes(1)
    expect(onUpdateNode).toHaveBeenCalledWith('n1', { ...base, name: '登录 V2' })
  })

  it('空名编辑框不预填 kind 兜底词（清空名称即恢复自动命名）', () => {
    renderCard(requestNode('GET /api/users'))
    fireEvent.doubleClick(screen.getByText('请求'))
    const input = screen.getByTestId('workflow-node-name-input')
    expect(input).toHaveValue('')
    expect(input).toHaveAttribute('placeholder', '请求')
  })

  it('外部重命名请求（右键菜单 / F2）：进入编辑态并聚焦全选', () => {
    renderCard(
      { ...requestNode('GET /api/users'), name: '登录' },
      { renameRequest: { nodeId: 'n1', seq: 1 } },
    )
    const input = screen.getByTestId('workflow-node-name-input') as HTMLInputElement
    expect(input).toHaveFocus()
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe('登录'.length)
  })

  it('重命名请求只命中目标节点：其他节点不进入编辑态', () => {
    renderCard(
      { ...requestNode('GET /api/users'), name: '登录' },
      { renameRequest: { nodeId: 'other', seq: 1 } },
    )
    expect(screen.queryByTestId('workflow-node-name-input')).not.toBeInTheDocument()
    expect(screen.getByText('登录')).toBeInTheDocument()
  })
})

describe('node-card：断言节点内联规则编辑面', () => {
  function assertNode(ruleCount: number): WorkflowNode {
    return {
      id: 'n1',
      name: '',
      position: { x: 0, y: 0 },
      config: {
        type: 'assert',
        rules: Array.from({ length: ruleCount }, () => ({ type: 'statusCode', expected: '200' })),
      },
    }
  }

  it('规则行直接铺在节点内（行数跟随 config）', () => {
    renderCard(assertNode(3))
    expect(screen.getByTestId('workflow-assert-editor')).toBeInTheDocument()
    expect(screen.getAllByTestId('workflow-assert-rule-row')).toHaveLength(3)
    expect(screen.getByRole('button', { name: '添加规则' })).toBeInTheDocument()
  })

  it('空规则集仍显示添加入口', () => {
    renderCard(assertNode(0))
    expect(screen.queryAllByTestId('workflow-assert-rule-row')).toHaveLength(0)
    expect(screen.getByRole('button', { name: '添加规则' })).toBeInTheDocument()
  })
})

describe('node-card：条件节点内联分支编辑面与执行摘要', () => {
  function conditionNode(): WorkflowNode {
    return {
      id: 'n1',
      name: '',
      position: { x: 0, y: 0 },
      config: {
        type: 'condition',
        branches: [
          { id: 'b1', expression: '{{login_status}} == 200' },
          { id: 'b2', expression: '' },
        ],
      },
    }
  }

  it('分支表达式是可编辑输入（空分支显占位示例）', () => {
    renderCard(conditionNode())
    expect(screen.getByTestId('workflow-node-condition')).toBeDefined()
    expect(screen.getByDisplayValue('{{login_status}} == 200')).toBeInTheDocument()
    // 每个分支行都带同一占位示例（填入的分支行也保留占位）
    expect(screen.getAllByPlaceholderText('如 {{登录.status}} == 200')).toHaveLength(2)
    expect(screen.getByRole('button', { name: '添加分支' })).toBeInTheDocument()
  })

  it('引用引导说明 status / body 字段集', () => {
    renderCard(conditionNode())
    expect(
      screen.getByText(
        '可用 {{节点名.status}}（状态码）与 {{节点名.body}}（响应原文）引用可达上游的请求节点。',
      ),
    ).toBeInTheDocument()
  })

  it('执行通过后附加「✓ 表达式 → 分支」摘要行（Rust 产物原文）', () => {
    useWorkflowExecutionStore.setState({
      executions: {
        wf1: {
          executionId: 'e1',
          workflowId: 'wf1',
          status: 'passed',
          nodes: {
            n1: {
              status: 'passed',
              output: '✓ {{login_status}} == 200 → b1',
            },
          },
          order: ['n1'],
          activeEdgeIds: new Set(),
        },
      },
      executionIndex: { e1: 'wf1' },
    })
    renderCard(conditionNode())
    expect(screen.getByText('✓ {{login_status}} == 200 → b1')).toBeInTheDocument()
  })
})

describe('node-card：Join / 延时 / 重试配置面', () => {
  it('Join 内联汇聚模式选择', () => {
    renderCard({
      id: 'n1',
      name: '',
      position: { x: 0, y: 0 },
      config: { type: 'join', mode: 'any' },
    })
    expect(screen.getByTestId('workflow-join-editor')).toBeInTheDocument()
    expect(screen.getByText('汇聚模式')).toBeInTheDocument()
  })

  it('延时内联等待时长输入（值来自 config）', () => {
    renderCard({
      id: 'n1',
      name: '',
      position: { x: 0, y: 0 },
      config: { type: 'delay', durationMs: 500 },
    })
    expect(screen.getByTestId('workflow-delay-editor')).toBeInTheDocument()
    expect(screen.getByLabelText('等待时长（毫秒）')).toHaveValue(500)
  })

  it('重试内联次数与间隔输入（值来自 config）', () => {
    renderCard({
      id: 'n1',
      name: '',
      position: { x: 0, y: 0 },
      config: { type: 'retry', maxAttempts: 3, intervalMs: 1000 },
    })
    expect(screen.getByTestId('workflow-retry-editor')).toBeInTheDocument()
    expect(screen.getByLabelText('最大重试次数')).toHaveValue(3)
    expect(screen.getByLabelText('重试间隔（毫秒）')).toHaveValue(1000)
  })
})

describe('node-card：提取写回分支开关', () => {
  it('存变量开关经更新通道落 config.writeback.enabled', () => {
    const onUpdateNode = vi.fn()
    renderCard(
      {
        id: 'n1',
        name: '',
        position: { x: 0, y: 0 },
        config: {
          type: 'extract',
          source: 'jsonPath',
          rules: [{ path: '$.token', name: 'token' }],
          writeback: {
            enabled: false,
            productPath: '',
            key: '',
            categoryName: null,
            secret: true,
          },
        },
      },
      { onUpdateNode },
    )
    const switches = screen
      .getByTestId('workflow-extract-editor')
      .querySelectorAll('[data-slot="switch"]')
    fireEvent.click(switches[0]!)
    expect(onUpdateNode).toHaveBeenCalledWith(
      'n1',
      expect.objectContaining({
        config: expect.objectContaining({
          writeback: expect.objectContaining({
            enabled: true,
            // 开启时写回值缺省取产物名、键缺省取值尾段（单值默认赋单值）
            productPath: 'token',
            key: 'token',
          }),
        }),
      }),
    )
  })
})
