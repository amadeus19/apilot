import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryWrapper } from '@/test/render-providers'

import { EnvQuickSwitchControl } from '../env-quick-switch'
import type { VariableCategoriesDto } from '../variable-api'

// —— IPC invoke 替换：分类清单走桩，激活切换更新桩指针 ——
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

let stubView: VariableCategoriesDto

function stubInvokes() {
  invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'variable.list_categories') return Promise.resolve(stubView)
    if (cmd === 'variable.set_active_category') {
      stubView = { ...stubView, activeCategoryId: (args?.categoryId as string | null) ?? null }
      return Promise.resolve(stubView)
    }
    return Promise.resolve(undefined)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  stubView = {
    items: [
      { id: 'g1', name: '全局公共', isGlobal: true, sortOrder: 0 },
      { id: 'c1', name: '开发环境', isGlobal: false, sortOrder: 1 },
      { id: 'c2', name: '生产环境', isGlobal: false, sortOrder: 2 },
    ],
    activeCategoryId: 'c1',
  }
  stubInvokes()
})

describe('环境快捷切换（地址栏环境块）', () => {
  it('触发器显示当前激活分类名并标记 data-active', async () => {
    render(<EnvQuickSwitchControl workspaceId="w1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getByTestId('env-quick-switch-trigger').textContent).toContain('开发环境')
    })
    expect(screen.getByTestId('env-quick-switch-trigger')).toHaveAttribute('data-active')
  })

  it('无激活分类时显示「未激活」且不带 data-active', async () => {
    stubView = { ...stubView, activeCategoryId: null }
    render(<EnvQuickSwitchControl workspaceId="w1" />, { wrapper: createQueryWrapper() })
    await waitFor(() => {
      expect(screen.getByTestId('env-quick-switch-trigger').textContent).toContain('未激活')
    })
    expect(screen.getByTestId('env-quick-switch-trigger')).not.toHaveAttribute('data-active')
  })

  it('清单只列本空间分类（全局分类不可激活），当前行之外可点选切换', async () => {
    render(<EnvQuickSwitchControl workspaceId="w1" />, { wrapper: createQueryWrapper() })
    fireEvent.click(await screen.findByTestId('env-quick-switch-trigger'))
    const rows = await screen.findAllByTestId('env-quick-switch-row')
    expect(rows).toHaveLength(2)
    expect(screen.getByTestId('env-quick-switch-list').textContent).not.toContain('全局公共')

    // 点「生产环境」＝激活切换：IPC 携带该分类 id，成功后清单视图直写
    fireEvent.click(rows[1]!)
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'variable.set_active_category',
        expect.objectContaining({ workspaceId: 'w1', categoryId: 'c2' }),
      )
    })
    expect(stubView.activeCategoryId).toBe('c2')
  })

  it('键盘可达：聚焦分类行后 Enter 触发切换（原生 button 激活行为）', async () => {
    const user = userEvent.setup()
    render(<EnvQuickSwitchControl workspaceId="w1" />, { wrapper: createQueryWrapper() })
    fireEvent.click(await screen.findByTestId('env-quick-switch-trigger'))
    const rows = await screen.findAllByTestId('env-quick-switch-row')
    expect(rows[1]).toHaveProperty('tagName', 'BUTTON')
    rows[1]!.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'variable.set_active_category',
        expect.objectContaining({ workspaceId: 'w1', categoryId: 'c2' }),
      )
    })
  })

  it('「全部不激活」行置底，点选＝取消激活（categoryId null）', async () => {
    render(<EnvQuickSwitchControl workspaceId="w1" />, { wrapper: createQueryWrapper() })
    fireEvent.click(await screen.findByTestId('env-quick-switch-trigger'))
    fireEvent.click(await screen.findByTestId('env-quick-switch-deactivate'))
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'variable.set_active_category',
        expect.objectContaining({ workspaceId: 'w1', categoryId: null }),
      )
    })
    expect(stubView.activeCategoryId).toBeNull()
  })

  it('点当前激活分类不白发请求（等值守卫）', async () => {
    render(<EnvQuickSwitchControl workspaceId="w1" />, { wrapper: createQueryWrapper() })
    fireEvent.click(await screen.findByTestId('env-quick-switch-trigger'))
    const rows = await screen.findAllByTestId('env-quick-switch-row')
    fireEvent.click(rows[0]!) // c1＝当前激活行
    await waitFor(() => {
      // Popover 关闭（清单移出文档）即交互完成，期间零切换请求
      expect(screen.queryByTestId('env-quick-switch-list')).not.toBeInTheDocument()
    })
    expect(invokeMock).not.toHaveBeenCalledWith('variable.set_active_category', expect.anything())
  })

  it('无本空间分类时显示空态引导', async () => {
    stubView = {
      items: [{ id: 'g1', name: '全局公共', isGlobal: true, sortOrder: 0 }],
      activeCategoryId: null,
    }
    render(<EnvQuickSwitchControl workspaceId="w1" />, { wrapper: createQueryWrapper() })
    fireEvent.click(await screen.findByTestId('env-quick-switch-trigger'))
    expect(await screen.findByText('暂无本空间分类')).toBeInTheDocument()
    expect(screen.queryByTestId('env-quick-switch-deactivate')).not.toBeInTheDocument()
  })

  it('清单为 listbox/option 语义：激活行 aria-selected 通报当前态', async () => {
    render(<EnvQuickSwitchControl workspaceId="w1" />, { wrapper: createQueryWrapper() })
    fireEvent.click(await screen.findByTestId('env-quick-switch-trigger'))
    const listbox = screen.getByRole('listbox')
    const options = screen.getAllByRole('option')
    // 2 个本空间分类＋「全部不激活」同属一份单选清单（视觉两段、语义一份）
    expect(options).toHaveLength(3)
    expect(options.every((option) => listbox.contains(option))).toBe(true)
    expect(options[0]).toHaveAttribute('aria-selected', 'true') // c1＝当前激活
    expect(options[1]).toHaveAttribute('aria-selected', 'false')
    expect(options[2]).toHaveAttribute('aria-selected', 'false')
  })

  it('加载中渲染骨架占位，不闪「暂无本空间分类」假空态', async () => {
    invokeMock.mockImplementation(() => new Promise(() => {})) // 分类清单永挂起
    render(<EnvQuickSwitchControl workspaceId="w1" />, { wrapper: createQueryWrapper() })
    fireEvent.click(screen.getByTestId('env-quick-switch-trigger'))
    expect(await screen.findByTestId('env-quick-switch-skeleton')).toBeInTheDocument()
    expect(screen.queryByText('暂无本空间分类')).not.toBeInTheDocument()
    expect(screen.queryByTestId('env-quick-switch-deactivate')).not.toBeInTheDocument()
  })
})
