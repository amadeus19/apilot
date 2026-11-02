import { act, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryWrapper } from '@/test/render-providers'
import { useAppStore } from '@/stores/app.store'
import { useSettingsStore } from '@/stores/settings.store'
import { useTabsStore, WORKSPACE_SETTINGS_TAB_ID, type TabMeta } from '@/stores/tabs.store'
import { registerSendAction } from '@/features/workbench/send-action-bridge'
import { workbenchKeys } from '@/services/workbench-api'
import { variableKeys } from '@/features/variables/variable-api'

import { useCommandsStore } from '../commands.store'
import { useGlobalCommands } from '../global-commands'
import { useCommandDispatcher } from '../use-command-dispatcher'
import { useRegisterCommands } from '../use-register-commands'
import type { CommandDef } from '../types'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

/** 命令注册 seam（注册 / 幂等覆盖 / 卸载清理）与统一分发器 */
function makeCommand(id: string, overrides?: Partial<CommandDef>): CommandDef {
  return {
    id,
    labelKey: 'commandPalette.cmdOpenSettings',
    group: 'settings',
    run: () => {},
    ...overrides,
  }
}

function RegistryProbe({ defs }: { defs: CommandDef[] }) {
  useRegisterCommands(defs, [defs])
  return null
}

beforeEach(() => {
  invokeMock.mockImplementation(() => Promise.resolve(undefined))
  useCommandsStore.setState({ commands: [], paletteOpen: false })
  useAppStore.setState({ settingsOpen: false, searchFocusNonce: 0 })
  useSettingsStore.setState({ keybindings: {} })
})

afterEach(() => {
  useCommandsStore.setState({ commands: [], paletteOpen: false })
})

describe('useRegisterCommands', () => {
  it('挂载注册、卸载清理；挂载循环三次注册表不增长（资源四问）', () => {
    const defs = [makeCommand('a'), makeCommand('b')]
    for (let round = 0; round < 3; round += 1) {
      const view = render(<RegistryProbe defs={defs} />)
      expect(useCommandsStore.getState().commands.map((c) => c.id)).toEqual(['a', 'b'])
      view.unmount()
      expect(useCommandsStore.getState().commands).toHaveLength(0)
    }
  })

  it('同 id 重注册幂等覆盖：定义被替换、注册表不增长', () => {
    const first = render(<RegistryProbe defs={[makeCommand('a', { defaultShortcut: 'Ctrl+X' })]} />)
    expect(useCommandsStore.getState().commands).toHaveLength(1)
    first.rerender(<RegistryProbe defs={[makeCommand('a', { defaultShortcut: 'Ctrl+Y' })]} />)
    const registered = useCommandsStore.getState().commands
    expect(registered).toHaveLength(1)
    expect(registered[0]?.defaultShortcut).toBe('Ctrl+Y')
  })

  it('卸载只摘自己的注册项（他者注册不受影响）', () => {
    const keep = render(<RegistryProbe defs={[makeCommand('keep')]} />)
    const gone = render(<RegistryProbe defs={[makeCommand('gone')]} />)
    expect(useCommandsStore.getState().commands).toHaveLength(2)
    gone.unmount()
    expect(useCommandsStore.getState().commands.map((c) => c.id)).toEqual(['keep'])
    keep.unmount()
    expect(useCommandsStore.getState().commands).toHaveLength(0)
  })
})

/** 全局命令 + 统一分发器：默认键位 / 覆盖＞默认 / 参数化族 / 清空 */
function CommandHost() {
  useGlobalCommands()
  useCommandDispatcher()
  return null
}

function pressKey(init: KeyboardEventInit) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', init))
  })
}

