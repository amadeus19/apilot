import { describe, expect, it } from 'vitest'

import { parseQueryPairs } from '../query-pairs'

describe('query 拆行共享原语：基本形态', () => {
  it('`&` 分段、首个 `=` 分键值的基本拆行', () => {
    expect(parseQueryPairs('a=1&b=2')).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
    ])
  })

  it('无 `=` 的裸段解析为空值行（名称保留）', () => {
    expect(parseQueryPairs('flag&k=1')).toEqual([
      { name: 'flag', value: '' },
      { name: 'k', value: '1' },
    ])
  })

  it('空段丢弃（`&&` 与尾随 `&` 均不产生垃圾行）', () => {
    expect(parseQueryPairs('a=1&&b=2&')).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
    ])
  })

  it('首个 `=` 分键值，值内 `=` 原样保留（a=b=c → 值 b=c）', () => {
    expect(parseQueryPairs('a=b=c')).toEqual([{ name: 'a', value: 'b=c' }])
  })

  it('空串拆出空行集', () => {
    expect(parseQueryPairs('')).toEqual([])
  })

  it('串内同名键保留为多行（同名收敛归调用方合并语义）', () => {
    expect(parseQueryPairs('a=1&a=2')).toEqual([
      { name: 'a', value: '1' },
      { name: 'a', value: '2' },
    ])
  })
})

describe('query 拆行共享原语：`+` 两口径（镜像口径的一部分）', () => {
  it('默认 RFC 语义：`+` 字面保留，`%XX` 正常解码', () => {
    expect(parseQueryPairs('r=x+y&q=a%20b')).toEqual([
      { name: 'r', value: 'x+y' },
      { name: 'q', value: 'a b' },
    ])
  })

  it('plusAsSpace 表单语义：`+` 与 `%20` 收敛为真实空格', () => {
    expect(parseQueryPairs('r=x+y&q=a%20b', { plusAsSpace: true })).toEqual([
      { name: 'r', value: 'x y' },
      { name: 'q', value: 'a b' },
    ])
  })

  it('两口径对键名同样生效', () => {
    expect(parseQueryPairs('x+y=1', { plusAsSpace: true })).toEqual([{ name: 'x y', value: '1' }])
    expect(parseQueryPairs('x+y=1')).toEqual([{ name: 'x+y', value: '1' }])
  })
})

describe('query 拆行共享原语：非法百分号容错', () => {
  it('非法百分号序列保留原文（不改写用户数据）', () => {
    expect(parseQueryPairs('p=100%&bad=%zz')).toEqual([
      { name: 'p', value: '100%' },
      { name: 'bad', value: '%zz' },
    ])
  })

  it('plusAsSpace 下 `+` 在非法序列中字面原样（catch 返回原始输入，非归一后的串）', () => {
    expect(parseQueryPairs('p=a+b%&q=%2', { plusAsSpace: true })).toEqual([
      { name: 'p', value: 'a+b%' },
      { name: 'q', value: '%2' },
    ])
  })

  it('键名非法百分号序列同样容错', () => {
    expect(parseQueryPairs('%zz=1')).toEqual([{ name: '%zz', value: '1' }])
  })
})

describe('query 拆行共享原语：空名两口径', () => {
  it('默认保留空名段（快照形态宽容）', () => {
    expect(parseQueryPairs('=v&k=1')).toEqual([
      { name: '', value: 'v' },
      { name: 'k', value: '1' },
    ])
  })

  it('dropEmptyName 丢弃空名段（粘贴与 cURL 不产垃圾行）', () => {
    expect(parseQueryPairs('=v&k=1&', { dropEmptyName: true })).toEqual([{ name: 'k', value: '1' }])
  })

  it('dropEmptyName 只丢空名：解码后非空的裸段与具名段保留', () => {
    expect(parseQueryPairs('flag&k=1', { dropEmptyName: true })).toEqual([
      { name: 'flag', value: '' },
      { name: 'k', value: '1' },
    ])
  })
})
