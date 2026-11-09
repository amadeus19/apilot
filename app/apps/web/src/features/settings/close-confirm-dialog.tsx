import * as React from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Checkbox,
} from '@workspace/ui/components'

import { useI18n } from '@/i18n'
import type { CloseBehaviorAction } from '@/lib/settings-schema'
import { reportError } from '@/services/error-center'
import { flushAllForExit } from '@/services/exit-flush'
import { confirmExit, hideToTray } from '@/services/ipc'
import { useCloseConfirmStore } from '@/stores/close-confirm.store'
import { useSettingsStore } from '@/stores/settings.store'

/**
 * 关闭确认弹窗（根部挂载）：Rust ask 分支 emit `app://close-requested`（语义＝
 * 询问用户）后呈现，用户在「最小化到托盘」与「退出应用」间选择；Esc / 点弹窗
 * 外＝取消，不绑任何动作（Rust 侧同样不关窗，窗口原样保留）。
 *
 * 「记住我的选择」写入 closeBehavior 设置，下次关闭不再询问；选择即执行——
 * 先写设置再动作，动作失败不回滚已记住的选择（settings store 不回滚口径），
 * 失败经统一错误协议 toast 呈现。
 *
 * 点外取消：Base UI 的 alertdialog 固定禁用 pointer dismissal（防误点的强制
 * 决策语义），与本弹窗「点外＝取消」的产品要求不同——这里自行监听 pointerdown
 * 补足：按下点在弹窗内容之外即视为取消。
 */

/** 弹窗可选择的动作（ask 是设置面板的「每次询问」，不是弹窗选项） */
type ConfirmAction = Exclude<CloseBehaviorAction, 'ask'>

async function performCloseAction(action: ConfirmAction): Promise<void> {
  if (action === 'tray') {
    await hideToTray()
    return
  }
  // 退出前全量收尾（会话保存 + 草稿 flush；逐项容错），随后 Rust 放行完整退出序列
  await flushAllForExit()
  await confirmExit()
}

export function CloseConfirmDialog() {
  const { t } = useI18n()
  const pending = useCloseConfirmStore((s) => s.pending)
  const clear = useCloseConfirmStore((s) => s.clear)
  const setCloseBehavior = useSettingsStore((s) => s.setCloseBehavior)

  // 「记住我的选择」默认不勾：每次弹出重置（渲染期调整模式追踪 pending 上升沿，
  // 弹窗根部常驻挂载，状态不能跨次保留）
  const [remember, setRemember] = React.useState(false)
  const [prevPending, setPrevPending] = React.useState(pending)
  if (pending !== prevPending) {
    setPrevPending(pending)
    if (pending) setRemember(false)
  }

  const runChoice = (action: ConfirmAction): void => {
    // 勾选记住：先写设置再动作（写失败由 store 统一上报，不阻断动作）
    if (remember) setCloseBehavior(action)
    clear()
    void performCloseAction(action).catch((error) => reportError(error))
  }

  // 点弹窗外＝取消：与 alertdialog 默认禁用点外关闭的语义不同，自行监听按下
  // 位置补足（取舍见组件注释）；弹窗不在场不挂监听
  React.useEffect(() => {
    if (!pending) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Element && !target.closest('[data-slot="alert-dialog-content"]')) {
        clear()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [pending, clear])

  return (
    <AlertDialog
      open={pending}
      onOpenChange={(open) => {
        if (!open) clear()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('settings.closeConfirmTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{t('settings.closeConfirmDesc')}</AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={remember}
            onCheckedChange={(checked) => setRemember(checked)}
            aria-label={t('settings.closeConfirmRemember')}
            data-testid="close-confirm-remember"
          />
          {t('settings.closeConfirmRemember')}
        </label>
        <AlertDialogFooter>
          <AlertDialogAction
            variant="outline"
            onClick={() => runChoice('exit')}
            data-testid="close-confirm-exit"
          >
            {t('settings.closeConfirmExit')}
          </AlertDialogAction>
          <AlertDialogAction onClick={() => runChoice('tray')} data-testid="close-confirm-tray">
            {t('settings.closeConfirmTray')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
