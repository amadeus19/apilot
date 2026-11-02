import { describe, expect, it } from 'vitest'

import type { KvRow } from '../kv-rows'
import contract from '@/test/fixtures/url-compose-contract.json'

import { composeFinalUrl, mergeQueryIntoRows, parsePastedUrl, percentEncode } from '../url-draft'

describe('最终 URL 组合契约夹具（与 Rust request.rs 测试共享同一份表）', () => {
  it('逐 case 组合结果与夹具一致（含绝对模板 / 编码 / 错误形态）', () => {
    expect(contract.cases.length).toBeGreaterThan(0)
    for (const testCase of contract.cases) {
      const params: KvRow[] = testCase.params.map((row) => ({ name: row.name, value: row.value }))
      const outcome = composeFinalUrl(testCase.baseUrl, testCase.pathTemplate, params)
      if (testCase.expectUrl !== undefined) {
        expect(outcome, `case=${testCase.name}`).toEqual({ url: testCase.expectUrl })
      } else {
        expect(outcome, `case=${testCase.name}`).toEqual({ error: testCase.expectError })
      }
    }
  })
})

describe('粘贴拆分（urlencoded 语义）', () => {
  it('按第一个 ? 分离：path 段进模板、query 段按 & 与 = 解析', () => {
    expect(parsePastedUrl('/api/users?id=42&verbose=true')).toEqual({
      pathTemplate: '/api/users',
      queryParams: [
        { name: 'id', value: '42' },
        { name: 'verbose', value: 'true' },
      ],
    })
  })

  it('绝对 URL 粘贴：host 与 path 整体进模板，fragment 截断不进参数行', () => {
    expect(parsePastedUrl('https://api.example.com/v1/users?id=7#section')).toEqual({
      pathTemplate: 'https://api.example.com/v1/users',
      queryParams: [{ name: 'id', value: '7' }],
    })
  })

  it('加号与百分号编码均解：%XX 还原、+ 归一为空格（urlencoded 空格两形态收敛）', () => {
    expect(parsePastedUrl('/s?q=a%20b%2B1&k=x+y&c=%E4%B8%AD%E6%96%87')).toEqual({
      pathTemplate: '/s',
      queryParams: [
        { name: 'q', value: 'a b+1' },
        { name: 'k', value: 'x y' },
        { name: 'c', value: '中文' },
      ],
    })
  })

  it('无 = 的裸段解析为空值行；空段与空名段丢弃', () => {
    expect(parsePastedUrl('/t?flag&&=v&k=1')).toEqual({
      pathTemplate: '/t',
      queryParams: [
        { name: 'flag', value: '' },
        { name: 'k', value: '1' },
      ],
    })
  })

  it('非法百分号序列容错保留原文（不改写用户数据）', () => {
    expect(parsePastedUrl('/t?p=100%&ok=1')).toEqual({
      pathTemplate: '/t',
      queryParams: [
        { name: 'p', value: '100%' },
        { name: 'ok', value: '1' },
      ],
    })
  })

  it('串内同名键保留为多行（后值胜收敛发生在合并阶段）；首尾空白剔除', () => {
    expect(parsePastedUrl('  /dup?a=1&a=2  ')).toEqual({
      pathTemplate: '/dup',
      queryParams: [
        { name: 'a', value: '1' },
        { name: 'a', value: '2' },
      ],
    })
  })

  it('不含 ? 的文本原样进模板（拆分不生效的兜底形态）', () => {
    expect(parsePastedUrl('/plain/path')).toEqual({
      pathTemplate: '/plain/path',
      queryParams: [],
    })
  })
})

describe('query 行合并（粘贴 → 参数行）', () => {
  it('同名行覆盖值且标注保留，新名追加，未命中行原样保留', () => {
    const rows: KvRow[] = [
      { name: 'a', value: '1', type: 'integer', description: '旧说明' },
      { name: 'keep', value: 'x' },
    ]
    expect(
      mergeQueryIntoRows(rows, [
        { name: 'a', value: '9' },
        { name: 'b', value: '2' },
      ]),
    ).toEqual([
      { name: 'a', value: '9', type: 'integer', description: '旧说明' },
      { name: 'keep', value: 'x' },
      { name: 'b', value: '2' },
    ])
  })

  it('粘贴串内重复 key 后值胜（只落一行终值）', () => {
    expect(
      mergeQueryIntoRows(
        [],
        [
          { name: 'a', value: '1' },
          { name: 'a', value: '2' },
        ],
      ),
    ).toEqual([{ name: 'a', value: '2' }])
  })

  it('现有同名多行都被覆盖为终值（行序不变，不引入重复行）', () => {
    const rows: KvRow[] = [
      { name: 'tag', value: 'old1' },
      { name: 'tag', value: 'old2' },
      { name: 'z', value: 'end' },
    ]
    expect(mergeQueryIntoRows(rows, [{ name: 'tag', value: 'new' }])).toEqual([
      { name: 'tag', value: 'new' },
      { name: 'tag', value: 'new' },
      { name: 'z', value: 'end' },
    ])
  })
})

describe('解析与拼接的 round-trip 对称', () => {
  it('粘贴进来的空格两形态（+ / %20）解析为真实空格，再组合统一为 %20 上线', () => {
    const pasted = parsePastedUrl('/s?q=a+b&k=c%20d')
    const rows = mergeQueryIntoRows([], pasted.queryParams)
    expect(composeFinalUrl('http://x.test', '/s', rows)).toEqual({
      url: 'http://x.test/s?q=a%20b&k=c%20d',
    })
  })

  it('百分号编码：非保留字符直通、空格 %20、中文按 UTF-8 编码（与发送侧同源）', () => {
    expect(percentEncode('a-b.c~d_9 中文')).toBe('a-b.c~d_9%20%E4%B8%AD%E6%96%87')
    expect(percentEncode('&=?#')).toBe('%26%3D%3F%23')
  })
})
