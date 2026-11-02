import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import { useWorkspaceSession } from '../session-persistence'
import { useTreeExpandedStore } from '@/features/api-tree/tree-state.store'
import { createQueryWrapper } from '@/test/render-providers'
import { invoke } from '@tauri-apps/api/core'
import { workbenchKeys } from '@/services/workbench-api'
import { useTabsStore } from '@/stores/tabs.store'
import { useWorkspacesStore } from '@/features/workspaces/workspaces.store'

const invokeMock = vi.mocked(invoke)

/** 会话接线宿主：workspaceId 由测试驱动（模拟工作空间切换） */
function SessionHost({ workspaceId }: { workspaceId: string | null }) {
  useWorkspaceSession(workspaceId)
  return null
}

/** 工作空间清单缓存预填：详情指针校正的名称回填读取该缓存 */
function seedWorkspaces(queryClient: QueryClient) {
  queryClient.setQueryData(workbenchKeys.workspaces(), {
    items: [
      { id: 'w1', name: '默认工作空间', baseUrl: null, auth: null, isCurrent: true },
      { id: 'w2', name: '第二空间', baseUrl: null, auth: null, isCurrent: false },
    ],
    currentId: 'w1',
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  useTabsStore.setState({ tabs: [], activeTabId: null })
  useTreeExpandedStore.setState({ expandedIds: [] })
  useWorkspacesStore.setState({ treeSelectedWorkspaceId: null })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Tab 会话持久化接线', () => {
  it('挂载即恢复当前工作空间会话（Tab + 树展开同一事务）', async () => {
    invokeMock.mockImplementation((cmd) => {
      if (cmd === 'session.get') {
        return Promise.resolve({
          tabs: JSON.stringify({
            tabs: [{ kind: 'endpoint', title: '接口A', serviceId: 's1', key: 'k1', preview: true }],
            activeTabId: 'endpoint:s1:k1',
          }),
          treeExpanded: JSON.stringify(['svc1', 'cat2']),
        })
      }
      return Promise.resolve(undefined)
    })

    render(<SessionHost workspaceId="w1" />, { wrapper: createQueryWrapper() })
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    const state = useTabsStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]).toMatchObject({ id: 'endpoint:s1:k1', preview: true })
    expect(state.activeTabId).toBe('endpoint:s1:k1')
    expect(useTreeExpandedStore.getState().expandedIds).toEqual(['svc1', 'cat2'])
  })

  it('恢复失败（IPC 异常）按无会话处理，不炸启动', async () => {
    invokeMock.mockRejectedValue(new Error('ipc down'))
    render(<SessionHost workspaceId="w1" />, { wrapper: createQueryWrapper() })
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    expect(useTabsStore.getState().tabs).toEqual([])
    expect(useTreeExpandedStore.getState().expandedIds).toEqual([])
  })

  it('恢复失败兜底的空会话不回写（已存会话原地保留）', async () => {
    invokeMock.mockRejectedValue(new Error('ipc down'))
    render(<SessionHost workspaceId="w1" />, { wrapper: createQueryWrapper() })
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'session.save')).toBe(false)
  })

  it('切换工作空间：在途防抖保存立即以旧空间 id 落库（不丢弃、不跨空间）', async () => {
    invokeMock.mockResolvedValue(undefined)
    const { rerender } = render(<SessionHost workspaceId="w1" />, { wrapper: createQueryWrapper() })
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    invokeMock.mockClear()

    act(() => {
      useTabsStore.getState().openEndpoint({ serviceId: 's1', key: 'k1', title: 'A' }, 'persistent')
    })
    // 防抖窗口内切换空间：在途变更立即以旧 id 落库（用户最后编辑不丢）
    rerender(<SessionHost workspaceId="w2" />)
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    const saveCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'session.save')
    expect(saveCalls).toHaveLength(1)
    const [, args] = saveCalls[0]!
    expect((args as { args: { workspaceId: string } }).args.workspaceId).toBe('w1')

    // 切换后用户动作照常保存，且落在新空间 id 上
    act(() => {
      useTabsStore.getState().openEndpoint({ serviceId: 's2', key: 'k9', title: 'B' }, 'persistent')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    const laterCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'session.save')
    expect(laterCalls).toHaveLength(2)
    const [, laterArgs] = laterCalls[1]!
    expect((laterArgs as { args: { workspaceId: string } }).args.workspaceId).toBe('w2')
  })

  it('双击切换竞态：恢复不覆盖刚导航的详情指针（树选中为权威源校正）', async () => {
    // 用户点击第二空间行：树选中 w2、详情 Tab 打开（key=w2）
    act(() => {
      useWorkspacesStore.getState().setTreeSelectedWorkspace('w2')
      useTabsStore
        .getState()
        .openWorkspaceSettings({ workspaceId: 'w2', name: '第二空间', mode: 'persistent' })
    })
    // 切换到 w2；其上次会话的详情指针停留在 w1（旧会话回跳的竞态源）
    invokeMock.mockImplementation((cmd) => {
      if (cmd === 'session.get') {
        return Promise.resolve({
          tabs: JSON.stringify({
            tabs: [
              { kind: 'endpoint', title: '接口A', serviceId: 's1', key: 'k1', preview: false },
              { kind: 'workspaceSettings', title: '默认工作空间', key: 'w1', preview: false },
            ],
            activeTabId: 'workspaceSettings',
          }),
          treeExpanded: '[]',
        })
      }
      return Promise.resolve(undefined)
    })
    const { rerender } = render(<SessionHost workspaceId="w1" />, {
      wrapper: createQueryWrapper(seedWorkspaces),
    })
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    rerender(<SessionHost workspaceId="w2" />)
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })

    const state = useTabsStore.getState()
    const detail = state.tabs.find((tab) => tab.id === 'workspaceSettings')
    // 详情指针校正为树选中的 w2（不回跳会话里的 w1），标题回填缓存名，详情激活
    expect(detail).toMatchObject({ key: 'w2', title: '第二空间' })
    expect(state.activeTabId).toBe('workspaceSettings')
    // 会话里的接口 Tab 集照常恢复（恢复语义不被校正破坏）
    expect(state.tabs.some((tab) => tab.kind === 'endpoint')).toBe(true)
  })

  it('双击切换且会话无详情 Tab 记录：补开树选中详情并激活（导航不被抹掉）', async () => {
    act(() => {
      useWorkspacesStore.getState().setTreeSelectedWorkspace('w2')
      useTabsStore
        .getState()
        .openWorkspaceSettings({ workspaceId: 'w2', name: '第二空间', mode: 'persistent' })
    })
    // w2 上次会话只有接口 Tab，无详情记录
    invokeMock.mockImplementation((cmd) => {
      if (cmd === 'session.get') {
        return Promise.resolve({
          tabs: JSON.stringify({
            tabs: [
              { kind: 'endpoint', title: '接口A', serviceId: 's1', key: 'k1', preview: false },
            ],
            activeTabId: 'endpoint:s1:k1',
          }),
          treeExpanded: '[]',
        })
      }
      return Promise.resolve(undefined)
    })
    const { rerender } = render(<SessionHost workspaceId="w1" />, {
      wrapper: createQueryWrapper(seedWorkspaces),
    })
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    rerender(<SessionHost workspaceId="w2" />)
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })

    const state = useTabsStore.getState()
    const detail = state.tabs.find((tab) => tab.id === 'workspaceSettings')
    // 补开树选中空间的详情（标题回填清单缓存名），详情 Tab 激活
    expect(detail).toMatchObject({ key: 'w2', title: '第二空间' })
    expect(state.activeTabId).toBe('workspaceSettings')
    // 会话里的接口 Tab 集照常恢复
    expect(state.tabs.some((tab) => tab.kind === 'endpoint')).toBe(true)
  })

  it('无树选中（启动恢复）：会话按原样落地，不做详情校正', async () => {
    invokeMock.mockImplementation((cmd) => {
      if (cmd === 'session.get') {
        return Promise.resolve({
          tabs: JSON.stringify({
            tabs: [{ kind: 'workspaceSettings', title: '第二空间', key: 'w2', preview: false }],
            activeTabId: 'workspaceSettings',
          }),
          treeExpanded: '[]',
        })
      }
      return Promise.resolve(undefined)
    })
    render(<SessionHost workspaceId="w1" />, { wrapper: createQueryWrapper() })
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    // 会话里的详情指针原样保留（启动恢复无导航意图可校正）
    const detail = useTabsStore.getState().tabs.find((tab) => tab.id === 'workspaceSettings')
    expect(detail?.key).toBe('w2')
  })

  it('tabs / 树展开变化防抖整包保存（300ms 窗口内合并）', async () => {
    invokeMock.mockResolvedValue(undefined)
    render(<SessionHost workspaceId="w1" />, { wrapper: createQueryWrapper() })
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    invokeMock.mockClear()

    act(() => {
      useTabsStore.getState().openEndpoint({ serviceId: 's1', key: 'k1', title: 'A' }, 'persistent')
      useTabsStore.getState().openEndpoint({ serviceId: 's1', key: 'k2', title: 'B' }, 'persistent')
      useTreeExpandedStore.getState().setExpanded(['svc1'])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    const saveCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'session.save')
    expect(saveCalls).toHaveLength(1) /* 防抖窗口内多次变更合并为一次整包写 */
    const [, args] = saveCalls[0]!
    const payload = JSON.parse((args as { args: { tabs: string } }).args.tabs) as {
      tabs: unknown[]
      activeTabId: string
    }
    expect(payload.tabs).toHaveLength(2)
    expect(payload.activeTabId).toBe('endpoint:s1:k2')
  })

  it('退出收尾注册：flush 绕过防抖立即落库（挂接退出闸门前段）', async () => {
    invokeMock.mockResolvedValue(undefined)
    const { unmount } = render(<SessionHost workspaceId="w1" />, { wrapper: createQueryWrapper() })
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    invokeMock.mockClear()

    act(() => {
      useTabsStore.getState().openEndpoint({ serviceId: 's1', key: 'k1', title: 'A' }, 'persistent')
    })
    // 不等防抖窗口：直接触发模块级 flushAllForExit（退出闸门的收尾路径）
    const { flushAllForExit } = await import('@/services/exit-flush')
    await flushAllForExit()
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'session.save')).toBe(true)
    unmount()
  })

  it('卸载：防抖定时器清除，在途变更立即落库（资源不悬空、不丢失）', async () => {
    invokeMock.mockResolvedValue(undefined)
    const { unmount } = render(<SessionHost workspaceId="w1" />, { wrapper: createQueryWrapper() })
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    invokeMock.mockClear()
    act(() => {
      useTabsStore.getState().openEndpoint({ serviceId: 's1', key: 'k1', title: 'A' }, 'persistent')
    })
    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    // 在途变更随卸载清理立即落库（不悬空等待防抖窗口），落在本空间 id 上
    const saveCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'session.save')
    expect(saveCalls).toHaveLength(1)
    const [, args] = saveCalls[0]!
    expect((args as { args: { workspaceId: string } }).args.workspaceId).toBe('w1')
  })
})
