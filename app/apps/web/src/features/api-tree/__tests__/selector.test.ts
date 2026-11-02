import { describe, expect, it } from 'vitest'

import type { TreeDto } from '@/services/workbench-api'

import {
  API_TREE_ROOT_ID,
  PINNED_GROUP_ID,
  allContainerIds,
  buildApiTreeIndex,
  expandForFilter,
  filterApiTree,
  makeEndpointNodeId,
  makeServiceNodeId,
  parseEndpointNodeId,
} from '../selector'

function endpoint(
  serviceId: string,
  key: string,
  title: string,
  overrides: Partial<{
    categoryId: string | null
    method: string
    pathTemplate: string
    isManual: boolean
    pinned: boolean
    badge: string | null
  }> = {},
): TreeDto['services'][number]['endpoints'][number] {
  return {
    serviceId,
    key,
    title,
    categoryId: overrides.categoryId ?? null,
    definition: {
      method: overrides.method ?? 'GET',
      pathTemplate: overrides.pathTemplate ?? `/${key}`,
    },
    isManual: overrides.isManual ?? true,
    pinned: overrides.pinned ?? false,
    badge: overrides.badge ?? null,
  }
}

function tree(
  overrides: {
    services?: TreeDto['services']
  } = {},
): TreeDto {
  return {
    workspaceId: 'w1',
    services: overrides.services ?? [],
  }
}

function service(
  id: string,
  name: string,
  overrides: Partial<{
    docUrl: string | null
    categories: TreeDto['services'][number]['categories']
    endpoints: TreeDto['services'][number]['endpoints']
  }> = {},
): TreeDto['services'][number] {
  return {
    id,
    name,
    docUrl: overrides.docUrl ?? null,
    docType: 'openapi',
    sortOrder: 0,
    categories: overrides.categories ?? [],
    endpoints: overrides.endpoints ?? [],
  }
}

