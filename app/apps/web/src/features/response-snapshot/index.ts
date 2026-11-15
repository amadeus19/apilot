/**
 * 响应快照域统一导出入口：域外（main.tsx 分流挂载、响应区工具栏触发）经
 * 本 barrel 导入公开面；域内部件互引走相对路径，不进公开面。
 */
export { SnapshotWindowApp } from './snapshot-window-app'
export { SNAPSHOT_WINDOW_LABEL } from './snapshot-api'