describe('useCommandDispatcher（全局命令接线）', () => {
  function renderHost() {
    return render(<CommandHost />, { wrapper: createQueryWrapper() })
  }

  it('Ctrl+Shift+P 开关命令面板；Ctrl+, 打开设置', () => {
    renderHost()
    pressKey({ ctrlKey: true, shiftKey: true, key: 'P' })
    expect(useCommandsStore.getState().paletteOpen).toBe(true)
    pressKey({ ctrlKey: true, shiftKey: true, key: 'P' })
    expect(useCommandsStore.getState().paletteOpen).toBe(false)
    pressKey({ ctrlKey: true, key: ',' })
    expect(useAppStore.getState().settingsOpen).toBe(true)
  })

  it('键位覆盖＞默认值：改绑后新键触发、旧键不触发', () => {
    renderHost()
    act(() => {
      useSettingsStore.getState().setKeybinding('settings.open', 'Ctrl+Alt+O')
    })
    pressKey({ ctrlKey: true, key: ',' })
    expect(useAppStore.getState().settingsOpen).toBe(false)
    pressKey({ ctrlKey: true, altKey: true, key: 'O' })
    expect(useAppStore.getState().settingsOpen).toBe(true)
  })

  it('显式清空后默认键位不再触发', () => {
    renderHost()
    act(() => {
      useSettingsStore.getState().setKeybinding('settings.open', null)
    })
    pressKey({ ctrlKey: true, key: ',' })
    expect(useAppStore.getState().settingsOpen).toBe(false)
  })

  it('Ctrl+1..9 参数化族切换到对应标签（tabs store 真实动作）', () => {
    const tabs: TabMeta[] = [
      {
        id: 'endpoint:s1:e1',
        kind: 'endpoint',
        title: '一',
        serviceId: 's1',
        key: 'e1',
        preview: false,
      },
      {
        id: 'endpoint:s1:e2',
        kind: 'endpoint',
        title: '二',
        serviceId: 's1',
        key: 'e2',
        preview: false,
      },
      {
        id: 'endpoint:s1:e3',
        kind: 'endpoint',
        title: '三',
        serviceId: 's1',
        key: 'e3',
        preview: false,
      },
    ]
    act(() => {
      useTabsStore.setState({ tabs, activeTabId: tabs[0]!.id })
    })
    renderHost()
    pressKey({ ctrlKey: true, key: '3' })
    expect(useTabsStore.getState().activeTabId).toBe('endpoint:s1:e3')
  })

  it('Ctrl+W 关闭当前标签、Ctrl+K 聚焦左栏搜索（视图切到接口树）', () => {
    const tabs: TabMeta[] = [
      {
        id: 'endpoint:s1:e1',
        kind: 'endpoint',
        title: '一',
        serviceId: 's1',
        key: 'e1',
        preview: false,
      },
    ]
    act(() => {
      useTabsStore.setState({ tabs, activeTabId: 'endpoint:s1:e1' })
      useAppStore.setState({ leftView: 'variables' })
    })
    renderHost()
    pressKey({ ctrlKey: true, key: 'w' })
    expect(useTabsStore.getState().tabs).toHaveLength(0)
    pressKey({ ctrlKey: true, key: 'k' })
    // Ctrl+K 只聚焦当前视图的搜索框，不切换视图（各视图搜索框都挂着 Ctrl+K 提示）
    expect(useAppStore.getState().leftView).toBe('variables')
    expect(useAppStore.getState().searchFocusNonce).toBeGreaterThan(0)
  })

  it('切主题命令在明暗间翻转（无默认键位，经面板/注册表执行）', () => {
    renderHost()
    act(() => {
      useSettingsStore.getState().hydrateFromBoot(null, 'light')
    })
    const toggle = useCommandsStore
      .getState()
      .commands.find((cmd) => cmd.id === 'appearance.toggleTheme')
    act(() => {
      toggle?.run()
    })
    expect(useSettingsStore.getState().theme.preference).toBe('dark')
    act(() => {
      toggle?.run()
    })
    expect(useSettingsStore.getState().theme.preference).toBe('light')
  })

  it('variables.activateCategory 参数化族：run(n) 切到第 n 个本空间分类（全局分类不计序号）', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    queryClient.setQueryData(workbenchKeys.workspaces(), { items: [], currentId: 'w1' })
    queryClient.setQueryData(variableKeys.categories('w1'), {
      items: [
        { id: 'g1', name: '全局', isGlobal: true, sortOrder: 0 },
        { id: 'c1', name: '开发', isGlobal: false, sortOrder: 1 },
        { id: 'c2', name: '生产', isGlobal: false, sortOrder: 2 },
      ],
      activeCategoryId: null,
    })
    render(<CommandHost />, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    })
    const activate = useCommandsStore
      .getState()
      .commands.find((cmd) => cmd.id === 'variables.activateCategory')
    act(() => {
      activate?.run(2)
    })
    expect(invokeMock).toHaveBeenCalledWith('variable.set_active_category', {
      workspaceId: 'w1',
      categoryId: 'c2',
    })
    // 序号越界静默跳过（快捷键语义，无目标不报错）
    act(() => {
      activate?.run(9)
    })
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  it('中文输入法合成期间不分发', () => {
    renderHost()
    pressKey({ ctrlKey: true, key: ',', isComposing: true })
    expect(useAppStore.getState().settingsOpen).toBe(false)
  })
})

