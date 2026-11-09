import * as React from 'react'

import { Handle, Position, type NodeProps } from '@xyflow/react'
import { TriangleAlertIcon } from 'lucide-react'

import { cn } from 'cn'

import { useI18n } from '@/i18n'

import { nodeKindOf, type WorkflowNode, type WorkflowPanelGroup } from '../workflow-model'
import type { WorkflowFlowNode } from '../canvas-converter'
import { useWorkflowEditorStore, type WorkflowEditorSession } from '../workflow-editor.store'
import { WorkflowIdContext } from './workflow-id-context'
import { InvalidRefContext } from './validation-context'
import { NODE_ICONS, NODE_LABEL_KEYS, NODE_META } from './node-meta'
import {
  isHttpSuccessStatus,
  useNodeExecutionClasses,
  useNodeExecutionState,
} from './execution-state'
import { NodeExecutionBadge } from './execution-visual'
import { NodeUpdateContext, RenameRequestContext } from './node-editing-context'
import { RequestEditor } from './request-editor'
import { ExtractEditor } from './data-editor'
import { ConditionEditor, JoinEditor } from './logic-editor'
import { DelayEditor, RetryEditor } from './control-editor'
import { AssertEditor } from './assert-editor'

/** Default 兜底出口的 Handle id（与领域边 label 词对齐——引擎选中分支的定位锚） */
const DEFAULT_HANDLE_ID = 'DEFAULT'

/** 连线锚点：卡片底色描边的小「孔」，悬停节点时点亮为主线色 */
const HANDLE_CLASS = '!size-2 !border-2 !border-card !bg-node-line-strong group-hover:!bg-primary'

/** 标题条分组色（低饱和提示节点类别，不承担状态编码） */
const HEAD_TINT: Record<WorkflowPanelGroup, string> = {
  flow: 'bg-node-head-neutral',
  request: 'bg-node-head-request',
  data: 'bg-node-head-data',
  logic: 'bg-node-head-logic',
  control: 'bg-node-head-neutral',
}

/** 标题条图标配色：与分组色同源的小面积强调（请求绿 / 数据琥珀 / 逻辑蓝） */
const HEAD_ICON: Record<WorkflowPanelGroup, string> = {
  flow: 'text-muted-foreground',
  request: 'text-success',
  data: 'text-warning',
  logic: 'text-primary',
  control: 'text-muted-foreground',
}

/** 过程节点卡片宽度：配置编辑面按 256px 排（输入行两列不挤）；无配置的
 * 并行节点收窄，避免空白卡占出多余的画布面积 */
const PROCESS_WIDTH: Partial<Record<string, string>> = { parallel: 'w-44' }

/** 会话图内按 id 取节点（会话缺席 / 节点不在图内返回 undefined） */
function findSessionNode(
  session: WorkflowEditorSession | undefined,
  id: string,
): WorkflowNode | undefined {
  return session?.graph.nodes.find((node) => node.id === id)
}

/**
 * 节点内容（名称＋配置）的同拍数据源：编辑会话图优先，data.node 兜底。
 *
 * React Flow 受控 nodes 经 effect 异步灌入其内部 store，自定义节点拿到的
 * data.node 比键入晚一拍——节点内受控输入（Body 覆写、覆写行、名称等）在
 * 输入事件收尾时先被 React 回写成旧值（光标随之落到末尾），新值随后才到，
 * 表现为中间插入时光标跳尾。会话图在更新通道（sync）内同步落定，节点内
 * 输入读它即与键入同拍。名称与配置分开订阅：会话图每次整图重建，但未改动
 * 节点的 config 引用与 name 原值不变，无关节点不重渲。会话图里没有的节点
 * （会话缺席等）回落 data.node。
 */
function useSessionNodeContent(id: string, fallback: WorkflowNode): WorkflowNode {
  const workflowId = React.useContext(WorkflowIdContext)
  const name = useWorkflowEditorStore((s) =>
    workflowId != null ? findSessionNode(s.sessions[workflowId], id)?.name : undefined,
  )
  const config = useWorkflowEditorStore((s) =>
    workflowId != null ? findSessionNode(s.sessions[workflowId], id)?.config : undefined,
  )
  return React.useMemo(
    () => (name === undefined || config === undefined ? fallback : { ...fallback, name, config }),
    [fallback, name, config],
  )
}

/**
 * 工作流节点卡片（11 类共用壳，kind 驱动图标、标题条分组色与配置编辑面）：
 * Postman Flow 式「配置即节点内容」——名称在标题条内双击编辑，配置编辑面
 * 直接铺在卡片里（不再有右侧属性面板），卡片本身就是配置与状态的唯一落点。
 *
 * 两层读法：标题条（图标 / 名称 / 引用态 / 执行状态）＋配置编辑面。
 * 开始 / 结束是胶囊终端节点（无配置面），过程节点才是白卡——图形有节奏。
 * 请求节点附加引用态——已绑定＝配置面内的接口行（方法徽标＋路径稳定键），
 * 待绑定＝虚线边＋标题条「待绑定」chip，失效引用＝警示实线边＋警示图标
 * （方法与路径留痕恒可见，区别于待绑定态）；响应状态码进标题条行尾。
 * Handle 拓扑：开始只有右出口、结束只有左入口、条件节点每个分支＋Default
 * 各一出口（Handle id＝分支 id / DEFAULT，与边 label 对齐）、其余双侧。
 * 执行期视觉：右上角状态徽标＋整卡着色 (success / running 脉冲 / 弱化 / 错误色)，
 * 条件节点执行通过后附加「✓ 表达式 → 分支」摘要行；状态源为执行事件 store，
 * 纯渲染不轮询。失效态为校验解析的派生态（经 context 注入），不落库。
 */
