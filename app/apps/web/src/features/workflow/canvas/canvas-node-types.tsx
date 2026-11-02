import { type NodeTypes } from '@xyflow/react'

import { WorkflowNodeCard } from './node-card'
import { NODE_LABEL_KEYS } from './node-meta'
import { TempPlaceholderNode } from './temp-placeholder-node'
import { TEMP_NODE_TYPE } from './connection-picker'
import type { WorkflowNodeKind } from '../workflow-model'

/**
 * 画布 nodeTypes 注册单点：全部 kind 注册同一卡片组件（kind 驱动视觉与
 * 配置面）；kind 全集经 NODE_LABEL_KEYS 的穷尽 Record 派生——新增 kind 漏
 * 更新元数据源时在源头编译报错，此处自动跟随。连线临时体的占位节点与
 * 领域 kind 共用一张分发表（占位键非领域 kind，仅编辑器视图层消费），
 * 组件本体见 temp-placeholder-node.tsx。
 */

const NODE_TYPES = Object.fromEntries(
  Object.keys(NODE_LABEL_KEYS).map((kind) => [kind, WorkflowNodeCard]),
) as Record<WorkflowNodeKind, typeof WorkflowNodeCard>

export const NODE_TYPES_WITH_TEMP: NodeTypes = {
  ...NODE_TYPES,
  [TEMP_NODE_TYPE]: TempPlaceholderNode,
}
