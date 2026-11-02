import { describe, expect, it } from 'vitest'

import {
  categoryScopeOrder,
  computeVariablesNavDrop,
  type VariableNavIndex,
} from '../variables-nav-dnd'

/** 树索引夹具：全局区 g1/g2 置顶、本空间区 c1/c2 随后（与视图组装序一致） */
const index: VariableNavIndex = {
  nodes: new Map([
    ['g1', { kind: 'category', id: 'g1', name: '全局一', isGlobal: true, activated: false }],
    ['g2', { kind: 'category', id: 'g2', name: '全局二', isGlobal: true, activated: false }],
    ['c1', { kind: 'category', id: 'c1', name: '开发', isGlobal: false, activated: true }],
    ['c2', { kind: 'category', id: 'c2', name: '测试', isGlobal: false, activated: false }],
    [
      'v:c1:token',
      { kind: 'variable', id: 'v:c1:token', name: 'token', categoryId: 'c1', secret: true },
    ],
  ]),
  rootChildren: ['g1', 'g2', 'c1', 'c2'],
  childrenOf: new Map([['c1', ['v:c1:token']]]),
}

const category = (id: 'g1' | 'g2' | 'c1' | 'c2') => index.nodes.get(id)!

describe('categoryScopeOrder（区序过滤）', () => {
  it('全局组与本空间组各自成序', () => {
    expect(categoryScopeOrder(index, true)).toEqual(['g1', 'g2'])
    expect(categoryScopeOrder(index, false)).toEqual(['c1', 'c2'])
  })
})

describe('computeVariablesNavDrop（分类排序落点判定）', () => {
  it('同区内 before / after：index 为摘除自身后的插入位', () => {
    expect(computeVariablesNavDrop(category('c2'), category('c1'), 0.2, index)).toEqual({
      indicator: 'before',
      action: { kind: 'category', id: 'c2', index: 0 },
    })
    expect(computeVariablesNavDrop(category('c1'), category('c2'), 0.8, index)).toEqual({
      indicator: 'after',
      action: { kind: 'category', id: 'c1', index: 1 },
    })
  })

  it('全局组内可拖（全局序是共享资源的语义）', () => {
    expect(computeVariablesNavDrop(category('g2'), category('g1'), 0.2, index)).toEqual({
      indicator: 'before',
      action: { kind: 'category', id: 'g2', index: 0 },
    })
  })

  it('跨区、变量行、自拖自均不可落', () => {
    // 全局 → 本空间行
    expect(computeVariablesNavDrop(category('g1'), category('c1'), 0.5, index)).toBeNull()
    // 本空间 → 全局行
    expect(computeVariablesNavDrop(category('c1'), category('g2'), 0.5, index)).toBeNull()
    // 目标是变量行
    const variable = index.nodes.get('v:c1:token')!
    expect(computeVariablesNavDrop(category('c2'), variable, 0.5, index)).toBeNull()
    // 变量行是源
    expect(computeVariablesNavDrop(variable, category('c2'), 0.5, index)).toBeNull()
    // 自拖自
    expect(computeVariablesNavDrop(category('c1'), category('c1'), 0.5, index)).toBeNull()
  })
})