describe('buildApiTreeIndex 结构组装', () => {
  it('层级＝服务 › 分类 › 接口：分类节点在前、散接口在后混排', () => {
    const index = buildApiTreeIndex(
      tree({
        services: [
          service('s1', '用户服务', {
            categories: [{ id: 'c1', name: '账号', sortOrder: 1 }],
            endpoints: [
              endpoint('s1', 'e1', '登录', { categoryId: 'c1' }),
              endpoint('s1', 'e2', '健康检查'),
            ],
          }),
        ],
      }),
    )

    const s1 = makeServiceNodeId('s1')
    expect(index.rootChildren).toEqual([s1])
    expect(index.childrenOf.get(s1)).toEqual(['category:c1', makeEndpointNodeId('s1', 'e2')])
    expect(index.childrenOf.get('category:c1')).toEqual([makeEndpointNodeId('s1', 'e1')])
    // 分类内接口的祖先链：分类 → 服务
    const inCategory = index.nodes.get(makeEndpointNodeId('s1', 'e1'))
    expect(inCategory?.parentIds).toEqual(['category:c1', s1])
    expect(inCategory?.categoryName).toBe('账号')
  })

  it('同步徽标透传：new/changed 进节点，置顶提升随行携带，其余值视为无徽标', () => {
    const index = buildApiTreeIndex(
      tree({
        services: [
          service('s1', '服务', {
            endpoints: [
              endpoint('s1', 'e1', '新增接口', { badge: 'new' }),
              endpoint('s1', 'e2', '变更接口', { badge: 'changed' }),
              endpoint('s1', 'e3', '无徽标'),
              endpoint('s1', 'e4', '脏值防御', { badge: 'weird' }),
              endpoint('s1', 'e5', '置顶也带徽标', { pinned: true, badge: 'changed' }),
            ],
          }),
        ],
      }),
    )

    expect(index.nodes.get(makeEndpointNodeId('s1', 'e1'))?.syncBadge).toBe('new')
    expect(index.nodes.get(makeEndpointNodeId('s1', 'e2'))?.syncBadge).toBe('changed')
    expect(index.nodes.get(makeEndpointNodeId('s1', 'e3'))?.syncBadge).toBeUndefined()
    expect(index.nodes.get(makeEndpointNodeId('s1', 'e4'))?.syncBadge).toBeUndefined()
    expect(index.nodes.get(makeEndpointNodeId('s1', 'e5'))?.syncBadge).toBe('changed')
  })

  it('散层顺序保持 DTO 序（Rust 已按创建时间升序，不重排）', () => {
    const index = buildApiTreeIndex(
      tree({
        services: [
          service('s1', '服务', {
            endpoints: [endpoint('s1', 'z', '先建'), endpoint('s1', 'a', '后建')],
          }),
        ],
      }),
    )
    expect(index.childrenOf.get(makeServiceNodeId('s1'))).toEqual([
      makeEndpointNodeId('s1', 'z'),
      makeEndpointNodeId('s1', 'a'),
    ])
  })

  it('置顶接口提升到顶层置顶组（组在最前），原位不保留', () => {
    const index = buildApiTreeIndex(
      tree({
        services: [
          service('s1', '用户服务', {
            categories: [{ id: 'c1', name: '账号', sortOrder: 1 }],
            endpoints: [
              endpoint('s1', 'e1', '登录', { categoryId: 'c1', pinned: true }),
              endpoint('s1', 'e2', '健康检查'),
            ],
          }),
          service('s2', '订单服务', {
            endpoints: [endpoint('s2', 'e3', '下单', { pinned: true })],
          }),
        ],
      }),
    )

    expect(index.rootChildren).toEqual([PINNED_GROUP_ID, 'service:s1', 'service:s2'])
    expect(index.childrenOf.get(PINNED_GROUP_ID)).toEqual([
      makeEndpointNodeId('s1', 'e1'),
      makeEndpointNodeId('s2', 'e3'),
    ])
    // 置顶接口的实际父链＝置顶组；原位分类不再出现（未置顶的散接口留在原位）
    expect(index.childrenOf.get('category:c1')).toEqual([])
    expect(index.childrenOf.get('service:s1')).toEqual([
      'category:c1',
      makeEndpointNodeId('s1', 'e2'),
    ])
    const pinned = index.nodes.get(makeEndpointNodeId('s1', 'e1'))
    expect(pinned?.parentIds).toEqual([PINNED_GROUP_ID])
    // 置顶接口仍保留原归属快照（菜单上下文与匹配用）
    expect(pinned?.serviceId).toBe('s1')
    expect(pinned?.categoryName).toBe('账号')
  })

  it('无置顶接口不建置顶组', () => {
    const index = buildApiTreeIndex(
      tree({
        services: [service('s1', '服务', { endpoints: [endpoint('s1', 'e1', '接口')] })],
      }),
    )
    expect(index.rootChildren).toEqual(['service:s1'])
    expect(index.nodes.has(PINNED_GROUP_ID)).toBe(false)
  })

  it('分类已删而 DTO 未刷新时接口退回散层（脏 categoryId 不丢行）', () => {
    const index = buildApiTreeIndex(
      tree({
        services: [
          service('s1', '服务', {
            endpoints: [endpoint('s1', 'e1', '孤儿', { categoryId: 'c-gone' })],
          }),
        ],
      }),
    )
    expect(index.childrenOf.get(makeServiceNodeId('s1'))).toEqual([makeEndpointNodeId('s1', 'e1')])
  })

  it('空树：rootChildren 为空（视图按空态渲染）', () => {
    const index = buildApiTreeIndex(tree())
    expect(index.rootChildren).toEqual([])
    expect(index.nodes.size).toBe(0)
  })
})

describe('parseEndpointNodeId 身份解析', () => {
  it('接口 id 解析出服务与键；其余形态返回 null', () => {
    expect(parseEndpointNodeId(makeEndpointNodeId('s1', 'k:2'))).toEqual({
      serviceId: 's1',
      key: 'k:2',
    })
    expect(parseEndpointNodeId('service:s1')).toBeNull()
    expect(parseEndpointNodeId('endpoint:only-service')).toBeNull()
    expect(parseEndpointNodeId('endpoint::key')).toBeNull()
  })
})

