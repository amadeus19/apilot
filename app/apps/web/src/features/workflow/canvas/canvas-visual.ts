import type { WorkflowFlowEdge, WorkflowFlowNode } from '../canvas-converter'

/**
 * 画布呈现投影纯函数（单测点）：领域标注 → 渲染期人话呈现的修饰投影。
 * 与 canvas-converter 的模型互转分离——本文件只做呈现修饰，产物只进
 * React Flow 渲染层，不回写领域模型（编辑模型与执行 / 视觉模型分离）。
 */

/**
 * 条件分支出边标注投影：领域 label 是分支 id（引擎选中分支的定位锚），
 * 画布呈现投影成人话——DEFAULT 锚显本地化文案（调用方经 t() 解出传入），
 * 命中分支显表达式摘要（过长截断：标注会压到下游卡片上，完整表达式在
 * 节点内可读），未知锚（分支已删等）回落锚原值兜底；无标注或源节点非
 * 条件的边原样保留（同一对象引用，不产生渲染扰动）。源节点按 id 建 Map
 * 索引，避免逐边线性查找。
 */
export function projectConditionBranchLabels(
  edges: WorkflowFlowEdge[],
  nodes: readonly WorkflowFlowNode[],
  defaultBranchLabel: string,
): WorkflowFlowEdge[] {
  const nodesById = new Map(nodes.map((flowNode) => [flowNode.id, flowNode]))
  return edges.map((edge) => {
    const anchor = edge.data?.label
    if (anchor == null) return edge
    const sourceConfig = nodesById.get(edge.source)?.data.node.config
    if (sourceConfig?.type !== 'condition') return edge
    const expression =
      anchor === 'DEFAULT'
        ? null
        : sourceConfig.branches.find((branch) => branch.id === anchor)?.expression
    const summary =
      anchor === 'DEFAULT'
        ? defaultBranchLabel
        : expression != null
          ? truncateBranchLabel(expression)
          : anchor
    return {
      ...edge,
      label: summary,
      // 分支标注浮在网点画布上：字色取弱化前景，底块取画布平面色（网点从
      // 字下透出来会把 11px 小字读花），内边距与圆角只做贴底收口
      labelStyle: { fontSize: 11, fill: 'var(--muted-foreground)' },
      labelBgStyle: { fill: 'var(--canvas)' },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 3,
    }
  })
}

/** 边标注最大字符数（按码点计，避免截断代理对） */
const BRANCH_LABEL_MAX_CHARS = 24

/** 分支表达式摘要截断（完整表达式在条件节点内可编辑可读） */
function truncateBranchLabel(expression: string): string {
  const chars = Array.from(expression)
  if (chars.length <= BRANCH_LABEL_MAX_CHARS) return expression
  return `${chars.slice(0, BRANCH_LABEL_MAX_CHARS).join('').trimEnd()}…`
}
