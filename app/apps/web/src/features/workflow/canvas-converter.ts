/**
 * 领域模型 ↔ React Flow 模型转换器（纯函数，单测点）。
 *
 * 转换即投影：React Flow 节点的 `type`＝领域 kind（nodeTypes 注册键）、
 * `data` 携带完整领域节点，位置以画布坐标为准——domain → flow → domain
 * 往返零信息损失（React Flow 的 selected / measured 等视图态在逆向转换
 * 时有意丢弃，不进领域模型）。
 * 领域模型不混入 React Flow 类型（架构铁律）：本文件是两侧唯一的边界，
 * 业务组件不得直接把 RF 结构当领域模型消费。
 */

import type { Connection, Edge as FlowEdge, Node as FlowNode } from '@xyflow/react'

import { NODE_META } from './canvas/node-meta'
import {
  GRAPH_SCHEMA_VERSION,
  nodeKindOf,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeKind,
} from './workflow-model'

/** React Flow 节点数据载荷：完整领域节点随行（渲染与节点内配置面直读）。 */
export interface WorkflowNodeData {
  node: WorkflowNode
  [key: string]: unknown
}

/** React Flow 侧节点：type＝kind（nodeTypes 分发键），position 为画布真相。 */
export type WorkflowFlowNode = FlowNode<WorkflowNodeData>

/** React Flow 侧边：领域 label 藏在 data（RF 顶层 label 留给执行态渲染）。 */
export interface WorkflowEdgeData {
  label: string | null
  [key: string]: unknown
}

export type WorkflowFlowEdge = FlowEdge<WorkflowEdgeData>

/** 领域图 → React Flow 节点集（type＝kind、data＝领域节点整体）。 */
export function toFlowNodes(graph: WorkflowGraph): WorkflowFlowNode[] {
  return graph.nodes.map((node) => makeFlowNode(node))
}

/** 领域节点 → React Flow 节点单体工厂（type＝kind、data 携带领域节点；
 * position 直传画布坐标）。建节点三通道（拖放 / 面板 / 连线转正）与图投
 * 影共用同一投影形态，字面量不出现第二份。 */
export function makeFlowNode(node: WorkflowNode, selected = false): WorkflowFlowNode {
  return {
    id: node.id,
    type: nodeKindOf(node.config),
    position: { x: node.position.x, y: node.position.y },
    data: { node },
    ...(selected ? { selected: true } : {}),
  }
}

/** 领域图 → React Flow 边集：条件分支出边的 label（分支 id 或 DEFAULT）
 * 同时落 RF 的 sourceHandle——多出口节点的连线恢复靠它定位源 Handle。 */
export function toFlowEdges(graph: WorkflowGraph): WorkflowFlowEdge[] {
  return graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.label ?? undefined,
    data: { label: edge.label },
  }))
}

/** React Flow 节点集 + 边集 → 领域图（保存序列化单点；视图态有意丢弃）。
 * 条件分支出边的 sourceHandle 回写为领域 label（与 toFlowEdges 互逆）。 */
export function fromFlow(nodes: WorkflowFlowNode[], edges: WorkflowFlowEdge[]): WorkflowGraph {
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    nodes: nodes.map((flowNode) => ({
      ...flowNode.data.node,
      position: { x: flowNode.position.x, y: flowNode.position.y },
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.data?.label ?? null,
    })),
  }
}

/** 删除节点后剪除相连边（React Flow 删节点不自动清边，本函数补齐）。 */
export function pruneEdgesForNodes(
  edges: WorkflowFlowEdge[],
  removedIds: readonly string[],
): WorkflowFlowEdge[] {
  const removed = new Set(removedIds)
  return edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target))
}

/** 卡片默认包围盒兜底（w-64 卡片；React Flow measured 就绪前的降级） */
const DEFAULT_NODE_BOX = { width: 256, height: 36 }

/** drop 点 → 命中节点（包围盒含点即命中，先命中先得；无命中返回 null）。 */
export function findNodeAt(
  nodes: WorkflowFlowNode[],
  point: { x: number; y: number },
): WorkflowFlowNode | null {
  for (const flowNode of nodes) {
    const width = flowNode.measured?.width ?? DEFAULT_NODE_BOX.width
    const height = flowNode.measured?.height ?? DEFAULT_NODE_BOX.height
    const { x, y } = flowNode.position
    if (point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height) {
      return flowNode
    }
  }
  return null
}

/** 面板拖出新节点工厂：uuid 身份、空名（卡片显示 kind 名兜底）、默认配置。
 * 默认配置取自 NODE_META（模块级常量），深拷贝保证每个新节点独享实例——
 * 嵌套的覆写行集 / 分支行集等不与表共享引用，节点间编辑互不串扰。 */
export function makeNode(kind: WorkflowNodeKind, position: { x: number; y: number }): WorkflowNode {
  return {
    id: crypto.randomUUID(),
    name: '',
    position,
    config: structuredClone(NODE_META[kind].defaultConfig),
  }
}

/** 连线事件 → React Flow 新边工厂（uuid 身份；label 由调用方按源节点
 * kind 落定——条件节点＝源 Handle id（分支 id 或 DEFAULT），其余 null）。 */
export function makeFlowEdge(
  connection: Connection,
  label: string | null = null,
): WorkflowFlowEdge {
  return { ...connection, id: crypto.randomUUID(), data: { label } }
}
