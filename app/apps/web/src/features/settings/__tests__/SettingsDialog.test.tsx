import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider } from '@/app/providers'
import { createQueryWrapper } from '@/test/render-providers'
import { Toaster } from '@workspace/ui/components'
import { useAppStore } from '@/stores/app.store'
import { useSettingsStore } from '@/stores/settings.store'
import { SettingsDialog } from '../SettingsDialog'

// Tauri / IPC 依赖替换：面板交互不触达窗口 API；setSetting 走 store 落库协议
const winMocks = vi.hoisted(() => ({
  unlisten: vi.fn(),
  onThemeChanged: vi.fn().mockResolvedValue(vi.fn()),
  setTheme: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => winMocks,
}))
// get_diagnostics 返回结构化 DTO（复制诊断摘要需要真实字段形态）；
// open_log_dir / check_update_source / set_setting 等命令共用此替身
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
// 文件夹 / 文件选择器替身（日志目录、更新源本机类型与备份组存取；默认取消 = null）
const dialogMocks = vi.hoisted(() => ({
  open: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: dialogMocks.open, save: dialogMocks.save }))
// 「立即重启」替身（官方 process 插件 relaunch；真实调用会退出测试进程）
const relaunchMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: relaunchMock }))
// 剪贴板 spy 持有器（beforeEach 换新实例，测试体内经 .current 断言）
const clipboardState = vi.hoisted(() => ({
  current: { writeText: vi.fn() },
}))

beforeEach(() => {
  vi.clearAllMocks()
  dialogMocks.open.mockResolvedValue(null)
  dialogMocks.save.mockResolvedValue(null)
  relaunchMock.mockResolvedValue(undefined)
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === 'get_diagnostics') {
      return Promise.resolve({
        version: '0.1.0',
        platform: 'windows',
        arch: 'x86_64',
        family: 'windows',
        build: 'debug',
        activeTasks: 0,
        log: { level: 'info', ringCount: 0, ringCapacity: 5000 },
      })
    }
    if (cmd === 'check_updates') {
      return Promise.resolve({ status: 'up_to_date', latestVersion: '0.1.0', notes: null })
    }
    if (cmd === 'backup_export') {
      // 12890112 bytes ≈ 12.3 MB（导出 toast 的字节数拼接断言用）
      return Promise.resolve({ sizeBytes: 12890112 })
    }
    return Promise.resolve(undefined)
  })
  // navigator.clipboard 的替换跨 jsdom 版本形态不稳，用 Proxy 全局 stub：
  // clipboard 指向 spy，其余属性透传原生 navigator
  clipboardState.current = { writeText: vi.fn().mockResolvedValue(undefined) }
  vi.stubGlobal(
    'navigator',
    new Proxy(navigator, {
      get: (target, key) =>
        key === 'clipboard' ? clipboardState.current : Reflect.get(target, key),
    }),
  )
  useAppStore.setState({ settingsOpen: false })
  useSettingsStore.getState().hydrateFromBoot(null, null)
  document.documentElement.className = ''
})

/** 打开面板（与用户点击标题栏设置按钮等价） */
function openSettings() {
  render(
    <ThemeProvider>
      <SettingsDialog />
      {/* 复制诊断等 toast 的呈现宿主（App.tsx 同款挂载） */}
      <Toaster />
    </ThemeProvider>,
    { wrapper: createQueryWrapper() },
  )
  act(() => {
    useAppStore.setState({ settingsOpen: true })
  })
}

