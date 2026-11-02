/**
 * ELK 自动布局（layered 左→右）。`elkjs/lib/main.js` 是 node 入口，
 * 内置主线程 fallback worker（不依赖真实 Web Worker，不受 CSP 限制）；
 * dynamic import 按需加载（产物约 1.6MB，不进首屏包）。
 *
 * 布局触发是显式动作（工具栏按钮 / Ctrl+Shift+L），不随拖动自动整理；
 * 布局结果只产出坐标写回映射，节点的身份 / 配置 / 边一律不动。
 */

import type { ELK } from 'elkjs/lib/elk-api'

import type { WorkflowFlowEdge, WorkflowFlowNode } from '../canvas-converter'
import type { Position } from '../workflow-model'

/** 卡片默认包围盒兜底（w-64 卡片；与 canvas-converter 的 drop 命中同一口径） */
const DEFAULT_NODE_BOX = { width: 256, height: 36 }

/** 布局选项：Layered 左→右；层间距 / 同层间距给足连线与分支标签的呼吸位 */
const LAYOUT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.layered.spacing.nodeNodeBetweenLayers': '72',
  'elk.spacing.nodeNode': '36',
}

/** ELK 布局结果节点形状（消费面只取 id / x / y） */
interface ElkLayoutChild {
  id: string
  x?: number
  y?: number
}

/** ELK 实例模块级缓存（布局是偶发动作用；实例无每图状态） */
let elkPromise: Promise<ELK> | null = null

async function elkOf(): Promise<ELK> {
  elkPromise ??= import('elkjs/lib/main.js').then(({ default: ELK }) => new ELK())
  return elkPromise
}

/** 画布节点 → ELK 图输入（尺寸用 measured 就绪值，兜底默认卡片盒） */
export function toElkGraph(
  nodes: readonly WorkflowFlowNode[],
  edges: readonly WorkflowFlowEdge[],
): { children: ElkLayoutChild[]; edges: { id: string; sources: string[]; targets: string[] }[] } {
  return {
    children: nodes.map((flowNode) => ({
      id: flowNode.id,
      width: flowNode.measured?.width ?? DEFAULT_NODE_BOX.width,
      height: flowNode.measured?.height ?? DEFAULT_NODE_BOX.height,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  }
}

/** ELK 布局结果 → nodeId → 画布坐标（写回映射纯函数；未布局节点不进表） */
export function positionsFromLayout(
  children: readonly ElkLayoutChild[] | undefined,
): Map<string, Position> {
  const positions = new Map<string, Position>()
  for (const child of children ?? []) {
    if (child.x == null || child.y == null) continue
    positions.set(child.id, { x: child.x, y: child.y })
  }
  return positions
}

/**
 * 计算整图布局：返回 nodeId → 新坐标。图空＝空表（无动作可做）。
 * 布局失败（ELK 内部错误）向上抛，由调用方统一报错——画布保持原状。
 */
export async function computeLayout(
  nodes: readonly WorkflowFlowNode[],
  edges: readonly WorkflowFlowEdge[],
): Promise<Map<string, Position>> {
  if (nodes.length === 0) return new Map()
  const elk = await elkOf()
  const graph = toElkGraph(nodes, edges)
  const layout = await elk.layout({
    id: 'root',
    layoutOptions: LAYOUT_OPTIONS,
    children: graph.children,
    edges: graph.edges,
  })
  return positionsFromLayout(layout.children)
}
