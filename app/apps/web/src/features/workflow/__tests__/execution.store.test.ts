import { beforeEach, describe, expect, it, vi } from 'vitest'

// workflowCancel 换替身：dispose 的取消联动直接断言调用（IPC 不进单测）
vi.mock('../workflow-api', () => ({
  workflowCancel: vi.fn().mockResolvedValue(true),
}))

import { workflowCancel } from '../workflow-api'
import {
  executionProgress,
  reduceExecutionEvent,
  useWorkflowExecutionStore,
  type WorkflowExecutionUiState,
} from '../execution.store'
import type { WorkflowExecutionDto } from '../workflow-api'

/** 空槽基准（归约纯函数测试的起点） */
function emptyState() {
  return { executions: {}, executionIndex: {} }
}

/** 已登记在途执行的槽位基准（executionId 已由 workflow.started 建立） */
function runningState(workflowId = 'wf1', executionId = 'e1') {
  return reduceExecutionEvent(emptyState(), {
    event: 'workflow.started',
    executionId,
    workflowId,
  })
}

function slotOf(
  state: ReturnType<typeof reduceExecutionEvent>,
  workflowId = 'wf1',
): WorkflowExecutionUiState {
  const slot = state.executions[workflowId]
  if (!slot) throw new Error('执行槽位缺失')
  return slot
}

beforeEach(() => {
  useWorkflowExecutionStore.setState({ executions: {}, executionIndex: {} })
  vi.clearAllMocks()
})

