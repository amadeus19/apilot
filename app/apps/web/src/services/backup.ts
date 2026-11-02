import { open as openFileDialog, save as saveFileDialog } from '@tauri-apps/plugin-dialog'

import { invoke } from './ipc'

/**
 * 备份系统能力收口：手动导出 / 恢复的一次性 IPC 动作与文件对话框。
 * 路径由系统对话框选定后传入 Rust，不落设置；取消为正常路径（返回 null，
 * 静默）。备份包为单条目 zip（内嵌一致性 sqlite 副本）。
 */

/** 导出结果 DTO（Rust BackupExportResultDto 镜像）：产物字节数 */
export interface BackupExportResult {
  sizeBytes: number
}

/** 恢复受理结果 DTO（Rust BackupRestoreResultDto 镜像）：暂存已落盘，待重启生效 */
export interface BackupRestoreResult {
  requiresRestart: boolean
}

/** zip 过滤器：备份包与恢复选文件的共同类型限定 */
const ZIP_FILTERS = [{ name: 'ZIP', extensions: ['zip'] }]

/** 导出一致性单库副本为 zip，返回产物字节数 */
export function exportBackup(path: string): Promise<BackupExportResult> {
  return invoke<BackupExportResult>('backup_export', { path })
}

/** 恢复预检：只校验所选备份包（合法 zip / 库 / schema 版本），无任何落盘副作用 */
export function validateBackup(path: string): Promise<void> {
  return invoke<void>('backup_validate', { path })
}

/** 恢复受理：校验通过后写暂存库与标记，重启应用后生效 */
export function restoreBackup(path: string): Promise<BackupRestoreResult> {
  return invoke<BackupRestoreResult>('backup_restore', { path })
}

/** 系统另存对话框：返回所选绝对路径；null = 用户取消 */
export async function pickBackupSavePath(defaultName: string): Promise<string | null> {
  const picked = await saveFileDialog({
    defaultPath: defaultName,
    filters: ZIP_FILTERS,
  })
  return typeof picked === 'string' ? picked : null
}

/** 系统打开对话框（限 zip）：返回所选绝对路径；null = 用户取消 */
export async function pickBackupFile(): Promise<string | null> {
  const picked = await openFileDialog({
    multiple: false,
    filters: ZIP_FILTERS,
  })
  return typeof picked === 'string' ? picked : null
}

/**
 * 导出默认文件名 `apilot-backup-<YYYYMMDD-HHmmss>.zip`（本地时间，
 * 时间戳由前端生成随对话框初值传入，路径不落设置）。
 * 本函数是备份文件名格式的唯一事实源：Rust / CLI 侧无同名常量登记，
 * 未来若需同格式（如 CLI 导出）必须以此实现为准对齐。
 */
export function defaultBackupFileName(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `apilot-backup-${stamp}.zip`
}
