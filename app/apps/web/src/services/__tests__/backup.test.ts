import { beforeEach, describe, expect, it, vi } from 'vitest'

import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { open as openFileDialog, save as saveFileDialog } from '@tauri-apps/plugin-dialog'

import {
  defaultBackupFileName,
  exportBackup,
  pickBackupFile,
  pickBackupSavePath,
  restoreBackup,
  validateBackup,
} from '../backup'

// Tauri IPC 原语替换为可编排的 mock（转发行为不属于被测面）
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

// 系统对话框原语替换为可编排的 mock（转发行为不属于被测面）
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
}))

const invokeMock = vi.mocked(tauriInvoke)
const saveMock = vi.mocked(saveFileDialog)
const openMock = vi.mocked(openFileDialog)

beforeEach(() => {
  invokeMock.mockReset()
  saveMock.mockReset()
  openMock.mockReset()
})

describe('defaultBackupFileName', () => {
  // 跨语言对账锚点：此断言钉住备份默认文件名格式（唯一事实源＝defaultBackupFileName）。
  // Rust / CLI 侧未来若立同格式实现或据此格式生成文件名，改格式必须两处同批：
  // 先改本断言使其转红，再同步实现。
  it('默认名＝apilot-backup-<YYYYMMDD-HHmmss>.zip（本地时间补零）', () => {
    expect(defaultBackupFileName(new Date(2026, 0, 2, 3, 4, 5))).toBe(
      'apilot-backup-20260102-030405.zip',
    )
    // 月份 0 基：9 = 十月
    expect(defaultBackupFileName(new Date(2026, 9, 19, 23, 59, 9))).toBe(
      'apilot-backup-20261019-235909.zip',
    )
  })
})

// IPC 契约钉住：命令名 / { path } 参数形状 / DTO 字段（camelCase）与
// Rust 侧 BackupExportResultDto、BackupRestoreResultDto 镜像——service 定义点
// 与契约断言同处，改命令名先红此处。
describe('IPC 契约', () => {
  it('exportBackup 调 backup_export 并透传 sizeBytes 结果', async () => {
    invokeMock.mockResolvedValue({ sizeBytes: 2048 })
    await expect(exportBackup('D:\\Backups\\apilot-backup-20261019-120000.zip')).resolves.toEqual({
      sizeBytes: 2048,
    })
    expect(invokeMock).toHaveBeenCalledWith('backup_export', {
      path: 'D:\\Backups\\apilot-backup-20261019-120000.zip',
    })
  })

  it('validateBackup 调 backup_validate，仅 { path } 参数且无返回值', async () => {
    invokeMock.mockResolvedValue(undefined)
    await expect(validateBackup('D:\\Backups\\good.zip')).resolves.toBeUndefined()
    expect(invokeMock).toHaveBeenCalledWith('backup_validate', { path: 'D:\\Backups\\good.zip' })
  })

  it('restoreBackup 调 backup_restore 并透传 requiresRestart 结果', async () => {
    invokeMock.mockResolvedValue({ requiresRestart: true })
    await expect(restoreBackup('D:\\Backups\\good.zip')).resolves.toEqual({
      requiresRestart: true,
    })
    expect(invokeMock).toHaveBeenCalledWith('backup_restore', { path: 'D:\\Backups\\good.zip' })
  })
})

describe('对话框选路', () => {
  it('另存对话框：带 zip 过滤器与默认名；字符串路径透传', async () => {
    saveMock.mockResolvedValue('D:\\Backups\\apilot-backup-20261019-120000.zip')
    await expect(pickBackupSavePath('apilot-backup-x.zip')).resolves.toBe(
      'D:\\Backups\\apilot-backup-20261019-120000.zip',
    )
    expect(saveMock).toHaveBeenCalledWith({
      defaultPath: 'apilot-backup-x.zip',
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    })
  })

  it('打开对话框：限定 zip 单选；取消（null）与多选形态归一为 null', async () => {
    openMock.mockResolvedValue('D:\\Backups\\good.zip')
    await expect(pickBackupFile()).resolves.toBe('D:\\Backups\\good.zip')
    expect(openMock).toHaveBeenCalledWith({
      multiple: false,
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    })

    openMock.mockResolvedValue(null)
    await expect(pickBackupFile()).resolves.toBeNull()
  })
})