describe('reduceExecutionEvent 事件流归约', () => {
  it('串行链完整事件流：节点逐步推进、活跃边随终态清空（动画即停）', () => {
    let state = runningState('wf1', 'e1')
    state = reduceExecutionEvent(state, { event: 'node.queued', executionId: 'e1', nodeId: 'a' })
    state = reduceExecutionEvent(state, { event: 'node.started', executionId: 'e1', nodeId: 'a' })
    expect(slotOf(state).nodes.a?.status).toBe('running')
    state = reduceExecutionEvent(state, {
      event: 'node.completed',
      executionId: 'e1',
      nodeId: 'a',
      durationMs: 120,
      output: '***',
    })
    state = reduceExecutionEvent(state, {
      event: 'edge.activated',
      executionId: 'e1',
      edgeId: 'e0',
    })
    expect(slotOf(state).activeEdgeIds.has('e0')).toBe(true)
    expect(slotOf(state).nodes.a).toMatchObject({
      status: 'passed',
      durationMs: 120,
      output: '***',
    })
    state = reduceExecutionEvent(state, { event: 'node.queued', executionId: 'e1', nodeId: 'b' })
    expect(slotOf(state).order).toEqual(['a', 'b'])

    state = reduceExecutionEvent(state, {
      event: 'workflow.completed',
      executionId: 'e1',
      workflowId: 'wf1',
      durationMs: 300,
    })
    const slot = slotOf(state)
    expect(slot.status).toBe('passed')
    expect(slot.durationMs).toBe(300)
    expect(slot.activeEdgeIds.size).toBe(0)
    // 终态即摘除事件索引（防长会话累积）
    expect(state.executionIndex.e1).toBeUndefined()
  })

  it('失败链：失败节点带错误详情、工作流 failed', () => {
    let state = runningState()
    state = reduceExecutionEvent(state, { event: 'node.started', executionId: 'e1', nodeId: 'a' })
    state = reduceExecutionEvent(state, {
      event: 'node.failed',
      executionId: 'e1',
      nodeId: 'a',
      errorCode: 'HTTP_REQUEST_FAILED',
      errorMessage: 'connection refused',
    })
    expect(slotOf(state).nodes.a).toMatchObject({
      status: 'failed',
      errorCode: 'HTTP_REQUEST_FAILED',
      errorMessage: 'connection refused',
    })
    state = reduceExecutionEvent(state, { event: 'node.skipped', executionId: 'e1', nodeId: 'b' })
    expect(slotOf(state).nodes.b?.status).toBe('skipped')
    state = reduceExecutionEvent(state, {
      event: 'workflow.failed',
      executionId: 'e1',
      workflowId: 'wf1',
      durationMs: 50,
      errorCode: 'HTTP_REQUEST_FAILED',
      errorMessage: 'connection refused',
    })
    expect(slotOf(state).status).toBe('failed')
  })

  it('取消链：在途节点 cancelled、工作流 cancelled', () => {
    let state = runningState()
    state = reduceExecutionEvent(state, { event: 'node.started', executionId: 'e1', nodeId: 'a' })
    state = reduceExecutionEvent(state, { event: 'node.cancelled', executionId: 'e1', nodeId: 'a' })
    state = reduceExecutionEvent(state, {
      event: 'workflow.cancelled',
      executionId: 'e1',
      workflowId: 'wf1',
      durationMs: 10,
    })
    expect(slotOf(state).nodes.a?.status).toBe('cancelled')
    expect(slotOf(state).status).toBe('cancelled')
  })

  it('未知 executionId 的节点事件静默忽略', () => {
    const state = reduceExecutionEvent(runningState(), {
      event: 'node.started',
      executionId: 'ghost',
      nodeId: 'a',
    })
    expect(slotOf(state).nodes.a).toBeUndefined()
  })

  it('终态后迟到的节点事件不再进槽', () => {
    let state = runningState()
    state = reduceExecutionEvent(state, {
      event: 'workflow.completed',
      executionId: 'e1',
      workflowId: 'wf1',
      durationMs: 1,
    })
    state = reduceExecutionEvent(state, { event: 'node.started', executionId: 'e1', nodeId: 'a' })
    expect(slotOf(state).nodes.a).toBeUndefined()
  })

  it('新一轮 workflow.started 覆盖上一轮终态槽（最近一次口径）', () => {
    let state = runningState()
    state = reduceExecutionEvent(state, { event: 'node.queued', executionId: 'e1', nodeId: 'a' })
    state = reduceExecutionEvent(state, {
      event: 'workflow.completed',
      executionId: 'e1',
      workflowId: 'wf1',
      durationMs: 1,
    })
    state = reduceExecutionEvent(state, {
      event: 'workflow.started',
      executionId: 'e2',
      workflowId: 'wf1',
    })
    const slot = slotOf(state)
    expect(slot.executionId).toBe('e2')
    expect(slot.status).toBe('running')
    expect(slot.nodes).toEqual({})
    expect(state.executionIndex.e2).toBe('wf1')
  })

  it('断言节点 node.completed 携带的逐规则结果进节点态；非断言节点不落字段', () => {
    let state = runningState()
    const assertions = [
      { ruleKind: 'statusCode', path: null, expected: '200', actual: '200', passed: true },
      { ruleKind: 'jsonPath', path: '$.success', expected: 'true', actual: 'false', passed: false },
    ]
    state = reduceExecutionEvent(state, {
      event: 'node.completed',
      executionId: 'e1',
      nodeId: 'assert',
      durationMs: 5,
      output: 'assertions 1/2 passed',
      assertions,
    })
    expect(slotOf(state).nodes.assert?.assertions).toEqual(assertions)
    // 非断言节点（无 assertions 字段）不落断言态
    state = reduceExecutionEvent(state, {
      event: 'node.completed',
      executionId: 'e1',
      nodeId: 'login',
      durationMs: 9,
    })
    expect(slotOf(state).nodes.login?.assertions).toBeUndefined()
  })

  it('断言失败走 node.failed：逐规则结果随失败事件落节点态（实时明细）', () => {
    let state = runningState()
    const assertions = [
      { ruleKind: 'statusCode', path: null, expected: '500', actual: '200', passed: false },
      { ruleKind: 'exists', path: '$.token', expected: null, actual: '***', passed: true },
    ]
    state = reduceExecutionEvent(state, {
      event: 'node.failed',
      executionId: 'e1',
      nodeId: 'assert',
      errorCode: 'WORKFLOW_ASSERT_FAILED',
      errorMessage: '1 of 2 assertions failed',
      assertions,
    })
    expect(slotOf(state).nodes.assert).toMatchObject({
      status: 'failed',
      errorCode: 'WORKFLOW_ASSERT_FAILED',
    })
    expect(slotOf(state).nodes.assert?.assertions).toEqual(assertions)
  })

  it('事件归约不落请求 / 响应明细与写回清单（事件协议不携带，只经终态记录播种）', () => {
    let state = runningState()
    state = reduceExecutionEvent(state, {
      event: 'node.completed',
      executionId: 'e1',
      nodeId: 'login',
      durationMs: 80,
    })
    state = reduceExecutionEvent(state, {
      event: 'node.failed',
      executionId: 'e1',
      nodeId: 'call',
      errorCode: 'HTTP_REQUEST_FAILED',
      errorMessage: 'connection refused',
    })
    expect(slotOf(state).nodes.login?.request).toBeUndefined()
    expect(slotOf(state).nodes.login?.response).toBeUndefined()
    expect(slotOf(state).nodes.login?.writebacks).toBeUndefined()
    expect(slotOf(state).nodes.call?.request).toBeUndefined()
    expect(slotOf(state).nodes.call?.response).toBeUndefined()
    expect(slotOf(state).nodes.call?.writebacks).toBeUndefined()
  })
})

