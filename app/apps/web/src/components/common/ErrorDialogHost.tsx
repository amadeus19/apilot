import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@workspace/ui/components'
import * as React from 'react'

import { blockingErrorStore, localizeIpcError } from '@/services/error-center'
import { isDevMode } from '@/services/ipc'
import { useI18n } from '@/i18n'

/**
 * 阻断性错误对话框宿主（F8）：订阅 blockingErrorStore，有错即弹模态。
 * 应用根挂载一次；用户确认前主流程保持可见（非替换式终态）。
 * 错误文案按 errors.<code> 本地化（details 插值），devMode 附稳定 code。
 */
export function ErrorDialogHost() {
  const { t } = useI18n()
  const state = React.useSyncExternalStore(
    blockingErrorStore.subscribe,
    blockingErrorStore.getSnapshot,
  )
  const error = state?.error ?? null

  return (
    <Dialog
      open={error !== null}
      onOpenChange={(open) => {
        if (!open) blockingErrorStore.dismiss()
      }}
    >
      {error && (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('common.errorDialogTitle')}</DialogTitle>
            <DialogDescription>
              {localizeIpcError(error)}
              {isDevMode() && <span className="mt-1 block font-mono text-xs">{error.code}</span>}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={blockingErrorStore.dismiss}>
              {t('common.errorDialogAcknowledge')}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}
