import { describe, expect, it } from 'vitest'

import type { VariableNavIndex } from '../variables-nav-dnd'
import { expandForVariablesFilter, filterVariablesNav } from '../variables-nav-filter'

/** 树索引夹具：全局区 g1 置顶、本空间区 c1/c2 随后；c1 下两个变量键 */
const index: VariableNavIndex = {
  nodes: new Map([
    ['g1', { kind: 'category', id: 'g1', name: '公共', isGlobal: true, activated: false }],
    ['c1', { kind: 'category', id: 'c1', name: '开发', isGlobal: false, activated: true }],
    ['c2', { kind: 'category', id: 'c2', name: '测试', isGlobal: false, activated: false }],
    [
      'v:c1:host',
      { kind: 'variable', id: 'v:c1:host', name: 'host', categoryId: 'c1', secret: false },
    ],
    [
      'v:c1:token',
      { kind: 'variable', id: 'v:c1:token', name: 'token', categoryId: 'c1', secret: true },
    ],
  ]),
  rootChildren: ['g1', 'c1', 'c2'],
  childrenOf: new Map([['c1', ['v:c1:host', 'v:c1:token']]]),
}

describe('filterVariablesNav（树搜索过滤）', () => {
  it('空查询返回 null＝非过滤模式（全量索引）', () => {
    expect(filterVariablesNav(index, '')).toBeNull()
    expect(filterVariablesNav(index, '   ')).toBeNull()
  })

  it('分类名命中：命中分类行保留，未命中分支整枝隐藏', () => {
    const result = filterVariablesNav(index, '开发')
    expect(result).not.toBeNull()
    expect(result!.hasMatches).toBe(true)
    expect(result!.index.rootChildren).toEqual(['c1'])
    expect(result!.index.nodes.get('c1')?.name).toBe('开发')
    // 分类行自身命中不产生自动展开目标（它直接挂在根层可见）
    expect(result!.ancestorsToExpand).toEqual([])
  })

  it('变量 key 命中：父分类保留为可见祖先，其余分类隐藏', () => {
    const result = filterVariablesNav(index, 'token')
    expect(result).not.toBeNull()
    expect(result!.index.rootChildren).toEqual(['c1'])
    expect(result!.index.nodes.get('v:c1:token')).toBeDefined()
    expect(result!.index.nodes.get('v:c1:host')).toBeUndefined()
    expect(result!.ancestorsToExpand).toEqual(['c1'])
    // 可见子图只保留可见节点间的边：父分类的子序中未命中变量被剔除
    expect(result!.index.childrenOf.get('c1')).toEqual(['v:c1:token'])
  })

  it('匹配不区分大小写且忽略首尾空白', () => {
    const result = filterVariablesNav(index, '  HOST ')
    expect(result).not.toBeNull()
    expect(result!.index.nodes.get('v:c1:host')).toBeDefined()
  })

  it('无命中＝空集（hasMatches false、根序为空）', () => {
    const result = filterVariablesNav(index, '不存在的关键词')
    expect(result).not.toBeNull()
    expect(result!.hasMatches).toBe(false)
    expect(result!.index.rootChildren).toEqual([])
    expect(result!.index.nodes.size).toBe(0)
  })
})

describe('expandForVariablesFilter（进入过滤的展开合并）', () => {
  it('基线展开与命中父分类取并集去重', () => {
    expect(expandForVariablesFilter(['c2'], ['c1', 'c2'])).toEqual(['c2', 'c1'])
  })

  it('无命中祖先时原样返回基线（不换引用）', () => {
    const base = ['c1']
    expect(expandForVariablesFilter(base, [])).toBe(base)
  })
})
