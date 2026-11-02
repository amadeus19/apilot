import * as React from 'react'
import { relaunch } from '@tauri-apps/plugin-process'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  toast,
} from '@workspace/ui/components'

import { formatBytes, useI18n } from '@/i18n'
import {
  defaultBackupFileName,
  exportBackup,
  pickBackupFile,
  pickBackupSavePath,
  restoreBackup,
  validateBackup,
} from '@/services/backup'
import { reportError } from '@/services/error-center'
import { SettingRow, SettingRows } from '@/components/common/SettingRow'

/**
 * 备份组：两动作极简——导出（另存对话框选定目标，不确认）与恢复
 * （两段式：选文件 → 预检 → 确认框 → 执行暂存 → 重启确认模态）。路径由系统
 * 对话框选定后直接传入 IPC，不落设置；备份含明文凭据（组描述注明）。
 */

/** 恢复链路阶段：空闲 / 选文件守卫中 / 预检中 / 预检通过待确认 / 暂存完成待重启 */
type RestorePhase = 'idle' | 'picking' | 'validating' | 'confirm' | 'staged'

export function BackupSection() {
  const { t } = useI18n()
  const [exporting, setExporting] = React.useState(false)
  const [restorePhase, setRestorePhase] = React.useState<RestorePhase>('idle')
  // 预检通过待确认的备份包路径（确认框在场期间持有；确认或取消即清）
  const [pendingPath, setPendingPath] = React.useState<string | null>(null)
  const [restoring, setRestoring] = React.useState(false)

  /** 导出：另存对话框（取消静默）→ backup_export；成功 toast 含产物大小与目标路径 */
  const handleExport = async (): Promise<void> => {
    if (exporting) return
    setExporting(true)
    try {
      const target = await pickBackupSavePath(defaultBackupFileName())
      if (target === null) return
      const result = await exportBackup(target)
      toast.success(
        t('settings.backupExportDone', { path: target, size: formatBytes(result.sizeBytes) }),
      )
    } catch (error) {
      reportError(error)
    } finally {
      setExporting(false)
    }
  }

  /** 恢复前段：选文件（取消静默）→ 预检；失败走统一错误呈现，不进确认框 */
  const startRestore = async (): Promise<void> => {
    if (restorePhase !== 'idle') return
    // 守卫态先于系统对话框置位（与导出侧对称）：Windows 文件对话框不模态于
    // 主窗，对话框在场期间入口按钮必须禁用，杜绝二次点击并发竞写
    // restorePhase / pendingPath
    setRestorePhase('picking')
    let file: string | null
    try {
      file = await pickBackupFile()
    } catch (error) {
      // 对话框自身异常也必须复位守卫，否则按钮永久禁用
      reportError(error)
      setRestorePhase('idle')
      return
    }
    if (file === null) {
      setRestorePhase('idle')
      return
    }
    setPendingPath(file)
    setRestorePhase('validating')
    try {
      await validateBackup(file)
      setRestorePhase('confirm')
    } catch (error) {
      reportError(error)
      setRestorePhase('idle')
      setPendingPath(null)
    }
  }

  /** 恢复后段：确认后执行暂存（重启生效）；失败保持确认框在场可重试 */
  const confirmRestore = (): void => {
    if (pendingPath === null || restoring) return
    setRestoring(true)
    restoreBackup(pendingPath)
      .then(() => {
        // 暂存成功 → 转重启确认模态（catch 刻意不重置 phase：确认框留在场可重试）
        setPendingPath(null)
        setRestorePhase('staged')
      })
      .catch((error) => {
        reportError(error)
      })
      .finally(() => setRestoring(false))
  }

  /** 关闭确认框（取消 / Esc / 遮罩）：丢弃待确认路径，无任何落盘副作用 */
  const dismissRestore = (): void => {
    if (restoring) return
    setRestorePhase('idle')
    setPendingPath(null)
  }

  /** 重启确认模态「知道了」/ Esc：稍后自行重启，回到空闲态 */
  const dismissStaged = (): void => {
    setRestorePhase('idle')
  }

  /** 「立即重启」：官方 process 插件 relaunch；失败仅提示，模态留在场可重试 */
  const handleRelaunch = async (): Promise<void> => {
    try {
      await relaunch()
    } catch (error) {
      reportError(error)
    }
  }

  return (
    <section aria-label={t('settings.navBackup')} className="p-6">
      <h2 className="text-sm font-medium">{t('settings.navBackup')}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t('settings.navBackupDesc')}</p>

      <div className="mt-5">
        <SettingRows>
          <SettingRow
            label={t('settings.backupExport')}
            description={t('settings.backupExportDesc')}
            control={
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleExport()}
                disabled={exporting}
              >
                {t('settings.backupExport')}
              </Button>
            }
          />
          <SettingRow
            label={t('settings.backupRestore')}
            description={t('settings.backupRestoreDesc')}
            control={
              <Button
                variant="outline"
                size="sm"
                onClick={() => void startRestore()}
                disabled={restorePhase !== 'idle'}
              >
                {t('settings.backupRestore')}
              </Button>
            }
          />
        </SettingRows>
      </div>

      {/* 恢复确认框（两段式后段）：预检通过才出现——确认前零落盘副作用 */}
      {restorePhase === 'confirm' && (
        <AlertDialog open onOpenChange={(open) => !open && dismissRestore()}>
          <AlertDialogContent data-testid="backup-restore-confirm">
            <AlertDialogHeader>
              <AlertDialogTitle>{t('settings.backupRestoreConfirmTitle')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('settings.backupRestoreConfirmDesc')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={restoring}>
                {t('settings.backupCancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={restoring}
                data-testid="backup-restore-confirm-action"
                onClick={confirmRestore}
              >
                {t('settings.backupRestoreConfirmAction')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {/* 重启确认模态：暂存成功后显式化「必须重启才继续」与窗口期写入丢失风险 */}
      {restorePhase === 'staged' && (
        <AlertDialog open onOpenChange={(open) => !open && dismissStaged()}>
          <AlertDialogContent data-testid="backup-restart-confirm">
            <AlertDialogHeader>
              <AlertDialogTitle>{t('settings.backupRestartTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{t('settings.backupRestartDesc')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogAction variant="outline" onClick={dismissStaged}>
                {t('settings.backupRestartAcknowledge')}
              </AlertDialogAction>
              <AlertDialogAction
                data-testid="backup-restart-now"
                onClick={() => void handleRelaunch()}
              >
                {t('settings.backupRestartNow')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </section>
  )
}
