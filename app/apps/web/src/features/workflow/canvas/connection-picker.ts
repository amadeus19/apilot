import type { WorkflowNodeKind } from '../workflow-model'
import type { WorkflowFlowEdge, WorkflowFlowNode, WorkflowNodeData } from '../canvas-converter'

/**
 * 连线末端节点选择框的决策纯函数：拉线方向判定、候选节点按拓扑过滤、
 * 新边两端计划与条件分支标注规则、连线临时体（视图态）的构建。编辑器
 * onConnectEnd 通道与节点选择面板（连线场景变体）共用；拉线全程是
 * 视图态，这里只产出视图层挂载物与建边决策，不触碰领域模型。
 */

/** 连线方向：顺向＝从出口 handle 拉出找下游（新节点落在 target 端），
 * 反向＝从入口 handle 拉出找上游（新节点落在 source 端） */
export type ConnectionDirection = 'forward' | 'backward'

/** 拉线方向判定：起点 handle 类型即方向——出口 handle 顺向、入口 handle 反向 */
export function connectionDirectionOf(fromHandleType: 'source' | 'target'): ConnectionDirection {
  return fromHandleType === 'source' ? 'forward' : 'backward'
}

/**
 * 连线候选按 Handle 拓扑过滤：顺向（找下游）排除「开始」（无入口
 * handle），反向（找上游）排除「结束」（无出口 handle），其余 kind 全出。
 * kind 集由调用方按节点元数据表现状动态传入（组集与组内序不变），不在此
 * 硬编码类数——元数据增删 kind 时候选自然跟随。
 */
export function filterConnectableKinds(
  kinds: readonly WorkflowNodeKind[],
  direction: ConnectionDirection,
): WorkflowNodeKind[] {
  const excluded = direction === 'forward' ? 'start' : 'end'
  return kinds.filter((kind) => kind !== excluded)
}

/** 连线选型后的新边两端计划：顺向＝拉线起点在 source 端、新节点是
 * target；反向＝新节点是 source、拉线起点在 target 端 */
export interface ConnectionEdgePlan {
  sourceId: string
  targetId: string
  /** source 端 Handle id（条件分支 id 或 DEFAULT）；无标注语义为 null */
  sourceHandleId: string | null
}

/** 新边两端计划：把拉线方向翻译成边的 source / target 与 source 端
 * Handle id。反向从入口 handle 拉出时新节点在 source 端且无 Handle id
 * （新建节点尚无分支 Handle，反向也不带分支标注） */
export function planConnectionEdge(
  direction: ConnectionDirection,
  fromNodeId: string,
  fromHandleId: string | null,
  newNodeId: string,
): ConnectionEdgePlan {
  return direction === 'forward'
    ? { sourceId: fromNodeId, targetId: newNodeId, sourceHandleId: fromHandleId }
    : { sourceId: newNodeId, targetId: fromNodeId, sourceHandleId: null }
}

/** 连线临时体的占位节点类型键：nodeTypes 的分发键，非领域 kind。临时体
 * 是纯视图态，永不入领域模型 */
export const TEMP_NODE_TYPE = 'placeholder'

/** 连线临时体：视图层真实存在的占位节点与临时边。React Flow 的拖拽连线
 * 在松手即消失，持久连线要求两端都落在视图层真实节点上——松手在空白处
 * 时占位节点即刻落点、临时边从拉线起点接到占位节点，连线全程可见不断。
 * 选中候选时占位就地转正，Esc／点外关闭时整体撤销 */
export interface TempConnectionBody {
  node: WorkflowFlowNode
  edge: WorkflowFlowEdge
}

/** 构建连线临时体：占位节点落 position（调用方按建节点落点口径回退），
 * 临时边两端与转正边共用 planConnectionEdge（占位节点 id 代入「新节点」
 * 位）——转正时两端不变，仅节点身份由占位换为真节点，连线视觉零跳变。
 * 占位节点不参与任何画布交互（不可拖 / 不可选 / 不可连线 / 不可删），
 * 标注恒空——分支标注在转正提交时按源节点 kind 落定，临时态不预决 */
export function tempConnectionBody(input: {
  direction: ConnectionDirection
  fromNodeId: string
  fromHandleId: string | null
  /** 占位节点身份（视图层 uuid，永不入领域模型） */
  tempNodeId: string
  edgeId: string
  position: { x: number; y: number }
}): TempConnectionBody {
  const node: WorkflowFlowNode = {
    id: input.tempNodeId,
    type: TEMP_NODE_TYPE,
    position: input.position,
    // 占位节点不携带领域节点载荷：nodeTypes 按类型键分发到占位组件，
    // 节点卡片组件不经手临时体，空载荷断言是视图层边界的显式收窄
    data: {} as WorkflowNodeData,
    draggable: false,
    selectable: false,
    deletable: false,
    connectable: false,
  }
  const plan = planConnectionEdge(
    input.direction,
    input.fromNodeId,
    input.fromHandleId,
    input.tempNodeId,
  )
  const edge: WorkflowFlowEdge = {
    id: input.edgeId,
    source: plan.sourceId,
    target: plan.targetId,
    sourceHandle: plan.sourceHandleId,
    targetHandle: null,
    data: { label: null },
  }
  return { node, edge }
}

/** 连线边的分支标注规则：条件节点出边 label＝source Handle id（分支 id
 * 或 DEFAULT，引擎选中分支的定位锚），其余节点出边不带标注。直接连线
 * （onConnect）与连线面板建边共用同一规则，两条通道不漂移 */
export function connectEdgeLabel(
  sourceKind: WorkflowNodeKind,
  sourceHandleId: string | null,
): string | null {
  return sourceKind === 'condition' ? sourceHandleId : null
}

/** 拉线松手事件的指针 client 坐标：鼠标事件直读；触摸事件读
 * changedTouches（松手时 touches 已清空，仅 changedTouches 留存） */
export function pointerClientPoint(event: MouseEvent | TouchEvent): { x: number; y: number } {
  const source = 'changedTouches' in event ? event.changedTouches[0] : event
  return { x: source.clientX, y: source.clientY }
}
