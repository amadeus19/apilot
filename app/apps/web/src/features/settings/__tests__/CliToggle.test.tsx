import { Toaster } from '@workspace/ui/components'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DeveloperSection } from '../sections/DeveloperSection'
import type { CliStatus } from '@/services/ipc'
import { createQueryWrapper } from '@/test/render-providers'
import { useSettingsStore } from '@/stores/settings.store'

// IPC 替身：get_cli_status 回放可变的状态夹具（镜像真值源）；
// register_cli_path / unregister_cli_path 改写夹具的注册态，模拟注册表真值变化
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
const pathMocks = vi.hoisted(() => ({ appLogDir: vi.fn().mockResolvedValue('C:\\Logs') }))
vi.mock('@tauri-apps/api/path', () => ({ appLogDir: pathMocks.appLogDir }))

const OWN_EXE = 'C:\\Apps\\APilot\\apilot.exe'

/** S1 正常态夹具；各态测试按需覆写 */
function statusFixture(overrides: Partial<CliStatus> = {}): CliStatus {
  return {
    exePath: OWN_EXE,
    version: '0.1.5',
    binaryAvailable: true,
    isDevBuild: false,
    registered: true,
    resolvedDir: 'C:\\Apps\\APilot',
    shadowedBy: null,
    staleDirs: [],
    ...overrides,
  }
}

/** 可变夹具与失败开关：mock 每次调用读取当下值 */
const world = {
  status: statusFixture(),
  registerFails: false,
  unregisterFails: false,
}

const writeTextMock = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  vi.clearAllMocks()
  world.status = statusFixture()
  world.registerFails = false
  world.unregisterFails = false
  writeTextMock.mockResolvedValue(undefined)
  // Proxy 全局 stub：userEvent.setup 会替换 navigator.clipboard，经 Proxy 拦截
  // clipboard 读取才能稳定命中 spy（其余属性透传）
  vi.stubGlobal(
    'navigator',
    new Proxy(navigator, {
      get: (target, key) =>
        key === 'clipboard' ? { writeText: writeTextMock } : Reflect.get(target, key),
    }),
  )
  invokeMock.mockImplementation((cmd: string) => {
    switch (cmd) {
      case 'get_diagnostics':
        return Promise.resolve({
          version: '0.1.5',
          platform: 'windows',
          arch: 'x86_64',
          family: 'windows',
          build: 'debug',
          activeTasks: 0,
          log: { level: 'info', ringCount: 0, ringCapacity: 5000 },
        })
      case 'get_cli_status':
        return Promise.resolve(world.status)
      case 'register_cli_path':
        if (world.registerFails) {
          return Promise.reject(
            Object.assign(new Error('registry write failed'), { code: 'CLI_PATH_REGISTRY_FAILED' }),
          )
        }
        world.status = { ...world.status, registered: true, resolvedDir: 'C:\\Apps\\APilot' }
        return Promise.resolve(undefined)
      case 'unregister_cli_path':
        if (world.unregisterFails) {
          return Promise.reject(
            Object.assign(new Error('unregister failed'), { code: 'CLI_PATH_REGISTRY_FAILED' }),
          )
        }
        world.status = { ...world.status, registered: false, resolvedDir: null }
        return Promise.resolve(undefined)
      default:
        return Promise.resolve(undefined)
    }
  })
  pathMocks.appLogDir.mockResolvedValue('C:\\Logs')
  useSettingsStore.getState().hydrateFromBoot(null, null)
})

function renderSection() {
  const Wrapper = createQueryWrapper()
  return render(
    <Wrapper>
      <DeveloperSection />
      <Toaster />
    </Wrapper>,
  )
}

const switchRole = { role: 'switch', name: '命令行界面' } as const
// 弹窗打开时页面其余部分被置 aria-hidden：hidden:true 让开关在待定态仍可查到
const getToggle = () => screen.getByRole(switchRole.role, { name: switchRole.name, hidden: true })
// Base UI Switch 渲染为 span[role=switch]，禁用态以 aria-disabled 表达（非 disabled 属性）
const expectToggleDisabled = () => expect(getToggle()).toHaveAttribute('aria-disabled', 'true')
const expectToggleEnabled = () => expect(getToggle()).not.toHaveAttribute('aria-disabled', 'true')
const statusCalls = () =>
  invokeMock.mock.calls.filter((call: unknown[]) => call[0] === 'get_cli_status').length

/** 等到首次探测回来（开关解除禁用） */
async function waitForStatus() {
  await waitFor(() => expectToggleEnabled())
}

/** 拨开开关到弹窗出现 */
async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(getToggle())
  const dialog = await screen.findByTestId('cli-register-dialog')
  return { toggle: getToggle(), dialog }
}

