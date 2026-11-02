import { describe, expect, it } from 'vitest'

import { buildApiTreeIndex, PINNED_GROUP_ID } from '../selector'
import { computeTreeDrop, treeDropModeAt } from '../tree-dnd'
import type { TreeDto } from '@/services/workbench-api'

/**
 * 拖拽落点判定纯函数测试：层级约束（分类限分类序列 / 接口限同服务 /
 * 服务限服务序列）、插入位计算（摘除自身语义）、置顶组豁免。
 */

const TREE: TreeDto = {
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
        {
          serviceId: 's1',
          key: 'e1',
          title: '接口一',
          categoryId: null,
          definition: { method: 'GET', pathTemplate: '/a' },
          isManual: true,
          pinned: false,
        },
        {
          serviceId: 's1',
          key: 'e2',
          title: '接口二',
          categoryId: 'c1',
          definition: { method: 'GET', pathTemplate: '/b' },
          isManual: true,
          pinned: false,
        },
        {
          serviceId: 's1',
          key: 'e3',
          title: '接口三',
          categoryId: 'c1',
          definition: { method: 'GET', pathTemplate: '/c' },
          isManual: true,
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
      categories: [{ id: 'c9', name: '他服务分类', sortOrder: 0 }],
      endpoints: [
        {
          serviceId: 's2',
          key: 'e9',
          title: '他服务接口',
          categoryId: null,
          definition: { method: 'GET', pathTemplate: '/x' },
          isManual: true,
          pinned: false,
        },
      ],
    },
  ],
}

const index = buildApiTreeIndex(TREE)

const node = (id: string) => index.nodes.get(id)!

describe('treeDropModeAt', () => {
  it('容器目标分三分，非容器按上下半分', () => {
    expect(treeDropModeAt(true, 0.2)).toBe('before')
    expect(treeDropModeAt(true, 0.5)).toBe('inside')
    expect(treeDropModeAt(true, 0.9)).toBe('after')
    expect(treeDropModeAt(false, 0.3)).toBe('before')
    expect(treeDropModeAt(false, 0.7)).toBe('after')
  })
})

describe('computeTreeDrop：接口', () => {
  it('拖到分类行＝进入该分类末尾（限同服务）', () => {
    const result = computeTreeDrop(node('endpoint:s1:e1'), node('category:c1'), 0.5, index)
    expect(result).toEqual({
      indicator: 'inside',
      action: { kind: 'endpoint', serviceId: 's1', categoryId: 'c1', index: 2 },
    })
  })

  it('跨服务分类拒绝', () => {
    expect(computeTreeDrop(node('endpoint:s1:e1'), node('category:c9'), 0.5, index)).toBeNull()
  })

  it('拖到服务行＝进散层末尾（限同服务）', () => {
    // 散层现有 [e1]：e2（分类内）拖入散层末尾 → index 1
    const result = computeTreeDrop(node('endpoint:s1:e2'), node('service:s1'), 0.5, index)
    expect(result).toEqual({
      indicator: 'inside',
      action: { kind: 'endpoint', serviceId: 's1', categoryId: null, index: 1 },
    })
  })

  it('同组接口行 before/after：插入位按摘除自身后的序列计算', () => {
    // 分类 c1 内 [e2, e3]：e2 拖到 e3 之后 → 摘除 e2 后 [e3]，after(e3)=1
    const result = computeTreeDrop(node('endpoint:s1:e2'), node('endpoint:s1:e3'), 0.7, index)
    expect(result).toEqual({
      indicator: 'after',
      action: { kind: 'endpoint', serviceId: 's1', categoryId: 'c1', index: 1 },
    })
    // e3 拖到 e2 之前 → 摘除 e3 后 [e2]，before(e2)=0
    const reverse = computeTreeDrop(node('endpoint:s1:e3'), node('endpoint:s1:e2'), 0.3, index)
    expect(reverse?.action).toMatchObject({ index: 0 })
  })

  it('跨服务接口行拒绝', () => {
    expect(computeTreeDrop(node('endpoint:s1:e1'), node('endpoint:s2:e9'), 0.3, index)).toBeNull()
  })
})

describe('computeTreeDrop：分类', () => {
  it('拖到目标分类前后＝目标服务分类序列的对应位（可跨服务）', () => {
    // 服务二分类序列 [c9]：c1 拖到 c9 之后 → index 1
    const result = computeTreeDrop(node('category:c1'), node('category:c9'), 0.7, index)
    expect(result).toEqual({
      indicator: 'after',
      action: { kind: 'category', id: 'c1', targetServiceId: 's2', index: 1 },
    })
  })

  it('拖到服务行＝进该服务分类序列末尾', () => {
    const result = computeTreeDrop(node('category:c2'), node('service:s2'), 0.5, index)
    expect(result).toEqual({
      indicator: 'inside',
      action: { kind: 'category', id: 'c2', targetServiceId: 's2', index: 1 },
    })
  })

  it('拖到接口行拒绝', () => {
    expect(computeTreeDrop(node('category:c1'), node('endpoint:s1:e1'), 0.5, index)).toBeNull()
  })
})

describe('computeTreeDrop：服务与置顶', () => {
  it('服务拖到服务前后＝工作空间服务序列对应位', () => {
    const result = computeTreeDrop(node('service:s2'), node('service:s1'), 0.3, index)
    expect(result).toEqual({ indicator: 'before', action: { kind: 'service', id: 's2', index: 0 } })
  })

  it('置顶组行与置顶组内接口拒绝拖放', () => {
    const pinnedTree: TreeDto = {
      ...TREE,
      services: [
        {
          ...TREE.services[0]!,
          endpoints: [{ ...TREE.services[0]!.endpoints[0]!, pinned: true }],
        },
      ],
    }
    const pinnedIndex = buildApiTreeIndex(pinnedTree)
    const pinned = pinnedIndex.nodes.get('endpoint:s1:e1')!
    // 置顶组内接口不可拖
    expect(
      computeTreeDrop(pinned, pinnedIndex.nodes.get('service:s1')!, 0.5, pinnedIndex),
    ).toBeNull()
    // 任何行不可落进置顶组（虚拟视图）
    expect(
      computeTreeDrop(
        pinnedIndex.nodes.get('service:s1')!,
        pinnedIndex.nodes.get(PINNED_GROUP_ID)!,
        0.5,
        pinnedIndex,
      ),
    ).toBeNull()
  })

  it('自身拖到自身拒绝', () => {
    expect(computeTreeDrop(node('endpoint:s1:e1'), node('endpoint:s1:e1'), 0.5, index)).toBeNull()
  })
})
