import { describe, expect, it } from 'vitest'

import type {
  BodyKeyChange,
  DiffKind,
  DiffOutcome,
  EndpointDiff,
  ParamChange,
  ResponseChange,
} from '../diff-contract'
import {
  aggregateTotals,
  bodySchemaJsonText,
  changeCounts,
  groupDiffsByKind,
  paramsJsonText,
  responsesJsonText,
  splitStableKey,
} from '../diff-json'

function param(
  name: string,
  change: ParamChange['change'],
  extra: Partial<ParamChange> = {},
): ParamChange {
  return { name, change, ...extra } as ParamChange
}

describe('paramsJsonText（参数页签两侧重建）', () => {
  it('Added 行只进新侧、Removed 行只进旧侧、Unchanged 两侧同值', () => {
    const params: ParamChange[] = [
      param('page', 'unchanged', {
        old: { location: 'query', required: false, paramType: 'integer' },
        new: { location: 'query', required: false, paramType: 'integer' },
      }),
      param('lang', 'removed', {
        old: { location: 'query', required: false, paramType: 'integer' },
      }),
      param('verbose', 'added', {
        new: { location: 'query', required: false, paramType: 'integer' },
      }),
      param('trace', 'changed', {
        old: { location: 'query', required: false, paramType: 'integer' },
        new: { location: 'header', required: false, paramType: 'integer' },
      }),
    ]
    const { original, modified } = paramsJsonText(params)
    expect(JSON.parse(original)).toEqual({
      page: { location: 'query', required: false, paramType: 'integer' },
      lang: { location: 'query', required: false, paramType: 'integer' },
      trace: { location: 'query', required: false, paramType: 'integer' },
    })
    expect(JSON.parse(modified)).toEqual({
      page: { location: 'query', required: false, paramType: 'integer' },
      verbose: { location: 'query', required: false, paramType: 'integer' },
      trace: { location: 'header', required: false, paramType: 'integer' },
    })
    // 序列化形态：2 空格缩进（Monaco 行级 diff 的锚定口径）
    expect(original.split('\n')[0]).toBe('{')
  })

  it('Option 字段缺省（description）以键缺席呈现（空值省略口径）', () => {
    const { original } = paramsJsonText([
      param('page', 'removed', { old: { location: 'query', required: true, paramType: 'string' } }),
    ])
    expect(original).not.toContain('description')
  })
})

describe('responsesJsonText（响应页签两侧重建）', () => {
  it('按状态码组织、key 级明细嵌套 keys', () => {
    const responses: ResponseChange[] = [
      {
        status: '200',
        change: 'unchanged',
        oldDescription: '成功',
        newDescription: '成功',
        keys: [
          {
            keyPath: 'total',
            change: 'changed',
            old: { schemaType: 'integer', required: false },
            new: { schemaType: 'string', required: false },
          },
        ],
      },
      { status: '404', change: 'added', newDescription: '未找到', keys: [] },
    ]
    const { original, modified } = responsesJsonText(responses)
    expect(JSON.parse(original)).toEqual({
      '200': { description: '成功', keys: { total: { schemaType: 'integer', required: false } } },
    })
    expect(JSON.parse(modified)).toEqual({
      '200': { description: '成功', keys: { total: { schemaType: 'string', required: false } } },
      '404': { description: '未找到', keys: {} },
    })
  })
})

describe('bodySchemaJsonText（Schema 折叠区嵌套重建）', () => {
  it('点路径下钻成嵌套树、[] 段保持为 items 键', () => {
    const rows: BodyKeyChange[] = [
      {
        keyPath: 'name',
        change: 'unchanged',
        old: { schemaType: 'string', required: true },
        new: { schemaType: 'string', required: true },
      },
      {
        keyPath: 'addr.city',
        change: 'changed',
        old: { schemaType: 'string', required: true },
        new: { schemaType: 'string', required: false },
      },
      { keyPath: 'age', change: 'removed', old: { schemaType: 'integer', required: false } },
      {
        keyPath: 'tags[]',
        change: 'changed',
        old: { schemaType: 'string', required: false },
        new: { schemaType: 'integer', required: false },
      },
    ]
    const { original, modified } = bodySchemaJsonText(rows)
    expect(JSON.parse(original)).toEqual({
      name: { schemaType: 'string', required: true },
      addr: { city: { schemaType: 'string', required: true } },
      age: { schemaType: 'integer', required: false },
      'tags[]': { schemaType: 'string', required: false },
    })
    expect(JSON.parse(modified)).toEqual({
      name: { schemaType: 'string', required: true },
      addr: { city: { schemaType: 'string', required: false } },
      'tags[]': { schemaType: 'integer', required: false },
    })
  })
})

