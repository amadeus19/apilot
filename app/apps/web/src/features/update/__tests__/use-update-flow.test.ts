import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useUpdateFlow } from '../use-update-flow'
import { toast } from '@workspace/ui/components'
import { useUpdatePromptStore } from '@/stores/update-prompt.store'

// 流程状态机测试：IPC 命令替身 + toast 替身；就绪对话框请求通道（prompt
// store）为真实 store（状态机行为断言的一部分）
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

vi.mock('@workspace/ui/components', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}))

beforeEach(() => {
  vi.clearAllMocks()
  useUpdateFlow.setState({
    checking: false,
    installing: false,
    availableVersion: null,
    availableIsDowngrade: false,
  })
  useUpdatePromptStore.getState().clear()
})

describe('useUpdateFlow（更新流程单一事实源）', () => {
  it('checkUpdates：全状态反馈并记录可安装版本', async () => {
    invokeMock.mockResolvedValue({ status: 'newer_available', latestVersion: '0.1.6', notes: null })
    await useUpdateFlow.getState().checkUpdates()
    expect(useUpdateFlow.getState().availableVersion).toBe('0.1.6')
    expect(useUpdateFlow.getState().availableIsDowngrade).toBe(false)
    expect(useUpdateFlow.getState().checking).toBe(false)
    expect(toast.info).toHaveBeenCalledWith('发现新版本 0.1.6，可在更新源获取安装包', {
      description: undefined,
    })

    // 其余状态清空可安装版本
    invokeMock.mockResolvedValue({ status: 'up_to_date', latestVersion: '0.1.5', notes: null })
    await useUpdateFlow.getState().checkUpdates()
    expect(useUpdateFlow.getState().availableVersion).toBeNull()
  })

  it('checkUpdates：清单低于当前记为可回滚版本（横幅方向随之切换）', async () => {
    invokeMock.mockResolvedValue({
      status: 'downgrade_available',
      latestVersion: '0.0.9',
      notes: null,
    })
    await useUpdateFlow.getState().checkUpdates()
    expect(useUpdateFlow.getState().availableVersion).toBe('0.0.9')
    expect(useUpdateFlow.getState().availableIsDowngrade).toBe(true)

    // 方向标志跟随最近一次检查结果，不残留
    invokeMock.mockResolvedValue({ status: 'newer_available', latestVersion: '0.1.6', notes: null })
    await useUpdateFlow.getState().checkUpdates()
    expect(useUpdateFlow.getState().availableIsDowngrade).toBe(false)
  })

  it('checkUpdates 失败：统一上报，不残留 checking 态', async () => {
    invokeMock.mockRejectedValue({ kind: 'apilot_error', code: 'INTERNAL', message: 'boom' })
    await useUpdateFlow.getState().checkUpdates()
    expect(toast.error).toHaveBeenCalled()
    expect(useUpdateFlow.getState().checking).toBe(false)
  })

  it('downloadAndInstall：下载校验通过后请求就绪确认对话框', async () => {
    invokeMock.mockResolvedValue({ version: '0.1.6' })
    await useUpdateFlow.getState().downloadAndInstall()
    expect(toast.success).toHaveBeenCalledWith('v0.1.6 下载完成，校验通过')
    expect(useUpdatePromptStore.getState().pending).toMatchObject({ version: '0.1.6' })
    expect(useUpdateFlow.getState().installing).toBe(false)
  })

  it('downloadAndInstall 失败：统一上报，不弹对话框', async () => {
    invokeMock.mockRejectedValue({
      kind: 'apilot_error',
      code: 'UPDATE_CHECKSUM_MISMATCH',
      message: 'sha256 mismatch',
    })
    await useUpdateFlow.getState().downloadAndInstall()
    expect(toast.error).toHaveBeenCalled()
    expect(useUpdatePromptStore.getState().pending).toBeNull()
    expect(useUpdateFlow.getState().installing).toBe(false)
  })

  it('confirmInstall：以暂存包版本号启动安装（Rust 通过后接管关窗）', async () => {
    useUpdatePromptStore.getState().show({ version: '0.1.6' })
    invokeMock.mockResolvedValue(undefined)
    await useUpdateFlow.getState().confirmInstall()
    expect(invokeMock).toHaveBeenCalledWith('install_update', { version: '0.1.6' })
    // 成功路径窗口即将关闭：installing 保持锁定（无盲等定时器）
    expect(useUpdateFlow.getState().installing).toBe(true)
  })

  it('confirmInstall 失败：上报并恢复可重试', async () => {
    useUpdatePromptStore.getState().show({ version: '0.1.6' })
    invokeMock.mockRejectedValue({
      kind: 'apilot_error',
      code: 'UPDATE_INSTALL_FAILED',
      message: 'staged installer missing',
    })
    await useUpdateFlow.getState().confirmInstall()
    expect(toast.error).toHaveBeenCalled()
    expect(useUpdateFlow.getState().installing).toBe(false)
  })

  it('confirmInstall 无就绪包请求时不动作（纯视图依赖请求通道）', async () => {
    await useUpdateFlow.getState().confirmInstall()
    expect(invokeMock).not.toHaveBeenCalledWith('install_update', expect.anything())
  })
})
