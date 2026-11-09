import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@workspace/ui/components'
import { useUpdateFlow } from './use-update-flow'
import { useI18n } from '@/i18n'
import { useUpdatePromptStore } from '@/stores/update-prompt.store'

/**
 * 更新就绪确认对话框（纯视图）：下载校验通过 / boot 续接就绪包时弹出，
 * 对话框请求与安装动作均来自 stores/update-prompt（请求通道）与
 * useUpdateFlow（状态机）。「立即安装」= Rust 校验后暂存安装请求，前端收尾
 * ack 后进入退出序列，序列末尾 spawn 安装器；「稍后」= 保留就绪包，下次启动续接。
 * 安装中锁定交互并就地呈现安装中文案（中途取消会让「应用将关闭」的告知
 * 语义断裂）。
 */
export function UpdateReadyDialog() {
  const { t } = useI18n()
  const pending = useUpdatePromptStore((s) => s.pending)
  const clear = useUpdatePromptStore((s) => s.clear)
  const installing = useUpdateFlow((s) => s.installing)
  const confirmInstall = useUpdateFlow((s) => s.confirmInstall)

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open && !installing) clear()
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('settings.updateReadyTitle')}</DialogTitle>
          <DialogDescription>
            {installing
              ? t('settings.updateInstalling')
              : t('settings.updateReadyDesc', { version: pending?.version ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={clear} disabled={installing}>
            {t('settings.updateLater')}
          </Button>
          <Button
            onClick={() => {
              void confirmInstall()
            }}
            disabled={installing}
          >
            {t('settings.updateInstallNow')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
