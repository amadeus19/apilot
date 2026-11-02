import { create } from 'zustand'

import type { ImportGroupCheck } from './import-groups'

/**
 * 工作空间域会话态：对话框状态机（工作空间 / 服务的新建、编辑与删除确认，
 * 与批量导入向导）＋导入向导步骤数据。对话框提交后的 IPC 变更归 api.ts 的
 * mutation hooks，本 store 只持交互态（GUI 交互测试面）。
 *
 * 另持左栏工作空间树的会话态（不落库，纯内存）：树选中行＝正在查看详情的
 * 工作空间（详情打开与右键菜单上下文共用），展开集＝用户手动展开的空间。
 */

/** 管理视图对话框形态（服务表单复用接口树的同语义：名称 + 可选文档地址） */
export type WorkspacesDialog =
  | { type: 'ws-new' }
  | { type: 'ws-rename'; id: string; name: string }
  | { type: 'ws-delete'; id: string; name: string }
  | { type: 'service-new'; workspaceId: string }
  | { type: 'service-edit'; id: string; name: string; docUrl: string | null }
  | { type: 'service-delete'; id: string; name: string }
  | { type: 'import'; workspaceId: string }

/** 导入向导步骤：entry＝输入入口页地址；groups＝勾选发现分组 */
export type ImportStep = 'entry' | 'groups'

interface WorkspacesState {
  dialog: WorkspacesDialog | null
  openDialog: (dialog: WorkspacesDialog) => void
  closeDialog: () => void

  // —— 导入向导（dialog=import 期间有效；关闭即重置） ——
  importStep: ImportStep
  importEntryUrl: string
  /** 发现分组（含查重标注）；空数组＝尚未发现 */
  importGroups: ImportGroupCheck[]
  /** 勾选索引集（importGroups 的下标） */
  importChecked: number[]
  beginImport: (workspaceId: string) => void
  setImportEntryUrl: (url: string) => void
  /** 发现成功：进入勾选步（checked 为默认勾选，调用方经纯函数计算） */
  importDiscovered: (groups: ImportGroupCheck[], checked: number[]) => void
  /** 发现失败退回输入步（保留已输入地址便于修正） */
  backToImportEntry: () => void
  toggleImportChecked: (index: number) => void
  /** 批量置勾选集（表头全选传可勾全集 / 清空传空数组两用），保持升序不变式 */
  setImportChecked: (indexes: number[]) => void

  // —— 左栏工作空间树会话态 ——
  /** 正在查看详情的工作空间（树选中行；无选中＝null） */
  treeSelectedWorkspaceId: string | null
  setTreeSelectedWorkspace: (id: string | null) => void
  /** 树中已展开的工作空间 id 集 */
  treeExpandedIds: string[]
  setTreeExpandedIds: (ids: string[]) => void
}

export const useWorkspacesStore = create<WorkspacesState>((set) => ({
  dialog: null,
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () =>
    set({
      dialog: null,
      importStep: 'entry',
      importEntryUrl: '',
      importGroups: [],
      importChecked: [],
    }),

  importStep: 'entry',
  importEntryUrl: '',
  importGroups: [],
  importChecked: [],
  beginImport: (workspaceId) =>
    set({
      dialog: { type: 'import', workspaceId },
      importStep: 'entry',
      importGroups: [],
      importChecked: [],
    }),
  setImportEntryUrl: (url) => set({ importEntryUrl: url }),
  importDiscovered: (groups, checked) =>
    set({ importGroups: groups, importChecked: checked, importStep: 'groups' }),
  backToImportEntry: () => set({ importStep: 'entry', importGroups: [], importChecked: [] }),
  toggleImportChecked: (index) =>
    set((state) => ({
      importChecked: state.importChecked.includes(index)
        ? state.importChecked.filter((i) => i !== index)
        : [...state.importChecked, index].sort((a, b) => a - b),
    })),
  setImportChecked: (indexes) => set({ importChecked: [...indexes].sort((a, b) => a - b) }),

  treeSelectedWorkspaceId: null,
  setTreeSelectedWorkspace: (id) => set({ treeSelectedWorkspaceId: id }),
  treeExpandedIds: [],
  setTreeExpandedIds: (ids) => set({ treeExpandedIds: ids }),
}))
