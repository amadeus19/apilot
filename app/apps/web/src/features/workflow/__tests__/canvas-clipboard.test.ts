import { beforeEach, describe, expect, it, vi } from 'vitest'

import { copySelection, pastedDuplicate } from '../canvas-clipboard'
import type { WorkflowEdge, WorkflowNode } from '../workflow-model'

/** 画布内节点组复制 / 粘贴纯函数：组内边收集、粘贴物全新身份与端点重映射。 */

let uuid = 0
vi.stubGlobal('crypto', {
  randomUUID: () => `uuid-${(uuid += 1)}`,
})

function requestNode(id: string, key: string | null): WorkflowNode {
  return {
    id,
    name: `节点${id}`,
    position: { x: 10, y: 20 },
    config: {
      type: 'request',
      endpointKey: key,
      query: [],
      pathParams: [],
      body: null,
      timeoutMs: null,
    },
  }
}

function edge(
  id: string,
  source: string,
  target: string,
  label: string | null = null,
): WorkflowEdge {
  return { id, source, target, label }
}

beforeEach(() => {
  uuid = 0
})

describe('copySelection：选中节点集 → 复制载荷', () => {
  it('只收两端都在选集内的边（跨选集边不进载荷——粘贴后端点会悬空）', () => {
    const nodes = [requestNode('a', 'GET /x'), requestNode('b', 'GET /y'), requestNode('c', null)]
    const edges = [edge('e1', 'a', 'b', 'b1'), edge('e2', 'b', 'c'), edge('e3', 'a', 'c')]
    const payload = copySelection(nodes, edges, new Set(['a', 'b']))
    expect(payload.nodes.map((node) => node.id)).toEqual(['a', 'b'])
    expect(payload.edges).toEqual([edge('e1', 'a', 'b', 'b1')])
  })

  it('空选集＝空载荷', () => {
    const payload = copySelection([requestNode('a', null)], [edge('e1', 'a', 'a')], new Set())
    expect(payload.nodes).toEqual([])
    expect(payload.edges).toEqual([])
  })
})

describe('pastedDuplicate：载荷 → 粘贴物', () => {
  it('节点与边全部换新身份、位置按偏移平移、配置与标注原样保留', () => {
    const payload = {
      nodes: [requestNode('a', 'GET /x'), requestNode('b', null)],
      edges: [edge('e1', 'a', 'b', 'DEFAULT')],
    }
    const made = pastedDuplicate(payload, { x: 40, y: 40 })
    expect(made.nodes.map((node) => node.id)).toEqual(['uuid-1', 'uuid-2'])
    // 与源身份零重叠
    const sourceIds = new Set([...payload.nodes.map((n) => n.id), payload.edges[0].id])
    for (const item of [...made.nodes.map((n) => n.id), ...made.edges.map((e) => e.id)]) {
      expect(sourceIds.has(item)).toBe(false)
    }
    // 位置平移；配置与边标注原样
    expect(made.nodes[0]?.position).toEqual({ x: 50, y: 60 })
    expect(made.nodes[0]?.config).toEqual(payload.nodes[0].config)
    expect(made.edges[0]?.label).toBe('DEFAULT')
  })

  it('边端点按节点 id 映射重写（指向粘贴物节点，不指回源）', () => {
    const payload = {
      nodes: [requestNode('a', null), requestNode('b', null)],
      edges: [edge('e1', 'a', 'b')],
    }
    const made = pastedDuplicate(payload, { x: 0, y: 0 })
    const newIds = made.nodes.map((node) => node.id)
    expect(made.edges[0]?.source).toBe(newIds[0])
    expect(made.edges[0]?.target).toBe(newIds[1])
  })

  it('同载荷连续粘贴两次产出互不相同的身份（各次独立重制）', () => {
    const payload = { nodes: [requestNode('a', null)], edges: [] }
    const first = pastedDuplicate(payload, { x: 40, y: 40 })
    const second = pastedDuplicate(payload, { x: 80, y: 80 })
    expect(first.nodes[0]?.id).not.toBe(second.nodes[0]?.id)
    expect(second.nodes[0]?.position).toEqual({ x: 90, y: 100 })
  })
})
