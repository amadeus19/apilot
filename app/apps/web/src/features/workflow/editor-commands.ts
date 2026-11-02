import * as React from 'react'

import {
  PlayIcon,
  SaveIcon,
  SquareIcon,
  Undo2Icon,
  Redo2Icon,
  WandSparklesIcon,
} from 'lucide-react'

import { useTabsStore } from '@/stores/tabs.store'

import { useRegisterCommands } from '@/features/commands/use-register-commands'
import type { CommandDef } from '@/features/commands/types'

import { useWorkflowExecutionStore } from './execution.store'
import { useWorkflowEditorStore } from './workflow-editor.store'

/**
 * 工作流编辑器命令（运行 / 停止 / 保存 / 自动布局 / 撤销 / 重做 / 画布复制
 * 粘贴 / 节点重命名）：编辑 Tab 挂载期注册、卸载注销。动作语义单活在编辑器
 * （在途判定、取消、保存会话、布局、栈操作、画布剪贴板与重命名聚焦），
 * 命令零业务——run 闭包经 ref 直读现值。键位承诺：F5 运行、Shift+F5 停止、
 * Ctrl+S 保存、Ctrl+Shift+L 自动布局、Ctrl+Z 撤销、Ctrl+Shift+Z 与 Ctrl+Y
 * （别名注册）重做、Ctrl+C / Ctrl+V 画布选中集复制粘贴、F2 重命名；非工作流
 * Tab 激活时 when 关断（不吞键）。
 *
 * 与原生文本编辑争用键位的命令（撤销 / 重做 / 画布复制粘贴 / 重命名）统一
 * 声明「输入焦点让键」（yieldsToTextInput，分发器单点执行）；撤销 / 重做的
 * when 另带栈空守卫（无可撤销 / 重做时关断，不吞键也不空转）。画布复制粘贴
 * 在窗口存在选中文本时同样让位（浏览器原生文本复制粘贴），守卫落在 when。
 */

/** 编辑器动作面：键位与右键菜单共用的动作与键位 when 守卫谓词 */
export interface WorkflowEditorActions {
  run: () => void
  stop: () => void
  save: () => void
  autoLayout: () => void
  undo: () => void
  redo: () => void
  /** 复制画布选中集到画布剪贴板（返回 false＝空选中未落载） */
  copySelection: () => boolean
  /** 画布剪贴板粘贴为全新节点并入图（返回 false＝无载荷未落图） */
  pasteSelection: () => boolean
  /** 请求聚焦选中节点重命名（返回 false＝非单选未生效） */
  renameNode: () => boolean
  /** 画布当前是否有选中节点（复制键位 when 守卫） */
  hasSelection: () => boolean
  /** 画布当前是否恰有一个选中节点（重命名键位 when 守卫） */
  hasSingleSelection: () => boolean
  /** 画布剪贴板是否有载荷（粘贴键位 when 守卫） */
  hasClipboard: () => boolean
}

