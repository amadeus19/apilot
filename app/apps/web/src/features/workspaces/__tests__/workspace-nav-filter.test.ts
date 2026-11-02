import { describe, expect, it } from 'vitest'

import { expandNavForFilter, filterWorkspaceNav } from '../workspace-nav-filter'
import type { WorkspaceNavIndex } from '../workspace-nav-dnd'

/** 两级树测试索引：两个工作空间（w1 含两服务，w2 空间名与 w1 服务名交叉命中用） */
function makeIndex(): WorkspaceNavIndex {
  return {
    nodes: new Map([
      ['w1', { kind: 'workspace', id: 'w1', name: '默认工作空间', isCurrent: true }],
      ['w2', { kind: 'workspace', id: 'w2', name: '第二空间', isCurrent: false }],
      ['s1', { kind: 'service', id: 's1', workspaceId: 'w1', name: '用户服务', docUrl: null }],
      ['s2', { kind: 'service', id: 's2', workspaceId: 'w1', name: '手工容器', docUrl: null }],
    ]),
    rootChildren: ['w1', 'w2'],
    childrenOf: new Map([
      ['w1', ['s1', 's2']],
      ['w2', []],
    ]),
  }
}

describe('工作空间树过滤纯函数', () => {
  it('空查询返回 null（非过滤，行为与无搜索一致）', () => {
    expect(filterWorkspaceNav(makeIndex(), '')).toBeNull()
    expect(filterWorkspaceNav(makeIndex(), '   ')).toBeNull()
  })

  it('工作空间名命中：空间行保留、兄弟空间剔除（命中行＋祖先口径，与接口树同构）', () => {
    const result = filterWorkspaceNav(makeIndex(), '默认')
    expect(result).not.toBeNull()
    expect(result!.hasMatches).toBe(true)
    expect(result!.index.rootChildren).toEqual(['w1'])
    expect(result!.index.nodes.has('w1')).toBe(true)
    // 可见子图只含命中行与其祖先（工作空间在根层，无更深祖先）
    expect(result!.index.nodes.has('s1')).toBe(false)
    expect(result!.index.nodes.has('w2')).toBe(false)
    expect(result!.ancestorsToExpand).toEqual([])
  })

  it('服务名命中：命中行与父工作空间行保留，父级进自动展开集', () => {
    const result = filterWorkspaceNav(makeIndex(), '用户')
    expect(result).not.toBeNull()
    // 命中服务行 + 父工作空间行保留；父工作空间名不含查询词
    expect(result!.index.nodes.has('s1')).toBe(true)
    expect(result!.index.nodes.has('w1')).toBe(true)
    expect(result!.index.rootChildren).toEqual(['w1'])
    // 父级进自动展开集（保证命中项可见）；同空间未命中兄弟行随子图剔除
    expect(result!.ancestorsToExpand).toEqual(['w1'])
    expect(result!.index.childrenOf.get('w1')).toEqual(['s1'])
    expect(result!.index.nodes.has('s2')).toBe(false)
    expect(result!.index.nodes.has('w2')).toBe(false)
  })

  it('匹配不区分大小写', () => {
    const index = makeIndex()
    index.nodes.set('w2', { kind: 'workspace', id: 'w2', name: 'Api Workspace', isCurrent: false })
    const result = filterWorkspaceNav(index, 'API W')
    expect(result).not.toBeNull()
    expect(result!.index.rootChildren).toEqual(['w2'])
  })

  it('无命中：hasMatches false、空子图（视图层据此呈现空态）', () => {
    const result = filterWorkspaceNav(makeIndex(), '不存在的词')
    expect(result).not.toBeNull()
    expect(result!.hasMatches).toBe(false)
    expect(result!.index.rootChildren).toEqual([])
    expect(result!.index.nodes.size).toBe(0)
    expect(result!.ancestorsToExpand).toEqual([])
  })

  it('expandNavForFilter：基线与命中父级并集去重；无命中父级返回原引用', () => {
    expect(expandNavForFilter(['w2'], ['w1'])).toEqual(['w2', 'w1'])
    expect(expandNavForFilter(['w1', 'w2'], ['w1'])).toEqual(['w1', 'w2'])
    const base = ['w1']
    expect(expandNavForFilter(base, [])).toBe(base)
  })
})
