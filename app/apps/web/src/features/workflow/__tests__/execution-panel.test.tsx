import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'

// IPC 不进单测：面板挂载播种与 store 取消联动都换替身
vi.mock('../workflow-api', () => ({
  workflowLastExecution: vi.fn().mockResolvedValue(null),
  workflowCancel: vi.fn().mockResolvedValue(true),
}))

import { useWorkflowExecutionStore, type NodeExecutionUiState } from '../execution.store'
import { ExecutionPanel } from '../canvas/execution-panel'

/**
 * 执行面板请求 / 响应明细面与写回清单面：请求节点行展开区呈现「状态码＋
 * 方法＋URL＋响应摘要」（明细只经终态记录播种，Rust 侧已掩码、前端纯呈现）；
 * 存变量行展开写回清单（键＋目标分类＋掩码值）并随块提示「写回不等于激活」
 * 的中性引导；展开条件涵盖有明细或写回的行（不只 failed 或有断言）；无明细
 * 行点击仅定位不展开。
 */

const NODE_NAMES = new Map([
  ['login', '登录'],
  ['ping', '探测'],
])

function seedSlot(nodes: Record<string, NodeExecutionUiState>, order: readonly string[]) {
  useWorkflowExecutionStore.setState({
    executions: {
      wf1: {
        executionId: 'e1',
        workflowId: 'wf1',
        status: 'passed',
        nodes,
        order: [...order],
        activeEdgeIds: new Set(),
      },
    },
    executionIndex: { e1: 'wf1' },
  })
}

function renderPanel(onLocate = vi.fn()) {
  render(<ExecutionPanel workflowId="wf1" nodeNames={NODE_NAMES} onLocate={onLocate} />)
  return onLocate
}

beforeEach(() => {
  useWorkflowExecutionStore.setState({ executions: {}, executionIndex: {} })
})

describe('execution-panel：请求 / 响应明细展开区', () => {
  it('passed 行有明细即可展开：状态码＋方法＋URL＋响应摘要齐备，点击同时定位', async () => {
    const user = userEvent.setup()
    seedSlot(
      {
        login: {
          status: 'passed',
          durationMs: 120,
          request: { method: 'POST', url: 'https://api.example.com/login?token=***' },
          response: { status: 200, body: '{"code":***}' },
        },
      },
      ['login'],
    )
    const onLocate = renderPanel()
    await user.click(screen.getByText('登录'))
    const detail = screen.getByTestId('workflow-execution-request-detail')
    expect(screen.getByText('200')).toBeInTheDocument()
    expect(screen.getByText('POST https://api.example.com/login?token=***')).toBeInTheDocument()
    expect(detail).toHaveTextContent('{"code":***}')
    expect(onLocate).toHaveBeenCalledWith('login')
  })

  it('非 2xx 状态码走警示色（500 视觉可区分于 200）', async () => {
    const user = userEvent.setup()
    seedSlot(
      {
        login: {
          status: 'passed',
          request: { method: 'POST', url: 'https://api.example.com/login' },
          response: { status: 500, body: '{"code":***}' },
        },
      },
      ['login'],
    )
    renderPanel()
    await user.click(screen.getByText('登录'))
    expect(screen.getByText('500').className).toContain('text-destructive')
  })

  it('无明细的 passed 行点击仅定位，不展开 detail 容器', async () => {
    const user = userEvent.setup()
    seedSlot({ ping: { status: 'passed', durationMs: 5 } }, ['ping'])
    const onLocate = renderPanel()
    await user.click(screen.getByText('探测'))
    expect(onLocate).toHaveBeenCalledWith('ping')
    expect(screen.queryByTestId('workflow-execution-row-detail')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workflow-execution-writebacks')).not.toBeInTheDocument()
  })

  it('传输失败行：错误详情与仅有的请求明细并列，无状态码', async () => {
    const user = userEvent.setup()
    seedSlot(
      {
        login: {
          status: 'failed',
          errorCode: 'HTTP_REQUEST_FAILED',
          errorMessage: 'connection refused',
          request: { method: 'POST', url: 'https://api.example.com/login' },
        },
      },
      ['login'],
    )
    renderPanel()
    await user.click(screen.getByText('登录'))
    const detail = screen.getByTestId('workflow-execution-row-detail')
    expect(detail).toHaveTextContent('connection refused')
    expect(screen.getByTestId('workflow-execution-request-detail')).toHaveTextContent(
      'POST https://api.example.com/login',
    )
    expect(detail.querySelector('.tabular-nums')).toBeNull()
  })
})

describe('execution-panel：写回清单与激活引导', () => {
  it('passed 行有写回清单即可展开：逐条键＋目标分类＋掩码值，激活引导随块出现一次', async () => {
    const user = userEvent.setup()
    seedSlot(
      {
        login: {
          status: 'passed',
          durationMs: 40,
          writebacks: [
            { key: 'token', categoryName: '登录态', secret: true, value: '***' },
            { key: 'userId', categoryName: '登录态', secret: false, value: '***' },
          ],
        },
      },
      ['login'],
    )
    const onLocate = renderPanel()
    await user.click(screen.getByText('登录'))
    const block = screen.getByTestId('workflow-execution-writebacks')
    expect(block).toHaveTextContent('token')
    expect(block).toHaveTextContent('写入分类「登录态」· 值 ***')
    expect(block).toHaveTextContent('userId')
    expect(within(block).getAllByText(/写回不会自动激活分类/)).toHaveLength(1)
    expect(onLocate).toHaveBeenCalledWith('login')
  })

  it('写回行不携带失败与断言：引导为中性措辞，不冒充「未激活」判定', async () => {
    const user = userEvent.setup()
    seedSlot(
      {
        login: {
          status: 'passed',
          writebacks: [{ key: 'token', categoryName: '登录态', secret: true, value: '***' }],
        },
      },
      ['login'],
    )
    renderPanel()
    await user.click(screen.getByText('登录'))
    const block = screen.getByTestId('workflow-execution-writebacks')
    expect(within(block).queryAllByText(/未激活/)).toHaveLength(0)
    expect(within(block).getAllByText(/请到变量视图激活目标分类/)).toHaveLength(1)
  })
})