describe('设置「高级」CLI 开关（注册表真值镜像）', () => {
  it('探测未回来前开关禁用、三行显示检测中；回来后镜像注册态', async () => {
    let resolveStatus: ((status: CliStatus) => void) | undefined
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'get_cli_status'
        ? new Promise<CliStatus>((resolve) => {
            resolveStatus = resolve
          })
        : Promise.resolve(undefined),
    )
    renderSection()

    expectToggleDisabled()
    expect(getToggle()).toHaveAttribute('aria-checked', 'false')
    expect(screen.getAllByText('检测中…')).toHaveLength(3)

    resolveStatus?.(statusFixture({ registered: true }))
    await waitForStatus()
    expect(getToggle()).toHaveAttribute('aria-checked', 'true')
    // 打开即探测一次，无手动刷新按钮
    expect(statusCalls()).toBe(1)
    expect(screen.queryByRole('button', { name: /刷新/ })).not.toBeInTheDocument()
  })

  it('S2 未注册：开关关、PATH 行「未注册」；版本与路径仍显示；无安装 / 重新注册按钮', async () => {
    world.status = statusFixture({ registered: false, resolvedDir: null })
    renderSection()
    await waitForStatus()

    expect(getToggle()).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('cli-status-path-env-value')).toHaveTextContent('未注册')
    expect(screen.getByTestId('cli-status-version-value')).toHaveTextContent('0.1.5')
    expect(screen.getByTestId('cli-status-path')).toHaveTextContent(OWN_EXE)
    expect(screen.getByRole('button', { name: '复制 CLI 路径' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /安装 CLI/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /重新注册/ })).not.toBeInTheDocument()
    // 正常态无任何警示
    expect(screen.queryByText(/CLI 二进制不可用/)).not.toBeInTheDocument()
    expect(screen.queryByText(/开发构建目录/)).not.toBeInTheDocument()
  })

  it('S1 正常：开关开、PATH 行「已注册」、无警示无残留提示', async () => {
    renderSection()
    await waitForStatus()
    expect(getToggle()).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('cli-status-path-env-value')).toHaveTextContent('已注册')
    expect(screen.queryByText(/终端/)).not.toBeInTheDocument()
    expect(screen.queryByText(/失效条目/)).not.toBeInTheDocument()
  })

  it('拨开：弹窗＋开关「开＋禁用」待定态；跳过 → 弹窗关、开关回关、未写 PATH', async () => {
    const user = userEvent.setup()
    world.status = statusFixture({ registered: false, resolvedDir: null })
    renderSection()
    await waitForStatus()

    const { toggle } = await openDialog(user)
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expectToggleDisabled()
    expect(screen.getByText('设置CLI以在终端中使用')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '跳过' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '注册' })).toBeInTheDocument()
    expect(invokeMock).not.toHaveBeenCalledWith('register_cli_path')

    await user.click(screen.getByRole('button', { name: '跳过' }))
    await waitFor(() => expect(screen.queryByTestId('cli-register-dialog')).not.toBeInTheDocument())
    expect(getToggle()).toHaveAttribute('aria-checked', 'false')
    expectToggleEnabled()
    expect(invokeMock).not.toHaveBeenCalledWith('register_cli_path')
  })

  it('Esc 关闭弹窗＝跳过语义', async () => {
    const user = userEvent.setup()
    world.status = statusFixture({ registered: false, resolvedDir: null })
    renderSection()
    await waitForStatus()

    await openDialog(user)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('cli-register-dialog')).not.toBeInTheDocument())
    expect(getToggle()).toHaveAttribute('aria-checked', 'false')
    expect(invokeMock).not.toHaveBeenCalledWith('register_cli_path')
  })

  it('注册成功：调 register_cli_path → 失效重取 → 弹窗关、开关亮', async () => {
    const user = userEvent.setup()
    world.status = statusFixture({ registered: false, resolvedDir: null })
    renderSection()
    await waitForStatus()
    const before = statusCalls()

    await openDialog(user)
    await user.click(screen.getByRole('button', { name: '注册' }))

    expect(invokeMock).toHaveBeenCalledWith('register_cli_path')
    await waitFor(() => expect(screen.queryByTestId('cli-register-dialog')).not.toBeInTheDocument())
    // 注册成功后失效重取（镜像态随真值翻转）
    expect(statusCalls()).toBeGreaterThan(before)
    expect(getToggle()).toHaveAttribute('aria-checked', 'true')
    expectToggleEnabled()
    expect(screen.getByTestId('cli-status-path-env-value')).toHaveTextContent('已注册')
    expect(await screen.findByText('已注册，重启终端后生效')).toBeInTheDocument()
  })

  it('注册失败：弹窗原位停留＋错误透传＋[取消][重试]；取消回关；重试成功落开态', async () => {
    const user = userEvent.setup()
    world.status = statusFixture({ registered: false, resolvedDir: null })
    world.registerFails = true
    renderSection()
    await waitForStatus()

    await openDialog(user)
    await user.click(screen.getByRole('button', { name: '注册' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('registry write failed')
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
    // 失败弹窗仍开：开关保持待定态
    expect(getToggle()).toHaveAttribute('aria-checked', 'true')
    expectToggleDisabled()

    // 取消＝跳过语义：回镜像态（未注册）
    await user.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByTestId('cli-register-dialog')).not.toBeInTheDocument())
    expect(getToggle()).toHaveAttribute('aria-checked', 'false')

    // 再入口＝再开开关 → 重试成功
    world.registerFails = false
    await openDialog(user)
    await user.click(screen.getByRole('button', { name: '注册' }))
    await waitFor(() => expect(screen.queryByTestId('cli-register-dialog')).not.toBeInTheDocument())
    expect(getToggle()).toHaveAttribute('aria-checked', 'true')
  })

  it('拨关（已注册）：静默注销、无弹窗；重取后开关关', async () => {
    const user = userEvent.setup()
    renderSection()
    await waitForStatus()
    expect(getToggle()).toHaveAttribute('aria-checked', 'true')
    const before = statusCalls()

    await user.click(getToggle())
    expect(invokeMock).toHaveBeenCalledWith('unregister_cli_path')
    expect(screen.queryByTestId('cli-register-dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(getToggle()).toHaveAttribute('aria-checked', 'false'))
    expect(statusCalls()).toBeGreaterThan(before)
    expect(screen.getByTestId('cli-status-path-env-value')).toHaveTextContent('未注册')
  })

  it('拨关注销失败：toast 透传错误，开关回弹开且可再次拨动', async () => {
    const user = userEvent.setup()
    world.unregisterFails = true
    renderSection()
    await waitForStatus()

    await user.click(getToggle())
    expect(invokeMock).toHaveBeenCalledWith('unregister_cli_path')
    expect(await screen.findByText('unregister failed')).toBeInTheDocument()
    // 注册态真值未变：开关回弹开、解除进行态
    await waitFor(() => expect(getToggle()).toHaveAttribute('aria-checked', 'true'))
    await waitFor(() => expectToggleEnabled())
    expect(screen.getByTestId('cli-status-path-env-value')).toHaveTextContent('已注册')
  })

  it('S3 未注册＋被遮蔽：开关关、⚠ 文案含遮蔽目录', async () => {
    world.status = statusFixture({
      registered: false,
      resolvedDir: 'C:\\OldApilot',
      shadowedBy: 'C:\\OldApilot',
    })
    renderSection()
    await waitForStatus()
    expect(getToggle()).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('cli-status-path-env')).toHaveTextContent(
      '终端的 apilot 来自 C:\\OldApilot',
    )
  })

  it('S4 已注册＋被遮蔽：开关开、⚠ 文案含遮蔽目录与复制路径引导', async () => {
    world.status = statusFixture({ resolvedDir: 'C:\\OldApilot', shadowedBy: 'C:\\OldApilot' })
    renderSection()
    await waitForStatus()
    expect(getToggle()).toHaveAttribute('aria-checked', 'true')
    const row = screen.getByTestId('cli-status-path-env')
    expect(row).toHaveTextContent('已注册')
    expect(row).toHaveTextContent('终端优先解析到 C:\\OldApilot')
    expect(row).toHaveTextContent('复制 CLI 路径')
  })

  it('S5 残留旧目录：正常之外附提示', async () => {
    world.status = statusFixture({ staleDirs: ['C:\\OldApilot'] })
    renderSection()
    await waitForStatus()
    expect(getToggle()).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('cli-status-path-env')).toHaveTextContent(
      '注册表另有含 apilot.exe 的失效条目（旧安装遗留，无害）',
    )
  })

  it('S6 二进制不可用：版本行 ⚠；版本缺失显示占位', async () => {
    world.status = statusFixture({ binaryAvailable: false, version: null })
    renderSection()
    await waitForStatus()
    const row = screen.getByTestId('cli-status-version')
    expect(row).toHaveTextContent('CLI 二进制不可用，修复安装或重装应用')
    expect(screen.getByTestId('cli-status-version-value')).toHaveTextContent('—')
  })

  it('S7 开发构建目录：路径行警示', async () => {
    world.status = statusFixture({
      isDevBuild: true,
      exePath: 'D:\\repo\\target\\debug\\apilot.exe',
    })
    renderSection()
    await waitForStatus()
    const row = screen.getByTestId('cli-status-path')
    expect(row).toHaveTextContent('D:\\repo\\target\\debug\\apilot.exe')
    expect(row).toHaveTextContent('开发构建目录，正式安装后需重新注册')
  })

  it('[复制 CLI 路径] 复制 exe 全路径（不是目录）', async () => {
    const user = userEvent.setup()
    renderSection()
    await waitForStatus()
    await user.click(screen.getByRole('button', { name: '复制 CLI 路径' }))
    await waitFor(() => expect(writeTextMock).toHaveBeenCalledWith(OWN_EXE))
  })

  it('探测失败：显示无法获取状态，开关禁用', async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'get_cli_status'
        ? Promise.reject(
            Object.assign(new Error('registry open failed'), { code: 'CLI_PATH_REGISTRY_FAILED' }),
          )
        : Promise.resolve(undefined),
    )
    renderSection()
    expect(await screen.findByText('无法获取 CLI 状态')).toBeInTheDocument()
    expectToggleDisabled()
  })
})
