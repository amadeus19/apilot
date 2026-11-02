import { create } from 'zustand'

import type { WorkflowGraph } from './workflow-model'

/**
 * 工作流应用内剪贴板（跨空间复制的载体）：纯前端会话态——不入库、不进
 * 会话恢复、不碰系统剪贴板（应用重启即失效，系统剪贴板不被写入）。
 *
 * 载荷＝名称＋整图（节点＋边＋覆写＋参数提取 / 存变量配置＋分类快照名
 * 皆在图内）；粘贴时经 workflow.paste 在目标空间按稳定键解析落地。
 * 引用安全性：编辑图全程不可变更新（applyGraph 整图替换），直接持引用
 * 不会被后续编辑波及，无需深拷贝。
 */

export interface WorkflowClipboardEntry {
  name: string
  graph: WorkflowGraph
}

interface WorkflowClipboardState {
  entry: WorkflowClipboardEntry | null
  /** 复制（后写覆盖先写——剪贴板单槽） */
  copy: (entry: WorkflowClipboardEntry) => void
  clear: () => void
}

export const useWorkflowClipboardStore = create<WorkflowClipboardState>((set) => ({
  entry: null,
  copy: (entry) => set({ entry }),
  clear: () => set({ entry: null }),
}))
