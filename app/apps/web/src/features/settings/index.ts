/**
 * 设置域统一导出入口：域外（App 挂载）经 `@/features/settings` 导入公开面；
 * 域内部件（navigation、各 Section）互引走相对路径，不进公开面。
 */
export { SettingsDialog } from './SettingsDialog'
export { CloseConfirmDialog } from './close-confirm-dialog'