describe('executionProgress 进度计数（清单行 running 徽标面）', () => {
  it('乐观态 order 为空：无计数（null），徽标只显示「执行中」', () => {
    useWorkflowExecutionStore.getState().startLocal('wf1')
    const slot = useWorkflowExecutionStore.getState().executions.wf1
    if (!slot) throw new Error('乐观槽位缺失')
    expect(slot.status).toBe('running')
    expect(executionProgress(slot)).toBeNull()
  })

  it('计数随事件流实时推进：node.queued 增 M、节点终态增 N', () => {
    let state = runningState()
    state = reduceExecutionEvent(state, { event: 'node.queued', executionId: 'e1', nodeId: 'a' })
    expect(executionProgress(slotOf(state))).toEqual({ done: 0, total: 1 })
    // running 过程态不计完成
    state = reduceExecutionEvent(state, { event: 'node.started', executionId: 'e1', nodeId: 'a' })
    expect(executionProgress(slotOf(state))).toEqual({ done: 0, total: 1 })
    state = reduceExecutionEvent(state, {
      event: 'node.completed',
      executionId: 'e1',
      nodeId: 'a',
      durationMs: 5,
    })
    expect(executionProgress(slotOf(state))).toEqual({ done: 1, total: 1 })
    state = reduceExecutionEvent(state, { event: 'node.queued', executionId: 'e1', nodeId: 'b' })
    expect(executionProgress(slotOf(state))).toEqual({ done: 1, total: 2 })
  })

  it('终态槽位语义不变：failed / cancelled / skipped 节点同样计入 done，计数不回退', () => {
    let state = runningState()
    state = reduceExecutionEvent(state, { event: 'node.queued', executionId: 'e1', nodeId: 'a' })
    state = reduceExecutionEvent(state, { event: 'node.queued', executionId: 'e1', nodeId: 'b' })
    state = reduceExecutionEvent(state, {
      event: 'node.failed',
      executionId: 'e1',
      nodeId: 'a',
      errorCode: 'HTTP_REQUEST_FAILED',
      errorMessage: 'boom',
    })
    state = reduceExecutionEvent(state, { event: 'node.skipped', executionId: 'e1', nodeId: 'b' })
    state = reduceExecutionEvent(state, {
      event: 'workflow.failed',
      executionId: 'e1',
      workflowId: 'wf1',
      durationMs: 9,
      errorCode: 'HTTP_REQUEST_FAILED',
      errorMessage: 'boom',
    })
    expect(executionProgress(slotOf(state))).toEqual({ done: 2, total: 2 })
  })
})

