import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchKeys, type TreeDto } from '@/services/workbench-api'
import { makeEndpointNodeId } from '@/lib/tree-identity'
import { useTabsStore } from '@/stores/tabs.store'

import type { ApiTreeNode } from '../selector'
import { collectCategoryEndpointTabIds, useTreeNodeActions } from '../tree-node-actions'
import type { TreeMutations } from '../use-tree-mutations'

/**
 * 删除动作的 Tab 联动测试：mutation 以测试桩替换（同步兑现 onSuccess /
 * onError 并记录调用），tabs store 用真实实现——断言「删除成功后联动
 * 关闭哪些 Tab、激活落点是否正确」。分类收集走 QueryClient 预填的树
 * 缓存（与运行时同源：useTreeNodeActions 自行读取树查询数据）。
 */

// —— 测试桩 ——
function makeFakeMutations(mode: 'success' | 'failure' = 'success') {
  const calls: Array<{ mutation: string; vars: unknown }> = []
  const make = (name: string) => ({
    mutate: (
      vars: unknown,
      options?: {
        onSuccess?: (data: unknown, vars: unknown, context: unknown) => void
        onError?: (error: unknown) => void
      },
    ) => {
      if (mode === 'success') options?.onSuccess?.({}, vars, undefined)
      else options?.onError?.(new Error('ipc failed'))
      calls.push({ mutation: name, vars })
    },
  })
  const mutations = Object.fromEntries(
    [
      'serviceCreateMutation',
      'serviceUpdateMutation',
      'serviceDeleteMutation',
      'serviceMoveMutation',
      'serviceMoveToMutation',
      'categoryCreateMutation',
      'categoryRenameMutation',
      'categoryDeleteMutation',
      'categoryMoveMutation',
      'categoryMoveToMutation',
      'endpointCreateMutation',
      'endpointUpdateMutation',
      'endpointDeleteMutation',
      'endpointSetPinnedMutation',
      'endpointMoveMutation',
    ].map((name) => [name, make(name)]),
  ) as unknown as TreeMutations
  return { mutations, calls }
}

// —— 节点与树数据构造 ——
function serviceNode(id: string): ApiTreeNode {
  return { id: `service:${id}`, kind: 'service', name: `服务${id}`, parentIds: [] }
}
function categoryNode(id: string): ApiTreeNode {
  return { id: `category:${id}`, kind: 'category', name: `分类${id}`, parentIds: ['service:s1'] }
}
function endpointNode(serviceId: string, key: string): ApiTreeNode {
  return {
    id: makeEndpointNodeId(serviceId, key),
    kind: 'endpoint',
    name: `接口${key}`,
    parentIds: [],
    serviceId,
    key,
  }
}

function makeTree(): TreeDto {
  const endpoint = (serviceId: string, key: string, categoryId: string | null) => ({
    serviceId,
    key,
    title: `接口${key}`,
    categoryId,
    definition: { method: 'GET', pathTemplate: `/${key}` },
    isManual: true,
    pinned: false,
  })
  return {
    workspaceId: 'w1',
    services: [
      {
        id: 's1',
        name: '服务一',
        docUrl: null,
        docType: 'openapi',
        sortOrder: 0,
        categories: [
          { id: 'c1', name: '分类一', sortOrder: 0 },
          { id: 'c2', name: '分类二', sortOrder: 1 },
        ],
        endpoints: [
          endpoint('s1', 'k1', 'c1'),
          endpoint('s1', 'k2', 'c1'),
          endpoint('s1', 'k3', 'c2'),
        ],
      },
      {
        id: 's2',
        name: '服务二',
        docUrl: null,
        docType: 'openapi',
        sortOrder: 1,
        categories: [],
        endpoints: [endpoint('s2', 'k1', null)],
      },
    ],
  }
}

function renderActions(treeData: TreeDto | null, mode: 'success' | 'failure' = 'success') {
  const queryClient = new QueryClient()
  if (treeData) queryClient.setQueryData(workbenchKeys.tree('w1'), treeData)
  const { mutations, calls } = makeFakeMutations(mode)
  const onError = vi.fn()
  const { result } = renderHook(
    () =>
      useTreeNodeActions({
        workspaceId: 'w1',
        activeIndex: null,
        mutations,
        onError,
      }),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    },
  )
  return { actions: result.current, calls, onError }
}

beforeEach(() => {
  useTabsStore.setState({ tabs: [], activeTabId: null })
})

