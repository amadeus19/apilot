import * as React from 'react'

import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type FinalConnectionState,
  type NodeChange,
} from '@xyflow/react'

import '@xyflow/react/dist/style.css'

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  toast,
  usePointContextMenu,
} from '@workspace/ui/components'

import { useIpcQuery } from '@/services/ipc-query'
import { reportError } from '@/services/error-center'
import { useI18n } from '@/i18n'
import { SEMANTIC_ICONS } from '@/features/icons/semantic-icons'
import { useTabsStore } from '@/stores/tabs.store'

import {
  findNodeAt,
  fromFlow,
  makeFlowEdge,
  makeFlowNode,
  makeNode,
  pruneEdgesForNodes,
  toFlowEdges,
  toFlowNodes,
  type WorkflowFlowEdge,
  type WorkflowFlowNode,
} from './canvas-converter'
import {
  ENDPOINT_DRAG_MIME,
  bindEndpointToNode,
  decodeEndpointDragPayload,
  isBindableDropTarget,
} from './endpoint-dnd'
import { NODE_DRAG_MIME, nodeDisplayName } from './canvas/node-meta'
import { CanvasContextMenu, type CanvasMenuTarget } from './canvas/context-menu'
import { NodePicker, type NodePickerAnchor } from './canvas/node-picker'
import {
  NODE_PICKER_MARGIN,
  NODE_PICKER_TOOLBAR_CLEARANCE,
  pickerAnchorLocal,
  toolbarPickerAnchorLocal,
} from './canvas/node-picker-anchor'
import { NODE_TYPES_WITH_TEMP } from './canvas/canvas-node-types'
import {
  connectEdgeLabel,
  connectionDirectionOf,
  planConnectionEdge,
  pointerClientPoint,
  tempConnectionBody,
  type ConnectionDirection,
  type TempConnectionBody,
} from './canvas/connection-picker'
import {
  RenameRequestContext,
  NodeUpdateContext,
  type RenameRequest,
} from './canvas/node-editing-context'
import { WorkflowBottomConsole } from './canvas/bottom-console'
import {
  consoleTabFallback,
  consoleTabForRunSignal,
  type WorkflowConsoleTab,
} from './canvas/console-tab'
import { computeLayout } from './canvas/auto-layout'
import { projectConditionBranchLabels } from './canvas/canvas-visual'
import { withEdgeExecutionAnimation } from './canvas/execution-state'
import { InvalidRefContext } from './canvas/validation-context'
import { WorkflowIdContext } from './canvas/workflow-id-context'
import { useWorkflowEditorCommands, useWorkflowRunning } from './editor-commands'
import { useWorkflowExecutionStore } from './execution.store'
import { useWorkflowValidation } from './use-workflow-validation'
import { useCanvasClipboard, type CanvasSync } from './use-canvas-clipboard'
import { workflowCancel, workflowKeys, workflowLoad } from './workflow-api'
import { executeWorkflowGuarded } from './run-flow'
import { useWorkflowClipboardStore } from './workflow-clipboard.store'
import { useWorkflowEditorStore } from './workflow-editor.store'
import { selectResolvedTheme, useSettingsStore } from '@/stores/settings.store'
import { FloatingToolbar } from './canvas/floating-toolbar'
import {
  isWorkflowNodeKind,
  nodeKindOf,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeKind,
} from './workflow-model'

/**
 * 工作流编辑器：画布独占主体（Postman Flow 式），配置直接铺在节点卡片内，
 * 节点清单经画布右键 / 底部悬浮工具栏的「添加节点」／拉线松手在画布空白处
 * 的连线选型面板按需弹出；底部控制台（校验 / 执行）保持独立。悬浮工具栏
 * ＝运行/停止（在途切换）＋撤销/重做（栈空置灰）＋保存（脏态点亮）＋复制
 * 工作流＋自动布局＋小地图开关＋适配视图＋添加节点。
 *
 * 状态归属：领域图的编辑期真相在 workflow-editor store（跨挂载存续、关 Tab
 * 释放；撤销 / 重做栈随会话存续）；React Flow 的 nodes/edges 是本组件树内
 * 的视图层状态（含选中 / 拖动等视图态），结构变更经 sync 投影回 store
 * 标脏，撤销类结构变更记一条撤销（拖动由 dragStart 快照 / dragStop 收口，
 * 其余按 label 合并窗折算），保存以 store 的图落库。React Flow 模型不进
 * 领域模型（架构铁律）；节点注册表与连线临时体见 canvas-node-types、
 * 校验接线见 use-workflow-validation、画布剪贴板见 use-canvas-clipboard。
 * 连线（命中 handle 直接建边；松手在空白处即刻挂视图层临时连线体——占位
 * 节点＋临时边保证连线不断——并弹选型面板，选中即占位转正、Esc／点外整体
 * 撤销，落在节点卡片取消；临时体不入模型、不触发校验、不进撤销栈）、
 * 删除（节点连带剪边）、多选、缩放平移为 React Flow 原生交互接线；
 * ELK 自动布局与小地图是画布级辅助（显式触发，不随拖动自动整理）。
 */

/** 拖放落点、选择面板落点与连线临时体落点共用：建节点位置回退半个卡片
 * 尺寸（w-64 卡片半宽 + 标题条高，防卡片半宽落在坐标左上外） */
