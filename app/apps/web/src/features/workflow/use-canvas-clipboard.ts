import * as React from 'react'

import { copySelection, pastedDuplicate, type CanvasClipboard } from './canvas-clipboard'
import {
  toFlowEdges,
  toFlowNodes,
  type WorkflowFlowEdge,
  type WorkflowFlowNode,
} from './canvas-converter'
import { GRAPH_SCHEMA_VERSION, type WorkflowGraph } from './workflow-model'

/** 结构变更统一出口签名（编辑器的 sync 通道；hook 只消费，不关心撤销记账语义） */
export type CanvasSync = (
  nextNodes: WorkflowFlowNode[],
  nextEdges: WorkflowFlowEdge[],
  commitLabel?: string,
  coalesce?: boolean,
) => void

/** 画布内粘贴的落点步进（px；连续粘贴逐次外扩，避免完全重叠） */
const CANVAS_PASTE_STEP = 40

/**
 * 画布剪贴板（复制 / 粘贴当前选中集）：载荷随编辑器组件存活（关 Tab /
 * 切空间即失效，天然不跨空间）；round 计连续粘贴的落点步进。键位与右键
 * 菜单共用同一动作面；latest-ref 持有画布现值（键事件时刻经 ref 读，渲
 * 染期不触 ref）。hasClipboard 与载荷 ref 的唯一写入点同在 copy（复制是
 * 唯一写入点），面板置灰与键位 when 守卫不漂移。
 */
export function useCanvasClipboard({
  nodes,
  edges,
  sync,
}: {
  nodes: WorkflowFlowNode[]
  edges: WorkflowFlowEdge[]
  sync: CanvasSync
}) {
  const canvasClipboardRef = React.useRef<{ payload: CanvasClipboard; round: number } | null>(null)
  const [hasClipboard, setHasClipboard] = React.useState(false)
  // 键位与右键菜单的动作共读同一 ref 快照（effect 后同步，渲染期不触 ref）
  const canvasStateRef = React.useRef({ nodes, edges, sync })
  React.useEffect(() => {
    canvasStateRef.current = { nodes, edges, sync }
  })

  /** 复制当前选中集到画布剪贴板，返回是否落载（键位与节点右键菜单共用；
   * 空选中＝未落载，键位路径不吞键） */
  const copySelectedNodes = React.useCallback(() => {
    const { nodes: currentNodes, edges: currentEdges } = canvasStateRef.current
    const selectedIds = new Set(
      currentNodes.filter((flowNode) => flowNode.selected).map((flowNode) => flowNode.id),
    )
    if (selectedIds.size === 0) return false
    const domainNodes = currentNodes
      .filter((flowNode) => selectedIds.has(flowNode.id))
      .map((flowNode) => flowNode.data.node)
    const domainEdges = currentEdges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.data?.label ?? null,
    }))
    canvasClipboardRef.current = {
      payload: copySelection(domainNodes, domainEdges, selectedIds),
      round: 0,
    }
    setHasClipboard(true)
    return true
  }, [])

  /** 画布剪贴板粘贴为全新节点并入图，返回是否落图（无载荷＝未落图，键位
   * 路径不吞键）；连续粘贴按 round 步进落点，粘贴物整体选中并记一条撤销 */
  const pasteClipboard = React.useCallback(() => {
    const clipboard = canvasClipboardRef.current
    if (!clipboard) return false
    const { nodes: currentNodes, edges: currentEdges, sync: currentSync } = canvasStateRef.current
    const round = clipboard.round + 1
    clipboard.round = round
    const made = pastedDuplicate(clipboard.payload, {
      x: CANVAS_PASTE_STEP * round,
      y: CANVAS_PASTE_STEP * round,
    })
    const fragment: WorkflowGraph = {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      nodes: made.nodes,
      edges: made.edges,
    }
    const added = toFlowNodes(fragment).map((flowNode) => ({ ...flowNode, selected: true }))
    currentSync(
      [...currentNodes.map((flowNode) => ({ ...flowNode, selected: false })), ...added],
      [...currentEdges, ...toFlowEdges(fragment)],
      'paste',
    )
    return true
  }, [])

  // 键位 when 守卫谓词（键事件时刻经 ref 读画布现值，渲染期不触 ref）
  const hasCanvasClipboard = React.useCallback(() => canvasClipboardRef.current != null, [])

  return { hasClipboard, copySelectedNodes, pasteClipboard, hasCanvasClipboard }
}
