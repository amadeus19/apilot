import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchKeys, type TreeDto } from '@/services/workbench-api'

import { openNewEndpointDialog, resolveNewEndpointTarget } from '../new-endpoint-action'
import { useTreeExpandedStore } from '../tree-state.store'

/** 新建接口目标服务解析（纯函数全路径） */
describe('resolveNewEndpointTarget', () => {
  const tree: TreeDto = {
    workspaceId: 'w1',
    services: [
      {
        id: 's1',
        name: '服务一',
        docUrl: null,
        docType: 'openapi',
        sortOrder: 0,
        categories: [{ id: 'c1', name: '分类一', sortOrder: 0 }],
        endpoints: [
          {
            serviceId: 's1',
            key: 'e1',
            title: '接口一',
            categoryId: null,
            definition: { method: 'GET', pathTemplate: '/a' },
            isManual: false,
            pinned: false,
          },
        ],
      },
      {
        id: 's2',
        name: '服务二',
        docUrl: null,
        docType: 'openapi',
        sortOrder: 1,
        categories: [],
        endpoints: [],
      },
    ],
  }

  it('无选中＝第一个服务；无服务＝null（引导建服务）', () => {
    expect(resolveNewEndpointTarget(tree, null)).toBe('s1')
    expect(resolveNewEndpointTarget({ workspaceId: 'w1', services: [] }, null)).toBeNull()
    expect(resolveNewEndpointTarget(undefined, null)).toBeNull()
  })

  it('服务行取自身；分类行取所属服务；接口行取所属服务', () => {
    expect(resolveNewEndpointTarget(tree, 'service:s2')).toBe('s2')
    expect(resolveNewEndpointTarget(tree, 'category:c1')).toBe('s1')
    expect(resolveNewEndpointTarget(tree, 'endpoint:s1:e1')).toBe('s1')
  })

  it('选中行已从树中移除（数据未刷新）回落第一个服务', () => {
    expect(resolveNewEndpointTarget(tree, 'service:gone')).toBe('s1')
    expect(resolveNewEndpointTarget(tree, 'endpoint:gone:k')).toBe('s1')
    expect(resolveNewEndpointTarget(tree, 'pinned')).toBe('s1')
  })
})

/** 新建接口动作：按选中行所属 / 第一个 / 无服务发新建请求 */
describe('openNewEndpointDialog', () => {
  const TREE: TreeDto = {
    workspaceId: 'w1',
    services: [
      {
        id: 's1',
        name: '服务一',
        docUrl: null,
        docType: 'openapi',
        sortOrder: 0,
        categories: [{ id: 'c1', name: '分类一', sortOrder: 0 }],
        endpoints: [],
      },
    ],
  }

  function makeClient(tree: TreeDto | undefined): QueryClient {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(workbenchKeys.workspaces(), {
      items: [{ id: 'w1', name: '默认工作空间', baseUrl: null, isCurrent: true }],
      currentId: 'w1',
    })
    if (tree) client.setQueryData(workbenchKeys.tree('w1'), tree)
    return client
  }

  beforeEach(() => {
    vi.clearAllMocks()
    useTreeExpandedStore.getState().clear()
  })

  it('无选中：对第一个服务发新建请求', () => {
    openNewEndpointDialog(makeClient(TREE))
    const request = useTreeExpandedStore.getState().newEndpointRequest
    expect(request?.serviceId).toBe('s1')
    expect(typeof request?.nonce).toBe('number')
  })

  it('选中分类行：对所属服务发新建请求；无服务时 serviceId 为 null（引导建服务）', () => {
    openNewEndpointDialog(makeClient(TREE))
    useTreeExpandedStore.getState().setActiveNode('category:c1')
    openNewEndpointDialog(makeClient(TREE))
    expect(useTreeExpandedStore.getState().newEndpointRequest?.serviceId).toBe('s1')

    useTreeExpandedStore.getState().clear()
    openNewEndpointDialog(makeClient({ workspaceId: 'w1', services: [] }))
    expect(useTreeExpandedStore.getState().newEndpointRequest?.serviceId).toBeNull()
  })
})
