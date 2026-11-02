import * as React from 'react'

import type { WorkflowNode } from '../workflow-model'

/**
 * 节点编辑接缝：画布节点卡是 React Flow 注册组件，拿不到编辑器实例的
 * 编辑回调——配置编辑与改名经 context 注入，卡片只声明「改了什么」。
 */

/** 单节点整体更新（名称与 config 同一合并窗撤销通道） */
export const NodeUpdateContext = React.createContext<(nodeId: string, next: WorkflowNode) => void>(
  () => {},
)

/** 外部重命名请求：seq 递增即请求命中节点进入名称编辑态（右键菜单 / F2） */
export interface RenameRequest {
  nodeId: string
  seq: number
}

export const RenameRequestContext = React.createContext<RenameRequest | null>(null)