export function WorkflowNodeCard({ id, data, selected }: NodeProps<WorkflowFlowNode>) {
  const { t } = useI18n()
  const node = useSessionNodeContent(id, data.node)
  const kind = nodeKindOf(node.config)
  const Icon = NODE_ICONS[kind]
  const request = kind === 'request' && node.config.type === 'request' ? node.config : null
  const unbound = request != null && request.endpointKey == null
  const invalidRefs = React.useContext(InvalidRefContext)
  const invalid = request != null && !unbound && invalidRefs.has(id)
  const executionClass = useNodeExecutionClasses(id)
  const executionState = useNodeExecutionState(id)
  const branches =
    kind === 'condition' && node.config.type === 'condition' ? node.config.branches : []
  // 条件节点执行通过后的摘要行（「✓ 表达式 → 分支」，Rust 侧产物原文）
  const conditionSummary =
    kind === 'condition' && executionState?.status === 'passed' ? executionState.output : undefined
  // 请求节点执行响应状态码（明细只经终态记录播种进入，过程态无；数字
  // 本身即非色彩通道，非 2xx 附加警示色与「传输成功」区分）
  const responseStatus = executionState?.response?.status
  const configurable = kind !== 'start' && kind !== 'end' && kind !== 'parallel'

  // 终端节点（开始 / 结束）：胶囊形态，只承载「流程从哪里起、到哪里止」，
  // 不是可配置的过程节点——与白卡拉开形态差，流程图因此有起止节奏
  if (kind === 'start' || kind === 'end') {
    return (
      <div
        className={cn(
          'group relative flex h-7 items-center gap-1.5 rounded-full border border-node-line bg-card pr-3 pl-2.5 text-foreground/80 shadow-node transition-colors',
          executionClass,
        )}
        data-testid={`workflow-node-${kind}`}
      >
        {kind === 'end' && (
          <Handle type="target" position={Position.Left} className={HANDLE_CLASS} />
        )}
        <NodeExecutionBadge nodeId={id} />
        <Icon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        <NodeTitle node={node} id={id} className="max-w-24" />
        {kind === 'start' && (
          <Handle type="source" position={Position.Right} className={HANDLE_CLASS} />
        )}
      </div>
    )
  }

  return (
    <div
      className={cn(
        'group relative rounded-lg border bg-card shadow-node transition-[box-shadow,border-color]',
        PROCESS_WIDTH[kind] ?? 'w-64',
        selected
          ? 'border-primary shadow-node-raised ring-2 ring-primary/20'
          : 'border-node-line hover:border-node-line-strong hover:shadow-node-raised',
        unbound && 'border-dashed',
        invalid && 'border-destructive',
        executionClass,
      )}
      data-testid={`workflow-node-${kind}`}
      data-bound={request ? String(!unbound) : undefined}
      data-invalid={request ? String(invalid) : undefined}
    >
      <Handle type="target" position={Position.Left} className={HANDLE_CLASS} />
      <NodeExecutionBadge nodeId={id} />
      <div
        className={cn(
          'flex h-8 items-center gap-1.5 border-b border-node-line/70 px-2 select-none',
          HEAD_TINT[NODE_META[kind].group],
          configurable ? 'rounded-t-lg' : 'rounded-lg border-b-0',
        )}
      >
        <Icon
          aria-hidden
          className={cn(
            'size-3.5 shrink-0',
            unbound ? 'text-muted-foreground/60' : HEAD_ICON[NODE_META[kind].group],
          )}
        />
        <NodeTitle node={node} id={id} />
        {unbound && (
          <span className="shrink-0 rounded-sm bg-background/70 px-1 py-0.5 text-micro leading-none text-muted-foreground">
            {t('workflows.requestUnbound')}
          </span>
        )}
        {responseStatus != null && (
          <span
            className={cn(
              'shrink-0 font-mono text-micro tabular-nums',
              isHttpSuccessStatus(responseStatus) ? 'text-success' : 'text-destructive',
            )}
            data-testid="workflow-node-request-status"
          >
            {responseStatus}
          </span>
        )}
        {invalid && <TriangleAlertIcon aria-hidden className="size-3 shrink-0 text-destructive" />}
      </div>
      {configurable && (
        <div
          className="nodrag nowheel space-y-2 p-2.5"
          data-testid={`workflow-node-config-${kind}`}
        >
          <NodeConfigEditor node={node} />
        </div>
      )}
      {conditionSummary != null && (
        <div
          className="rounded-b-lg border-t border-node-line/70 bg-success/5 px-2.5 py-1 text-micro text-success"
          title={conditionSummary}
        >
          <span className="block truncate">{conditionSummary}</span>
        </div>
      )}
      {kind !== 'condition' && (
        <Handle type="source" position={Position.Right} className={HANDLE_CLASS} />
      )}
      {/* Handle 拓扑按 kind 条件渲染（多出口的数量与 Handle id 依赖分支集），
          暂留组件内——拓扑随 kind 的护栏待后续 */}
      {kind === 'condition' && node.config.type === 'condition' && (
        <>
          {branches.map((branch, index) => (
            <Handle
              key={branch.id}
              type="source"
              id={branch.id}
              position={Position.Right}
              style={{ top: `${((index + 1) / (branches.length + 1)) * 100}%` }}
              className={HANDLE_CLASS}
            />
          ))}
          <Handle
            type="source"
            id={DEFAULT_HANDLE_ID}
            position={Position.Right}
            style={{ top: '100%' }}
            className={HANDLE_CLASS}
          />
        </>
      )}
    </div>
  )
}

