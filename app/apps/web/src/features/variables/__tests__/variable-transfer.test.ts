import { describe, expect, it } from 'vitest'

import {
  exportCategoryJson,
  parseBulkVariableLines,
  parseImportedVariables,
} from '../variable-transfer'

const rows = [
  { key: 'token', value: 'plain-secret-value', secret: true },
  { key: 'host', value: 'https://dev.example.com', secret: false },
]

describe('exportCategoryJson（导出默认脱敏）', () => {
  it('默认掩码：Secret 值以 *** 导出，标记位保留', () => {
    const json = JSON.parse(exportCategoryJson('开发', rows, false)) as {
      version: number
      category: string
      variables: { key: string; value: string; secret: boolean }[]
    }
    expect(json.version).toBe(1)
    expect(json.category).toBe('开发')
    expect(json.variables[0]).toEqual({ key: 'token', value: '***', secret: true })
    expect(json.variables[1]).toEqual({
      key: 'host',
      value: 'https://dev.example.com',
      secret: false,
    })
    expect(exportCategoryJson('开发', rows, false)).not.toContain('plain-secret-value')
  })

  it('显式勾选才含真值', () => {
    const json = JSON.parse(exportCategoryJson('开发', rows, true)) as {
      variables: { value: string }[]
    }
    expect(json.variables[0]!.value).toBe('plain-secret-value')
  })
})

describe('parseImportedVariables（导入解析）', () => {
  it('包裹形态与裸数组都接受；缺省字段补默认', () => {
    const wrapped = parseImportedVariables(
      '{"variables":[{"key":"a"},{"key":"b","value":"v","secret":true}]}',
    )
    expect(wrapped).toEqual({
      rows: [
        { key: 'a', value: '', secret: false },
        { key: 'b', value: 'v', secret: true },
      ],
      skipped: [],
    })
    expect(parseImportedVariables('[{"key":" a ","value":"x"}]')).toEqual({
      rows: [{ key: 'a', value: 'x', secret: false }],
      skipped: [],
    })
  })

  it('非法 JSON 与非法形态分别报错（行级定位可得时携带）', () => {
    // invalid-json：语法层失败（line 依赖 V8 message 携带 position，跨版本
    // 不稳定，只断言错误分支）
    expect(parseImportedVariables('not json')).toMatchObject({ error: 'invalid-json' })
    // 顶层形态不对＝整单粒度（index null）
    expect(parseImportedVariables('{"other":1}')).toEqual({ error: 'invalid-shape', index: null })
    // 行级校验失败＝携带条目下标（0 起算）
    expect(parseImportedVariables('[{"key":"ok"},{"value":"no-key"}]')).toEqual({
      error: 'invalid-shape',
      index: 1,
    })
    expect(parseImportedVariables('[{"key":"ok"},{"key":1}]')).toEqual({
      error: 'invalid-shape',
      index: 1,
    })
    expect(parseImportedVariables('[{"key":"ok"},{"key":"a","secret":"yes"}]')).toEqual({
      error: 'invalid-shape',
      index: 1,
    })
    expect(parseImportedVariables('[{"key":"ok"},{"key":"a","value":3}]')).toEqual({
      error: 'invalid-shape',
      index: 1,
    })
  })
})

describe('parseImportedVariables（掩码回灌防御，表驱动）', () => {
  it.each([
    {
      name: 'secret 行值恰为掩码字面量 → 跳过出行级警示，其余行不受影响',
      input: '[{"key":"token","value":"***","secret":true},{"key":"host","value":"h"}]',
      rows: [{ key: 'host', value: 'h', secret: false }],
      skipped: [{ index: 0, key: 'token', reason: 'secret-mask' }],
    },
    {
      name: '包裹形态内同拦；跳过行的下标按数组内条目计',
      input:
        '{"variables":[{"key":"a","value":"1"},{"key":"b","value":"***","secret":true},{"key":"c","value":"***","secret":true}]}',
      rows: [{ key: 'a', value: '1', secret: false }],
      skipped: [
        { index: 1, key: 'b', reason: 'secret-mask' },
        { index: 2, key: 'c', reason: 'secret-mask' },
      ],
    },
    {
      name: '非 secret 行的真值 *** 是合法数据，不拦',
      input: '[{"key":"plain","value":"***","secret":false}]',
      rows: [{ key: 'plain', value: '***', secret: false }],
      skipped: [],
    },
    {
      name: 'secret 行带真值（显式勾选导出的）正常导入',
      input: '[{"key":"token","value":"real-value","secret":true}]',
      rows: [{ key: 'token', value: 'real-value', secret: true }],
      skipped: [],
    },
    {
      name: 'secret 缺省 false 的掩码值不拦（secret===true 才拦）',
      input: '[{"key":"a","value":"***"}]',
      rows: [{ key: 'a', value: '***', secret: false }],
      skipped: [],
    },
    {
      name: '全部行都是掩码 → rows 空、警示全量（宁可不导入也不落假值）',
      input: '[{"key":"t1","value":"***","secret":true},{"key":"t2","value":"***","secret":true}]',
      rows: [],
      skipped: [
        { index: 0, key: 't1', reason: 'secret-mask' },
        { index: 1, key: 't2', reason: 'secret-mask' },
      ],
    },
  ])('$name', ({ input, rows, skipped }) => {
    expect(parseImportedVariables(input)).toEqual({ rows, skipped })
  })

  it('导出→导入闭环：默认掩码导出的 JSON 回灌不落假值', () => {
    const exported = exportCategoryJson('开发', rows, false)
    const parsed = parseImportedVariables(exported)
    expect(parsed).toEqual({
      rows: [{ key: 'host', value: 'https://dev.example.com', secret: false }],
      skipped: [{ index: 0, key: 'token', reason: 'secret-mask' }],
    })
  })
})

describe('parseBulkVariableLines（批量行解析，行级定位）', () => {
  it('每行一对、首个冒号分隔（值内冒号保留）、两端 trim', () => {
    expect(
      parseBulkVariableLines('token: abc\nhost: https://x.test:8080/path\n\n  spaced : v '),
    ).toEqual({
      rows: [
        { line: 1, key: 'token', value: 'abc' },
        { line: 2, key: 'host', value: 'https://x.test:8080/path' },
        { line: 4, key: 'spaced', value: 'v' },
      ],
      errors: [],
    })
  })

  it('无冒号与空键行按行号报错，不影响其余行', () => {
    const result = parseBulkVariableLines('a: 1\nbad line\n: 2\nb: 2')
    expect(result.rows).toEqual([
      { line: 1, key: 'a', value: '1' },
      { line: 4, key: 'b', value: '2' },
    ])
    expect(result.errors).toEqual([
      { line: 2, reason: 'missing-colon' },
      { line: 3, reason: 'empty-key' },
    ])
  })

  it('批次内重复键保留首次出现、后续行报 duplicate', () => {
    const result = parseBulkVariableLines('a: 1\nb: 2\na: 3')
    expect(result.rows).toEqual([
      { line: 1, key: 'a', value: '1' },
      { line: 2, key: 'b', value: '2' },
    ])
    expect(result.errors).toEqual([{ line: 3, reason: 'duplicate' }])
  })
})
