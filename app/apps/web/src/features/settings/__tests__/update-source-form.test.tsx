import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { UpdateSourceForm } from '../sections/UpdateSourceForm'
import { toast } from '@workspace/ui/components'
import { useSettingsStore } from '@/stores/settings.store'
import { pickDirectory } from '@/services/log-dir'
import { DEFAULT_CLOUD_BASE_URL } from '@/lib/settings-schema'

// IPC 原语替换：set_setting（落库）与 check_update_source（folder 可达性校验）
// 按命令分派；目录选择器替身单独注入返回值
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

vi.mock('@/services/log-dir', () => ({ pickDirectory: vi.fn() }))

// 保留真实 UI 组件（交互断言需要），仅替 toast 呈现通道
vi.mock('@workspace/ui/components', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@workspace/ui/components')>()),
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}))

/** 以存量设置灌入 store（模拟 boot 载荷，含旧库 type 形态兼容路径） */
function hydrate(updateSource: Record<string, unknown>): void {
  useSettingsStore
    .getState()
    .hydrateFromBoot({ settings: { updateSource }, systemLocale: null }, null)
}

beforeEach(() => {
  vi.clearAllMocks()
  invokeMock.mockResolvedValue(undefined)
  vi.mocked(pickDirectory).mockResolvedValue(null)
  useSettingsStore.getState().hydrateFromBoot(null, null)
})