/** 标题条名称：展示态是纯文本（双击进入编辑），编辑态是窄输入框。
 * 外部重命名请求（右键菜单 / F2）经 RenameRequestContext 的 seq 递增
 * 驱动进入编辑态并聚焦全选。 */
function NodeTitle({
  node,
  id,
  className,
}: {
  node: WorkflowNode
  id: string
  /** 展示态宽度约束（终端胶囊限宽，过程节点占满剩余宽度） */
  className?: string
}) {
  const { t } = useI18n()
  const updateNode = React.useContext(NodeUpdateContext)
  const renameRequest = React.useContext(RenameRequestContext)
  const [editing, setEditing] = React.useState(false)
  const [handledSeq, setHandledSeq] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const renameSeq = renameRequest?.nodeId === id ? renameRequest.seq : 0
  // 渲染期调整：外部重命名请求到达即进入编辑态（seq 收敛后不再触发）
  if (renameSeq !== handledSeq) {
    setHandledSeq(renameSeq)
    if (renameSeq > 0) setEditing(true)
  }
  // 聚焦是外部系统同步（DOM focus），编辑态成立后执行一次
  React.useEffect(() => {
    if (!editing) return
    const input = inputRef.current
    if (input == null) return
    input.focus()
    input.select()
  }, [editing, handledSeq])

  const kind = nodeKindOf(node.config)
  const label = node.name !== '' ? node.name : t(NODE_LABEL_KEYS[kind])
  if (editing) {
    return (
      <input
        ref={inputRef}
        value={node.name}
        placeholder={t(NODE_LABEL_KEYS[kind])}
        aria-label={t('workflows.nodeName')}
        data-testid="workflow-node-name-input"
        className="nodrag min-w-0 flex-1 rounded-sm bg-background/80 px-1 text-xs font-medium ring-1 ring-ring/40 outline-none"
        onChange={(event) => updateNode(id, { ...node, name: event.target.value })}
        onBlur={() => setEditing(false)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur()
        }}
      />
    )
  }
  return (
    <span
      className={cn('min-w-0 flex-1 truncate text-xs font-medium', className)}
      title={label}
      onDoubleClick={() => setEditing(true)}
    >
      {label}
    </span>
  )
}

/** 配置编辑面分发：kind 对应编辑面直接铺在节点卡片内（请求节点需 nodeId
 * 定位失效引用，其余只面对自己的配置变体）。更新经 NodeUpdateContext
 * 落回编辑器，与其他编辑同一合并窗撤销通道。 */
function NodeConfigEditor({ node }: { node: WorkflowNode }) {
  const updateNode = React.useContext(NodeUpdateContext)
  const config = node.config
  switch (config.type) {
    case 'request':
      return (
        <RequestEditor
          nodeId={node.id}
          config={config}
          onChange={(next) => updateNode(node.id, { ...node, config: next })}
        />
      )
    case 'extract':
      return (
        <ExtractEditor
          nodeId={node.id}
          config={config}
          onChange={(next) => updateNode(node.id, { ...node, config: next })}
        />
      )
    case 'condition':
      return (
        <ConditionEditor
          config={config}
          onChange={(next) => updateNode(node.id, { ...node, config: next })}
        />
      )
    case 'join':
      return (
        <JoinEditor
          config={config}
          onChange={(next) => updateNode(node.id, { ...node, config: next })}
        />
      )
    case 'delay':
      return (
        <DelayEditor
          config={config}
          onChange={(next) => updateNode(node.id, { ...node, config: next })}
        />
      )
    case 'retry':
      return (
        <RetryEditor
          config={config}
          onChange={(next) => updateNode(node.id, { ...node, config: next })}
        />
      )
    case 'assert':
      return (
        <AssertEditor
          config={config}
          onChange={(next) => updateNode(node.id, { ...node, config: next })}
        />
      )
    default:
      return null
  }
}