describe('执行态 store 动作', () => {
  it('startLocal 乐观置 running，workflow.started 到达后对齐 executionId 且保留乐观槽', () => {
    useWorkflowExecutionStore.getState().startLocal('wf1')
    expect(useWorkflowExecutionStore.getState().executions.wf1?.status).toBe('running')
    useWorkflowExecutionStore.getState().applyEvent({
      event: 'workflow.started',
      executionId: 'e9',
      workflowId: 'wf1',
    })
    const slot = useWorkflowExecutionStore.getState().executions.wf1
    expect(slot?.executionId).toBe('e9')
    expect(slot?.status).toBe('running')
  })

  it('seedFromRecord 播种最近一次执行记录（回看面；order 沿库序）', () => {
    const record: WorkflowExecutionDto = {
      id: 'e1',
      workflowId: 'wf1',
      status: 'failed',
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:00:01Z',
      durationMs: 1000,
      errorCode: 'HTTP_REQUEST_FAILED',
      errorMessage: 'boom',
      nodes: [
        {
          nodeId: 'a',
          status: 'passed',
          startedAt: null,
          completedAt: null,
          durationMs: 100,
          errorCode: null,
          errorMessage: null,
          output: '***',
          request: { method: 'POST', url: 'https://api.example.com/login?token=***' },
          response: { status: 500, body: '{"code":***}' },
          assertions: [
            { ruleKind: 'statusCode', path: null, expected: '200', actual: '200', passed: true },
          ],
          writebacks: [{ key: 'token', categoryName: '登录态', secret: true, value: '***' }],
        },
        {
          nodeId: 'b',
          status: 'skipped',
          startedAt: null,
          completedAt: null,
          durationMs: null,
          errorCode: null,
          errorMessage: null,
        },
      ],
    }
    useWorkflowExecutionStore.getState().seedFromRecord(record)
    const slot = useWorkflowExecutionStore.getState().executions.wf1
    expect(slot?.status).toBe('failed')
    expect(slot?.order).toEqual(['a', 'b'])
    expect(slot?.nodes.a?.output).toBe('***')
    // 断言结果与写回清单随记录播种（回看面与实时面同构）
    expect(slot?.nodes.a?.assertions).toEqual(record.nodes[0]?.assertions)
    expect(slot?.nodes.a?.writebacks).toEqual(record.nodes[0]?.writebacks)
    // 请求 / 响应明细随记录播种（Rust 侧已掩码，前端原样透传）
    expect(slot?.nodes.a?.request).toEqual(record.nodes[0]?.request)
    expect(slot?.nodes.a?.response).toEqual(record.nodes[0]?.response)
    // 非请求节点（无明细字段）不落请求 / 响应 / 写回态
    expect(slot?.nodes.b?.request).toBeUndefined()
    expect(slot?.nodes.b?.response).toBeUndefined()
    expect(slot?.nodes.b?.writebacks).toBeUndefined()
  })

  it('在途执行优先于历史记录播种（事件流推进的面不被旧记录回滚）', () => {
    useWorkflowExecutionStore.getState().startLocal('wf1')
    useWorkflowExecutionStore.getState().seedFromRecord({
      id: 'e0',
      workflowId: 'wf1',
      status: 'failed',
      startedAt: '',
      completedAt: '',
      durationMs: null,
      errorCode: null,
      errorMessage: null,
      nodes: [],
    })
    expect(useWorkflowExecutionStore.getState().executions.wf1?.status).toBe('running')
    expect(useWorkflowExecutionStore.getState().executions.wf1?.executionId).toBe('')
  })

  it('dispose 取消在途执行并释放槽位与事件索引', () => {
    useWorkflowExecutionStore.getState().startLocal('wf1')
    useWorkflowExecutionStore.getState().applyEvent({
      event: 'workflow.started',
      executionId: 'e1',
      workflowId: 'wf1',
    })
    useWorkflowExecutionStore.getState().dispose('wf1')
    expect(workflowCancel).toHaveBeenCalledWith('wf1')
    expect(useWorkflowExecutionStore.getState().executions.wf1).toBeUndefined()
    expect(useWorkflowExecutionStore.getState().executionIndex.e1).toBeUndefined()
  })

  it('dispose 对终态槽位同样释放（取消幂等 no-op），未知槽位不触发取消', () => {
    useWorkflowExecutionStore.getState().seedFromRecord({
      id: 'e0',
      workflowId: 'wf1',
      status: 'passed',
      startedAt: '',
      completedAt: '',
      durationMs: null,
      errorCode: null,
      errorMessage: null,
      nodes: [],
    })
    useWorkflowExecutionStore.getState().dispose('wf1')
    expect(workflowCancel).toHaveBeenCalledTimes(1)
    expect(useWorkflowExecutionStore.getState().executions.wf1).toBeUndefined()

    vi.clearAllMocks()
    useWorkflowExecutionStore.getState().dispose('absent')
    expect(workflowCancel).not.toHaveBeenCalled()
  })

  it('pruneOrphans 只对无存活 Tab 的槽位 dispose（在途执行一并取消），存活的保留', () => {
    const store = useWorkflowExecutionStore.getState()
    store.startLocal('wf-stale')
    store.applyEvent({ event: 'workflow.started', executionId: 'es', workflowId: 'wf-stale' })
    store.startLocal('wf-alive')
    store.applyEvent({ event: 'workflow.started', executionId: 'ea', workflowId: 'wf-alive' })

    store.pruneOrphans(['wf-alive'])
    expect(workflowCancel).toHaveBeenCalledWith('wf-stale')
    expect(workflowCancel).not.toHaveBeenCalledWith('wf-alive')
    const executions = useWorkflowExecutionStore.getState().executions
    expect(executions['wf-stale']).toBeUndefined()
    expect(executions['wf-alive']?.status).toBe('running')
  })
})
