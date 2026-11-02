import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AppearanceSection } from '../sections/AppearanceSection'
import { useSettingsStore } from '@/stores/settings.store'

// 主题 / 强调色写入走 store 落库协议（set_setting 替身），面板内无其余 IPC
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

beforeEach(() => {
  vi.clearAllMocks()
  invokeMock.mockResolvedValue(undefined)
  useSettingsStore.getState().hydrateFromBoot(null, null)
  document.documentElement.className = ''
})

describe('外观组键盘可用性（roving tabindex）', () => {
  it('主题三态：Tab 进组焦点落选中项，方向键在选项间移动，Space 选中，Tab 出组', async () => {
    const user = userEvent.setup()
    render(<AppearanceSection />)

    const group = screen.getByRole('radiogroup', { name: '主题' })
    const radios = within(group).getAllByRole('radio')
    expect(radios).toHaveLength(3)

    // roving tabindex：仅选中项（默认跟随系统）留在 Tab 序，其余 -1
    expect(radios[2]).toHaveAttribute('aria-checked', 'true')
    expect(radios[0]).toHaveAttribute('tabIndex', '-1')
    expect(radios[1]).toHaveAttribute('tabIndex', '-1')
    expect(radios[2]).toHaveAttribute('tabIndex', '0')

    // Tab 进组：焦点直接落选中项
    await user.tab()
    expect(radios[2]).toHaveFocus()

    // 方向键在选项间移动焦点（roving：新焦点项接手 tabIndex）
    await user.keyboard('{ArrowLeft}')
    expect(radios[1]).toHaveFocus()
    expect(radios[1]).toHaveAttribute('tabIndex', '0')
    expect(radios[2]).toHaveAttribute('tabIndex', '-1')

    // Space 选中新焦点项：store 落库 + 选中态迁移
    await user.keyboard('{ }')
    expect(useSettingsStore.getState().theme.preference).toBe('dark')
    expect(radios[1]).toHaveAttribute('aria-checked', 'true')
    expect(radios[2]).toHaveAttribute('aria-checked', 'false')

    // Tab 出组：焦点离开整组
    await user.tab()
    expect(group.contains(document.activeElement)).toBe(false)
  })

  it('强调色板：整组单向 Tab 一站可达，方向键换焦点，选中经 store 落库', async () => {
    const user = userEvent.setup()
    render(<AppearanceSection />)

    const themeGroup = screen.getByRole('radiogroup', { name: '主题' })
    const accentGroup = screen.getByRole('radiogroup', { name: '强调色' })
    const swatches = within(accentGroup).getAllByRole('radio')
    expect(swatches).toHaveLength(6)

    // Tab 序：主题组选中项 → 强调色组选中项（两组各一站，组内不逐项 Tab）
    await user.tab()
    expect(within(themeGroup).getAllByRole('radio')[2]).toHaveFocus()
    await user.tab()
    expect(swatches[0]).toHaveFocus()
    expect(swatches[0]).toHaveAttribute('tabIndex', '0')
    expect(swatches[1]).toHaveAttribute('tabIndex', '-1')

    // 方向键移动焦点后选中（名称来自 title，读屏可达）
    await user.keyboard('{ArrowRight}')
    expect(swatches[1]).toHaveFocus()
    await user.keyboard('{ }')
    expect(useSettingsStore.getState().theme.accent).toBe('teal')
  })
})
