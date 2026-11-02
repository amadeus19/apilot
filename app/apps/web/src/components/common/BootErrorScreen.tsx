import { CircleAlertIcon } from 'lucide-react'

import { Button } from '@workspace/ui/components'
import { Toaster } from '@workspace/ui/components'
import { useI18n } from '@/i18n'
import type { IpcError } from '@/services/ipc'
import { openLogDirectory } from '@/services/log-dir'

/**
 * 启动期阻断错误全屏呈现（库完整性校验失败 → DB_CORRUPTED → 全屏错误）。
 *
 * 当前为阻断终态：不渲染主应用，仅提供「打开日志目录」与「重试」两个出口。
 * 此路径 store 未灌入 boot 载荷（库不可用），生效语言以系统语言兜底；
 * 稳定 code + 英文 message 行恒原样直出（排障终态，不进字典）。
 */

export function BootErrorScreen({ error }: { error: IpcError }) {
  const { t } = useI18n()
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background p-6 text-foreground">
      {/* 本路径不渲染主应用：Toaster 就地挂载，保证统一错误协议（瞬态 → Toast）可用 */}
      <Toaster />
      <div className="flex max-w-md flex-col items-start gap-4">
        <CircleAlertIcon className="size-8 text-destructive" aria-hidden />
        <div className="flex flex-col gap-2">
          <h1 className="font-heading text-base font-medium">{t('shell.bootErrorTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('shell.bootErrorDescription')}</p>
          {/* 稳定错误码 + 英文 message 直出（启动期无法确认 devMode，终态全量可见便于支持排障） */}
          <p className="font-mono text-xs text-muted-foreground">
            {error.code}: {error.message}
          </p>
        </div>
        {/* 主按钮＝恢复主路径（重试），排右；打开日志目录为辅助出口 */}
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void openLogDirectory()}>
            {t('shell.bootErrorOpenLogs')}
          </Button>
          <Button onClick={() => window.location.reload()}>{t('shell.bootErrorRetry')}</Button>
        </div>
      </div>
    </div>
  )
}
