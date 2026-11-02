import { describe, expect, it } from 'vitest'

import { httpKeys } from '../http-api'

/**
 * httpKeys 键工厂单测：history 的 workspaceId 段是缓存域隔离的契约本体——
 * 前缀关系（historyRoot）承载发送完成失效与详情键挂载，两处约定在此锁定。
 */
describe('httpKeys 键构造', () => {
  it('workspaceId 入键：同页码不同空间各占缓存域', () => {
    expect(httpKeys.history('w1', 1)).toEqual(['http', 'history', 'w1', 1])
    expect(httpKeys.history('w1', 1)).not.toEqual(httpKeys.history('w2', 1))
    expect(httpKeys.history('w2', 3)).toEqual(['http', 'history', 'w2', 3])
  })

  it('historyRoot 前缀关系：任意空间任意页码与详情键都挂在根下（失效前缀全匹配）', () => {
    const root = httpKeys.historyRoot()
    expect(root).toEqual(['http', 'history'])
    expect(httpKeys.history('w1', 2).slice(0, root.length)).toEqual(root)
    expect([...root, 'detail', 'run-1'].slice(0, root.length)).toEqual(root)
  })
})
