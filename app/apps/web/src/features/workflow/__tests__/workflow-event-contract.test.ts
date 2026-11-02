import { describe, expect, it } from 'vitest'

import contract from '@/test/fixtures/workflow-event-contract.json'

import { reduceExecutionEvent, type WorkflowExecutionUiState } from '../execution.store'
import {
  WORKFLOW_EXECUTION_EVENT_KINDS,
  type WorkflowExecutionEvent,
  type WorkflowExecutionEventKind,
} from '../workflow-api'

/**
 * 工作流执行事件契约夹具：与 Rust `services/workflow_engine/events.rs` 的
 * 契约测试共享同一份 `src/test/fixtures/workflow-event-contract.json`
 * （Rust 侧 include_str! 引用）——任一端改事件词或字段键集，另一端立红。
 * 本文件钉住前端手写镜像的两个面：事件词常量数组与夹具集合相等（Rust 侧
 * 已把逐变体序列化 tag 对夹具）；夹具每条样例经 reduceExecutionEvent 归约
 * 落入正确 UI 态（终态词按对应表、节点字段按样例）——字段漂移在此现形。
 */

/**
 * 类型级双向对账：联合多词而数组漏登、或数组多词而联合缺席，两侧 Exclude
 * 之一非 never，本别名解析为 never → 下方赋值点编译失败（常量上的
 * `satisfies` 只钉数组 ⊆ 联合这一向，反向由此补齐）。
 */
type EventKindsExact = [
  Exclude<WorkflowExecutionEvent['event'], WorkflowExecutionEventKind>,
] extends [never]
  ? [Exclude<WorkflowExecutionEventKind, WorkflowExecutionEvent['event']>] extends [never]
    ? true
    : never
  : never
const eventKindsExact: EventKindsExact = true

type ReduceState = Parameters<typeof reduceExecutionEvent>[0]

/** 夹具样例（宽松键集；收窄前按夹具自身声明逐键自检） */
type FixtureSample = Record<string, unknown>

const requiredKeys: Readonly<Record<string, readonly string[]>> = contract.requiredKeys
const optionalKeys: Readonly<Record<string, readonly string[]>> = contract.optionalKeys
const statusMap: Readonly<Record<string, string>> = contract.statusMap
const samples: readonly FixtureSample[] = contract.samples

const EVENT_KIND_SET: ReadonlySet<string> = new Set(WORKFLOW_EXECUTION_EVENT_KINDS)
/** 样例元数据键（仅夹具侧标注，不属事件键集） */
const SAMPLE_META_KEYS: ReadonlySet<string> = new Set(['name'])

function sampleName(sample: FixtureSample): string {
  return typeof sample.name === 'string' ? sample.name : '<未命名样例>'
}

function eventKeys(sample: FixtureSample): string[] {
  return Object.keys(sample).filter((key) => !SAMPLE_META_KEYS.has(key))
}

/**
 * 样例 → 事件收窄：event 词须在常量数组内、键集 ⊆ 夹具必有 ∪ 可选声明；
 * 违例抛错（夹具结构自检），通过即视为合法事件（不用 any 的边界收窄）。
 */
function toEvent(sample: FixtureSample): WorkflowExecutionEvent {
  const event = sample.event
  if (typeof event !== 'string' || !EVENT_KIND_SET.has(event)) {
    throw new Error(`样例「${sampleName(sample)}」event 词未知：${String(event)}`)
  }
  const declared = new Set([...(requiredKeys[event] ?? []), ...(optionalKeys[event] ?? [])])
  for (const key of eventKeys(sample)) {
    if (!declared.has(key)) {
      throw new Error(`样例「${sampleName(sample)}」键 ${key} 不在 ${event} 的必有 ∪ 可选声明内`)
    }
  }
  return sample as WorkflowExecutionEvent
}

/** 全部样例收窄为事件（夹具结构违例时整文件立红，错误信息指明样例与键） */
const events: readonly WorkflowExecutionEvent[] = samples.map(toEvent)

/** 建槽样例（其余样例按其 executionId 路由进槽） */
function startedSample(): Extract<WorkflowExecutionEvent, { event: 'workflow.started' }> {
  const started = events.find((event) => event.event === 'workflow.started')
  if (!started || started.event !== 'workflow.started') {
    throw new Error('夹具缺 workflow.started 建槽样例')
  }
  return started
}

function statusOf(kind: WorkflowExecutionEventKind): string {
  const status = statusMap[kind]
  if (status === undefined) throw new Error(`事件词 ${kind} 缺终态对应`)
  return status
}

/** 同节点的前驱 node.queued 样例（node.started 归约要求前态 queued） */
function queuedSampleFor(nodeId: string): WorkflowExecutionEvent | undefined {
  return events.find(
    (candidate) => candidate.event === 'node.queued' && candidate.nodeId === nodeId,
  )
}

function slotOf(state: ReduceState, workflowId: string): WorkflowExecutionUiState {
  const slot = state.executions[workflowId]
  if (!slot) throw new Error('执行槽位缺失')
  return slot
}

function nodeOf(slot: WorkflowExecutionUiState, nodeId: string) {
  const node = slot.nodes[nodeId]
  if (!node) throw new Error(`节点态缺失：${nodeId}`)
  return node
}