export function useWorkflowEditorCommands(
  workflowId: string,
  actions: WorkflowEditorActions,
): void {
  const actionsRef = React.useRef(actions)
  // 渲染期不写 ref（编译器友好硬约束）：effect 后同步最新动作
  React.useEffect(() => {
    actionsRef.current = actions
  })

  const defs = React.useMemo<CommandDef[]>(
    () => [
      {
        id: 'workflow.run',
        labelKey: 'commandPalette.cmdRunWorkflow',
        icon: PlayIcon,
        group: 'workbench',
        defaultShortcut: 'F5',
        when: () => isWorkflowTabActive(workflowId),
        run: () => actionsRef.current.run(),
      },
      {
        id: 'workflow.stop',
        labelKey: 'commandPalette.cmdStopWorkflow',
        icon: SquareIcon,
        group: 'workbench',
        defaultShortcut: 'Shift+F5',
        when: () => isWorkflowTabActive(workflowId),
        run: () => actionsRef.current.stop(),
      },
      {
        id: 'workflow.save',
        labelKey: 'commandPalette.cmdSaveWorkflow',
        icon: SaveIcon,
        group: 'workbench',
        defaultShortcut: 'Ctrl+S',
        when: () => isWorkflowTabActive(workflowId),
        run: () => actionsRef.current.save(),
      },
      {
        id: 'workflow.autoLayout',
        labelKey: 'commandPalette.cmdAutoLayoutWorkflow',
        icon: WandSparklesIcon,
        group: 'workbench',
        defaultShortcut: 'Ctrl+Shift+L',
        when: () => isWorkflowTabActive(workflowId),
        run: () => actionsRef.current.autoLayout(),
      },
      {
        id: 'workflow.undo',
        labelKey: 'commandPalette.cmdUndoWorkflow',
        icon: Undo2Icon,
        group: 'workbench',
        defaultShortcut: 'Ctrl+Z',
        yieldsToTextInput: true,
        when: () =>
          isWorkflowTabActive(workflowId) && useWorkflowEditorStore.getState().canUndo(workflowId),
        run: () => actionsRef.current.undo(),
      },
      {
        id: 'workflow.redo',
        labelKey: 'commandPalette.cmdRedoWorkflow',
        icon: Redo2Icon,
        group: 'workbench',
        defaultShortcut: 'Ctrl+Shift+Z',
        // Ctrl+Y 别名键位（Windows 惯例重做键）
        aliasShortcuts: ['Ctrl+Y'],
        yieldsToTextInput: true,
        when: () =>
          isWorkflowTabActive(workflowId) && useWorkflowEditorStore.getState().canRedo(workflowId),
        run: () => actionsRef.current.redo(),
      },
      {
        id: 'workflow.copySelection',
        labelKey: 'commandPalette.cmdCopyWorkflowSelection',
        group: 'workbench',
        defaultShortcut: 'Ctrl+C',
        yieldsToTextInput: true,
        // 窗口存在选中文本时让位原生文本复制；空选中不吞键（放行默认行为）
        when: () =>
          isWorkflowTabActive(workflowId) &&
          !hasWindowSelectionText() &&
          actionsRef.current.hasSelection(),
        run: () => {
          actionsRef.current.copySelection()
        },
      },
      {
        id: 'workflow.pasteSelection',
        labelKey: 'commandPalette.cmdPasteWorkflowSelection',
        group: 'workbench',
        defaultShortcut: 'Ctrl+V',
        yieldsToTextInput: true,
        // 窗口存在选中文本时让位原生文本粘贴；无载荷不吞键（放行默认行为）
        when: () =>
          isWorkflowTabActive(workflowId) &&
          !hasWindowSelectionText() &&
          actionsRef.current.hasClipboard(),
        run: () => {
          actionsRef.current.pasteSelection()
        },
      },
      {
        id: 'workflow.renameNode',
        labelKey: 'commandPalette.cmdRenameWorkflowNode',
        group: 'workbench',
        defaultShortcut: 'F2',
        yieldsToTextInput: true,
        // 非单选（多选 / 空选）无重命名语义，不吞键
        when: () => isWorkflowTabActive(workflowId) && actionsRef.current.hasSingleSelection(),
        run: () => {
          actionsRef.current.renameNode()
        },
      },
    ],
    [workflowId],
  )
  useRegisterCommands(defs, [workflowId])
}

/** 窗口当前是否有选中文本（画布复制粘贴键位的让位守卫：选区非空时键位让给
 * 浏览器原生文本复制粘贴） */
function hasWindowSelectionText(): boolean {
  return (window.getSelection()?.toString() ?? '') !== ''
}

/** 当前激活 Tab 是否为指定工作流的编辑 Tab（when 门与编辑器内交互键位
 * 守卫共用：非编辑上下文不吞键） */
export function isWorkflowTabActive(workflowId: string): boolean {
  const { tabs, activeTabId } = useTabsStore.getState()
  const active = tabs.find((tab) => tab.id === activeTabId)
  return active?.kind === 'workflow' && active.key === workflowId
}

/** 编辑器运行/停止钮的在途判定（槽位 running 态单点） */
export function useWorkflowRunning(workflowId: string): boolean {
  return useWorkflowExecutionStore((s) => s.executions[workflowId]?.status === 'running')
}
