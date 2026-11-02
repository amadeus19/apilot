import * as React from 'react'

/**
 * 编辑器上下文（画布组件树内可用）：工作流 id——节点卡片 / 执行面板读执行
 * 态槽位的寻址键。React Flow 的 nodeTypes 组件不接收额外 props，经 context
 * 注入而不污染节点 data（data 恒为领域节点）。
 */
export const WorkflowIdContext = React.createContext<string | null>(null)
