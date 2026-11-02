import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { HttpSection } from '../sections/HttpSection'
import { useSettingsStore } from '@/stores/settings.store'

// HTTP 组写入走 store 落库协议（set_setting 替身），面板内无其余 IPC
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const HTTP_DEFAULT_VALUE = {
  timeoutSeconds: null,
  redirect: true,
  tlsVerify: true,
  proxy: { mode: 'none', url: null },
}

beforeEach(() => {
  vi.clearAllMocks()
  invokeMock.mockResolvedValue(undefined)
  useSettingsStore.getState().hydrateFromBoot(null, null)
})

describe('HTTP 组四行渲染', () => {
  it('超时 / 跟随重定向 / 校验 TLS 证书 / 代理四行齐备，默认态＝不限制＋双开＋不使用代理', () => {
    render(<HttpSection />)

    // 超时分段四档（不限制 / 10 / 30 / 60 秒）
    expect(screen.getByRole('button', { name: '不限制' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '10 秒' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '30 秒' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '60 秒' })).toBeInTheDocument()

    // 双开关默认开启
    expect(screen.getByRole('switch', { name: '跟随重定向' })).toBeChecked()
    expect(screen.getByRole('switch', { name: '校验 TLS 证书' })).toBeChecked()

    // 代理默认不使用；自定义地址行不渲染（动态出现约定）
    expect(screen.getByRole('radio', { name: '不使用' })).toBeChecked()
    expect(screen.queryByLabelText('代理地址')).not.toBeInTheDocument()
  })
})

describe('HTTP 组写穿（store 动作 + set_setting 整键）', () => {
  it('超时分段切换：store 即时生效并整键落库', async () => {
    const user = userEvent.setup()
    render(<HttpSection />)

    await user.click(screen.getByRole('button', { name: '30 秒' }))
    expect(useSettingsStore.getState().http.timeoutSeconds).toBe(30)
    expect(invokeMock).toHaveBeenCalledWith('set_setting', {
      key: 'http',
      value: { ...HTTP_DEFAULT_VALUE, timeoutSeconds: 30 },
    })

    // 切回不限制（null）
    await user.click(screen.getByRole('button', { name: '不限制' }))
    expect(useSettingsStore.getState().http.timeoutSeconds).toBeNull()
  })

  it('跟随重定向开关切换写穿', async () => {
    const user = userEvent.setup()
    render(<HttpSection />)

    await user.click(screen.getByRole('switch', { name: '跟随重定向' }))
    expect(useSettingsStore.getState().http.redirect).toBe(false)
    expect(invokeMock).toHaveBeenCalledWith('set_setting', {
      key: 'http',
      value: { ...HTTP_DEFAULT_VALUE, redirect: false },
    })
  })

  it('校验 TLS 证书开关切换写穿', async () => {
    const user = userEvent.setup()
    render(<HttpSection />)

    await user.click(screen.getByRole('switch', { name: '校验 TLS 证书' }))
    expect(useSettingsStore.getState().http.tlsVerify).toBe(false)
    expect(invokeMock).toHaveBeenCalledWith('set_setting', {
      key: 'http',
      value: { ...HTTP_DEFAULT_VALUE, tlsVerify: false },
    })
  })
})

describe('代理：自定义地址行动态出现 / 隐藏', () => {
  it('选自定义即出现地址行；地址落定（blur）整键写 custom', async () => {
    const user = userEvent.setup()
    render(<HttpSection />)

    // 切自定义：地址行动态出现；空地址不写（custom 缺 url 被 Rust 写前校验拒绝）
    await user.click(screen.getByRole('radio', { name: '自定义' }))
    const urlInput = screen.getByLabelText('代理地址')
    expect(urlInput).toBeInTheDocument()
    expect(invokeMock).not.toHaveBeenCalledWith(
      'set_setting',
      expect.objectContaining({ key: 'http' }),
    )

    // 输入地址后 blur 落定 → 整键写 custom
    fireEvent.change(urlInput, { target: { value: 'socks5://127.0.0.1:1080' } })
    fireEvent.blur(urlInput)
    expect(useSettingsStore.getState().http.proxy).toEqual({
      mode: 'custom',
      url: 'socks5://127.0.0.1:1080',
    })
    expect(invokeMock).toHaveBeenCalledWith('set_setting', {
      key: 'http',
      value: { ...HTTP_DEFAULT_VALUE, proxy: { mode: 'custom', url: 'socks5://127.0.0.1:1080' } },
    })
  })

  it('切回不使用：地址行隐藏并整键写 none（地址清空）', async () => {
    const user = userEvent.setup()
    // 预置已生效的自定义代理（boot 灌入形态）
    useSettingsStore.setState({
      http: {
        timeoutSeconds: null,
        redirect: true,
        tlsVerify: true,
        proxy: { mode: 'custom', url: 'http://127.0.0.1:7890' },
      },
    })
    render(<HttpSection />)

    expect(screen.getByLabelText('代理地址')).toHaveValue('http://127.0.0.1:7890')
    await user.click(screen.getByRole('radio', { name: '不使用' }))
    expect(screen.queryByLabelText('代理地址')).not.toBeInTheDocument()
    expect(useSettingsStore.getState().http.proxy).toEqual({ mode: 'none', url: null })
    expect(invokeMock).toHaveBeenCalledWith('set_setting', {
      key: 'http',
      value: { ...HTTP_DEFAULT_VALUE, proxy: { mode: 'none', url: null } },
    })
  })
})
