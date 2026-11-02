import { describe, expect, it } from 'vitest'

import type { WorkflowFlowEdge, WorkflowFlowNode } from '../canvas-converter'
import { projectConditionBranchLabels } from '../canvas/canvas-visual'
import { withEdgeExecutionAnimation } from '../canvas/execution-state'

/** 条件节点（流形态）：分支行集给定，位置与名字对投影无涉 */
function conditionNode(
  id: string,
  branches: Array<{ id: string; expression: string }>,
): WorkflowFlowNode {
  return {
    id,
    type: 'condition',
    position: { x: 0, y: 0 },
    data: {
      node: { id, name: '', position: { x: 0, y: 0 }, config: { type: 'condition', branches } },
    },
  }
}

/** 请求节点（非条件源样本）：带标注的出边不应被投影 */
function requestNode(id: string): WorkflowFlowNode {
  return {
    id,
    type: 'request',
    position: { x: 0, y: 0 },
    data: {
      node: {
        id,
        name: '',
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
    },
  }
}

function flowEdge(
  id: string,
  source: string,
  target: string,
  label: string | null,
): WorkflowFlowEdge {
  return { id, source, target, data: { label } }
}

describe('projectConditionBranchLabels：条件分支标注投影', () => {
  const nodes = [
    conditionNode('cond', [
      { id: 'b1', expression: '{{login.status}} == 200' },
      { id: 'b2', expression: '{{login.status}} >= 500' },
    ]),
    requestNode('req'),
  ]

  it('DEFAULT 锚投影为本地化文案（人话，非分支 id）', () => {
    const [projected] = projectConditionBranchLabels(
      [flowEdge('e1', 'cond', 'end', 'DEFAULT')],
      nodes,
      '默认',
    )
    expect(projected?.label).toBe('默认')
    // 投影样式：11px 弱化前景、画布平面色底衬（网点不从字下透出来）
    expect(projected?.labelStyle).toEqual({ fontSize: 11, fill: 'var(--muted-foreground)' })
    expect(projected?.labelBgStyle).toEqual({ fill: 'var(--canvas)' })
    // 领域锚不丢：data.label 保留原值（画布呈现修饰，不回写领域模型）
    expect(projected?.data?.label).toBe('DEFAULT')
  })

  it('命中分支投影为表达式摘要；未知锚回落锚原值兜底', () => {
    const projected = projectConditionBranchLabels(
      [flowEdge('e1', 'cond', 'yes', 'b1'), flowEdge('e2', 'cond', 'no', 'gone')],
      nodes,
      '默认',
    )
    expect(projected[0]?.label).toBe('{{login.status}} == 200')
    expect(projected[1]?.label).toBe('gone')
  })

  it('长表达式截断为摘要（完整表达式在条件节点内可读）', () => {
    const longNodes = [
      conditionNode('cond', [
        { id: 'b1', expression: '{{login.status}} == 200 && {{login.body}} != null' },
      ]),
    ]
    const [projected] = projectConditionBranchLabels(
      [flowEdge('e1', 'cond', 'yes', 'b1')],
      longNodes,
      '默认',
    )
    expect(projected?.label).toBe('{{login.status}} == 200…')
    // 领域锚不丢
    expect(projected?.data?.label).toBe('b1')
  })

  it('无标注边与非条件源边原样保留（同一对象引用，无渲染扰动）', () => {
    const plain = flowEdge('e1', 'cond', 'end', null)
    const nonCondition = flowEdge('e2', 'req', 'end', 'b1')
    const edges = [plain, nonCondition]
    const projected = projectConditionBranchLabels(edges, nodes, '默认')
    expect(projected[0]).toBe(plain)
    expect(projected[1]).toBe(nonCondition)
  })

  it('多边混合与乱序节点集：Map 索引按 id 命中源节点（非依赖数组序）', () => {
    const shuffled = [
      requestNode('req'),
      conditionNode('cond2', [{ id: 'x', expression: 'flag' }]),
      nodes[0]!,
    ]
    const edges = [
      flowEdge('e1', 'cond2', 'a', 'x'),
      flowEdge('e2', 'cond', 'b', 'DEFAULT'),
      flowEdge('e3', 'req', 'c', 'b2'),
      flowEdge('e4', 'ghost', 'd', 'DEFAULT'),
    ]
    const projected = projectConditionBranchLabels(edges, shuffled, '默认')
    expect(projected[0]?.label).toBe('flag')
    expect(projected[1]?.label).toBe('默认')
    // 非条件源与悬空源原样保留（同一对象引用；顶层 label 只在投影边出现）
    expect(projected[2]).toBe(edges[2])
    expect(projected[3]).toBe(edges[3])
  })
})

describe('withEdgeExecutionAnimation：运行中边执行视觉', () => {
  const edges = [flowEdge('e1', 'a', 'b', null), flowEdge('e2', 'b', 'c', null)]

  it('活跃边集非空：命中边加 animated，未命中边保持静态', () => {
    const styled = withEdgeExecutionAnimation(edges, new Set(['e2']))
    expect(styled[0]).toBe(edges[0])
    expect(styled[1]?.animated).toBe(true)
  })

  it('活跃边集为空或无执行槽位（undefined）：原样返回静态边集', () => {
    expect(withEdgeExecutionAnimation(edges, new Set())).toBe(edges)
    expect(withEdgeExecutionAnimation(edges, undefined)).toBe(edges)
  })
})
