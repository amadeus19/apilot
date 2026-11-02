import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { BootErrorScreen } from '../common/BootErrorScreen'
import type { IpcError } from '@/services/ipc'

// Tauri IPC 替身：断言「打开日志目录」按钮走 open_log_dir 命令（Rust 直调）
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { toast, toastStore } from '@workspace/ui/components'

const corrupted: IpcError = Object.assign(new Error('database integrity check reported problems'), {
  name: 'IpcError',
  code: 'DB_CORRUPTED',
  details: { findings: ['page 3 is never used'] },
  fromAppError: true,
}) as unknown as IpcError

describe('BootErrorScreen', () => {
  it('呈现错误码与英文 message（终态全量可见，便于支持排障）', () => {
    render(<BootErrorScreen error={corrupted} />)
    expect(screen.getByText('数据库无法使用')).toBeInTheDocument()
    expect(screen.getByText(/DB_CORRUPTED/)).toBeInTheDocument()
    expect(screen.getByText(/database integrity check reported problems/)).toBeInTheDocument()
  })

  it('「打开日志目录」调用 open_log_dir 命令（Rust 侧 canonicalize 直调）', async () => {
    invokeMock.mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<BootErrorScreen error={corrupted} />)

    await user.click(screen.getByRole('button', { name: '打开日志目录' }))
    expect(invokeMock).toHaveBeenCalledWith('open_log_dir')
  })

  it('打开失败不静默：走统一上报以 Toast 呈现', async () => {
    invokeMock.mockRejectedValue(new Error('no shell'))
    const user = userEvent.setup()
    render(<BootErrorScreen error={corrupted} />)

    await user.click(screen.getByRole('button', { name: '打开日志目录' }))
    // 统一错误协议生效：错误屏自带 Toaster 宿主，瞬态失败可见
    expect(toastStore.getSnapshot().length).toBeGreaterThan(0)
    for (const item of toastStore.getSnapshot()) toast.dismiss(item.id)
  })

  it('提供「重试」出口（reload 当前窗口）', () => {
    render(<BootErrorScreen error={corrupted} />)
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })
})
