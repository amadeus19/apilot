import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryWrapper } from '@/test/render-providers'
import { useSettingsStore } from '@/stores/settings.store'

import { useCommandsStore } from '@/features/commands/commands.store'
import { useGlobalCommands } from '@/features/commands/global-commands'
import { KeybindingsSection } from '../sections/KeybindingsSection'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

function SectionHost() {
  useGlobalCommands()
  return <KeybindingsSection />
}

/** 命令 id → 行容器；读取行内 kbd 显示的当前生效键位 */
const rowOf = (commandId: string): HTMLElement => screen.getByTestId(`keybinding-row-${commandId}`)

function shortcutOf(commandId: string): string {
  return rowOf(commandId).querySelector('kbd')!.textContent ?? ''
}

beforeEach(() => {
  invokeMock.mockImplementation(() => Promise.resolve(undefined))
  useCommandsStore.setState({ commands: [], paletteOpen: false })
  useSettingsStore.setState({ keybindings: {} })
})

afterEach(() => {
  useCommandsStore.setState({ commands: [], paletteOpen: false })
})

describe('设置「快捷键」分区', () => {
  it('按命令分组渲染：分组头 + 命令名 + 生效键位；参数化族显示为一行', () => {
    render(<SectionHost />, { wrapper: createQueryWrapper() })
    expect(screen.getByText('视图')).toBeInTheDocument()
    expect(screen.getByText('标签页')).toBeInTheDocument()
    expect(screen.getByText('设置')).toBeInTheDocument()
    expect(screen.getByText('外观')).toBeInTheDocument()
    expect(screen.getByText('聚焦')).toBeInTheDocument()
    expect(shortcutOf('tab.close')).toBe('Ctrl+W')
    expect(shortcutOf('focus.search')).toBe('Ctrl+K')
    expect(shortcutOf('tab.switchByIndex')).toBe('Ctrl+1..9')
    expect(shortcutOf('view.switchToApis')).toBe('未绑定')
  })

  it('发送命令随注册表自动出现（工作台分组、默认 Ctrl+Enter）并可改绑', () => {
    render(<SectionHost />, { wrapper: createQueryWrapper() })
    // 命令表驱动：新增命令不经设置面改动即出现（分组头与命令行同源注册表）
    expect(screen.getByText('工作台')).toBeInTheDocument()
    expect(shortcutOf('workbench.send')).toBe('Ctrl+Enter')
    // 改绑走同一捕获通道并落库
    const row = rowOf('workbench.send')
    fireEvent.click(within(row).getByRole('button', { name: '修改' }))
    fireEvent.keyDown(document, { ctrlKey: true, key: 'R' })
    expect(shortcutOf('workbench.send')).toBe('Ctrl+R')
    expect(useSettingsStore.getState().keybindings['workbench.send']).toBe('Ctrl+R')
  })

  it('按键捕获录入：修改后显示新键位并落库（set_setting 持久化）', () => {
    render(<SectionHost />, { wrapper: createQueryWrapper() })
    const row = rowOf('view.switchToApis')
    fireEvent.click(within(row).getByRole('button', { name: '修改' }))
    expect(row.querySelector('kbd')!.textContent).toContain('按下新键位')
    // 捕获监听挂 document capture 阶段，事件须派发到 document 才能到达
    fireEvent.keyDown(document, { ctrlKey: true, altKey: true, key: 'J' })
    expect(shortcutOf('view.switchToApis')).toBe('Ctrl+Alt+J')
    expect(useSettingsStore.getState().keybindings['view.switchToApis']).toBe('Ctrl+Alt+J')
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'set_setting')).toBe(true)
  })

  it('冲突检测：录入已被其他命令占用的键位时提示归属并阻止保存', () => {
    render(<SectionHost />, { wrapper: createQueryWrapper() })
    const row = rowOf('tab.close')
    fireEvent.click(within(row).getByRole('button', { name: '修改' }))
    // Ctrl+K 已绑「聚焦左栏搜索」
    fireEvent.keyDown(document, { ctrlKey: true, key: 'K' })
    expect(screen.getByText(/已绑定给「聚焦左栏搜索」/)).toBeInTheDocument()
    expect(useSettingsStore.getState().keybindings['tab.close']).toBeUndefined()
  })

  it('清空＝显式无键位（显示「未绑定」）；恢复默认删除覆盖（「···」菜单通道）', () => {
    render(<SectionHost />, { wrapper: createQueryWrapper() })
    const row = rowOf('tab.close')
    // 清空 / 恢复默认收在行尾「···」菜单里
    fireEvent.click(within(row).getByRole('button', { name: '更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '清空' }))
    expect(shortcutOf('tab.close')).toBe('未绑定')
    expect(useSettingsStore.getState().keybindings['tab.close']).toBeNull()
    fireEvent.click(within(row).getByRole('button', { name: '更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '恢复默认' }))
    expect(shortcutOf('tab.close')).toBe('Ctrl+W')
    expect(useSettingsStore.getState().keybindings['tab.close']).toBeUndefined()
  })

  it('组头「恢复全部默认」清空该组全部覆盖', () => {
    act(() => {
      useSettingsStore.getState().setKeybinding('tab.close', 'Ctrl+Q')
      useSettingsStore.getState().setKeybinding('focus.search', 'Ctrl+Alt+K')
    })
    render(<SectionHost />, { wrapper: createQueryWrapper() })
    // 标签页组头旁的恢复全部默认
    const tabsGroup = screen.getByText('标签页').closest('section')!
    fireEvent.click(within(tabsGroup).getByRole('button', { name: '恢复全部默认' }))
    expect(useSettingsStore.getState().keybindings['tab.close']).toBeUndefined()
    // 其他组覆盖不受影响
    expect(useSettingsStore.getState().keybindings['focus.search']).toBe('Ctrl+Alt+K')
  })

  it('捕获期间按 Esc 取消录入', () => {
    render(<SectionHost />, { wrapper: createQueryWrapper() })
    const row = rowOf('view.switchToApis')
    fireEvent.click(within(row).getByRole('button', { name: '修改' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(row.querySelector('kbd')!.textContent).not.toContain('按下新键位')
    expect(useSettingsStore.getState().keybindings['view.switchToApis']).toBeUndefined()
  })
})
