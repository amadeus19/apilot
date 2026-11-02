import { describe, expect, it } from 'vitest'

import {
  colorizeJsonTokens,
  contentTypeLabel,
  flattenDocSchema,
  generateSample,
  groupParamsByLocation,
  isFormContentType,
  nextExclusiveDrawerState,
  shouldShowDocEntry,
  type DocParameter,
  type DocSchema,
} from '../endpoint-doc-logic'

/**
 * 接口文档抽屉的逻辑面直测：入口显隐、抽屉互斥、分区数据装配
 * （参数分组 / schema 展平 / 示例生成 / JSON 着色分词）。
 * 呈现形态（540px 抽屉、单列折叠流、状态码手风琴）按 10 号票定案实现，
 * 细节视觉不入测试（不为覆盖率测无意义 DOM 细节）。
 */

describe('入口显隐', () => {
  it('仅同步接口渲染（手工与另存副本隐藏而非禁用）', () => {
    expect(shouldShowDocEntry(true)).toBe(false)
    expect(shouldShowDocEntry(false)).toBe(true)
  })
})

describe('抽屉互斥切换', () => {
  it('两钮并存、同时至多一开；点已开抽屉的钮＝收起', () => {
    expect(nextExclusiveDrawerState(false, false, 'doc')).toEqual([false, true])
    expect(nextExclusiveDrawerState(true, false, 'doc')).toEqual([false, true])
    expect(nextExclusiveDrawerState(false, true, 'doc')).toEqual([false, false])
    expect(nextExclusiveDrawerState(false, false, 'settings')).toEqual([true, false])
    expect(nextExclusiveDrawerState(false, true, 'settings')).toEqual([true, false])
    expect(nextExclusiveDrawerState(true, false, 'settings')).toEqual([false, false])
  })
})

describe('参数三小节装配', () => {
  const param = (name: string, location: DocParameter['location']): DocParameter => ({
    name,
    location,
    required: false,
    paramType: 'string',
  })

  it('path / query / header 各归其节；formData / cookie 归请求体形态不展开', () => {
    const groups = groupParamsByLocation([
      param('id', 'path'),
      param('page', 'query'),
      param('X-Trace', 'header'),
      param('file', 'formData'),
      param('session', 'cookie'),
    ])
    expect(groups.path.map((p) => p.name)).toEqual(['id'])
    expect(groups.query.map((p) => p.name)).toEqual(['page'])
    expect(groups.header.map((p) => p.name)).toEqual(['X-Trace'])
  })
})

describe('schema 展平（点路径缩进树）', () => {
  const leaf = (schemaType: string): DocSchema => ({
    schemaType,
    truncated: false,
    required: [],
    enumValues: [],
    properties: [],
  })
  const object = (props: [string, DocSchema][], required: string[]): DocSchema => ({
    schemaType: 'object',
    truncated: false,
    required,
    enumValues: [],
    properties: props,
  })
  const arrayOf = (items: DocSchema): DocSchema => ({
    schemaType: 'array',
    truncated: false,
    required: [],
    enumValues: [],
    properties: [],
    items,
  })

  it('嵌套点路径 + array `[]` 后缀 + required 标记 + 深度递增', () => {
    const schema = object(
      [
        ['name', leaf('string')],
        ['addr', object([['city', leaf('string')]], ['city'])],
        ['tags', arrayOf(leaf('string'))],
      ],
      ['name'],
    )
    const rows = flattenDocSchema(schema)
    expect(rows.map((r) => r.keyPath)).toEqual(['name', 'addr', 'addr.city', 'tags', 'tags[]'])
    // tags[] 是 array 元素行：比数组行本身深一级
    expect(rows.map((r) => r.depth)).toEqual([0, 0, 1, 0, 1])
    expect(rows[0]?.required).toBe(true)
    expect(rows[2]?.required).toBe(true)
    expect(rows[3]?.required).toBe(false)
  })
})

describe('示例生成（响应示例双轨的无 example 回退）', () => {
  it('object / array / 标量按类型生成；enum 取首值', () => {
    expect(
      generateSample({
        schemaType: 'object',
        truncated: false,
        required: [],
        enumValues: [],
        properties: [
          [
            'id',
            {
              schemaType: 'integer',
              truncated: false,
              required: [],
              enumValues: [],
              properties: [],
            },
          ],
          [
            'state',
            {
              schemaType: 'string',
              truncated: false,
              required: [],
              enumValues: ['on', 'off'],
              properties: [],
            },
          ],
        ],
      }),
    ).toEqual({ id: 0, state: 'on' })
    expect(
      generateSample({
        schemaType: 'boolean',
        truncated: false,
        required: [],
        enumValues: [],
        properties: [],
      }),
    ).toBe(true)
  })
})

describe('请求体媒型展示标签', () => {
  it('JSON 家族（精确 application/json / +json 后缀变体 / text/json）归一为「JSON」', () => {
    expect(contentTypeLabel('application/json')).toBe('JSON')
    expect(contentTypeLabel('application/json-patch+json')).toBe('JSON')
    expect(contentTypeLabel('application/*+json')).toBe('JSON')
    expect(contentTypeLabel('application/vnd.api+json')).toBe('JSON')
    expect(contentTypeLabel('text/json')).toBe('JSON')
  })

  it('媒型大小写不敏感；非 JSON 媒型原样展示', () => {
    expect(contentTypeLabel('Application/JSON')).toBe('JSON')
    expect(contentTypeLabel('Text/JSON')).toBe('JSON')
    expect(contentTypeLabel('multipart/form-data')).toBe('multipart/form-data')
    expect(contentTypeLabel('application/x-www-form-urlencoded')).toBe(
      'application/x-www-form-urlencoded',
    )
    expect(contentTypeLabel('text/plain')).toBe('text/plain')
    expect(contentTypeLabel('image/png')).toBe('image/png')
  })
})

describe('form 系媒型判定（请求体空字段区占位选择）', () => {
  it('multipart/* 与 x-www-form-urlencoded 为表单体；其余不是', () => {
    expect(isFormContentType('multipart/form-data')).toBe(true)
    expect(isFormContentType('multipart/mixed')).toBe(true)
    expect(isFormContentType('Multipart/Form-Data')).toBe(true)
    expect(isFormContentType('application/x-www-form-urlencoded')).toBe(true)
    expect(isFormContentType('application/json')).toBe(false)
    expect(isFormContentType('text/plain')).toBe(false)
    expect(isFormContentType('')).toBe(false)
  })
})

describe('JSON 轻量着色分词', () => {
  it('key / string / number / literal / punct 各归其类', () => {
    const tokens = colorizeJsonTokens('{"a": 1, "b": [true, "x", null]}')
    expect(tokens.filter((tk) => tk.kind === 'key').map((tk) => tk.text)).toEqual(['"a"', '"b"'])
    expect(tokens.filter((tk) => tk.kind === 'number').map((tk) => tk.text)).toEqual(['1'])
    expect(tokens.filter((tk) => tk.kind === 'literal').map((tk) => tk.text)).toEqual([
      'true',
      'null',
    ])
    expect(tokens.filter((tk) => tk.kind === 'string').map((tk) => tk.text)).toEqual(['"x"'])
  })

  it('token 流拼接无损（可还原原文）', () => {
    const text = '{"msg":"含中文与\\"转义\\"","n":-1.5e3}'
    const joined = colorizeJsonTokens(text)
      .map((tk) => tk.text)
      .join('')
    expect(joined).toBe(text)
  })
})
