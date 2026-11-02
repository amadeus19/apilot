/**
 * 画布内节点组复制 / 粘贴（同空间语义的基础版）：领域模型上的纯函数，
 * 编辑器把 React Flow 选中态投影到领域节点后经此模块复制与重制。
 *
 * 与跨空间剪贴板（workflow-clipboard.store）是两条独立通道：本通道只服务
 * 编辑器内的节点组复用（粘贴物是全新节点实例、id 重造、位置偏移）；载荷
 * 随编辑器组件存活（关 Tab / 切空间即失效），天然不跨空间生效。
 */

import type { WorkflowEdge, WorkflowNode } from './workflow-model'

/** 复制载荷：选中节点集＋组内边（两端都在选集内的边）。 */
export interface CanvasClipboard {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

/** 选中节点集 → 复制载荷（跨选集的边不进载荷——粘贴后端点悬空）。 */
export function copySelection(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  selectedIds: ReadonlySet<string>,
): CanvasClipboard {
  const selectedNodes = nodes.filter((node) => selectedIds.has(node.id))
  const selected = new Set(selectedNodes.map((node) => node.id))
  const internalEdges = edges.filter(
    (edge) => selected.has(edge.source) && selected.has(edge.target),
  )
  return { nodes: selectedNodes, edges: internalEdges }
}

/** 粘贴物：新节点集＋重映射后的组内边（可直接并入当前图）。 */
export interface CanvasPasteResult {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

/** 载荷 → 粘贴物：节点与边全部重造 uuid 身份、位置按偏移平移、边端点随
 * 节点 id 映射重写（条件分支标注等 label 原样保留）。配置对象按不可变
 * 更新纪律持引用复用（节点配置更新走整节点替换，不会被波及）。 */
export function pastedDuplicate(
  payload: CanvasClipboard,
  offset: { x: number; y: number },
): CanvasPasteResult {
  const idMap = new Map<string, string>()
  const nodes = payload.nodes.map((node) => {
    const id = crypto.randomUUID()
    idMap.set(node.id, id)
    return {
      ...node,
      id,
      position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
    }
  })
  const edges = payload.edges.map((edge) => ({
    ...edge,
    id: crypto.randomUUID(),
    source: idMap.get(edge.source) ?? edge.source,
    target: idMap.get(edge.target) ?? edge.target,
  }))
  return { nodes, edges }
}