/** 「输入焦点让键」声明项（yieldsToTextInput）：焦点在文本输入控件内键位
 *  让位原生文本编辑，分发器跳过不吞键；焦点离开恢复触发 */
describe('yieldsToTextInput 声明项（输入焦点让键）', () => {
  function FocusYieldHost({ run }: { run: () => void }) {
    useRegisterCommands(
      [
        {
          id: 'test.focusYield',
          labelKey: 'commandPalette.cmdOpenSettings',
          group: 'settings',
          defaultShortcut: 'Ctrl+E',
          yieldsToTextInput: true,
          run,
        },
      ],
      [],
    )
    useCommandDispatcher()
    return <input aria-label="笔记" />
  }

  it('焦点在输入控件内不触发；焦点离开后恢复触发', () => {
    const run = vi.fn()
    render(<FocusYieldHost run={run} />)
    const input = screen.getByRole('textbox', { name: '笔记' })
    input.focus()
    pressKey({ ctrlKey: true, key: 'e' })
    expect(run).not.toHaveBeenCalled()
    input.blur()
    pressKey({ ctrlKey: true, key: 'e' })
    expect(run).toHaveBeenCalledTimes(1)
  })
})

/** 带输入框的宿主：钉住「焦点在输入框内命令键位仍可达」——分发器挂 window，
 *  事件从目标冒泡即达，不依赖焦点落点 */
function CommandHostWithInput() {
  useGlobalCommands()
  useCommandDispatcher()
  return <input aria-label="URL" />
}

describe('workbench.send（Ctrl+Enter 发送激活 Tab 请求）', () => {
  /** 发送动作登记的用例回收（桥是模块级句柄表，用例结束统一注销） */
  const registeredSendActions: Array<() => void> = []

  function trackSendAction(tabId: string, action: () => void): void {
    registeredSendActions.push(registerSendAction(tabId, action))
  }

  function makeEndpointTab(key: string): TabMeta {
    return {
      id: `endpoint:s1:${key}`,
      kind: 'endpoint',
      title: key,
      serviceId: 's1',
      key,
      preview: false,
    }
  }

  afterEach(() => {
    for (const unregister of registeredSendActions) unregister()
    registeredSendActions.length = 0
    useTabsStore.setState({ tabs: [], activeTabId: null })
  })

  it('Ctrl+Enter 路由到激活 Tab 编辑器登记的发送动作（经 tabs store 取激活 tabId）', () => {
    const tabA = makeEndpointTab('e1')
    const tabB = makeEndpointTab('e2')
    act(() => {
      useTabsStore.setState({ tabs: [tabA, tabB], activeTabId: tabA.id })
    })
    render(<CommandHost />, { wrapper: createQueryWrapper() })
    const sendA = vi.fn()
    const sendB = vi.fn()
    trackSendAction(tabA.id, sendA)
    trackSendAction(tabB.id, sendB)
    pressKey({ ctrlKey: true, key: 'Enter' })
    expect(sendA).toHaveBeenCalledTimes(1)
    expect(sendB).not.toHaveBeenCalled()
  })

  it('URL 输入框聚焦时同样生效（事件冒泡到全局分发器，焦点链不设卡点）', () => {
    const tab = makeEndpointTab('e1')
    act(() => {
      useTabsStore.setState({ tabs: [tab], activeTabId: tab.id })
    })
    render(<CommandHostWithInput />, { wrapper: createQueryWrapper() })
    const send = vi.fn()
    trackSendAction(tab.id, send)
    const input = screen.getByRole('textbox', { name: 'URL' })
    input.focus()
    fireEvent.keyDown(input, { ctrlKey: true, key: 'Enter' })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('激活 Tab 非接口（工作空间设置）时不分发（when 门跳过）', () => {
    const tab: TabMeta = {
      id: WORKSPACE_SETTINGS_TAB_ID,
      kind: 'workspaceSettings',
      title: '',
      preview: false,
    }
    act(() => {
      useTabsStore.setState({ tabs: [tab], activeTabId: tab.id })
    })
    render(<CommandHost />, { wrapper: createQueryWrapper() })
    const send = vi.fn()
    trackSendAction(tab.id, send)
    pressKey({ ctrlKey: true, key: 'Enter' })
    expect(send).not.toHaveBeenCalled()
  })
})
