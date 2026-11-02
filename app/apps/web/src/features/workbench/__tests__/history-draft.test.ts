import { describe, expect, it } from 'vitest'

import { draftSeedFromSnapshot, isPathTemplateShapeValid } from '../history-draft'

/** 基线输入（逐字段覆写驱动矩阵分支） */
function makeInput(overrides?: Partial<Parameters<typeof draftSeedFromSnapshot>[0]>) {
  return {
    method: 'GET',
    url: 'https://api.example.com/v1/users?id=42',
    headers: [
      ['accept', '*/*'],
      ['authorization', 'Bearer secret-token'],
    ] as [string, string][],
    bodyExcerpt: null,
    bodyTruncated: false,
    sensitiveHeaderNames: ['x-custom-key'],
    sourceServiceId: 's1',
    baseUrl: 'https://api.example.com/v1',
    ...overrides,
  }
}

describe('history-draft：URL 拆分口径（与 build_url 组合规则互为镜像）', () => {
  it('BaseUrl 命中（origin＋path 前缀）：余下 path 进模板、query 拆参数行', () => {
    const seed = draftSeedFromSnapshot(makeInput())
    expect(seed.pathTemplate).toBe('/users')
    expect(JSON.parse(seed.paramsJson)).toEqual([{ name: 'id', value: '42' }])
  })

  it('快照 URL 恰等于 BaseUrl：模板回落根路径', () => {
    const seed = draftSeedFromSnapshot(makeInput({ url: 'https://api.example.com/v1' }))
    expect(seed.pathTemplate).toBe('/')
    expect(seed.paramsJson).toBe('[]')
  })

  it('BaseUrl 带尾斜杠：规范化后同命中', () => {
    const seed = draftSeedFromSnapshot(makeInput({ baseUrl: 'https://api.example.com/v1/' }))
    expect(seed.pathTemplate).toBe('/users')
  })

  it('host≠BaseUrl：pathTemplate 存完整 URL（绝对形态，query 仍拆行）', () => {
    const seed = draftSeedFromSnapshot(makeInput({ url: 'https://other.test/a/b?x=1' }))
    expect(seed.pathTemplate).toBe('https://other.test/a/b')
    expect(JSON.parse(seed.paramsJson)).toEqual([{ name: 'x', value: '1' }])
  })

  it('BaseUrl 缺省 / 空串 / 形态非法：一律绝对形态', () => {
    for (const baseUrl of [null, '', 'not a url']) {
      const seed = draftSeedFromSnapshot(makeInput({ baseUrl }))
      expect(seed.pathTemplate).toBe('https://api.example.com/v1/users')
    }
  })

  it('host 大小写差异经 URL 规范化后仍命中（两侧同源归一）', () => {
    const seed = draftSeedFromSnapshot(makeInput({ url: 'https://API.EXAMPLE.COM/v1/users' }))
    expect(seed.pathTemplate).toBe('/users')
  })

  it('前缀撞名不误命中（host 是 BaseUrl 的字符串延伸而非段边界）', () => {
    const seed = draftSeedFromSnapshot(makeInput({ url: 'https://api.example.com.v2.dev/users' }))
    expect(seed.pathTemplate).toBe('https://api.example.com.v2.dev/users')
  })

  it('query 百分号编码 round-trip：GUI percent_encode 生成的键值解码还原', () => {
    const seed = draftSeedFromSnapshot(
      makeInput({ url: 'https://api.example.com/v1/search?q=a%20b%26c%3Dd' }),
    )
    expect(JSON.parse(seed.paramsJson)).toEqual([{ name: 'q', value: 'a b&c=d' }])
  })

  it('query 多值全部保留（数组语义）；无等号裸键值为空串；非法百分号序列容错保留', () => {
    const seed = draftSeedFromSnapshot(
      makeInput({ url: 'https://api.example.com/v1/a?a=1&a=2&flag&bad=%zz' }),
    )
    expect(JSON.parse(seed.paramsJson)).toEqual([
      { name: 'a', value: '1' },
      { name: 'a', value: '2' },
      { name: 'flag', value: '' },
      { name: 'bad', value: '%zz' },
    ])
  })

  it('快照 URL 形态异常：原文进模板、query 不强拆（兜底不改写）', () => {
    const seed = draftSeedFromSnapshot(makeInput({ url: 'not a url at all' }))
    expect(seed.pathTemplate).toBe('not a url at all')
    expect(seed.paramsJson).toBe('[]')
  })
})

