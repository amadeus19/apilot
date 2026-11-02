import { describe, expect, it } from 'vitest'

import {
  findNodeAt,
  fromFlow,
  makeFlowEdge,
  makeNode,
  pruneEdgesForNodes,
  toFlowEdges,
  toFlowNodes,
  type WorkflowFlowEdge,
  type WorkflowFlowNode,
} from '../canvas-converter'
import {
  GRAPH_SCHEMA_VERSION,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNodeConfig,
} from '../workflow-model'

/** 全 10 类节点的样例图（与 Rust domain 测试同构，双端互证）。 */
function sampleGraph(): WorkflowGraph {
  const configs: WorkflowNodeConfig[] = [
    { type: 'start' },
    {
      type: 'request',
      endpointKey: 'post /api/auth/login',
      query: [{ name: 'verbose', value: 'true' }],
      pathParams: [{ name: 'id', value: '42' }],
      body: '{"user":"a"}',
      timeoutMs: 30000,
    },
    {
      type: 'extract',
      source: 'jsonPath',
      rules: [{ path: '$.data.token', name: 'token' }],
      writeback: {
        enabled: true,
        productPath: 'token',
        key: 'token',
        categoryName: '登录态',
        secret: true,
      },
    },
    { type: 'condition', branches: [{ id: 'b1', expression: '{{login.status}} == 200' }] },
    { type: 'parallel' },
    { type: 'join', mode: 'any' },
    { type: 'delay', durationMs: 500 },
    { type: 'retry', maxAttempts: 3, intervalMs: 1000 },
    {
      type: 'assert',
      rules: [
        { type: 'statusCode', expected: '200' },
        { type: 'jsonPath', path: '$.success', expected: 'true' },
        { type: 'exists', path: '$.data.id' },
        { type: 'contains', path: null, value: 'ok' },
      ],
    },
    { type: 'end' },
  ]
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    nodes: configs.map((config, index) => ({
      id: `n${index + 1}`,
      name: `节点${index + 1}`,
      position: { x: index * 120, y: (index % 2) * 40 },
      config,
    })),
    edges: [{ id: 'e1', source: 'n1', target: 'n2', label: 'b1' }],
  }
}