describe('UpdateSourceForm（更新源表单：类型切换与默认态）', () => {
  it('默认 folder 态：分段选中文件夹、当前目录显示「未配置」、cloud 表单不渲染', () => {
    render(<UpdateSourceForm />)

    expect(screen.getByRole('button', { name: '文件夹' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '云服务' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: '云服务' })).toBeEnabled()
    expect(screen.getByText('未配置')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '选择目录' })).toBeInTheDocument()
    expect(screen.queryByLabelText('仓库地址')).not.toBeInTheDocument()
  })

  it('切到 cloud：解禁可选，仓库地址预填默认地址、镜像前缀为空（直连）', async () => {
    const user = userEvent.setup()
    render(<UpdateSourceForm />)

    await user.click(screen.getByRole('button', { name: '云服务' }))
    expect(screen.getByRole('button', { name: '云服务' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('未配置')).not.toBeInTheDocument()
    expect(screen.getByLabelText('仓库地址')).toHaveValue(DEFAULT_CLOUD_BASE_URL)
    expect(screen.getByLabelText('镜像前缀')).toHaveValue('')
  })

  it('存量旧库 type 形态兼容回显：network 目录归入 folder 显示，cloud 存量回显输入框', () => {
    hydrate({ type: 'network', path: '\\\\server\\share' })
    const { unmount } = render(<UpdateSourceForm />)
    expect(screen.getByText('\\\\server\\share')).toBeInTheDocument()
    unmount()

    hydrate({
      kind: 'cloud',
      path: null,
      baseUrl: 'https://git.example.com/apilot',
      mirrorPrefix: 'https://mirror.example.com/',
    })
    render(<UpdateSourceForm />)
    // 存量 cloud 直接以 cloud 态渲染（kind 判别），输入框回显已存值
    expect(screen.getByRole('button', { name: '云服务' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('仓库地址')).toHaveValue('https://git.example.com/apilot')
    expect(screen.getByLabelText('镜像前缀')).toHaveValue('https://mirror.example.com/')
  })
})

describe('UpdateSourceForm（cloud 表单：默认值 / 校验 / 共存落库）', () => {
  it('不改输入直接保存：默认地址与空镜像前缀整键落库，不调目录可达性校验', async () => {
    const user = userEvent.setup()
    render(<UpdateSourceForm />)
    await user.click(screen.getByRole('button', { name: '云服务' }))
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(invokeMock).not.toHaveBeenCalledWith('check_update_source', expect.anything())
    expect(invokeMock).toHaveBeenCalledWith('set_setting', {
      key: 'updateSource',
      value: {
        kind: 'cloud',
        path: null,
        baseUrl: DEFAULT_CLOUD_BASE_URL,
        mirrorPrefix: '',
      },
    })
    expect(toast.success).toHaveBeenCalledWith('更新源已保存')
  })

  it('仓库地址清空保存＝回默认（null），镜像前缀 trim 后落库', async () => {
    hydrate({ kind: 'folder', path: 'D:\\updates', baseUrl: null, mirrorPrefix: '' })
    const user = userEvent.setup()
    render(<UpdateSourceForm />)
    await user.click(screen.getByRole('button', { name: '云服务' }))
    await user.clear(screen.getByLabelText('仓库地址'))
    await user.type(screen.getByLabelText('镜像前缀'), '  https://mirror.example.com/  ')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(invokeMock).toHaveBeenCalledWith('set_setting', {
      key: 'updateSource',
      value: {
        kind: 'cloud',
        // folder 配置共存保留：切 cloud 不丢已存目录
        path: 'D:\\updates',
        baseUrl: null,
        mirrorPrefix: 'https://mirror.example.com/',
      },
    })
  })

  it('URL 形态非法：保存禁用并就地提示，不触发落库', async () => {
    const user = userEvent.setup()
    render(<UpdateSourceForm />)
    await user.click(screen.getByRole('button', { name: '云服务' }))

    const save = screen.getByRole('button', { name: '保存' })
    await user.clear(screen.getByLabelText('仓库地址'))
    await user.type(screen.getByLabelText('仓库地址'), 'github.com/amadeus19/apilot')
    expect(save).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('地址无效，需以 http:// 或 https:// 开头')
    expect(invokeMock).not.toHaveBeenCalledWith('set_setting', expect.anything())

    // 修正为合法地址后恢复可保存
    await user.clear(screen.getByLabelText('仓库地址'))
    await user.type(screen.getByLabelText('仓库地址'), 'https://git.example.com/apilot')
    expect(save).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('cloud 保存后输入态对齐落库值：切走再切回不漂移', async () => {
    const user = userEvent.setup()
    render(<UpdateSourceForm />)
    await user.click(screen.getByRole('button', { name: '云服务' }))
    await user.clear(screen.getByLabelText('仓库地址'))
    await user.type(screen.getByLabelText('仓库地址'), 'https://git.example.com/apilot')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await user.click(screen.getByRole('button', { name: '文件夹' }))
    await user.click(screen.getByRole('button', { name: '云服务' }))
    expect(screen.getByLabelText('仓库地址')).toHaveValue('https://git.example.com/apilot')
  })
})

describe('UpdateSourceForm（folder 表单：选择目录 / 手输校验 / 共存落库）', () => {
  it('选择目录：选完即过可达性校验并落库；cloud 配置共存保留', async () => {
    hydrate({
      kind: 'cloud',
      path: null,
      baseUrl: 'https://git.example.com/apilot',
      mirrorPrefix: 'https://mirror.example.com/',
    })
    vi.mocked(pickDirectory).mockResolvedValue('D:\\updates')
    const user = userEvent.setup()
    render(<UpdateSourceForm />)
    // 存量 cloud 配置以 cloud 态渲染，先切回文件夹类型再选择目录
    await user.click(screen.getByRole('button', { name: '文件夹' }))
    await user.click(screen.getByRole('button', { name: '选择目录' }))

    expect(invokeMock).toHaveBeenCalledWith('check_update_source', { path: 'D:\\updates' })
    expect(invokeMock).toHaveBeenCalledWith('set_setting', {
      key: 'updateSource',
      value: {
        kind: 'folder',
        path: 'D:\\updates',
        baseUrl: 'https://git.example.com/apilot',
        mirrorPrefix: 'https://mirror.example.com/',
      },
    })
  })

  it('目录选择器取消：静默不落库', async () => {
    vi.mocked(pickDirectory).mockResolvedValue(null)
    const user = userEvent.setup()
    render(<UpdateSourceForm />)
    await user.click(screen.getByRole('button', { name: '选择目录' }))

    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('手输路径保存：空输入禁用；非空过校验落库 kind=folder', async () => {
    const user = userEvent.setup()
    render(<UpdateSourceForm />)

    const save = screen.getByRole('button', { name: '保存' })
    expect(save).toBeDisabled()
    await user.type(
      screen.getByLabelText('例如 \\\\server\\public\\apilot-updates'),
      '  \\\\s\\u  ',
    )
    expect(save).toBeEnabled()
    await user.click(save)

    expect(invokeMock).toHaveBeenCalledWith('check_update_source', { path: '\\\\s\\u' })
    expect(invokeMock).toHaveBeenCalledWith('set_setting', {
      key: 'updateSource',
      value: { kind: 'folder', path: '\\\\s\\u', baseUrl: null, mirrorPrefix: '' },
    })
  })

  it('可达性校验失败：toast 报错并阻止落库（带病保存无意义）', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'check_update_source')
        return Promise.reject({ code: 'UPDATE_SOURCE_UNREACHABLE' })
      return Promise.resolve(undefined)
    })
    const user = userEvent.setup()
    render(<UpdateSourceForm />)
    await user.type(
      screen.getByLabelText('例如 \\\\server\\public\\apilot-updates'),
      '\\\\gone\\share',
    )
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(toast.error).toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalledWith('set_setting', expect.anything())
  })
})
