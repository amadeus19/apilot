import { describe, expect, it } from 'vitest'

import { evaluateJsonPathLite, expandObservedFields, parseObservedBody } from '../extract-observed'

/**
 * 提取产物实测字段解析：受限 JSONPath（与 Rust json_path 同口径的最小
 * 镜像）与掩码响应体上的产物字段一层展开。
 */

describe('extract-observed：受限 JSONPath', () => {
  const root = {
    data: { token: 't-1', nest: { deep: 'v' } },
    list: [{ id: 1 }, { id: 2 }],
    status: 200,
  }

  it('点路径 / 引号属性 / 数组下标，根符可省', () => {
    expect(evaluateJsonPathLite('$.data.token', root)).toBe('t-1')
    expect(evaluateJsonPathLite('data.token', root)).toBe('t-1')
    expect(evaluateJsonPathLite("$['data'].nest.deep", root)).toBe('v')
    expect(evaluateJsonPathLite('$.list[1].id', root)).toBe(2)
    expect(evaluateJsonPathLite('$', root)).toBe(root)
  })

  it('未命中返回 undefined（不抛错）', () => {
    expect(evaluateJsonPathLite('$.absent', root)).toBeUndefined()
    expect(evaluateJsonPathLite('$.list[9]', root)).toBeUndefined()
    expect(evaluateJsonPathLite('$.list.token', root)).toBeUndefined()
  })
})

describe('extract-observed：掩码响应体解析', () => {
  it('合法 JSON 保留结构（掩码值不参与路径判断之外的字段）', () => {
    const body = '{"token":"***","data":{"exp":9,"nested":{"a":"***"}}}'
    expect(parseObservedBody(body)).toEqual({
      token: '***',
      data: { exp: 9, nested: { a: '***' } },
    })
  })

  it('非 JSON 回落 null（无实测数据）', () => {
    expect(parseObservedBody('plain text')).toBeNull()
    expect(parseObservedBody(null)).toBeNull()
    expect(parseObservedBody('')).toBeNull()
  })
})

describe('extract-observed：产物实测字段一层展开', () => {
  const body = '{"data":{"token":"***","exp":9},"list":[{"id":1},{"id":2}],"plain":"***"}'
  const root = parseObservedBody(body)

  it('对象产物展开键名（产物名.键）；数组产物取首元素展开', () => {
    expect(expandObservedFields('data', '$.data', root)).toEqual(['data.token', 'data.exp'])
    expect(expandObservedFields('list', '$.list', root)).toEqual(['list.0.id'])
  })

  it('单值产物不展开；空产物名不入展开；无实测数据返回空', () => {
    expect(expandObservedFields('plain', '$.plain', root)).toEqual([])
    expect(expandObservedFields('', '$.data', root)).toEqual([])
    expect(expandObservedFields('data', '$.data', null)).toEqual([])
  })
})
