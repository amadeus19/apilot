import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryWrapper } from '@/test/render-providers'
import { useVariableStore } from '@/stores/variable.store'

import { BaseUrlCandidatesControl, BaseUrlOverrideControl } from '../base-url-picker'

// —— IPC invoke 替换：候选清单走桩存储，新增 / 删除更新桩 ——
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

let stubCandidates: { id: string; url: string }[]

function listView() {
  return { items: stubCandidates.map((c) => ({ ...c })) }
}

function stubInvokes() {
  invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'variable.list_base_urls') return Promise.resolve(listView())
    if (cmd === 'variable.add_base_url') {
      stubCandidates.push({ id: `u${stubCandidates.length + 1}`, url: args?.url as string })
      return Promise.resolve(listView())
    }
    if (cmd === 'variable.delete_base_url') {
      stubCandidates = stubCandidates.filter((c) => c.id !== args?.id)
      return Promise.resolve(listView())
    }
    return Promise.resolve(undefined)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  useVariableStore.setState({
    treeExpandedIds: [],
    treeSelectedNodeId: null,
    baseUrlOverrides: {},
    sessionBaseUrl: null,
  })
  stubCandidates = [
    { id: 'u1', url: 'https://a.example.com' },
    { id: 'u2', url: 'https://b.example.com' },
  ]
  stubInvokes()
})

describe('BaseUrl 候选下拉（设置页形态）', () => {
  it('点候选＝选择即替换生效值（onPick 上抛），Popover 关闭', async () => {
    const onPick = vi.fn()
    render(
      <BaseUrlCandidatesControl
        workspaceId="w1"
        currentBaseUrl="https://a.example.com"
        onPick={onPick}
      />,
      { wrapper: createQueryWrapper() },
    )
    fireEvent.click(screen.getByTestId('base-url-candidates-trigger'))
    const rows = await screen.findAllByTestId('base-url-candidates-row')
    expect(rows).toHaveLength(2)
    // 当前生效值行打勾（data-url 定位行内容）
    expect(screen.getByTestId('base-url-candidates-list').textContent).toContain(
      'https://a.example.com',
    )
    fireEvent.click(screen.getAllByTestId('base-url-candidates-pick')[1]!)
    expect(onPick).toHaveBeenCalledExactlyOnceWith('https://b.example.com')
  })

  it('现场新增＝invoke add_base_url（只入候选，不触碰生效值）', async () => {
    render(
      <BaseUrlCandidatesControl workspaceId="w1" currentBaseUrl="" onPick={() => undefined} />,
      { wrapper: createQueryWrapper() },
    )
    fireEvent.click(screen.getByTestId('base-url-candidates-trigger'))
    const input = await screen.findByTestId('base-url-candidates-add-input')
    fireEvent.change(input, { target: { value: 'https://c.example.com' } })
    fireEvent.click(screen.getByTestId('base-url-candidates-add-button'))
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.add_base_url')
      expect(calls).toHaveLength(1)
    })
    const payload = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'variable.add_base_url',
    )[0]![1] as { workspaceId: string; url: string }
    expect(payload).toEqual({ workspaceId: 'w1', url: 'https://c.example.com' })
    // onPick 不被调用：新增不入生效值
    await waitFor(() => {
      expect(screen.getAllByTestId('base-url-candidates-row')).toHaveLength(3)
    })
  })

  it('行内删除候选＝invoke delete_base_url（轻操作无确认弹窗）', async () => {
    render(
      <BaseUrlCandidatesControl workspaceId="w1" currentBaseUrl="" onPick={() => undefined} />,
      { wrapper: createQueryWrapper() },
    )
    fireEvent.click(screen.getByTestId('base-url-candidates-trigger'))
    await screen.findAllByTestId('base-url-candidates-row')
    fireEvent.click(screen.getAllByTestId('base-url-candidates-delete')[0]!)
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'variable.delete_base_url')
      expect(calls).toHaveLength(1)
    })
    const payload = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'variable.delete_base_url',
    )[0]![1] as { workspaceId: string; id: string }
    expect(payload).toEqual({ workspaceId: 'w1', id: 'u1' })
    await waitFor(() => {
      expect(screen.getAllByTestId('base-url-candidates-row')).toHaveLength(1)
    })
  })
})