describe('事件词对账（常量数组 ⇄ 判别值联合 ⇄ 夹具）', () => {
  it('常量数组与判别值联合类型级双向相等（编译期结论；本断言为运行期消费点）', () => {
    expect(eventKindsExact).toBe(true)
  })

  it('常量数组与夹具事件词集合相等（成员是契约，顺序不是）且无重复', () => {
    expect(new Set(WORKFLOW_EXECUTION_EVENT_KINDS).size).toBe(WORKFLOW_EXECUTION_EVENT_KINDS.length)
    expect([...WORKFLOW_EXECUTION_EVENT_KINDS].sort()).toEqual([...contract.events].sort())
  })

  it('夹具结构自检：每事件词 ≥1 样例；可选键词两态样例齐备；终态对应表键 ⊆ 全集', () => {
    const covered = new Set<string>(events.map((event) => event.event))
    for (const kind of contract.events) {
      expect(covered.has(kind), `事件词 ${kind} 无样例`).toBe(true)
    }
    for (const [kind, optional] of Object.entries(optionalKeys)) {
      if (optional.length === 0) continue
      const carriedSets = samples
        .filter((sample) => sample.event === kind)
        .map((sample) => eventKeys(sample).filter((key) => optional.includes(key)))
      expect(
        carriedSets.some((set) => set.length === 0),
        `${kind} 缺可选键缺省态样例`,
      ).toBe(true)
      expect(
        carriedSets.some((set) => set.length === optional.length),
        `${kind} 缺可选键全携带态样例`,
      ).toBe(true)
    }
    for (const kind of Object.keys(statusMap)) {
      expect(contract.events, `对应表事件词 ${kind} 不在全集`).toContain(kind)
    }
  })

  it('样例共享建槽样例的 executionId（归约路由前提）；node.started 有同节点的 node.queued 前驱', () => {
    const started = startedSample()
    for (const event of events) {
      expect(event.executionId, `样例 ${event.event}`).toBe(started.executionId)
      if (event.event !== 'node.started') continue
      const queued = queuedSampleFor(event.nodeId)
      expect(queued !== undefined, `node.started(${event.nodeId}) 缺同节点 node.queued 样例`).toBe(
        true,
      )
    }
  })
})

describe('夹具样例归约（reduceExecutionEvent 手写镜像落位）', () => {
  const started = startedSample()
  /** 新归约态：以夹具 workflow.started 样例建立执行槽位（其余样例按其 executionId 路由） */
  const stateWithSlot = (): ReduceState =>
    reduceExecutionEvent({ executions: {}, executionIndex: {} }, started)

  it('workflow.started 样例建槽：running 且 executionId 登记进索引', () => {
    const state = stateWithSlot()
    const slot = slotOf(state, started.workflowId)
    expect(slot.status).toBe('running')
    expect(slot.executionId).toBe(started.executionId)
    expect(state.executionIndex[started.executionId]).toBe(started.workflowId)
  })

  for (const sample of samples) {
    const event = toEvent(sample)
    if (event.event === 'workflow.started') continue
    it(`样例「${sampleName(sample)}」归约落位`, () => {
      let state = stateWithSlot()
      if (event.event === 'node.started') {
        // node.started 要求前态 queued：先喂同节点的 node.queued 样例
        const queued = queuedSampleFor(event.nodeId)
        if (!queued) throw new Error('缺 node.queued 前驱样例')
        state = reduceExecutionEvent(state, queued)
      }
      state = reduceExecutionEvent(state, event)
      const slot = slotOf(state, started.workflowId)
      switch (event.event) {
        case 'node.queued':
          expect(nodeOf(slot, event.nodeId).status).toBe('queued')
          expect(slot.order).toContain(event.nodeId)
          break
        case 'node.started':
          expect(nodeOf(slot, event.nodeId).status).toBe('running')
          break
        case 'node.completed': {
          const node = nodeOf(slot, event.nodeId)
          expect(node.status).toBe(statusOf(event.event))
          expect(node.durationMs).toBe(event.durationMs)
          expect(node.output).toBe(event.output)
          expect(node.assertions).toEqual(event.assertions)
          break
        }
        case 'node.failed': {
          const node = nodeOf(slot, event.nodeId)
          expect(node.status).toBe(statusOf(event.event))
          expect(node.errorCode).toBe(event.errorCode)
          expect(node.errorMessage).toBe(event.errorMessage)
          expect(node.assertions).toEqual(event.assertions)
          break
        }
        case 'node.cancelled':
        case 'node.skipped':
          expect(nodeOf(slot, event.nodeId).status).toBe(statusOf(event.event))
          break
        case 'edge.activated':
          expect(slot.activeEdgeIds.has(event.edgeId)).toBe(true)
          break
        case 'workflow.completed':
        case 'workflow.cancelled':
          expect(slot.status).toBe(statusOf(event.event))
          expect(slot.durationMs).toBe(event.durationMs)
          // 终态即停：活跃边清空、事件索引摘除
          expect(slot.activeEdgeIds.size).toBe(0)
          expect(state.executionIndex[event.executionId]).toBeUndefined()
          break
        case 'workflow.failed':
          expect(slot.status).toBe(statusOf(event.event))
          expect(slot.durationMs).toBe(event.durationMs)
          expect(slot.errorCode).toBe(event.errorCode)
          expect(slot.errorMessage).toBe(event.errorMessage)
          expect(state.executionIndex[event.executionId]).toBeUndefined()
          break
      }
    })
  }
})