const DROP_CENTERING = { x: 128, y: 16 }

/** 连线场景节点选择面板的挂载态：面板锚点（松手点收口后）＋拉线起点的
 * 方向与身份（选中候选后按方向自动建边）＋连线临时体（松手即挂载的占位
 * 节点与临时边，保证连线全程可见不断）。临时体与面板同生命周期：选中
 * 落定占位转正、Esc／点外整体撤销；拉线全程是视图态，只有转正那一刻才
 * 写模型 */
interface ConnectionPickerState {
  anchor: NodePickerAnchor
  direction: ConnectionDirection
  /** 拉线起点节点 id（顺向＝新边的 source，反向＝新边的 target） */
  fromNodeId: string
  /** 拉线起点 Handle id（条件分支 id 或 DEFAULT；无 id Handle 为 null） */
  fromHandleId: string | null
  /** 连线临时体：纯视图态，不入图模型、不触发校验、不进撤销栈 */
  temp: TempConnectionBody
}

export function WorkflowEditorPage({ workflowId }: { workflowId: string }) {
  const workflowQuery = useIpcQuery({
    queryKey: workflowKeys.load(workflowId),
    queryFn: () => workflowLoad(workflowId),
  })
  const session = useWorkflowEditorStore((s) => s.sessions[workflowId])
  const seed = useWorkflowEditorStore((s) => s.seed)
  const gcSessions = useWorkflowEditorStore((s) => s.gcSessions)

  // 数据就绪即播种（幂等；已有会话不覆盖——保留未保存编辑）
  if (workflowQuery.data && !session) {
    seed(workflowQuery.data)
  }

  // 挂载期对账清扫：丢弃不在存活工作流 Tab 清单里的会话，并对无 Tab 的
  // 执行槽位取消在途执行、释放状态（切空间等外部关闭路径的兜底释放）。
  // 常规关闭路径（关 Tab / 删除联动）各自 dispose / discard，不依赖此处。
  React.useEffect(() => {
    const alive = useTabsStore
      .getState()
      .tabs.filter((tab) => tab.kind === 'workflow' && tab.key)
      .map((tab) => tab.key!)
    gcSessions(alive)
    useWorkflowExecutionStore.getState().pruneOrphans(alive)
  }, [workflowId, gcSessions])

  if (!session) {
    // 首帧（查询在途）：空占位，播种生效后重渲
    return <div className="h-full min-h-0" data-testid="workflow-editor-loading" />
  }

  return (
    <ReactFlowProvider>
      <EditorInner workflowId={workflowId} session={session} />
    </ReactFlowProvider>
  )
}

