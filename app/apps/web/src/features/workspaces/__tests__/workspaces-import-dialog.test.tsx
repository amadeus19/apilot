import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryWrapper } from '@/test/render-providers'

import { WorkspacesDialogHost } from '../workspaces-dialogs'
import { useWorkspacesStore } from '../workspaces.store'

// jsdom 未实现 Element.getAnimations（Base UI ScrollArea 挂载后等待子树动画用），补空实现
beforeAll(() => {
  Element.prototype.getAnimations ??= () => []
})

// —— IPC invoke 替换：按命令名分派 ——
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const WORKSPACES = {
  items: [{ id: 'w1', name: '默认工作空间', baseUrl: null, auth: null, isCurrent: true }],
  currentId: 'w1',
}

// 现有服务：V1 与发现分组之一重名（禁选行：默认不勾选，也不在全选集内）
const EXISTING_SERVICES = [
  {
    id: 's1',
    workspaceId: 'w1',
    name: 'V1',
    docUrl: '/x/v1.json',
    docType: 'openapi',
    sortOrder: 0,
  },
]

// 发现分组：index 1（V1）名称撞车为禁选行，其余两组为可勾行
const DISCOVERED = {
  entryUrl: 'https://host/swagger',
  groups: [
    { name: 'V2', docUrl: '/a.json' },
    { name: 'V1', docUrl: '/b.json' },
    { name: 'V3', docUrl: '/c.json' },
  ],
}

/** 走到勾选步：开导入向导 → 输入入口地址 → 发现成功（默认勾选＝可勾全集） */
async function openGroupsStep() {
  const user = userEvent.setup()
  act(() => {
    useWorkspacesStore.getState().beginImport('w1')
  })
  await user.type(
    await screen.findByPlaceholderText('/swagger 或 https://host/swagger'),
    'https://host/swagger',
  )
  await user.click(screen.getByRole('button', { name: '发现服务' }))
  await screen.findByText('发现 3 个分组')
  return user
}

beforeEach(() => {
  vi.clearAllMocks()
  useWorkspacesStore.setState({
    dialog: null,
    importStep: 'entry',
    importEntryUrl: '',
    importGroups: [],
    importChecked: [],
  })
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === 'workspace.list') return Promise.resolve(WORKSPACES)
    if (cmd === 'service.list_by_workspace') return Promise.resolve(EXISTING_SERVICES)
    if (cmd === 'service.import_discover') return Promise.resolve(DISCOVERED)
    return Promise.resolve(undefined)
  })
})

describe('导入向导勾选步：表头全选三态与逐行联动', () => {
  it('默认勾选＝可勾全集（禁选行排除）呈现全选态；点击表头清空全部', async () => {
    render(<WorkspacesDialogHost />, { wrapper: createQueryWrapper() })
    await openGroupsStep()
    const header = screen.getByRole('checkbox', { name: '全选分组' })
    // 默认勾选后可勾行全勾：表头全选态（Base UI 半态经 aria-checked 暴露）
    expect(header).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('checkbox', { name: /^V1/ })).toHaveAttribute('aria-checked', 'false')

    await userEvent.click(header)
    // 清空全部：勾选集与行勾选视觉同步归零
    expect(useWorkspacesStore.getState().importChecked).toEqual([])
    expect(screen.getByRole('checkbox', { name: '全选分组' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
    expect(screen.getByRole('checkbox', { name: /^V2/ })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('checkbox', { name: /^V3/ })).toHaveAttribute('aria-checked', 'false')
  })

  it('逐行勾选联动回写表头三态（全选 → 半态 → 全不选）', async () => {
    render(<WorkspacesDialogHost />, { wrapper: createQueryWrapper() })
    const user = await openGroupsStep()
    const header = screen.getByRole('checkbox', { name: '全选分组' })

    await user.click(screen.getByRole('checkbox', { name: /^V2/ }))
    expect(useWorkspacesStore.getState().importChecked).toEqual([2])
    expect(header).toHaveAttribute('aria-checked', 'mixed')

    await user.click(screen.getByRole('checkbox', { name: /^V3/ }))
    expect(useWorkspacesStore.getState().importChecked).toEqual([])
    expect(header).toHaveAttribute('aria-checked', 'false')
  })

  it('全不选态点击表头＝全选可勾行（禁选行恒排除在全集外）', async () => {
    render(<WorkspacesDialogHost />, { wrapper: createQueryWrapper() })
    const user = await openGroupsStep()
    const header = screen.getByRole('checkbox', { name: '全选分组' })
    await user.click(header)
    expect(useWorkspacesStore.getState().importChecked).toEqual([])

    await user.click(header)
    // 全选集只含可勾行：撞车行 V1（index 1）不被勾入
    expect(useWorkspacesStore.getState().importChecked).toEqual([0, 2])
    expect(screen.getByRole('checkbox', { name: /^V2/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('checkbox', { name: /^V1/ })).toHaveAttribute('aria-checked', 'false')
    expect(header).toHaveAttribute('aria-checked', 'true')
  })

  it('半态点击表头＝补全为全选', async () => {
    render(<WorkspacesDialogHost />, { wrapper: createQueryWrapper() })
    const user = await openGroupsStep()
    const header = screen.getByRole('checkbox', { name: '全选分组' })

    await user.click(screen.getByRole('checkbox', { name: /^V2/ }))
    expect(header).toHaveAttribute('aria-checked', 'mixed')
    await user.click(header)
    expect(useWorkspacesStore.getState().importChecked).toEqual([0, 2])
    expect(header).toHaveAttribute('aria-checked', 'true')
  })
})