describe('canvas-converter：领域 ↔ React Flow 转换', () => {
  it('往返一致：10 类判别联合与边零信息损失', () => {
    const graph = sampleGraph()
    const flowNodes = toFlowNodes(graph)
    const flowEdges = toFlowEdges(graph)
    expect(flowNodes).toHaveLength(10)
    // type＝kind（nodeTypes 分发键）
    expect(flowNodes.map((node) => node.type)).toEqual([
      'start',
      'request',
      'extract',
      'condition',
      'parallel',
      'join',
      'delay',
      'retry',
      'assert',
      'end',
    ])
    const restored = fromFlow(flowNodes, flowEdges)
    expect(restored).toEqual(graph)
  })

  it('label ↔ sourceHandle 恒等（双重编码不变量）：投影后两处一致，连线恢复与落库标注同源', () => {
    const graph = sampleGraph()
    // 投影口径：条件分支出边的 label 同时落 data.label 与 sourceHandle，
    // 非条件边两处同空——连线恢复（读 sourceHandle）与落库 / 呈现（读
    // data.label）依赖这一恒等，无类型可钉，用断言守住
    for (const edge of toFlowEdges(graph)) {
      expect(edge.sourceHandle ?? null).toBe(edge.data?.label ?? null)
    }
  })

  it('画布位置为准：RF position 覆盖领域位置，其余字段保留', () => {
    const graph = sampleGraph()
    const flowNodes = toFlowNodes(graph).map((node, index) =>
      index === 0 ? { ...node, position: { x: 999, y: -5 } } : node,
    )
    const restored = fromFlow(flowNodes, toFlowEdges(graph))
    expect(restored.nodes[0]?.position).toEqual({ x: 999, y: -5 })
    expect(restored.nodes[0]?.config).toEqual(graph.nodes[0]?.config)
  })

  it('视图态有意丢弃：selected / measured 不进领域模型', () => {
    const graph = sampleGraph()
    const flowNodes = toFlowNodes(graph).map((node, index) =>
      index === 0 ? { ...node, selected: true, dragging: true } : node,
    )
    const restored = fromFlow(flowNodes, toFlowEdges(graph))
    expect(restored.nodes[0]).not.toHaveProperty('selected')
    expect(restored).toEqual(graph)
  })

  it('pruneEdgesForNodes：只剪与被删节点相连的边', () => {
    const graph = sampleGraph()
    const edges: WorkflowFlowEdge[] = [
      ...toFlowEdges(graph),
      { id: 'e2', source: 'n2', target: 'n3', data: { label: null } },
      { id: 'e3', source: 'n3', target: 'n10', data: { label: null } },
    ]
    const pruned = pruneEdgesForNodes(edges, ['n2'])
    expect(pruned.map((edge) => edge.id)).toEqual(['e3'])
  })

  it('makeNode 工厂：uuid 身份、默认配置可往返（序列化安全）', () => {
    for (const kind of [
      'start',
      'end',
      'request',
      'extract',
      'condition',
      'parallel',
      'join',
      'delay',
      'retry',
      'assert',
    ] as const) {
      const node = makeNode(kind, { x: 10, y: 20 })
      expect(node.id).not.toBe('')
      expect(node.name).toBe('')
      expect(node.position).toEqual({ x: 10, y: 20 })
      const flowNode: WorkflowFlowNode = {
        id: node.id,
        type: kind,
        position: node.position,
        data: { node },
      }
      const flowEdge: WorkflowFlowEdge = {
        id: 'e',
        source: node.id,
        target: 'other',
        data: { label: null },
      }
      const restored = fromFlow([flowNode], [flowEdge])
      expect(restored.nodes[0]).toEqual(node)
      expect(restored.edges[0]).toEqual<WorkflowEdge>({
        id: 'e',
        source: node.id,
        target: 'other',
        label: null,
      })
    }
  })

  it('makeNode 默认配置：提取写回分支默认关且敏感默认开、断言规则集空', () => {
    const extract = makeNode('extract', { x: 0, y: 0 })
    expect(extract.config.type === 'extract' && extract.config.writeback).toEqual({
      enabled: false,
      productPath: '',
      key: '',
      categoryName: null,
      secret: true,
    })
    const assert = makeNode('assert', { x: 0, y: 0 })
    expect(assert.config.type === 'assert' && assert.config.rules).toEqual([])
  })

  it('makeFlowEdge：uuid 身份、透传连线端点、label 占位 null', () => {
    const edge = makeFlowEdge({ source: 'a', target: 'b', sourceHandle: 'out', targetHandle: null })
    expect(edge.source).toBe('a')
    expect(edge.target).toBe('b')
    expect(edge.sourceHandle).toBe('out')
    expect(edge.data?.label).toBeNull()
    expect(edge.id).not.toBe(
      makeFlowEdge({ source: 'a', target: 'b', sourceHandle: null, targetHandle: null }).id,
    )
  })

  it('makeFlowEdge 条件分支出边：label＝源 Handle id（分支 id 或 DEFAULT）', () => {
    const branchEdge = makeFlowEdge(
      { source: 'cond', target: 'yes', sourceHandle: 'b1', targetHandle: null },
      'b1',
    )
    expect(branchEdge.data?.label).toBe('b1')
    const defaultEdge = makeFlowEdge(
      { source: 'cond', target: 'end', sourceHandle: 'DEFAULT', targetHandle: null },
      'DEFAULT',
    )
    expect(defaultEdge.data?.label).toBe('DEFAULT')
    // 分支标注恢复成流边时同时落 sourceHandle（多出口连线恢复锚）
    const restored = fromFlow(
      [],
      toFlowEdges({
        schemaVersion: GRAPH_SCHEMA_VERSION,
        nodes: [],
        edges: [
          { id: 'e1', source: 'cond', target: 'yes', label: 'b1' },
          { id: 'e2', source: 'cond', target: 'end', label: 'DEFAULT' },
        ],
      }),
    )
    expect(restored.edges.map((edge) => edge.label)).toEqual(['b1', 'DEFAULT'])
    expect(
      toFlowEdges({
        schemaVersion: GRAPH_SCHEMA_VERSION,
        nodes: [],
        edges: [{ id: 'e1', source: 'cond', target: 'yes', label: 'b1' }],
      })[0]?.sourceHandle,
    ).toBe('b1')
  })

  it('findNodeAt：包围盒含点即命中（measured 优先，缺省兜底），先命中先得', () => {
    const node = (x: number, y: number, width?: number, height?: number): WorkflowFlowNode => ({
      id: `n${x}-${y}`,
      type: 'start',
      position: { x, y },
      data: { node: makeNode('start', { x, y }) },
      ...(width != null || height != null
        ? { measured: { width: width ?? 256, height: height ?? 36 } }
        : {}),
    })
    const nodes = [node(0, 0, 200, 40), node(300, 100)]
    expect(findNodeAt(nodes, { x: 100, y: 20 })?.id).toBe('n0-0')
    // measured 缺省走兜底盒（256×36）
    expect(findNodeAt(nodes, { x: 400, y: 110 })?.id).toBe('n300-100')
    expect(findNodeAt(nodes, { x: 560, y: 110 })).toBeNull()
    expect(findNodeAt(nodes, { x: 250, y: 50 })).toBeNull()
  })
})