describe('history-draft：快照回填构造', () => {
  it('headers 回填为 KV 行 JSON（含认证头真实值，掩码交展示层）', () => {
    const seed = draftSeedFromSnapshot(makeInput())
    expect(JSON.parse(seed.headersJson)).toEqual([
      { name: 'accept', value: '*/*' },
      { name: 'authorization', value: 'Bearer secret-token' },
    ])
    expect(seed.sensitiveHeaderNames).toEqual(['x-custom-key'])
    expect(seed.sourceServiceId).toBe('s1')
  })

  it('body 嗅探（信封读侧口径）：JSON→json、`<` 起头→xml、其余→text、空→null', () => {
    const json = draftSeedFromSnapshot(makeInput({ bodyExcerpt: '{"a":1}' }))
    expect(JSON.parse(json.body!)).toEqual({ kind: 'json', text: '{"a":1}' })

    const xml = draftSeedFromSnapshot(makeInput({ bodyExcerpt: '<root/>' }))
    expect(JSON.parse(xml.body!)).toEqual({ kind: 'xml', text: '<root/>' })

    const text = draftSeedFromSnapshot(makeInput({ bodyExcerpt: 'plain words' }))
    expect(JSON.parse(text.body!)).toEqual({ kind: 'text', text: 'plain words' })

    for (const empty of [null, '', '   ']) {
      const seed = draftSeedFromSnapshot(makeInput({ bodyExcerpt: empty }))
      expect(seed.body).toBeNull()
    }
  })

  it('body 原文不改写（嗅探只定 kind，excerpt 逐字进 text 载体）', () => {
    const excerpt = '{\n  "name": "Ada"\n}'
    const seed = draftSeedFromSnapshot(makeInput({ bodyExcerpt: excerpt }))
    expect(JSON.parse(seed.body!).text).toBe(excerpt)
    expect(seed.bodyTruncated).toBe(false)
  })

  it('标题＝`方法 + 模板`，超限截断；truncated 透传', () => {
    const normal = draftSeedFromSnapshot(makeInput())
    expect(normal.title).toBe('GET /users')

    const long = draftSeedFromSnapshot(
      makeInput({ bodyTruncated: true, url: 'https://api.example.com/v1/users' }),
    )
    expect(long.bodyTruncated).toBe(true)
    expect(long.title.length).toBeLessThanOrEqual(60)
  })
})

describe('history-draft：模板本地形态校验（后端 validate_path_template 的前端镜像）', () => {
  it('相对模板与绝对 URL 形态合法；空白 / 查询串 / 无前缀非法', () => {
    expect(isPathTemplateShapeValid('/users/{id}')).toBe(true)
    expect(isPathTemplateShapeValid('http://api.example.com/v1')).toBe(true)
    expect(isPathTemplateShapeValid('https://api.example.com')).toBe(true)
    expect(isPathTemplateShapeValid('users')).toBe(false)
    expect(isPathTemplateShapeValid('/a b')).toBe(false)
    expect(isPathTemplateShapeValid('/a?x=1')).toBe(false)
    expect(isPathTemplateShapeValid('https://x.test/a?x=1')).toBe(false)
    expect(isPathTemplateShapeValid('ftp://x.test/a')).toBe(false)
    expect(isPathTemplateShapeValid('')).toBe(false)
  })
})
