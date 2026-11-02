import {
  CirclePlayIcon,
  CircleStopIcon,
  FilterIcon,
  GitForkIcon,
  MergeIcon,
  RotateCcwIcon,
  SendIcon,
  ShieldCheckIcon,
  SplitIcon,
  TimerIcon,
  type LucideIcon,
} from 'lucide-react'

import type { DictKey } from '@/i18n'

import type { WorkflowNodeConfig, WorkflowNodeKind, WorkflowPanelGroup } from '../workflow-model'
import { nodeKindOf, type WorkflowNode } from '../workflow-model'

/**
 * 节点静态知识单一事实源：kind → 图标 / 文案键 / 一句话说明 / 面板归组 /
 * 新节点默认配置（节点卡片、右键节点选择面板、拖放工厂三处共用，防映射
 * 漂移）。Record 键穷尽于 WorkflowNodeKind——新增 kind 漏登记时在此编译
 * 报错。键序即 kind 声明序：面板派生的组内顺序与图标 / 文案的呈现都跟随它。
 * 图标为工作流域节点语义（feature 级，不进全局 SEMANTIC_ICONS——那是
 * 应用壳视图 / 导航语义的事实源）。
 */

/** 节点拖拽载荷 MIME（画布 drop 端识别用；外部拖入通道与测试共用） */
export const NODE_DRAG_MIME = 'application/x-apilot-workflow-node'

/** 单个 kind 的静态元知识。defaultConfig 为模块级常量，消费方须深拷贝后使用。 */
export interface NodeMeta {
  icon: LucideIcon
  labelKey: DictKey
  /** 一句话说明（右键节点选择面板的第二行，说明「这类节点做什么」） */
  descriptionKey: DictKey
  group: WorkflowPanelGroup
  defaultConfig: WorkflowNodeConfig
}

export const NODE_META: Record<WorkflowNodeKind, NodeMeta> = {
  start: {
    icon: CirclePlayIcon,
    labelKey: 'workflows.nodeStart',
    descriptionKey: 'workflows.nodeDescStart',
    group: 'flow',
    defaultConfig: { type: 'start' },
  },
  end: {
    icon: CircleStopIcon,
    labelKey: 'workflows.nodeEnd',
    descriptionKey: 'workflows.nodeDescEnd',
    group: 'flow',
    defaultConfig: { type: 'end' },
  },
  request: {
    icon: SendIcon,
    labelKey: 'workflows.nodeRequest',
    descriptionKey: 'workflows.nodeDescRequest',
    group: 'request',
    defaultConfig: {
      type: 'request',
      endpointKey: null,
      query: [],
      pathParams: [],
      body: null,
      timeoutMs: null,
    },
  },
  extract: {
    icon: FilterIcon,
    labelKey: 'workflows.nodeExtract',
    descriptionKey: 'workflows.nodeDescExtract',
    group: 'data',
    defaultConfig: {
      type: 'extract',
      source: 'jsonPath',
      // 播种一条空规则：落画布即可直接填路径与产物名
      rules: [{ path: '', name: '' }],
      writeback: { enabled: false, productPath: '', key: '', categoryName: null, secret: true },
    },
  },
  condition: {
    icon: SplitIcon,
    labelKey: 'workflows.nodeCondition',
    descriptionKey: 'workflows.nodeDescCondition',
    group: 'logic',
    defaultConfig: { type: 'condition', branches: [] },
  },
  parallel: {
    icon: GitForkIcon,
    labelKey: 'workflows.nodeParallel',
    descriptionKey: 'workflows.nodeDescParallel',
    group: 'logic',
    defaultConfig: { type: 'parallel' },
  },
  join: {
    icon: MergeIcon,
    labelKey: 'workflows.nodeJoin',
    descriptionKey: 'workflows.nodeDescJoin',
    group: 'logic',
    defaultConfig: { type: 'join', mode: 'all' },
  },
  delay: {
    icon: TimerIcon,
    labelKey: 'workflows.nodeDelay',
    descriptionKey: 'workflows.nodeDescDelay',
    group: 'control',
    defaultConfig: { type: 'delay', durationMs: 0 },
  },
  retry: {
    icon: RotateCcwIcon,
    labelKey: 'workflows.nodeRetry',
    descriptionKey: 'workflows.nodeDescRetry',
    group: 'control',
    defaultConfig: { type: 'retry', maxAttempts: 0, intervalMs: 0 },
  },
  assert: {
    icon: ShieldCheckIcon,
    labelKey: 'workflows.nodeAssert',
    descriptionKey: 'workflows.nodeDescAssert',
    group: 'control',
    defaultConfig: { type: 'assert', rules: [] },
  },
}

const META_KINDS = Object.keys(NODE_META) as WorkflowNodeKind[]

/** kind → 图标（NODE_META 投影，保持既有导入面）。 */
export const NODE_ICONS: Record<WorkflowNodeKind, LucideIcon> = Object.fromEntries(
  META_KINDS.map((kind) => [kind, NODE_META[kind].icon]),
) as Record<WorkflowNodeKind, LucideIcon>

/** kind → 文案键（NODE_META 投影，保持既有导入面）。 */
export const NODE_LABEL_KEYS: Record<WorkflowNodeKind, DictKey> = Object.fromEntries(
  META_KINDS.map((kind) => [kind, NODE_META[kind].labelKey]),
) as Record<WorkflowNodeKind, DictKey>

/** 节点展示名（空名回落 kind 本地化名的兜底单点）：面板节点名、控制台与
 * 粘贴报告等一切节点名呈现共用，兜底口径不出现第二份。 */
export function nodeDisplayName(
  node: Pick<WorkflowNode, 'name' | 'config'>,
  t: (key: DictKey) => string,
): string {
  return node.name !== '' ? node.name : t(NODE_META[nodeKindOf(node.config)].labelKey)
}

/** kind → 一句话说明键（右键节点选择面板消费）。 */
export const NODE_DESC_KEYS: Record<WorkflowNodeKind, DictKey> = Object.fromEntries(
  META_KINDS.map((kind) => [kind, NODE_META[kind].descriptionKey]),
) as Record<WorkflowNodeKind, DictKey>

/** 节点选择面板五组（顺序即面板呈现顺序；每组 kind 集按 NODE_META 归组
 * 派生，组内顺序跟随 NODE_META 键序——新增 kind 只登记表即可入面板）。 */
export const PALETTE_GROUPS: readonly {
  id: WorkflowPanelGroup
  labelKey: DictKey
  kinds: readonly WorkflowNodeKind[]
}[] = (
  [
    { id: 'flow', labelKey: 'workflows.groupFlow' },
    { id: 'request', labelKey: 'workflows.groupRequest' },
    { id: 'data', labelKey: 'workflows.groupData' },
    { id: 'logic', labelKey: 'workflows.groupLogic' },
    { id: 'control', labelKey: 'workflows.groupControl' },
  ] as const
).map((group) => ({
  ...group,
  kinds: META_KINDS.filter((kind) => NODE_META[kind].group === group.id),
}))
