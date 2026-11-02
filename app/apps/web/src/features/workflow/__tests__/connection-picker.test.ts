import { describe, expect, it } from 'vitest'

import {
  connectEdgeLabel,
  connectionDirectionOf,
  filterConnectableKinds,
  planConnectionEdge,
  pointerClientPoint,
  tempConnectionBody,
  TEMP_NODE_TYPE,
} from '../canvas/connection-picker'
import { NODE_META, PALETTE_GROUPS } from '../canvas/node-meta'

/**
 * 连线末端节点选择框决策纯函数：方向判定、候选拓扑过滤（顺向排除开始、
 * 反向排除结束）、新边两端计划、条件分支标注规则、连线临时体（视图态）
 * 的两端与交互位、松手坐标提取。候选断言用集合差（结果＝原集去掉排除
 * 项），不硬编码 kind 类数——元数据增删 kind 时候选自然跟随。
 */

/** 节点元数据表现状的 kind 全集（动态取，不硬编码） */
const allKinds = Object.keys(NODE_META) as (keyof typeof NODE_META)[]

describe('connectionDirectionOf：拉线方向判定', () => {
  it('出口 handle 顺向、入口 handle 反向', () => {
    expect(connectionDirectionOf('source')).toBe('forward')
    expect(connectionDirectionOf('target')).toBe('backward')
  })
})

describe('filterConnectableKinds：候选拓扑过滤', () => {
  it('顺向排除开始、其余全出（含结束）', () => {
    const result = filterConnectableKinds(allKinds, 'forward')
    expect(result).not.toContain('start')
    expect(result).toContain('end')
    expect([...result].sort()).toEqual(allKinds.filter((kind) => kind !== 'start').sort())
  })

  it('反向排除结束、其余全出（含开始）', () => {
    const result = filterConnectableKinds(allKinds, 'backward')
    expect(result).not.toContain('end')
    expect(result).toContain('start')
    expect([...result].sort()).toEqual(allKinds.filter((kind) => kind !== 'end').sort())
  })

  it('面板五组按组过滤：流程组顺向只剩结束、反向只剩开始，其余组只去排除项', () => {
    const forwardGroups = PALETTE_GROUPS.map((group) => ({
      id: group.id,
      kinds: filterConnectableKinds(group.kinds, 'forward'),
    }))
    const backwardGroups = PALETTE_GROUPS.map((group) => ({
      id: group.id,
      kinds: filterConnectableKinds(group.kinds, 'backward'),
    }))
    const flowForward = forwardGroups.find((group) => group.id === 'flow')
    expect(flowForward?.kinds).toEqual(['end'])
    const flowBackward = backwardGroups.find((group) => group.id === 'flow')
    expect(flowBackward?.kinds).toEqual(['start'])
    // 非流程组不含终端节点，过滤前后集合不变
    for (const group of PALETTE_GROUPS.filter((candidate) => candidate.id !== 'flow')) {
      const forward = forwardGroups.find((candidate) => candidate.id === group.id)
      expect(forward?.kinds).toEqual([...group.kinds])
      const backward = backwardGroups.find((candidate) => candidate.id === group.id)
      expect(backward?.kinds).toEqual([...group.kinds])
    }
  })
})

describe('planConnectionEdge：新边两端计划', () => {
  it('顺向：拉线起点在 source 端（携带起点 Handle id），新节点是 target', () => {
    expect(planConnectionEdge('forward', 'from-1', 'b1', 'new-1')).toEqual({
      sourceId: 'from-1',
      targetId: 'new-1',
      sourceHandleId: 'b1',
    })
  })

  it('顺向无 Handle id：sourceHandleId 为 null（非条件分支拉线）', () => {
    expect(planConnectionEdge('forward', 'from-1', null, 'new-1')).toMatchObject({
      sourceId: 'from-1',
      targetId: 'new-1',
      sourceHandleId: null,
    })
  })

  it('反向：新节点是 source（无 Handle id），拉线起点是 target', () => {
    expect(planConnectionEdge('backward', 'from-1', 'in', 'new-1')).toEqual({
      sourceId: 'new-1',
      targetId: 'from-1',
      sourceHandleId: null,
    })
  })
})

describe('connectEdgeLabel：条件分支标注规则', () => {
  it('条件节点出边 label＝source Handle id（分支 id 或 DEFAULT）', () => {
    expect(connectEdgeLabel('condition', 'b1')).toBe('b1')
    expect(connectEdgeLabel('condition', 'DEFAULT')).toBe('DEFAULT')
  })

  it('条件节点无 Handle id 与非条件节点一律不带标注', () => {
    expect(connectEdgeLabel('condition', null)).toBeNull()
    expect(connectEdgeLabel('request', 'b1')).toBeNull()
    expect(connectEdgeLabel('start', null)).toBeNull()
  })
})

describe('tempConnectionBody：连线临时体（视图态）', () => {
  const position = { x: 100, y: 80 }
  const base = {
    fromNodeId: 'from-1',
    tempNodeId: 'temp-1',
    edgeId: 'edge-1',
    position,
  }

  it('占位节点落给定点、不参与任何画布交互', () => {
    const body = tempConnectionBody({ ...base, direction: 'forward', fromHandleId: null })
    expect(body.node.id).toBe('temp-1')
    expect(body.node.type).toBe(TEMP_NODE_TYPE)
    expect(body.node.position).toEqual(position)
    expect(body.node.draggable).toBe(false)
    expect(body.node.selectable).toBe(false)
    expect(body.node.deletable).toBe(false)
    expect(body.node.connectable).toBe(false)
  })

  it('顺向：临时边从起点 handle（source 端）接到占位节点（target 端）', () => {
    const body = tempConnectionBody({ ...base, direction: 'forward', fromHandleId: 'b1' })
    expect(body.edge.id).toBe('edge-1')
    expect(body.edge.source).toBe('from-1')
    expect(body.edge.sourceHandle).toBe('b1')
    expect(body.edge.target).toBe('temp-1')
    expect(body.edge.data?.label).toBeNull()
  })

  it('反向：临时边从占位节点（source 端）接到起点（target 端）', () => {
    const body = tempConnectionBody({ ...base, direction: 'backward', fromHandleId: null })
    expect(body.edge.source).toBe('temp-1')
    expect(body.edge.sourceHandle).toBeNull()
    expect(body.edge.target).toBe('from-1')
    expect(body.edge.data?.label).toBeNull()
  })

  it('临时边两端＝两端计划以占位节点 id 代入「新节点」位的产出（转正仅换身份）', () => {
    for (const direction of ['forward', 'backward'] as const) {
      const body = tempConnectionBody({ ...base, direction, fromHandleId: 'b1' })
      const plan = planConnectionEdge(direction, 'from-1', 'b1', 'temp-1')
      expect(body.edge.source).toBe(plan.sourceId)
      expect(body.edge.target).toBe(plan.targetId)
      expect(body.edge.sourceHandle).toBe(plan.sourceHandleId)
    }
  })
})

describe('pointerClientPoint：松手指针坐标', () => {
  it('鼠标事件直读 client 坐标', () => {
    const event = new MouseEvent('mouseup', { clientX: 12, clientY: 34 })
    expect(pointerClientPoint(event)).toEqual({ x: 12, y: 34 })
  })

  it('触摸事件读 changedTouches（松手时 touches 已清空）', () => {
    const touch = { clientX: 56, clientY: 78 }
    const event = { changedTouches: [touch] } as unknown as TouchEvent
    expect(pointerClientPoint(event)).toEqual({ x: 56, y: 78 })
  })
})
