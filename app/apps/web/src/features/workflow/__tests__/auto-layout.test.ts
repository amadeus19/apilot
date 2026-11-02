import { describe, expect, it } from 'vitest'

import type { WorkflowFlowEdge, WorkflowFlowNode } from '../canvas-converter'
import { computeLayout, positionsFromLayout, toElkGraph } from '../canvas/auto-layout'

function flowNode(id: string, x: number, y: number, width?: number): WorkflowFlowNode {
  return {
    id,
    type: 'start',
    position: { x, y },
    data: {
      node: { id, name: id, position: { x, y }, config: { type: 'start' } },
    },
    ...(width != null ? { measured: { width, height: 36 } } : {}),
  } as WorkflowFlowNode
}

function flowEdge(id: string, source: string, target: string): WorkflowFlowEdge {
  return { id, source, target, data: { label: null } }
}

describe('toElkGraph：画布模型 → ELK 输入', () => {
  it('尺寸取 measured 就绪值，未就绪回落默认卡片盒', () => {
    const graph = toElkGraph(
      [flowNode('a', 0, 0, 200), flowNode('b', 10, 10)],
      [flowEdge('e1', 'a', 'b')],
    )
    expect(graph.children).toEqual([
      { id: 'a', width: 200, height: 36 },
      { id: 'b', width: 256, height: 36 },
    ])
    expect(graph.edges).toEqual([{ id: 'e1', sources: ['a'], targets: ['b'] }])
  })
})

describe('positionsFromLayout：ELK 结果 → 写回映射', () => {
  it('只收录带坐标的节点（缺坐标的行不参与写回）', () => {
    const positions = positionsFromLayout([
      { id: 'a', x: 12, y: 18 },
      { id: 'b', x: 248, y: 84 },
      { id: 'c' },
    ])
    expect(positions.size).toBe(2)
    expect(positions.get('a')).toEqual({ x: 12, y: 18 })
    expect(positions.get('c')).toBeUndefined()
  })

  it('结果缺省（ELK 异常返回）＝空表，画布保持原状', () => {
    expect(positionsFromLayout(undefined).size).toBe(0)
  })
})

describe('computeLayout：整图布局（真实 ELK）', () => {
  it('链形分层左→右单调；Condition 分支纵向分开；Parallel 同层水平展开、Join 汇聚在右', async () => {
    // 链头 → Condition（yes/no 两分支）→ 各自续接到并行分支 → Join 汇聚
    const nodes = [
      flowNode('start', 0, 0),
      flowNode('cond', 100, 0),
      flowNode('yes', 200, -100),
      flowNode('no', 200, 100),
      flowNode('p1', 300, -100),
      flowNode('p2', 300, 100),
      flowNode('join', 400, 0),
    ]
    const edges = [
      flowEdge('e1', 'start', 'cond'),
      flowEdge('e2', 'cond', 'yes'),
      flowEdge('e3', 'cond', 'no'),
      flowEdge('e4', 'yes', 'p1'),
      flowEdge('e5', 'no', 'p2'),
      flowEdge('e6', 'p1', 'join'),
      flowEdge('e7', 'p2', 'join'),
    ]
    const positions = await computeLayout(nodes, edges)
    expect(positions.size).toBe(nodes.length)
    const x = (id: string) => positions.get(id)?.x
    const y = (id: string) => positions.get(id)?.y

    // 每条边分层单调（target 在 source 右侧——layered 左→右的基本不变量）
    for (const edge of edges) {
      expect(x(edge.target), `${edge.source}→${edge.target}`).toBeGreaterThan(x(edge.source)!)
    }
    // Condition 两分支纵向分开（方向清晰，不叠在同一水平线）
    expect(y('yes')).not.toBe(y('no'))
    // 并行分支同层水平展开（同层 x 一致），Join 汇聚在更右层
    expect(x('p1')).toBe(x('p2'))
    expect(x('join')).toBeGreaterThan(x('p1')!)
  })

  it('空图＝空表（无动作可做）', async () => {
    expect((await computeLayout([], [])).size).toBe(0)
  })
})