describe('changeCounts（行芯片计数）', () => {
  it('增删改分类计数、Unchanged 不计', () => {
    const params: ParamChange[] = [
      param('a', 'added'),
      param('b', 'removed'),
      param('c', 'changed'),
      param('d', 'unchanged'),
    ]
    expect(changeCounts({ params })).toEqual({ added: 1, removed: 1, changed: 1 })
  })
})

/** 表驱动用最小 DiffOutcome 工厂（summary 与 diffs 行可各自覆写） */
function outcome(
  serviceId: string,
  summary: Partial<DiffOutcome['summary']>,
  diffs: EndpointDiff[] = [],
): DiffOutcome {
  return {
    serviceId,
    generation: 1,
    summary: {
      added: 0,
      changed: 0,
      removed: 0,
      unchanged: 0,
      ...summary,
    },
    diffs,
  }
}

describe('aggregateTotals（跨服务汇总聚合）', () => {
  it.each([
    ['空集为全零', [], { added: 0, changed: 0, removed: 0, unchanged: 0 }],
    [
      '单服务直通',
      [outcome('s1', { added: 1, unchanged: 5 })],
      { added: 1, changed: 0, removed: 0, unchanged: 5 },
    ],
    [
      '多服务逐字段相加',
      [
        outcome('s1', { added: 1, changed: 2, removed: 3, unchanged: 4 }),
        outcome('s2', { added: 10, changed: 20, removed: 30, unchanged: 40 }),
      ],
      { added: 11, changed: 22, removed: 33, unchanged: 44 },
    ],
  ])('%s', (_name, diffs, expected) => {
    expect(aggregateTotals(diffs)).toEqual(expected)
  })
})

describe('groupDiffsByKind（跨服务分组）', () => {
  const addedRow = (key: string): EndpointDiff => ({
    key,
    kind: 'added',
    title: 't',
    category: '',
    params: [],
    bodyKeys: [],
    responses: [],
  })
  const changedRow = (key: string): EndpointDiff => ({
    ...addedRow(key),
    kind: 'changed',
  })
  const diffs = [
    outcome('s1', {}, [addedRow('GET /a'), changedRow('POST /b')]),
    outcome('s2', {}, [addedRow('GET /c'), addedRow('GET /a'), changedRow('PUT /d')]),
  ]

  it.each([
    [
      'added 抽两服务共三行且 serviceId 随行',
      'added',
      [
        { serviceId: 's1', key: 'GET /a' },
        { serviceId: 's2', key: 'GET /c' },
        { serviceId: 's2', key: 'GET /a' },
      ],
    ],
    [
      'changed 抽两服务各一行',
      'changed',
      [
        { serviceId: 's1', key: 'POST /b' },
        { serviceId: 's2', key: 'PUT /d' },
      ],
    ],
    ['removed 无行为空数组', 'removed', []],
  ] as const)('%s', (_name, kind: DiffKind, expected) => {
    const rows = groupDiffsByKind(diffs, kind)
    expect(rows.map(({ serviceId, diff }) => ({ serviceId, key: diff.key }))).toEqual(expected)
  })

  it('同名稳定键跨服务不混淆（行身份含 serviceId）', () => {
    const rows = groupDiffsByKind(diffs, 'added')
    const sameKey = rows.filter((r) => r.diff.key === 'GET /a')
    expect(sameKey.map((r) => r.serviceId)).toEqual(['s1', 's2'])
  })
})

describe('splitStableKey（稳定键拆解）', () => {
  it.each([
    ['方法＋路径', 'GET /users', { method: 'GET', path: '/users' }],
    [
      '路径含空格以外的合法形态（大小写保留）',
      'post /Orders/{id}',
      { method: 'post', path: '/Orders/{id}' },
    ],
  ])('%s', (_name, key, expected) => {
    expect(splitStableKey(key)).toEqual(expected)
  })
})
