import * as React from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@workspace/ui/components'

import { useI18n } from '@/i18n'
import { useTabsStore, type TabMeta } from '@/stores/tabs.store'

import { useWorkflowEditorStore } from './workflow-editor.store'
import { useWorkflowExecutionStore } from './execution.store'

/**
 * 工作流 Tab 关闭编排（域内单点，标签栏关闭路径与删除联动共用）：
 * dirty 守卫（受影响范围存在未保存编辑会话 → 弹确认：保存并关闭 /
 * 不保存关闭 / 取消）→ 执行调用方注入的关闭动作 → 回收。回收对比动作
 * 前后的 Tab 清单，对确实关闭的工作流 Tab 释放编辑会话并 dispose 执行槽
 * （含取消在途执行，幂等）。删除联动已过删除确认（工作流即将不存在，
 * 脏编辑必然丢弃），直接走回收关闭，不过守卫弹层。
 */

/** 执行关闭动作并回收被关闭工作流 Tab 的编辑会话与执行槽（一切关闭路径
 *  单出口）：只回收动作前存在于 Tab 清单、动作后消失的工作流 Tab——
 *  关闭动作未波及的 Tab 不动 */
export function reclaimClosedWorkflowTabs(action: () => void): void {
  const before = new Map(
    useTabsStore
      .getState()
      .tabs.filter((tab) => tab.kind === 'workflow' && tab.key)
      .map((tab) => [tab.key!, tab.id]),
  )
  action()
  const after = new Set(useTabsStore.getState().tabs.map((tab) => tab.id))
  const editorStore = useWorkflowEditorStore.getState()
  const executionStore = useWorkflowExecutionStore.getState()
  for (const [key, tabId] of before) {
    if (!after.has(tabId)) {
      editorStore.discard(key)
      executionStore.dispose(key)
    }
  }
}

/** 未保存工作流 Tab 判定（守卫数据源；只认编辑会话的 dirty 标记） */
function isDirtyWorkflowTab(tab: TabMeta): boolean {
  return (
    tab.kind === 'workflow' &&
    tab.key !== undefined &&
    useWorkflowEditorStore.getState().sessions[tab.key]?.dirty === true
  )
}

/** 待决策的脏态关闭（弹层挂起期间持有；取消＝仅丢弃此状态） */
interface PendingClose {
  /** 脏会话键（＝工作流 id，保存通道的入参） */
  dirtyIds: string[]
  /** 脏 Tab 标题（弹层描述文案） */
  names: string[]
  /** 确认后执行的关闭动作 */
  action: () => void
}

/**
 * 工作流脏态关闭守卫（标签栏专用入口）：guardClose 对受影响 Tab 过守卫，
 * 无脏直接执行回收关闭；有脏挂起弹层待用户三选。closeGuardDialog 是与
 * 挂起状态配套的确认弹层，由调用方渲染在自身 JSX 内。
 */
export function useWorkflowCloseGuard(): {
  guardClose: (affected: readonly TabMeta[], action: () => void) => void
  closeGuardDialog: React.ReactNode
} {
  const { t } = useI18n()
  const [pending, setPending] = React.useState<PendingClose | null>(null)

  /** 关闭动作统一入口：先过脏态守卫，无脏（或确认后）才执行 */
  const guardClose = (affected: readonly TabMeta[], action: () => void): void => {
    const dirty = affected.filter(isDirtyWorkflowTab)
    if (dirty.length === 0) {
      reclaimClosedWorkflowTabs(action)
      return
    }
    setPending({
      dirtyIds: dirty.map((tab) => tab.key!),
      names: dirty.map((tab) => tab.title),
      action,
    })
  }

  /** 保存并关闭：全部保存成功才执行关闭；任一保存失败（脏态仍在）中止，
      错误已由 store 统一上报，用户可重试 */
  const saveAndClose = async (): Promise<void> => {
    if (!pending) return
    const editorStore = useWorkflowEditorStore.getState()
    for (const id of pending.dirtyIds) {
      await editorStore.saveSession(id)
    }
    const sessions = useWorkflowEditorStore.getState().sessions
    const stillDirty = pending.dirtyIds.some((id) => sessions[id]?.dirty === true)
    if (!stillDirty) reclaimClosedWorkflowTabs(pending.action)
    setPending(null)
  }

  const closeGuardDialog = (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('workflows.closeConfirmTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('workflows.closeConfirmDescription', {
              names: pending?.names.join('、') ?? '',
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('workflows.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant="outline"
            onClick={() => {
              if (pending) reclaimClosedWorkflowTabs(pending.action)
              setPending(null)
            }}
            data-testid="tabbar-close-discard"
          >
            {t('workflows.closeConfirmDiscard')}
          </AlertDialogAction>
          <AlertDialogAction onClick={() => void saveAndClose()} data-testid="tabbar-close-save">
            {t('workflows.closeConfirmSave')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  return { guardClose, closeGuardDialog }
}