describe('接口级 BaseUrl 切换（地址栏地址块）', () => {
  it('点候选＝设为该 Tab 内存覆写（store 会话态，无 invoke；纯选择清单无删除/新增/手输）', async () => {
    render(
      <BaseUrlOverrideControl
        workspaceId="w1"
        tabId="endpoint:s1:k1"
        effectiveUrl="https://work.example.com"
      />,
      {
        wrapper: createQueryWrapper(),
      },
    )
    fireEvent.click(screen.getByTestId('base-url-override-trigger'))
    // 工作空间生效地址（不在候选中）置顶合成，加两候选共 3 行（等清单稳定）
    await waitFor(() => {
      expect(screen.getAllByTestId('base-url-override-row')).toHaveLength(3)
    })
    const rows = screen.getAllByTestId('base-url-override-row')
    expect(rows[0]!.dataset.url).toBe('https://work.example.com')
    // 纯地址选择：无行内删除、无新增入口、无手输框
    expect(screen.queryByTestId('base-url-override-delete')).not.toBeInTheDocument()
    expect(screen.queryByTestId('base-url-override-add-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('base-url-override-input')).not.toBeInTheDocument()
    const invokeCountBefore = invokeMock.mock.calls.length
    fireEvent.click(screen.getAllByTestId('base-url-override-pick')[1]!)
    expect(useVariableStore.getState().baseUrlOverrides['endpoint:s1:k1']).toBe(
      'https://a.example.com',
    )
    expect(invokeMock.mock.calls.length).toBe(invokeCountBefore)
    // 覆写后入口呈激活态
    await waitFor(() => {
      expect(screen.getByTestId('base-url-override-trigger')).toHaveAttribute('data-active')
    })
  })

  it('点选工作空间生效地址＝清除覆写回跟随（切换后总能选回去）', async () => {
    useVariableStore.getState().setBaseUrlOverride('tab-1', 'https://a.example.com')
    render(
      <BaseUrlOverrideControl
        workspaceId="w1"
        tabId="tab-1"
        effectiveUrl="https://work.example.com"
      />,
      { wrapper: createQueryWrapper() },
    )
    fireEvent.click(screen.getByTestId('base-url-override-trigger'))
    const rows = await screen.findAllByTestId('base-url-override-row')
    expect(rows[0]!.dataset.url).toBe('https://work.example.com')
    fireEvent.click(screen.getAllByTestId('base-url-override-pick')[0]!)
    expect(useVariableStore.getState().baseUrlOverrides['tab-1']).toBeUndefined()
  })

  it('候选里已有工作空间同值地址时不重复合成行', async () => {
    render(
      <BaseUrlOverrideControl
        workspaceId="w1"
        tabId="tab-1"
        effectiveUrl="https://a.example.com"
      />,
      { wrapper: createQueryWrapper() },
    )
    fireEvent.click(screen.getByTestId('base-url-override-trigger'))
    await waitFor(() => {
      expect(screen.getAllByTestId('base-url-override-row')).toHaveLength(2)
    })
  })

  it('行尾会话档钮＝设为会话地址（所有 Tab 生效，弹层关闭）', async () => {
    render(
      <BaseUrlOverrideControl
        workspaceId="w1"
        tabId="tab-1"
        effectiveUrl="https://work.example.com"
      />,
      { wrapper: createQueryWrapper() },
    )
    fireEvent.click(screen.getByTestId('base-url-override-trigger'))
    // 行尾会话档钮按 data-url 定位（合成行占据首位）；点第二候选＝设为会话地址
    await waitFor(() => {
      expect(screen.getAllByTestId('base-url-override-row')).toHaveLength(3)
    })
    const target = screen
      .getAllByTestId('base-url-override-session-pick')
      .find((el) => el.dataset.url === 'https://b.example.com')
    expect(target).toBeDefined()
    fireEvent.click(target!)
    expect(useVariableStore.getState().sessionBaseUrl).toBe('https://b.example.com')
    // 会话档生效：无 Tab 覆写时触发器点亮呈激活态
    await waitFor(() => {
      expect(screen.getByTestId('base-url-override-trigger')).toHaveAttribute('data-active')
    })
    expect(useVariableStore.getState().baseUrlOverrides['tab-1']).toBeUndefined()
  })

  it('会话档区显示当前档值，清除钮置空回跟随', async () => {
    useVariableStore.getState().setSessionBaseUrl('https://b.example.com')
    render(
      <BaseUrlOverrideControl
        workspaceId="w1"
        tabId="tab-1"
        effectiveUrl="https://work.example.com"
      />,
      { wrapper: createQueryWrapper() },
    )
    fireEvent.click(screen.getByTestId('base-url-override-trigger'))
    const sessionRow = await screen.findByTestId('base-url-override-session')
    expect(sessionRow.textContent).toContain('https://b.example.com')
    fireEvent.click(screen.getByTestId('base-url-override-session-clear'))
    expect(useVariableStore.getState().sessionBaseUrl).toBeNull()
  })
})