function EditorInner({
  workflowId,
  session,
}: {
  workflowId: string
  session: { name: string; graph: WorkflowGraph; dirty: boolean }
}) {
  const { t } = useI18n()
  const { screenToFlowPosition, setCenter, getNodes, getEdges, getViewport, setViewport, getZoom } =
    useReactFlow()
  const [nodes, setNodes] = React.useState<WorkflowFlowNode[]>(() => toFlowNodes(session.graph))
  const [edges, setEdges] = React.useState<WorkflowFlowEdge[]>(() => toFlowEdges(session.graph))
  // 画布容器引用：节点选择面板与「添加节点」以容器几何中心为视口中心（ReactFlow 填满该容器）
  const canvasRef = React.useRef<HTMLDivElement | null>(null)
  // 重命名请求（右键菜单「重命名」与 F2 递增）：命中节点进入名称输入态，
  // 编辑本体在节点标题条完成
  const [renameRequest, setRenameRequest] = React.useState<RenameRequest | null>(null)
  // 节点选择面板锚点（右键空白面 / 悬浮工具栏「添加节点」打开；null＝收起）
  const [pickerAnchor, setPickerAnchor] = React.useState<NodePickerAnchor | null>(null)
  // 连线场景节点选择面板（拉线松手在画布空白处打开；null＝收起）
  const [connectionPicker, setConnectionPicker] = React.useState<ConnectionPickerState | null>(null)
  // 小地图开关（编辑器会话内 UI 态）
  const [minimapOpen, setMinimapOpen] = React.useState(false)
  // 已解析主题直通 React Flow colorMode：内置控件（缩放钮等）配色跟随
  // 应用主题切换（system 偏好已被 selectResolvedTheme 归一，不透传）
  const resolvedTheme = useSettingsStore(selectResolvedTheme)

  // —— 执行接线：在途判定、运行/停止动作、边流动动画与底部控制台 ——

  const running = useWorkflowRunning(workflowId)
  const activeEdgeIds = useWorkflowExecutionStore((s) => s.executions[workflowId]?.activeEdgeIds)
  // 执行在途判定（控制台渲染切换用；含乐观 running 空窗态——点运行到首个
  // 节点入队间槽位已在，控制台即时呈现「执行中」）。订阅布尔而非整槽位：
  // 执行期每个节点 / 边事件都换槽位对象引用，布尔让重渲止步于控制台
  const hasExecution = useWorkflowExecutionStore((s) => s.executions[workflowId] != null)

  // 撤销 / 重做钮的置灰门控：订阅选择器从 store 栈深度派生（布尔结果稳定，
  // undo / redo 落栈即重渲）——置灰态与栈状态严格一致，不经 effect 同步
  const canUndo = useWorkflowEditorStore((s) => s.canUndo(workflowId))
  const canRedo = useWorkflowEditorStore((s) => s.canRedo(workflowId))

  // —— 执行前校验接线（hook）：图变更防抖重校验、失效引用派生与运行前
  // 强制重校验写入 ——
  const sessionGraph = session.graph
  const { issues, setIssues, invalidRefIds } = useWorkflowValidation(workflowId, sessionGraph)

  // 底部控制台活跃 tab：运行信号驱动切换（见 runWorkflow），活跃侧失去
  // 内容时渲染期回落到有内容的一侧（consoleTabFallback 派生态调整模式，
  // 不进 effect）
  const [consoleTab, setConsoleTab] = React.useState<WorkflowConsoleTab>('validation')
  const hasIssues = issues.length > 0
  const consoleFallback = consoleTabFallback(consoleTab, hasIssues, hasExecution)
  if (consoleFallback != null) setConsoleTab(consoleFallback)
  // 条件分支出边标注投影成人话（DEFAULT 显本地化文案，命中分支显表达式
  // 摘要；纯函数在 canvas-visual）；运行中边叠加流动动画（activeEdgeIds
  // 终态清空后派生回静态，执行视觉单源在 execution-state，与节点侧对称）
  const labelEdges = React.useMemo(
    () => projectConditionBranchLabels(edges, nodes, t('workflows.branchDefault')),
    [edges, nodes, t],
  )
  const styledEdges = React.useMemo(
    () => withEdgeExecutionAnimation(labelEdges, activeEdgeIds),
    [labelEdges, activeEdgeIds],
  )
  // 面板节点名（kind 名兜底，兜底口径单点在 node-meta；展示序与定位共用）
  const nodeNames = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const flowNode of nodes) {
      map.set(flowNode.data.node.id, nodeDisplayName(flowNode.data.node, t))
    }
    return map
  }, [nodes, t])

  /** 运行：协议单点在 run-flow（校验闸 → 乐观置 running → 阻塞执行至
   * 终态 → 记录对齐＋清单徽标失效 → 失败回滚）；本编辑器差异项＝脏态先
   * 静默保存（执行体是落库图，所见即所跑；保存失败不启动执行——错误已
   * 上报）＋校验编辑态图＋问题写校验面板（空表清面板，引擎拒绝清单同面
   * 呈现），并按清单驱动控制台自动切 tab：被拒跳校验，放行即启动跳执行
   * （打断风险初版接受） */
  const runWorkflow = React.useCallback(() => {
    const editor = useWorkflowEditorStore.getState()
    const pending = editor.sessions[workflowId]?.dirty
      ? editor.saveSession(workflowId)
      : Promise.resolve(true)
    void pending.then((saved) => {
      if (!saved) return
      // 执行图取保存完成时刻的编辑态快照（而非本次渲染的陈旧闭包）：
      // 保存等待期间的继续编辑不丢失，运行与最新编辑态一致
      const latest = useWorkflowEditorStore.getState().sessions[workflowId]?.graph ?? session.graph
      executeWorkflowGuarded({
        workflowId,
        name: session.name,
        graph: latest,
        onIssues: (next) => {
          setIssues(next)
          setConsoleTab(consoleTabForRunSignal(next.length))
        },
      })
    })
  }, [workflowId, session.graph, session.name, setIssues])

  const stopWorkflow = React.useCallback(() => {
    void workflowCancel(workflowId).catch((error) => reportError(error))
  }, [workflowId])

  const saveWorkflow = React.useCallback(() => {
    void useWorkflowEditorStore.getState().saveSession(workflowId)
  }, [workflowId])

  /** 结构变更统一出口：视图层与 store 领域图同步落定。commitLabel 给定
   * 时记一条撤销；coalesce 标记合并通道（仅节点内配置编辑——逐键
   * 高频 tick 折算一条），结构操作独立成条。缺省只落定（拖动过程等连续
   * 通道，撤销条目由 dragStop 收口统一记）。标脏在 store 内。 */
  const sync = React.useCallback<CanvasSync>(
    (nextNodes, nextEdges, commitLabel?, coalesce?) => {
      setNodes(nextNodes)
      setEdges(nextEdges)
      const graph = fromFlow(nextNodes, nextEdges)
      const store = useWorkflowEditorStore.getState()
      if (commitLabel != null) {
        store.commitGraph(workflowId, graph, commitLabel, coalesce)
      } else {
        store.applyGraph(workflowId, graph)
      }
    },
    [workflowId],
  )

  /** 撤销 / 重做：store 栈恢复领域图后同步重建视图层（选中态随重建丢弃） */
  const undoEdit = React.useCallback(() => {
    const restored = useWorkflowEditorStore.getState().undo(workflowId)
    if (!restored) return
    setNodes(toFlowNodes(restored))
    setEdges(toFlowEdges(restored))
  }, [workflowId])

  const redoEdit = React.useCallback(() => {
    const restored = useWorkflowEditorStore.getState().redo(workflowId)
    if (!restored) return
    setNodes(toFlowNodes(restored))
    setEdges(toFlowEdges(restored))
  }, [workflowId])

  /** ELK 自动布局（显式动作，不随拖动触发）：对点击时点的图算坐标，
   * 应用到应用时点的现值上（经 React Flow store 取最新节点，异步期间的
   * 新增 / 删除不受影响）；一次布局记一条撤销。 */
  const autoLayout = React.useCallback(() => {
    void computeLayout(getNodes() as WorkflowFlowNode[], getEdges() as WorkflowFlowEdge[])
      .then((positions) => {
        if (positions.size === 0) return
        const nextNodes = (getNodes() as WorkflowFlowNode[]).map((flowNode) => {
          const position = positions.get(flowNode.id)
          return position ? { ...flowNode, position } : flowNode
        })
        sync(nextNodes, getEdges() as WorkflowFlowEdge[], 'layout')
      })
      .catch((error) => reportError(error))
  }, [getNodes, getEdges, sync])

  /** 复制工作流（编辑器工具栏入口）：当前编辑会话的名称＋整图写应用内
   * 剪贴板（会话态，含未保存编辑），供跨空间粘贴。 */
  const copyWorkflow = React.useCallback(() => {
    useWorkflowClipboardStore.getState().copy({ name: session.name, graph: session.graph })
    toast.success(t('workflows.copiedToast', { name: session.name }))
  }, [session.name, session.graph, t])

  /** 执行面板点击行 → 选中并居中定位节点（失败可定位的面） */
  const locateNode = React.useCallback(
    (nodeId: string) => {
      setNodes((current) =>
        current.map((flowNode) => ({ ...flowNode, selected: flowNode.id === nodeId })),
      )
      const target = nodes.find((flowNode) => flowNode.id === nodeId)
      if (target) {
        void setCenter(target.position.x, target.position.y, { zoom: 1.2, duration: 200 })
      }
    },
    [nodes, setCenter],
  )

  // —— 画布剪贴板（hook）：复制 / 粘贴动作与键位 when 守卫 ——
  const { hasClipboard, copySelectedNodes, pasteClipboard, hasCanvasClipboard } =
    useCanvasClipboard({ nodes, edges, sync })

  // —— 键位 / 菜单共读的画布现值快照（latest-ref：渲染期不触 ref）——
  const canvasStateRef = React.useRef({ nodes })
  React.useEffect(() => {
    canvasStateRef.current = { nodes }
  })

  /** 重命名入口（节点右键菜单「重命名」与 F2 共用）：命中节点进入标题条
   * 名称输入态，编辑本体在节点内完成（与其他配置同合并窗撤销通道）。
   * 仅单选节点生效——多选无重命名语义，返回 false 交键位路径放行不吞键 */
  const beginRename = React.useCallback((): boolean => {
    const selected = canvasStateRef.current.nodes.filter((node) => node.selected)
    if (selected.length !== 1) return false
    const nodeId = selected[0]!.id
    setRenameRequest((prev) => ({ nodeId, seq: (prev?.seq ?? 0) + 1 }))
    return true
  }, [])

  // 键位 when 守卫谓词（键事件时刻经 ref 读画布现值，渲染期不触 ref）
  const hasCanvasSelection = React.useCallback(
    () => canvasStateRef.current.nodes.some((node) => node.selected),
    [],
  )
  const hasSingleCanvasSelection = React.useCallback(
    () => canvasStateRef.current.nodes.filter((node) => node.selected).length === 1,
    [],
  )

  useWorkflowEditorCommands(workflowId, {
    run: runWorkflow,
    stop: stopWorkflow,
    save: saveWorkflow,
    autoLayout,
    undo: undoEdit,
    redo: redoEdit,
    copySelection: copySelectedNodes,
    pasteSelection: pasteClipboard,
    renameNode: beginRename,
    hasSelection: hasCanvasSelection,
    hasSingleSelection: hasSingleCanvasSelection,
    hasClipboard: hasCanvasClipboard,
  })

  // —— 节点拖动的撤销收口：拖动起点快照存 ref（不写 store、不标脏），
  // 拖动过程的位置变更走 applyGraph 连续通道，dragStop 补记一条撤销
  // （位置未变不记）；一次手势的重复收口在 store 内按快照引用去重
  const dragStartGraphRef = React.useRef<WorkflowGraph | null>(null)
  const handleNodeDragStart = React.useCallback(() => {
    dragStartGraphRef.current =
      useWorkflowEditorStore.getState().sessions[workflowId]?.graph ?? null
  }, [workflowId])
  const handleNodeDragStop = React.useCallback(() => {
    const snapshot = dragStartGraphRef.current
    dragStartGraphRef.current = null
    if (!snapshot) return
    useWorkflowEditorStore.getState().commitSnapshot(workflowId, snapshot)
  }, [workflowId])

  const handleNodesChange = React.useCallback(
    (changes: NodeChange<WorkflowFlowNode>[]) => {
      const removedIds = changes.flatMap((change) => (change.type === 'remove' ? [change.id] : []))
      const structural =
        removedIds.length > 0 || changes.some((change) => change.type === 'position')
      if (!structural) {
        // 选择 / 尺寸等视图态：函数式更新基于最新节点集。同一次点击里
        // 节点内的开关 / 按钮可能已先写入配置（setNodes 新图），线性用
        // 本渲染闭包重算会把它覆盖回旧配置
        setNodes((current) => applyNodeChanges(changes, current))
        return
      }
      // 删节点连带剪除相连边（React Flow 只移除节点本体）；位置变更走
      // 无 label 通道（撤销条目由 dragStop 收口统一记）
      const next = applyNodeChanges(changes, nodes)
      const nextEdges = removedIds.length > 0 ? pruneEdgesForNodes(edges, removedIds) : edges
      sync(next, nextEdges, removedIds.length > 0 ? 'delete' : undefined)
    },
    [nodes, edges, sync],
  )

  const handleEdgesChange = React.useCallback(
    (changes: EdgeChange<WorkflowFlowEdge>[]) => {
      if (!changes.some((change) => change.type === 'remove')) {
        // 同节点侧：选择等视图态用函数式更新，不与同一事件里的图变更抢写
        setEdges((current) => applyEdgeChanges(changes, current))
        return
      }
      sync(nodes, applyEdgeChanges(changes, edges), 'delete')
    },
    [nodes, edges, sync],
  )

  const handleConnect = React.useCallback(
    (connection: Connection) => {
      // 条件节点多出口：出边 label＝源 Handle id（分支 id 或 DEFAULT，
      // 引擎选中分支的定位锚）；其余节点出边不带标注——直接连线与连线
      // 面板建边共用同一规则
      const sourceNode = nodes.find((flowNode) => flowNode.id === connection.source)
      const label =
        sourceNode != null
          ? connectEdgeLabel(
              nodeKindOf(sourceNode.data.node.config),
              connection.sourceHandle ?? null,
            )
          : null
      sync(nodes, addEdge<WorkflowFlowEdge>(makeFlowEdge(connection, label), edges), 'connect')
    },
    [nodes, edges, sync],
  )

  /** 单节点配置更新（节点内配置编辑通道）：同节点的连续编辑（逐键输入）
   * 在合并窗内折算一条撤销 */
  const updateNode = React.useCallback(
    (nodeId: string, next: WorkflowNode) => {
      sync(
        nodes.map((flowNode) =>
          flowNode.id === nodeId
            ? { ...flowNode, data: { ...flowNode.data, node: next } }
            : flowNode,
        ),
        edges,
        `config:${nodeId}`,
        true,
      )
    },
    [nodes, edges, sync],
  )

  /** drop 点命中的可绑定节点（待绑定占位或失效引用节点；命中即绑定/重接） */
  const findBindableAt = React.useCallback(
    (point: { x: number; y: number }): WorkflowFlowNode | null => {
      const hit = findNodeAt(nodes, point)
      if (hit == null) return null
      return isBindableDropTarget(hit.data.node.config, invalidRefIds, hit.id) ? hit : null
    },
    [nodes, invalidRefIds],
  )

  /** 选中节点视口自适应（单选时把整卡平移进可视区）：卡片下缘越过「画布
   * 高 − 工具栏让位线」即向上平移越界量（缩放不动），上移会盖住顶缘时按
   * 顶对齐封顶（节点高于可视区时保标题条可见，其余靠自适应视图收图）。
   * 多选 / 清选不介入，已完全可见不落视口动画（避免每次点选都抖动）。 */
  const revealSelectedNode = React.useCallback(
    ({ nodes: selected }: { nodes: WorkflowFlowNode[] }) => {
      if (selected.length !== 1) return
      const flowNode = selected[0]
      const container = canvasRef.current
      if (flowNode == null || container == null) return
      const width = flowNode.measured?.width
      const height = flowNode.measured?.height
      if (width == null || height == null) return
      const zoom = getZoom()
      const viewport = getViewport()
      const screenTop = flowNode.position.y * zoom + viewport.y
      const screenBottom = screenTop + height * zoom
      const overflow = screenBottom - (container.clientHeight - NODE_PICKER_TOOLBAR_CLEARANCE)
      if (overflow <= 0) return
      const delta = Math.min(overflow, Math.max(screenTop - 8, 0))
      if (delta <= 0) return
      void setViewport({ x: viewport.x, y: viewport.y - delta, zoom }, { duration: 200 })
    },
    [getViewport, setViewport, getZoom],
  )

  /** 建节点并并入当前图（拖放落点与面板激活共用的单点路径，位置按
   * DROP_CENTERING 口径回退） */
  const addNodeAt = React.useCallback(
    (kind: WorkflowNodeKind, point: { x: number; y: number }) => {
      const node = makeNode(kind, { x: point.x - DROP_CENTERING.x, y: point.y - DROP_CENTERING.y })
      sync([...nodes, makeFlowNode(node)], edges, 'add')
    },
    [nodes, edges, sync],
  )

  /** 事件坐标 → 面板锚点：换算成画布容器本地坐标并收口在可视区内，底缘
   * 让位线＝画布底减 margin（右键与拉线松手共用同一几何口径）；clientX/Y
   * 保留为建节点落点 */
  const anchorAtClient = React.useCallback(
    (clientX: number, clientY: number): NodePickerAnchor | null => {
      const canvas = canvasRef.current
      if (canvas == null) return null
      const rect = canvas.getBoundingClientRect()
      return {
        ...pickerAnchorLocal(
          clientX - rect.left,
          clientY - rect.top,
          rect,
          rect.height - NODE_PICKER_MARGIN,
        ),
        clientX,
        clientY,
      }
    },
    [],
  )

  /** 打开节点选择面板：anchor 为面板左上角（收口后），nodePoint 为选中
   * 节点后的落点（缺省＝打开坐标） */
  const openPickerAt = React.useCallback(
    (clientX: number, clientY: number, nodePoint?: { x: number; y: number }) => {
      const anchor = anchorAtClient(clientX, clientY)
      if (anchor == null) return
      const point = nodePoint ?? { x: clientX, y: clientY }
      setPickerAnchor({ ...anchor, clientX: point.x, clientY: point.y })
    },
    [anchorAtClient],
  )

  /** 拉线松手（onConnectEnd 通道）：命中已有 handle＝既有直接连线语义
   * （onConnect 已建边或连接无效，均不弹面板、不进临时流程）；松手点落在
   * 已有节点卡片非 handle 处＝视同点别处取消；画布空白处＝即刻挂临时
   * 连线体（占位节点落松手点、临时边从拉线起点接到占位节点，连线全程
   * 可见不断）并弹连线场景节点选择面板。临时体是纯视图态（不入模型、
   * 不触发校验、不进撤销栈），选中候选时占位转正、Esc／点外关闭时整体
   * 撤销 */
  const handleConnectEnd = React.useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.fromHandle == null) return
      if (state.toHandle != null) return
      const point = pointerClientPoint(event)
      const dropPoint = screenToFlowPosition(point)
      if (findNodeAt(nodes, dropPoint) != null) return
      const anchor = anchorAtClient(point.x, point.y)
      if (anchor == null) return
      const direction = connectionDirectionOf(state.fromHandle.type)
      setConnectionPicker({
        anchor,
        direction,
        fromNodeId: state.fromHandle.nodeId,
        fromHandleId: state.fromHandle.id ?? null,
        temp: tempConnectionBody({
          direction,
          fromNodeId: state.fromHandle.nodeId,
          fromHandleId: state.fromHandle.id ?? null,
          tempNodeId: crypto.randomUUID(),
          edgeId: crypto.randomUUID(),
          // 临时体落点与建节点落点同口径：松手点回退半个卡片尺寸
          position: { x: dropPoint.x - DROP_CENTERING.x, y: dropPoint.y - DROP_CENTERING.y },
        }),
      })
    },
    [nodes, screenToFlowPosition, anchorAtClient],
  )

  /** 选中节点：按面板记录的落点转 flow 坐标建节点（与拖放同一建节点路径） */
  const addNodeFromPicker = React.useCallback(
    (kind: WorkflowNodeKind) => {
      if (pickerAnchor == null) return
      addNodeAt(kind, screenToFlowPosition({ x: pickerAnchor.clientX, y: pickerAnchor.clientY }))
      setPickerAnchor(null)
    },
    [pickerAnchor, addNodeAt, screenToFlowPosition],
  )

  /** 连线面板选型：占位节点就地转正——真节点落占位节点位置（落点取自
   * 临时体，缩放漂移不影响转正落点；defaultConfig 经 makeNode 深拷贝）、
   * 转正边与临时边同一两端计划（仅节点身份由占位 id 换为真节点 id），
   * 临时体随面板态清除；节点＋边同批入库＝一次撤销撤净，新节点入选中集
   * （既有选中让位，与粘贴同口径）。分支标注按源节点 kind 在转正时落定
   * （与直接连线共用同一规则），反向建边不带标注的现行规则不变 */
  const addNodeAndConnect = React.useCallback(
    (kind: WorkflowNodeKind, link: ConnectionPickerState) => {
      setConnectionPicker(null)
      const node = makeNode(kind, link.temp.node.position)
      const plan = planConnectionEdge(link.direction, link.fromNodeId, link.fromHandleId, node.id)
      const sourceNode = nodes.find((current) => current.id === plan.sourceId)
      const label =
        sourceNode != null
          ? connectEdgeLabel(nodeKindOf(sourceNode.data.node.config), plan.sourceHandleId)
          : null
      const edge = makeFlowEdge(
        {
          source: plan.sourceId,
          target: plan.targetId,
          sourceHandle: plan.sourceHandleId,
          targetHandle: null,
        },
        label,
      )
      sync(
        [...nodes.map((current) => ({ ...current, selected: false })), makeFlowNode(node, true)],
        [...edges, edge],
        'connect',
      )
    },
    [nodes, edges, sync],
  )

  /** 悬浮工具栏「添加节点」：面板底缘让出工具栏占位、整体悬在操作栏上方
   * （不遮挡运行按钮），落点取画布视口中心 */
  const openPickerFromToolbar = React.useCallback(() => {
    const canvas = canvasRef.current
    if (canvas == null) return
    const rect = canvas.getBoundingClientRect()
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    setPickerAnchor({ ...toolbarPickerAnchorLocal(rect), clientX: center.x, clientY: center.y })
  }, [])

  // —— 画布右键（节点 / 边 / 空白面）：节点与边用坐标菜单（动作全部复用
  // 既有命令路径），空白面打开节点选择面板（节点清单＋空白面动作同一个
  // 浮层）。多选语义按 IDE 惯例：命中节点在当前选中集内则菜单作用于整个
  // 选中集，不在则先单选该节点再作用于它 ——
  const canvasMenu = usePointContextMenu()
  const [menuTarget, setMenuTarget] = React.useState<CanvasMenuTarget | null>(null)

  const openNodeMenu = React.useCallback(
    (event: React.MouseEvent, flowNode: WorkflowFlowNode) => {
      event.preventDefault()
      const hitInSelection = canvasStateRef.current.nodes.some(
        (node) => node.id === flowNode.id && node.selected,
      )
      if (!hitInSelection) {
        // 单选命中节点（选择态为视图变更，不入撤销栈）
        setNodes((current) =>
          current.map((node) => ({ ...node, selected: node.id === flowNode.id })),
        )
      }
      setMenuTarget({ kind: 'node', nodeId: flowNode.id })
      canvasMenu.openAt(event.clientX, event.clientY)
    },
    [canvasMenu],
  )

  const openEdgeMenu = React.useCallback(
    (event: React.MouseEvent, edge: WorkflowFlowEdge) => {
      event.preventDefault()
      setMenuTarget({ kind: 'edge', edgeId: edge.id })
      canvasMenu.openAt(event.clientX, event.clientY)
    },
    [canvasMenu],
  )

  const openPanePicker = React.useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      event.preventDefault()
      setMenuTarget(null)
      openPickerAt(event.clientX, event.clientY)
    },
    [openPickerAt],
  )

  const closeCanvasMenu = React.useCallback(() => canvasMenu.close(), [canvasMenu])

  /** 菜单删除：节点菜单删当前选中集（打开时已保证命中节点入选；删除连带
   * 剪边与撤销记账走 handleNodesChange 单点），边菜单删命中边 */
  const deleteMenuTarget = React.useCallback(() => {
    if (menuTarget?.kind === 'edge') {
      handleEdgesChange([{ id: menuTarget.edgeId, type: 'remove' }])
      return
    }
    const selectedIds = canvasStateRef.current.nodes
      .filter((node) => node.selected)
      .map((node) => node.id)
    if (selectedIds.length === 0) return
    handleNodesChange(selectedIds.map((id) => ({ id, type: 'remove' as const })))
  }, [menuTarget, handleNodesChange, handleEdgesChange])

  /** 空白面选择面板的全选：全部节点入选中集（选择态为视图变更，不入撤销栈） */
  const selectAllCanvasNodes = React.useCallback(() => {
    setNodes((current) => current.map((node) => ({ ...node, selected: true })))
  }, [])

  /** 失效请求节点的重接项显隐：命中节点为已绑定且校验失效的请求节点 */
  const menuRebindNodeId = React.useMemo(() => {
    if (menuTarget?.kind !== 'node') return null
    const hit = nodes.find((node) => node.id === menuTarget.nodeId)
    if (hit == null) return null
    const config = hit.data.node.config
    return config.type === 'request' && config.endpointKey != null && invalidRefIds.has(hit.id)
      ? hit.id
      : null
  }, [menuTarget, nodes, invalidRefIds])

  /** 重接引导：重接本体是接口树拖入（唯一绑定路径），菜单动作只提示操作
   * 方式（与节点卡片失效引导同款文案） */
  const showRebindHint = React.useCallback(() => {
    toast.info(t('workflows.requestRebindHint'))
  }, [t])

  const handleDrop = React.useCallback(
    (event: React.DragEvent) => {
      // 接口树拖入：落占位完成绑定，落空白处创建已绑定请求节点
      const endpointRaw = event.dataTransfer.getData(ENDPOINT_DRAG_MIME)
      if (endpointRaw !== '') {
        const payload = decodeEndpointDragPayload(endpointRaw)
        if (!payload) return
        event.preventDefault()
        const point = screenToFlowPosition({ x: event.clientX, y: event.clientY })
        const placeholder = findBindableAt(point)
        if (placeholder) {
          updateNode(placeholder.id, bindEndpointToNode(placeholder.data.node, payload))
          return
        }
        const node = bindEndpointToNode(
          makeNode('request', { x: point.x - DROP_CENTERING.x, y: point.y - DROP_CENTERING.y }),
          payload,
        )
        sync([...nodes, makeFlowNode(node)], edges, 'add')
        return
      }
      const kind = event.dataTransfer.getData(NODE_DRAG_MIME)
      if (!isWorkflowNodeKind(kind)) return
      event.preventDefault()
      addNodeAt(kind, screenToFlowPosition({ x: event.clientX, y: event.clientY }))
    },
    [addNodeAt, nodes, edges, sync, screenToFlowPosition, findBindableAt, updateNode],
  )

  return (
    <WorkflowIdContext.Provider value={workflowId}>
      <InvalidRefContext.Provider value={invalidRefIds}>
        <NodeUpdateContext.Provider value={updateNode}>
          <RenameRequestContext.Provider value={renameRequest}>
            <div className="relative flex h-full min-h-0 flex-col">
              <div
                ref={canvasRef}
                className="relative min-h-0 flex-1 bg-canvas"
                onDrop={handleDrop}
                onDragOver={(event) => event.preventDefault()}
                data-testid="workflow-canvas"
              >
                <ReactFlow<WorkflowFlowNode, WorkflowFlowEdge>
                  // 连线临时体只在渲染层并入（占位节点带占位类型的
                  // nodeTypes 分发、临时边在样式投影链路之后追加）：
                  // 节点 / 边两个 state 与 sync 出口始终只见真实图
                  nodes={connectionPicker ? [...nodes, connectionPicker.temp.node] : nodes}
                  edges={
                    connectionPicker ? [...styledEdges, connectionPicker.temp.edge] : styledEdges
                  }
                  nodeTypes={NODE_TYPES_WITH_TEMP}
                  onNodesChange={handleNodesChange}
                  onEdgesChange={handleEdgesChange}
                  onConnect={handleConnect}
                  onConnectEnd={handleConnectEnd}
                  onNodeDragStart={handleNodeDragStart}
                  onNodeDragStop={handleNodeDragStop}
                  onSelectionChange={revealSelectedNode}
                  onNodeContextMenu={openNodeMenu}
                  onEdgeContextMenu={openEdgeMenu}
                  onPaneContextMenu={openPanePicker}
                  deleteKeyCode={['Backspace', 'Delete']}
                  fitView
                  minZoom={0.2}
                  maxZoom={2}
                  colorMode={resolvedTheme}
                  defaultEdgeOptions={{
                    markerEnd: { type: MarkerType.ArrowClosed, width: 11, height: 11 },
                  }}
                  proOptions={{ hideAttribution: true }}
                >
                  {/* 单级网点：纸面上的稀疏坐标点（Postman Flow 同款），
                    节点卡靠细边＋投影从纸面浮起 */}
                  <Background
                    id="workflow-grid"
                    variant={BackgroundVariant.Dots}
                    gap={22}
                    size={1.5}
                    color="var(--canvas-dot)"
                  />
                  {/* 缩放控件退到左上（底部中央让给悬浮工具栏）；适配视图在
                    工具栏，控件只留放大 / 缩小两钮 */}
                  <Controls
                    position="top-left"
                    showInteractive={false}
                    showFitView={false}
                    className="!overflow-hidden !rounded-md !border !border-node-line !shadow-node"
                  />
                  {minimapOpen && (
                    <MiniMap
                      position="bottom-left"
                      pannable
                      zoomable
                      className="!rounded-md !border !border-node-line !bg-card !shadow-node"
                      maskColor="color-mix(in oklab, var(--canvas) 72%, transparent)"
                      nodeColor="var(--node-line-strong)"
                    />
                  )}
                </ReactFlow>
                {nodes.length === 0 && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <CanvasEmptyHint />
                  </div>
                )}
                <FloatingToolbar
                  workflowId={workflowId}
                  dirty={session.dirty}
                  running={running}
                  canUndo={canUndo}
                  canRedo={canRedo}
                  onRun={runWorkflow}
                  onStop={stopWorkflow}
                  onUndo={undoEdit}
                  onRedo={redoEdit}
                  onCopy={copyWorkflow}
                  onAutoLayout={autoLayout}
                  minimapOpen={minimapOpen}
                  onToggleMinimap={() => setMinimapOpen((prev) => !prev)}
                  onAddNode={openPickerFromToolbar}
                />
                {pickerAnchor != null && (
                  <NodePicker
                    anchor={pickerAnchor}
                    canPaste={hasClipboard}
                    onClose={() => setPickerAnchor(null)}
                    onAddNode={addNodeFromPicker}
                    onPaste={pasteClipboard}
                    onSelectAll={selectAllCanvasNodes}
                    onAutoLayout={autoLayout}
                  />
                )}
                {connectionPicker != null && (
                  <NodePicker
                    variant="connect"
                    anchor={connectionPicker.anchor}
                    direction={connectionPicker.direction}
                    onClose={() => setConnectionPicker(null)}
                    onAddNode={(kind) => addNodeAndConnect(kind, connectionPicker)}
                  />
                )}
                <CanvasContextMenu
                  open={canvasMenu.open}
                  anchor={canvasMenu.anchor}
                  target={menuTarget}
                  rebindNodeId={menuRebindNodeId}
                  onClose={closeCanvasMenu}
                  onCopy={copySelectedNodes}
                  onPaste={pasteClipboard}
                  onDelete={deleteMenuTarget}
                  onRename={beginRename}
                  onRebindHint={showRebindHint}
                />
              </div>
              <WorkflowBottomConsole
                workflowId={workflowId}
                issues={issues}
                nodeNames={nodeNames}
                onLocate={locateNode}
                activeTab={consoleTab}
                onTabChange={setConsoleTab}
              />
            </div>
          </RenameRequestContext.Provider>
        </NodeUpdateContext.Provider>
      </InvalidRefContext.Provider>
    </WorkflowIdContext.Provider>
  )
}

/** 空画布态：主区大空态——标题＋两行引导，说明两条建节点通道（右键 /
 * 悬浮工具栏添加节点、接口树拖入），而不是一句漂浮的弱色说明 */
function CanvasEmptyHint() {
  const { t } = useI18n()
  const WorkflowIcon = SEMANTIC_ICONS.workflow
  return (
    <Empty className="max-w-sm border-0" data-testid="workflow-canvas-empty">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <WorkflowIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{t('workflows.canvasEmptyTitle')}</EmptyTitle>
        <EmptyDescription className="text-xs">{t('workflows.canvasEmptyHint')}</EmptyDescription>
      </EmptyHeader>
      <p className="text-micro text-muted-foreground/70">{t('workflows.canvasEmptyDropHint')}</p>
    </Empty>
  )
}
