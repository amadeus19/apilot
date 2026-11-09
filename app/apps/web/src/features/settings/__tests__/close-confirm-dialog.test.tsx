import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSettingsStore } from '@/stores/settings.store'
import { useCloseConfirmStore } from '@/stores/close-confirm.store'
import { CloseConfirmDialog } from '../close-confirm-dialog'

// IPC 替身：两动作命令与 set_setting 落库共用（store persist 通道）
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

// 收尾 flush 替身：记录调用顺序（退出路径断言 flush 先于 confirm_exit）
const flushAllForExitMock = vi.hoisted(() => vi.fn())
vi.mock('@/services/exit-flush', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/exit-flush')>()
  return { ...actual, flushAllForExit: flushAllForExitMock }
})

// 统一错误上报替身（toast 呈现是 error-center 自身职责；此处断言路由到达）
const reportErrorMock = vi.hoisted(() => vi.fn())
vi.mock('@/services/error-center', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/error-center')>()
  return { ...actual, reportError: reportErrorMock }
})

beforeEach(() => {
  vi.clearAllMocks()
  flushAllForExitMock.mockResolvedValue(undefined)
  invokeMock.mockResolvedValue(undefined)
  useSettingsStore.getState().hydrateFromBoot(null, null)
  useCloseConfirmStore.getState().clear()
})

/** 挂载弹窗宿主并发出关闭请求（弹窗在场） */
async function renderWithPending() {
  render(<CloseConfirmDialog />)
  await act(async () => {
    useCloseConfirmStore.getState().show()
  })
}

describe('CloseConfirmDialog（关闭确认弹窗）', () => {
  it('弹出后两动作按钮在场，「记住我的选择」默认不勾', async () => {
    await renderWithPending()

    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(screen.getByTestId('close-confirm-tray')).toBeInTheDocument()
    expect(screen.getByTestId('close-confirm-exit')).toBeInTheDocument()
    expect(screen.getByTestId('close-confirm-remember')).not.toBeChecked()
  })

  it('取消（Esc）＝仅退场不绑动作：两命令与落库都不发生', async () => {
    const user = userEvent.setup()
    await renderWithPending()

    await user.keyboard('{Escape}')
    expect(useCloseConfirmStore.getState().pending).toBe(false)
    expect(invokeMock).not.toHaveBeenCalled()
    expect(flushAllForExitMock).not.toHaveBeenCalled()
  })

  it('点弹窗外＝取消，同 Esc 语义', async () => {
    const user = userEvent.setup()
    await renderWithPending()

    await user.click(document.body)
    expect(useCloseConfirmStore.getState().pending).toBe(false)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('选「最小化到托盘」：调用 app.hide_to_tray 并退场，不 flush', async () => {
    const user = userEvent.setup()
    await renderWithPending()

    await user.click(screen.getByTestId('close-confirm-tray'))
    expect(useCloseConfirmStore.getState().pending).toBe(false)
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('app.hide_to_tray')
    })
    expect(invokeMock).not.toHaveBeenCalledWith('app.confirm_exit')
    expect(flushAllForExitMock).not.toHaveBeenCalled()
  })

  it('选「退出应用」：先全量 flush 再调用 app.confirm_exit', async () => {
    const user = userEvent.setup()
    const order: string[] = []
    flushAllForExitMock.mockImplementation(async () => {
      order.push('flush')
    })
    invokeMock.mockImplementation(async (cmd: string) => {
      order.push(cmd)
    })
    await renderWithPending()

    await user.click(screen.getByTestId('close-confirm-exit'))
    await waitFor(() => {
      expect(order).toEqual(['flush', 'app.confirm_exit'])
    })
    expect(useCloseConfirmStore.getState().pending).toBe(false)
  })

  it('勾选「记住我的选择」后选托盘：先写 closeBehavior 设置（不回滚）再执行动作', async () => {
    const user = userEvent.setup()
    await renderWithPending()

    await user.click(screen.getByTestId('close-confirm-remember'))
    expect(screen.getByTestId('close-confirm-remember')).toBeChecked()
    await user.click(screen.getByTestId('close-confirm-tray'))

    // 落库走 settings store persist 通道（set_setting closeBehavior）
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('set_setting', {
        key: 'closeBehavior',
        value: { action: 'tray' },
      })
    })
    expect(invokeMock).toHaveBeenCalledWith('app.hide_to_tray')
    expect(useSettingsStore.getState().closeBehavior).toEqual({ action: 'tray' })
  })

  it('勾选记住后动作失败：已记住的选择不回滚，错误经统一协议上报', async () => {
    const user = userEvent.setup()
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'app.confirm_exit') {
        throw { kind: 'apilot_error', code: 'EXIT_FAILED', message: 'refused' }
      }
    })
    await renderWithPending()

    await user.click(screen.getByTestId('close-confirm-remember'))
    await user.click(screen.getByTestId('close-confirm-exit'))

    await waitFor(() => {
      expect(reportErrorMock).toHaveBeenCalledOnce()
    })
    expect(useSettingsStore.getState().closeBehavior).toEqual({ action: 'exit' })
    expect(invokeMock).toHaveBeenCalledWith('set_setting', {
      key: 'closeBehavior',
      value: { action: 'exit' },
    })
  })

  it('每次弹出重置「记住我的选择」为默认不勾（根部常驻挂载不跨次保留）', async () => {
    const user = userEvent.setup()
    await renderWithPending()

    await user.click(screen.getByTestId('close-confirm-remember'))
    await user.click(screen.getByTestId('close-confirm-tray'))

    // 再次弹出：复选框回到默认不勾
    await act(async () => {
      useCloseConfirmStore.getState().show()
    })
    expect(screen.getByTestId('close-confirm-remember')).not.toBeChecked()
  })
})