describe('树删除动作的 Tab 联动', () => {
  it('接口删除成功：关闭同身份 Tab，激活落到相邻 Tab', () => {
    const store = useTabsStore.getState()
    store.openEndpoint({ serviceId: 's1', key: 'k1', title: '接口k1' }, 'persistent')
    store.openEndpoint({ serviceId: 's2', key: 'k1', title: '接口k1' }, 'persistent')
    const { actions, calls, onError } = renderActions(makeTree())

    act(() => actions.confirmDelete(endpointNode('s1', 'k1')))

    const state = useTabsStore.getState()
    expect(state.tabs.map((tab) => tab.id)).toEqual([makeEndpointNodeId('s2', 'k1')])
    expect(state.activeTabId).toBe(makeEndpointNodeId('s2', 'k1'))
    expect(calls).toEqual([
      { mutation: 'endpointDeleteMutation', vars: { serviceId: 's1', key: 'k1' } },
    ])
    expect(onError).not.toHaveBeenCalled()
    expect(actions.dialog).toBeNull()
  })

  it('服务删除成功：关闭该服务全部接口 Tab，其余服务 Tab 保留', () => {
    const store = useTabsStore.getState()
    store.openEndpoint({ serviceId: 's1', key: 'k1', title: '接口k1' }, 'persistent')
    store.openEndpoint({ serviceId: 's1', key: 'k3', title: '接口k3' }, 'persistent')
    store.openEndpoint({ serviceId: 's2', key: 'k1', title: '接口k1' }, 'persistent')
    const { actions, calls, onError } = renderActions(makeTree())

    act(() => actions.confirmDelete(serviceNode('s1')))

    const state = useTabsStore.getState()
    expect(state.tabs.map((tab) => tab.id)).toEqual([makeEndpointNodeId('s2', 'k1')])
    expect(state.activeTabId).toBe(makeEndpointNodeId('s2', 'k1'))
    expect(calls).toEqual([{ mutation: 'serviceDeleteMutation', vars: 's1' }])
    expect(onError).not.toHaveBeenCalled()
  })

  it('分类删除成功：关闭该分类下全部接口 Tab（身份收集自删除前的树缓存）', () => {
    const store = useTabsStore.getState()
    store.openEndpoint({ serviceId: 's1', key: 'k1', title: '接口k1' }, 'persistent')
    store.openEndpoint({ serviceId: 's1', key: 'k2', title: '接口k2' }, 'persistent')
    store.openEndpoint({ serviceId: 's1', key: 'k3', title: '接口k3' }, 'persistent')
    store.openEndpoint({ serviceId: 's2', key: 'k1', title: '接口k1' }, 'persistent')
    const { actions, calls, onError } = renderActions(makeTree())

    act(() => actions.confirmDelete(categoryNode('c1')))

    const state = useTabsStore.getState()
    expect(state.tabs.map((tab) => tab.id)).toEqual([
      makeEndpointNodeId('s1', 'k3'),
      makeEndpointNodeId('s2', 'k1'),
    ])
    expect(calls).toEqual([{ mutation: 'categoryDeleteMutation', vars: 'c1' }])
    expect(onError).not.toHaveBeenCalled()
  })

  it('分类删除关闭激活 Tab：落点右邻首个存活（与单 Tab 关闭同语义）', () => {
    const store = useTabsStore.getState()
    store.openEndpoint({ serviceId: 's1', key: 'k1', title: '接口k1' }, 'persistent')
    store.openEndpoint({ serviceId: 's1', key: 'k2', title: '接口k2' }, 'persistent')
    store.openEndpoint({ serviceId: 's1', key: 'k3', title: '接口k3' }, 'persistent')
    const { actions } = renderActions(makeTree())

    act(() => actions.confirmDelete(categoryNode('c1')))

    /* 激活的 k1 与右邻 k2 同批被关：落到右侧首个存活 k3 */
    const state = useTabsStore.getState()
    expect(state.tabs.map((tab) => tab.id)).toEqual([makeEndpointNodeId('s1', 'k3')])
    expect(state.activeTabId).toBe(makeEndpointNodeId('s1', 'k3'))
  })

  it('删除失败：Tab 一律不关（联动只在成功面）', () => {
    const store = useTabsStore.getState()
    store.openEndpoint({ serviceId: 's1', key: 'k1', title: '接口k1' }, 'persistent')
    const { actions, onError } = renderActions(makeTree(), 'failure')

    act(() => actions.confirmDelete(endpointNode('s1', 'k1')))

    expect(useTabsStore.getState().tabs).toHaveLength(1)
    expect(onError).toHaveBeenCalledTimes(1)
  })
})

describe('collectCategoryEndpointTabIds（分类联动范围收集）', () => {
  it('收集该分类下全部接口身份，跨服务不串、null 树返回空集', () => {
    const tree = makeTree()
    expect(collectCategoryEndpointTabIds(tree, 'c1')).toEqual(
      new Set([makeEndpointNodeId('s1', 'k1'), makeEndpointNodeId('s1', 'k2')]),
    )
    expect(collectCategoryEndpointTabIds(tree, 'c2')).toEqual(
      new Set([makeEndpointNodeId('s1', 'k3')]),
    )
    expect(collectCategoryEndpointTabIds(null, 'c1')).toEqual(new Set())
  })
})