describe('SettingsDialog', () => {
  it('打开后默认落外观组：三态预览卡与 6 色板可见', () => {
    openSettings()
    expect(screen.getByRole('heading', { name: '外观' })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: '主题' })).toBeInTheDocument()
    // 默认偏好跟随系统（boot 回退默认态）
    expect(screen.getByRole('radio', { name: '跟随系统' })).toBeChecked()
    expect(screen.getByRole('radiogroup', { name: '强调色' })).toBeInTheDocument()
  })

  it('主题三态卡联动 settings store 并显示跟随系统解析行', async () => {
    const user = userEvent.setup()
    useSettingsStore.setState({ systemTheme: 'light' })
    openSettings()

    await user.click(screen.getByRole('radio', { name: '跟随系统' }))
    expect(useSettingsStore.getState().theme.preference).toBe('system')
    // system 态出现解析行（当前解析值）
    expect(screen.getByTestId('theme-resolved')).toHaveTextContent('当前跟随系统解析为：浅色')

    await user.click(screen.getByRole('radio', { name: '深色' }))
    expect(useSettingsStore.getState().theme.preference).toBe('dark')
    expect(screen.queryByTestId('theme-resolved')).not.toBeInTheDocument()
  })

  it('强调色板切换写 store', async () => {
    const user = userEvent.setup()
    openSettings()
    await user.click(screen.getByRole('radio', { name: '青碧' }))
    expect(useSettingsStore.getState().theme.accent).toBe('teal')
  })

  it('语言组：三态下拉切换即时生效（字典键单点）', async () => {
    const user = userEvent.setup()
    openSettings()

    // 切到语言组
    await user.click(screen.getByRole('button', { name: /语言/ }))
    expect(screen.getByLabelText('界面语言')).toBeInTheDocument()

    await user.click(screen.getByLabelText('界面语言'))
    await user.click(screen.getByRole('option', { name: 'English' }))
    expect(useSettingsStore.getState().locale.preference).toBe('en')
    // 即时生效：语言组标题切英文（当前组仍为语言组）
    expect(screen.getByRole('heading', { name: 'Language' })).toBeInTheDocument()
  })

  it('开发者组：devMode 开关与 logLevel 分段联动 store（门控开启后可用）', async () => {
    const user = userEvent.setup()
    openSettings()
    await user.click(screen.getByRole('button', { name: /开发者/ }))

    const devSwitch = screen.getByRole('switch', { name: '开发者模式' })
    await user.click(devSwitch)
    expect(useSettingsStore.getState().devMode.enabled).toBe(true)

    await user.click(screen.getByRole('button', { name: 'debug' }))
    expect(useSettingsStore.getState().logLevel.level).toBe('debug')
  })

  it('门控两态渲染：关时仅见开关，开时其余条目即时齐现', async () => {
    const user = userEvent.setup()
    openSettings()
    await user.click(screen.getByRole('button', { name: /开发者/ }))

    // 默认 devMode 关：组内只有开关行，其余条目不渲染（条件渲染而非 disabled）
    expect(screen.getByRole('switch', { name: '开发者模式' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'debug' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '复制诊断信息' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '打开日志目录' })).not.toBeInTheDocument()

    // 开启后即时出现（store 订阅驱动，无需重开面板）
    await user.click(screen.getByRole('switch', { name: '开发者模式' }))
    expect(screen.getByRole('button', { name: 'debug' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复制诊断信息' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '打开日志目录' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '更改目录' })).toBeInTheDocument()
    expect(screen.getByText('更新源')).toBeInTheDocument()
  })

  it('搜索过滤与门控叠加：关态搜「日志」整组不可见，搜「诊断」仅开关在场', async () => {
    const user = userEvent.setup()
    openSettings()
    const search = screen.getByRole('searchbox', { name: '搜索设置…' })

    // 「日志」只出现在门控条目标签里：devMode 关时开发者组整体不可见
    await user.type(search, '日志')
    expect(screen.queryByRole('button', { name: /开发者/ })).not.toBeInTheDocument()
    await user.clear(search)

    // 「诊断」命中组描述（常驻过滤域）：组可见，但内容只有开关行
    await user.type(search, '诊断')
    expect(screen.getByRole('button', { name: /开发者/ })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '开发者模式' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '复制诊断信息' })).not.toBeInTheDocument()
    await user.clear(search)

    // devMode 开启后「日志」命中门控条目：组可见且条目齐现
    act(() => {
      useSettingsStore.setState({ devMode: { enabled: true } })
    })
    await user.type(search, '日志')
    expect(screen.getByRole('button', { name: /开发者/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'debug' })).toBeInTheDocument()
  })

  it('关于组：版本块与更新日志时间线可见；检查更新真实调命令 + 自动检查开关', async () => {
    const user = userEvent.setup()
    openSettings()
    await user.click(screen.getByRole('button', { name: /关于/ }))

    expect(screen.getByText('APilot', { exact: true })).toBeInTheDocument()
    expect(screen.getByText('更新日志')).toBeInTheDocument()
    // 自动检查更新开关（普通用户偏好，常驻关于组）
    const autoSwitch = screen.getByRole('switch', { name: '自动检查更新' })
    expect(autoSwitch).toBeChecked()
    await user.click(autoSwitch)
    expect(useSettingsStore.getState().autoCheckUpdates.enabled).toBe(false)

    // 检查更新：真实调 check_updates（mock 返回 up_to_date → 成功文案）
    await user.click(screen.getByRole('button', { name: '检查更新' }))
    expect(await screen.findByText('当前已是最新版本')).toBeInTheDocument()
  })

  it('搜索按组名过滤导航；当前组被滤掉时回落并提示空态', async () => {
    const user = userEvent.setup()
    openSettings()

    // 命中关键词「诊断」→ 仅开发者组可见（关键词含英文别名与中文组名）
    const search = screen.getByRole('searchbox', { name: '搜索设置…' })
    await user.type(search, '诊断')
    expect(screen.getByRole('button', { name: /开发者/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /外观/ })).not.toBeInTheDocument()

    // 当前组（appearance）被滤掉 → activeId 自动回落到首个可见组（开发者）
    expect(screen.getByRole('heading', { name: '开发者' })).toBeInTheDocument()

    // 无命中 → 导航空态（搜索无命中提示）
    await user.clear(search)
    await user.type(search, '不存在的设置项xyz')
    expect(screen.getAllByText('没有匹配的设置项').length).toBeGreaterThan(0)
  })

  it('HTTP 组转实：四行齐备（超时分段 / 双开关 / 代理单选）', async () => {
    const user = userEvent.setup()
    openSettings()
    await user.click(screen.getByRole('button', { name: /HTTP/ }))
    expect(screen.getByRole('button', { name: '不限制' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '跟随重定向' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '校验 TLS 证书' })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: '代理' })).toBeInTheDocument()
    // 组内为真实控件（搜索空态文本不出现）
    expect(screen.queryByText('没有匹配的设置项')).not.toBeInTheDocument()
  })

  it('快捷键组出现在导航并渲染命令键位分区', async () => {
    const user = userEvent.setup()
    openSettings()
    await user.click(screen.getByRole('button', { name: /快捷键/ }))
    expect(screen.getByTestId('keybindings-section')).toBeInTheDocument()
  })

  it('复制诊断信息：成功写剪贴板并 toast 确认；失败走失败提示', async () => {
    const user = userEvent.setup()
    openSettings()
    await user.click(screen.getByRole('button', { name: /开发者/ }))
    // 门控条目：先开 devMode 才渲染
    await user.click(screen.getByRole('switch', { name: '开发者模式' }))

    // 成功分支：get_diagnostics（mock 返回 undefined 亦能拼出摘要行）→ 剪贴板 + toast
    await user.click(screen.getByRole('button', { name: '复制诊断信息' }))
    // copyDiagnostics 是 async 链：先等 toast 出现再断言 spy（click 返回时微任务未必跑完）
    expect(await screen.findByText('诊断信息已复制')).toBeInTheDocument()
    expect(clipboardState.current.writeText).toHaveBeenCalledOnce()

    // 失败分支：剪贴板拒绝 → 失败 toast（诊断摘要拼接失败同样落入）
    clipboardState.current.writeText.mockRejectedValueOnce(new Error('denied'))
    await user.click(screen.getByRole('button', { name: '复制诊断信息' }))
    expect(await screen.findByText('复制失败，请手动复制')).toBeInTheDocument()
  })

  it('打开日志目录：调用 open_log_dir 命令（services/log-dir 单一事实源）', async () => {
    const user = userEvent.setup()
    openSettings()
    await user.click(screen.getByRole('button', { name: /开发者/ }))
    // 门控条目：先开 devMode 才渲染
    await user.click(screen.getByRole('switch', { name: '开发者模式' }))
    await user.click(screen.getByRole('button', { name: '打开日志目录' }))
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('open_log_dir')
    })
  })

  it('日志目录：更改目录选完即落库并提示重启生效；取消不落库', async () => {
    const user = userEvent.setup()
    openSettings()
    await user.click(screen.getByRole('button', { name: /开发者/ }))
    await user.click(screen.getByRole('switch', { name: '开发者模式' }))

    // 取消（dialog 返回 null）：静默，无落库
    await user.click(screen.getByRole('button', { name: '更改目录' }))
    expect(dialogMocks.open).toHaveBeenCalledWith({ directory: true, multiple: false })
    expect(invokeMock).not.toHaveBeenCalledWith(
      'set_setting',
      expect.objectContaining({ key: 'logDir' }),
    )

    // 选定目录：set_setting 落库 + 重启生效提示；恢复默认钮解禁
    dialogMocks.open.mockResolvedValue('D:\\NewLogs')
    await user.click(screen.getByRole('button', { name: '更改目录' }))
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('set_setting', {
        key: 'logDir',
        value: { path: 'D:\\NewLogs' },
      })
    })
    expect(await screen.findByText('日志目录已更新，重启应用后生效')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '恢复默认' })).toBeEnabled()
  })

  it('更新源：云服务禁用占位；UNC 校验成功保存、失败阻止落库', async () => {
    const user = userEvent.setup()
    openSettings()
    await user.click(screen.getByRole('button', { name: /开发者/ }))
    await user.click(screen.getByRole('switch', { name: '开发者模式' }))

    // 云服务禁用占位（不可选）
    expect(screen.getByRole('button', { name: '云服务' })).toBeDisabled()

    // 切到局域网共享，输入 UNC
    await user.click(screen.getByRole('button', { name: '局域网共享' }))
    const uncInput = screen.getByRole('textbox', {
      name: '例如 \\\\server\\public\\apilot-updates',
    })
    await user.type(uncInput, '\\\\server\\share')

    // 校验失败：toast 报错且不落库（带病保存被阻止）
    invokeMock.mockImplementationOnce(() =>
      Promise.reject({
        kind: 'apilot_error',
        code: 'UPDATE_SOURCE_UNREACHABLE',
        message: 'no route',
      }),
    )
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('更新源路径不可达，请检查后重试')).toBeInTheDocument()
    expect(invokeMock).not.toHaveBeenCalledWith(
      'set_setting',
      expect.objectContaining({ key: 'updateSource' }),
    )

    // 校验成功：整键落库 + 确认 toast
    await user.click(screen.getByRole('button', { name: '保存' }))
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('set_setting', {
        key: 'updateSource',
        value: { type: 'network', path: '\\\\server\\share' },
      })
    })
    expect(await screen.findByText('更新源已保存')).toBeInTheDocument()
  })

  it('设置导航收敛为 7 组：编辑器 / 同步 / 快照搜索均无命中', async () => {
    const user = userEvent.setup()
    openSettings()
    const search = screen.getByRole('searchbox', { name: '搜索设置…' })

    // 三个已删组关键词全部零命中（导航空态，无任何导航按钮在场）
    for (const term of ['编辑器', '同步', '快照']) {
      await user.clear(search)
      await user.type(search, term)
      expect(
        screen.queryByRole('button', { name: /备份|外观|语言|快捷键|HTTP|开发者|关于/ }),
      ).not.toBeInTheDocument()
    }

    // 清空搜索后 7 组齐现
    await user.clear(search)
    for (const name of [/外观/, /语言/, /快捷键/, /HTTP/, /备份/, /开发者/, /关于/]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
  })

  it('备份组转实：导出 / 恢复两动作渲染', async () => {
    const user = userEvent.setup()
    openSettings()
    // 当前组为外观：/备份/ 唯一命中导航项
    await user.click(screen.getByRole('button', { name: /备份/ }))

    expect(screen.getByRole('button', { name: '导出备份' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '恢复备份' })).toBeInTheDocument()
  })

  it('备份导出：另存框默认名带时间戳；成功 toast 含目标路径；取消静默', async () => {
    const user = userEvent.setup()
    openSettings()
    await user.click(screen.getByRole('button', { name: /备份/ }))

    // 取消（save 返回 null）：不发起导出 IPC
    await user.click(screen.getByRole('button', { name: '导出备份' }))
    expect(dialogMocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringMatching(/^apilot-backup-\d{8}-\d{6}\.zip$/),
      }),
    )
    expect(invokeMock).not.toHaveBeenCalledWith('backup_export', expect.anything())

    // 选定路径：backup_export 以所选路径调用 + toast 含产物大小与目标路径
    dialogMocks.save.mockResolvedValue('D:\\Backups\\apilot-backup-20261019-120000.zip')
    await user.click(screen.getByRole('button', { name: '导出备份' }))
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('backup_export', {
        path: 'D:\\Backups\\apilot-backup-20261019-120000.zip',
      })
    })
    expect(
      await screen.findByText(
        '备份已导出（12.3 MB）：D:\\Backups\\apilot-backup-20261019-120000.zip',
      ),
    ).toBeInTheDocument()
  })

  it('恢复备份两段式：预检失败走错误提示且不进确认框', async () => {
    const user = userEvent.setup()
    openSettings()
    await user.click(screen.getByRole('button', { name: /备份/ }))

    dialogMocks.open.mockResolvedValue('D:\\Backups\\bad.zip')
    invokeMock.mockImplementationOnce(() =>
      Promise.reject({
        kind: 'apilot_error',
        code: 'BACKUP_INVALID_ZIP',
        message: 'not a zip archive',
      }),
    )
    await user.click(screen.getByRole('button', { name: '恢复备份' }))

    // 错误码文案呈现；确认框不出现；不执行暂存
    expect(await screen.findByText('所选文件不是有效的备份包')).toBeInTheDocument()
    expect(screen.queryByTestId('backup-restore-confirm')).not.toBeInTheDocument()
    expect(invokeMock).toHaveBeenCalledWith('backup_validate', { path: 'D:\\Backups\\bad.zip' })
    expect(invokeMock).not.toHaveBeenCalledWith('backup_restore', expect.anything())
  })

  it('恢复备份两段式：预检通过弹确认框；取消不执行、确认后暂存并提示重启', async () => {
    const user = userEvent.setup()
    openSettings()
    await user.click(screen.getByRole('button', { name: /备份/ }))

    dialogMocks.open.mockResolvedValue('D:\\Backups\\good.zip')
    await user.click(screen.getByRole('button', { name: '恢复备份' }))
    // 预检通过 → 确认框在场
    expect(await screen.findByTestId('backup-restore-confirm')).toBeInTheDocument()

    // 取消：丢弃待确认路径，不执行暂存
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByTestId('backup-restore-confirm')).not.toBeInTheDocument()
    expect(invokeMock).not.toHaveBeenCalledWith('backup_restore', expect.anything())

    // 再走一遍确认：backup_restore 执行 → 重启确认模态（非 toast）
    await user.click(screen.getByRole('button', { name: '恢复备份' }))
    expect(await screen.findByTestId('backup-restore-confirm')).toBeInTheDocument()
    await user.click(screen.getByTestId('backup-restore-confirm-action'))
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('backup_restore', { path: 'D:\\Backups\\good.zip' })
    })
    expect(await screen.findByTestId('backup-restart-confirm')).toBeInTheDocument()
  })

  it('恢复选文件对话框在场期间入口禁用；取消后复位（picking 守卫，与导出侧对称）', async () => {
    const user = userEvent.setup()
    openSettings()
    await user.click(screen.getByRole('button', { name: /备份/ }))

    // 对话框挂起未决（Windows 系统对话框不模态于主窗）：入口按钮已禁用
    let settle!: (value: string | null) => void
    dialogMocks.open.mockReturnValue(
      new Promise<string | null>((resolve) => {
        settle = resolve
      }),
    )
    await user.click(screen.getByRole('button', { name: '恢复备份' }))
    expect(screen.getByRole('button', { name: '恢复备份' })).toBeDisabled()

    // 取消（null）：回空闲，入口解禁，不发起预检
    await act(async () => {
      settle(null)
    })
    expect(screen.getByRole('button', { name: '恢复备份' })).toBeEnabled()
    expect(invokeMock).not.toHaveBeenCalledWith('backup_validate', expect.anything())
  })

  it('恢复执行失败：错误提示呈现且确认框留在场，再次确认成功转重启模态', async () => {
    const user = userEvent.setup()
    openSettings()
    await user.click(screen.getByRole('button', { name: /备份/ }))

    dialogMocks.open.mockResolvedValue('D:\\Backups\\good.zip')
    await user.click(screen.getByRole('button', { name: '恢复备份' }))
    expect(await screen.findByTestId('backup-restore-confirm')).toBeInTheDocument()

    // 确认后 backup_restore 拒绝：错误 toast 呈现，确认框刻意留在场可重试
    invokeMock.mockImplementationOnce(() =>
      Promise.reject({
        kind: 'apilot_error',
        code: 'BACKUP_RESTORE_WRITE_FAILED',
        message: 'disk full',
      }),
    )
    await user.click(screen.getByTestId('backup-restore-confirm-action'))
    expect(await screen.findByText('备份恢复暂存失败，请重试')).toBeInTheDocument()
    expect(screen.getByTestId('backup-restore-confirm')).toBeInTheDocument()

    // 再次确认成功 → 重启确认模态
    await user.click(screen.getByTestId('backup-restore-confirm-action'))
    expect(await screen.findByTestId('backup-restart-confirm')).toBeInTheDocument()
  })

  it('重启确认模态：「立即重启」调用 relaunch；「知道了」关闭回空闲', async () => {
    const user = userEvent.setup()
    openSettings()
    await user.click(screen.getByRole('button', { name: /备份/ }))

    dialogMocks.open.mockResolvedValue('D:\\Backups\\good.zip')
    await user.click(screen.getByRole('button', { name: '恢复备份' }))
    expect(await screen.findByTestId('backup-restore-confirm')).toBeInTheDocument()
    await user.click(screen.getByTestId('backup-restore-confirm-action'))
    expect(await screen.findByTestId('backup-restart-confirm')).toBeInTheDocument()
    // 正文重申窗口期写入丢失口径
    expect(
      screen.getByText('重启应用后生效；受理后到重启前的数据写入将被备份内容替换，请尽快重启。'),
    ).toBeInTheDocument()

    // 「立即重启」：官方 process 插件 relaunch（应用随即退出）
    await user.click(screen.getByRole('button', { name: '立即重启' }))
    await vi.waitFor(() => {
      expect(relaunchMock).toHaveBeenCalledOnce()
    })

    // 「知道了」：关闭模态回空闲，恢复入口解禁
    await user.click(screen.getByRole('button', { name: '知道了' }))
    expect(screen.queryByTestId('backup-restart-confirm')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '恢复备份' })).toBeEnabled()
  })

  it('en 语言下面板文案即时切换（i18n 联动）', () => {
    openSettings()
    act(() => {
      useSettingsStore.setState({ locale: { preference: 'en' } })
    })
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Light' })).toBeInTheDocument()
  })
})