describe('filterApiTree 四字段过滤', () => {
  const fixture = tree({
    services: [
      service('s1', '用户服务', {
        docUrl: 'https://docs.example.com',
        categories: [{ id: 'c1', name: '账号管理', sortOrder: 1 }],
        endpoints: [
          endpoint('s1', 'e1', '登录', {
            categoryId: 'c1',
            method: 'POST',
            pathTemplate: '/auth/login',
          }),
          endpoint('s1', 'e2', '健康检查', { method: 'GET', pathTemplate: '/health' }),
        ],
      }),
      service('s2', '订单服务', {
        endpoints: [endpoint('s2', 'e3', '查询订单', { pathTemplate: '/orders/list' })],
      }),
    ],
  })

  it('空查询与纯空白＝非过滤模式（null）', () => {
    const index = buildApiTreeIndex(fixture)
    expect(filterApiTree(index, '')).toBeNull()
    expect(filterApiTree(index, '   ')).toBeNull()
  })

  it('标题命中：仅命中行与祖先可见，兄弟分支剔除', () => {
    const index = buildApiTreeIndex(fixture)
    const result = filterApiTree(index, '登录')!
    expect(result.hasMatches).toBe(true)
    expect([...result.index.nodes.keys()].sort()).toEqual(
      ['category:c1', makeEndpointNodeId('s1', 'e1'), 'service:s1'].sort(),
    )
    // 未命中服务整体不可见
    expect(result.index.rootChildren).toEqual(['service:s1'])
  })

  it('路径命中（不分大小写）：命中项祖先自动展开清单给出', () => {
    const index = buildApiTreeIndex(fixture)
    const result = filterApiTree(index, '/HEALTH')!
    expect([...result.index.nodes.keys()]).toContain(makeEndpointNodeId('s1', 'e2'))
    expect(result.ancestorsToExpand).toEqual(['service:s1'])
  })

  it('方法命中', () => {
    const index = buildApiTreeIndex(fixture)
    const result = filterApiTree(index, 'post')!
    expect([...result.index.nodes.keys()]).toContain(makeEndpointNodeId('s1', 'e1'))
    expect(result.hasMatches).toBe(true)
  })

  it('分类名命中其下接口（分类行自身不参与匹配）', () => {
    const index = buildApiTreeIndex(fixture)
    const result = filterApiTree(index, '账号管理')!
    expect([...result.index.nodes.keys()]).toContain(makeEndpointNodeId('s1', 'e1'))
    // 分类名不直接命中分类行：另一个分类接口不受影响
    const none = filterApiTree(index, '订单服务')
    expect(none?.hasMatches).toBe(false)
  })

  it('置顶组内接口命中：可见父链走置顶组（展开清单含置顶组）', () => {
    const pinned = tree({
      services: [
        service('s1', '服务', {
          endpoints: [endpoint('s1', 'e1', '登录', { pinned: true })],
        }),
      ],
    })
    const index = buildApiTreeIndex(pinned)
    const result = filterApiTree(index, '登录')!
    expect(result.index.rootChildren).toEqual([PINNED_GROUP_ID])
    expect(result.ancestorsToExpand).toEqual([PINNED_GROUP_ID])
  })

  it('无命中：hasMatches=false 且子图只剩空根（视图渲染无结果空态）', () => {
    const index = buildApiTreeIndex(fixture)
    const result = filterApiTree(index, '不存在的词')!
    expect(result.hasMatches).toBe(false)
    expect(result.index.rootChildren).toEqual([])
    expect(result.ancestorsToExpand).toEqual([])
  })
})

describe('expandForFilter 展开合并', () => {
  it('基线展开 ∪ 命中祖先，去重且保序稳定', () => {
    expect(expandForFilter(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('无新增祖先时原样返回（不换引用）', () => {
    const base = ['a']
    expect(expandForFilter(base, [])).toBe(base)
  })
})

describe('树根常量', () => {
  it('根 id 与置顶组 id 不与业务节点 id 形态重叠', () => {
    expect(API_TREE_ROOT_ID).toBe('root')
    expect(parseEndpointNodeId(PINNED_GROUP_ID)).toBeNull()
  })
})

describe('allContainerIds 一键展开目标集', () => {
  it('服务 + 分类全收，置顶组仅有置顶接口时收入', () => {
    const fixture = tree({
      services: [
        service('s1', '用户服务', {
          categories: [{ id: 'c1', name: '账号管理', sortOrder: 0 }],
          endpoints: [endpoint('s1', 'e1', '登录')],
        }),
        service('s2', '订单服务', {
          endpoints: [endpoint('s2', 'e2', '下单', { pinned: true })],
        }),
        service('s3', '无接口服务'),
      ],
    })
    expect(allContainerIds(fixture)).toEqual([
      'service:s1',
      'category:c1',
      'service:s2',
      'service:s3',
      PINNED_GROUP_ID,
    ])
  })

  it('无置顶接口不含置顶组（组节点不存在，展开它无意义）', () => {
    const fixture = tree({
      services: [service('s1', '用户服务', { endpoints: [endpoint('s1', 'e1', '登录')] })],
    })
    expect(allContainerIds(fixture)).toEqual(['service:s1'])
  })
})
