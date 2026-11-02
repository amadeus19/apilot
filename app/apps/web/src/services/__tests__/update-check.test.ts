import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { presentCheckToast, scheduleStartupUpdateSweep } from '../update-check'
import { toast } from '@workspace/ui/components'
import { useSettingsStore } from '@/stores/settings.store'
import { useUpdatePromptStore } from '@/stores/update-prompt.store'

// check_updates / list_staged_updates 等命令替身：按用例注入结果
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

vi.mock('@workspace/ui/components', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}))

const RESULT = {
  notConfigured: { status: 'not_configured', latestVersion: null, notes: null },
  unreachable: { status: 'unreachable', latestVersion: null, notes: 'timed out' },
  invalid: { status: 'invalid_manifest', latestVersion: null, notes: 'bad' },
  upToDate: { status: 'up_to_date', latestVersion: '0.1.0', notes: null },
  newer: { status: 'newer_available', latestVersion: '0.1.1', notes: '修复若干问题' },
  downgrade: { status: 'downgrade_available', latestVersion: '0.0.9', notes: null },
} as const

// list_staged_updates 各分支替身（Rust StagedUpdates 镜像：只含版本号，
// 路径由 Rust 侧从版本号重构，不越过 IPC 边界）
const STAGED = {
  none: { ready: null, finished: null, installFailed: null },
  ready: { ready: { version: '0.1.4' }, finished: null, installFailed: null },
  finished: {
    ready: null,
    finished: { version: '0.1.4' },
    installFailed: null,
  },
  installFailed: {
    ready: { version: '0.9.0' },
    finished: null,
    installFailed: { version: '0.9.0' },
  },
} as const

/** list_staged_updates / check_updates / discard_staged_update 组合替身 */
function stagedImpl(
  staged: (typeof STAGED)[keyof typeof STAGED],
  checkResult: (typeof RESULT)[keyof typeof RESULT] = RESULT.upToDate,
): void {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === 'list_staged_updates') return Promise.resolve(staged)
    if (cmd === 'discard_staged_update') return Promise.resolve(undefined)
    if (cmd === 'check_updates') return Promise.resolve(checkResult)
    return Promise.resolve(undefined)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  useSettingsStore.getState().hydrateFromBoot(null, null)
  useUpdatePromptStore.getState().clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('presentCheckToast（检查结果全状态反馈）', () => {
  it('newer_available：toast 提示版本号插值与说明', () => {
    presentCheckToast(RESULT.newer)
    expect(toast.info).toHaveBeenCalledWith('发现新版本 0.1.1，可在更新源获取安装包', {
      description: '修复若干问题',
    })
  })

  it('up_to_date / not_configured / unreachable / invalid_manifest / downgrade_available 各走对应文案', () => {
    presentCheckToast(RESULT.upToDate)
    expect(toast.success).toHaveBeenCalledWith('当前已是最新版本')

    presentCheckToast(RESULT.notConfigured)
    expect(toast.info).toHaveBeenCalledWith(expect.stringContaining('尚未配置更新源'))

    presentCheckToast(RESULT.unreachable)
    expect(toast.error).toHaveBeenCalledWith('更新源不可达，请检查目录或网络')

    presentCheckToast(RESULT.invalid)
    expect(toast.error).toHaveBeenCalledWith('更新源清单无效或缺少当前平台条目')

    presentCheckToast(RESULT.downgrade)
    expect(toast.info).toHaveBeenCalledWith(
      '发现可回滚版本 0.0.9，可降级安装（当前更新源已指回该版本）',
      {
        description: undefined,
      },
    )
  })

  it('cloud 源：发现新版文案切「可下载安装」分支（不再引导去更新源获取）', () => {
    useSettingsStore.setState({
      updateSource: { kind: 'cloud', path: null, baseUrl: null, mirrorPrefix: '' },
    })
    presentCheckToast(RESULT.newer)
    expect(toast.info).toHaveBeenCalledWith('发现新版本 0.1.1，可下载安装', {
      description: '修复若干问题',
    })

    // 其余状态沿用中性文案
    presentCheckToast(RESULT.upToDate)
    expect(toast.success).toHaveBeenCalledWith('当前已是最新版本')
  })
})

describe('scheduleStartupUpdateSweep（boot 扫场：反馈 / 续接 / 完成提示 / 自动检查）', () => {
  function advance() {
    vi.useFakeTimers()
    scheduleStartupUpdateSweep()
    return vi.advanceTimersByTimeAsync(3000)
  }

  it('有就绪包（上次「稍后」）：弹确认对话框并跳过自动检查（同版本会重复打扰）', async () => {
    stagedImpl(STAGED.ready)
    await advance()
    expect(useUpdatePromptStore.getState().pending).toMatchObject({ version: '0.1.4' })
    expect(invokeMock).not.toHaveBeenCalledWith('check_updates')
  })

  it('当前版本残留包：完成提示 + 清理 + 照常回落自动检查', async () => {
    useSettingsStore.setState({ autoCheckUpdates: { enabled: true } })
    stagedImpl(STAGED.finished, RESULT.upToDate)
    await advance()
    expect(toast.success).toHaveBeenCalledWith('已成功更新到 v0.1.4')
    expect(invokeMock).toHaveBeenCalledWith('discard_staged_update', {
      version: '0.1.4',
    })
    expect(invokeMock).toHaveBeenCalledWith('check_updates')
  })

  it('上次安装未完成：一次性失败反馈后照常续接就绪包（可重试）', async () => {
    stagedImpl(STAGED.installFailed)
    await advance()
    expect(toast.error).toHaveBeenCalledWith('上次安装（v0.9.0）未完成，可重新安装')
    expect(useUpdatePromptStore.getState().pending).toMatchObject({ version: '0.9.0' })
    expect(invokeMock).not.toHaveBeenCalledWith('check_updates')
  })

  it('无残留：回落自动检查（受 autoCheckUpdates 开关控制）', async () => {
    useSettingsStore.setState({ autoCheckUpdates: { enabled: true } })
    stagedImpl(STAGED.none, RESULT.newer)
    await advance()
    expect(useUpdatePromptStore.getState().pending).toBeNull()
    expect(invokeMock).toHaveBeenCalledWith('check_updates')
    expect(toast.info).toHaveBeenCalledWith('发现新版本 0.1.1，可在更新源获取安装包', {
      description: '修复若干问题',
    })

    // 开关关闭：扫场照跑（就绪包续接不受控）但回落检查不发起
    useSettingsStore.setState({ autoCheckUpdates: { enabled: false } })
    invokeMock.mockClear()
    stagedImpl(STAGED.none)
    await advance()
    expect(invokeMock).not.toHaveBeenCalledWith('check_updates')
  })

  it('扫场扫描失败：统一上报，仍回落自动检查（扫描失败不阻断检查）', async () => {
    invokeMock.mockRejectedValue({ kind: 'apilot_error', code: 'INTERNAL', message: 'boom' })
    await advance()
    expect(toast.error).toHaveBeenCalled()
    expect(invokeMock).toHaveBeenCalledWith('check_updates')
  })
})
