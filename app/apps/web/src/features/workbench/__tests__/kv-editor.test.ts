import { describe, expect, it } from 'vitest'

import contract from '@/test/fixtures/kv-contract.json'

import {
  formatBulkKvText,
  mergeBulkIntoRows,
  parseBulkKvText,
  parseKvRows,
  serializeKvRows,
} from '../kv-rows'

/** 键值编辑器数据转换：JSON ⇄ 键值行的往返一致与非法形态保真边界 */
describe('parseKvRows', () => {
  it('合法键值数组解析为行', () => {
    expect(parseKvRows('[{"name":"a","value":"1"}]')).toEqual([{ name: 'a', value: '1' }])
  })

  it('空数组解析为空行表', () => {
    expect(parseKvRows('[]')).toEqual([])
  })

  it('非法 JSON / 非数组 / 非对象项 / 缺字段均返回 null（原文保真模式）', () => {
    expect(parseKvRows('not json')).toBeNull()
    expect(parseKvRows('{"name":"a"}')).toBeNull()
    expect(parseKvRows('[1]')).toBeNull()
    expect(parseKvRows('[{"name":"a"}]')).toBeNull()
    expect(parseKvRows('[{"value":"1"}]')).toBeNull()
    expect(parseKvRows('[{"name":1,"value":"1"}]')).toBeNull()
  })

  it('行带 type / description 解析读出一致（可选标注随行持久化）', () => {
    expect(
      parseKvRows('[{"name":"page","value":"1","type":"integer","description":"页码"}]'),
    ).toEqual([{ name: 'page', value: '1', type: 'integer', description: '页码' }])
    expect(parseKvRows('[{"name":"flag","value":"true","type":"boolean"}]')).toEqual([
      { name: 'flag', value: 'true', type: 'boolean' },
    ])
  })

  it('非字符串 type / description 容忍置空（不报错、不改写其余字段）', () => {
    expect(parseKvRows('[{"name":"a","value":"1","type":123}]')).toEqual([
      { name: 'a', value: '1' },
    ])
    expect(parseKvRows('[{"name":"a","value":"1","description":null}]')).toEqual([
      { name: 'a', value: '1' },
    ])
    expect(parseKvRows('[{"name":"a","value":"1","type":{"x":1},"description":[1]}]')).toEqual([
      { name: 'a', value: '1' },
    ])
  })

  it('type 任意字符串保留（合法域约束在 UI 层，解析面只看字符串性）', () => {
    expect(parseKvRows('[{"name":"a","value":"1","type":"custom"}]')).toEqual([
      { name: 'a', value: '1', type: 'custom' },
    ])
  })

  it('enabled 布尔形态携带，缺失或非布尔不携带（缺省启用）', () => {
    expect(parseKvRows('[{"name":"a","value":"1","enabled":false}]')).toEqual([
      { name: 'a', value: '1', enabled: false },
    ])
    expect(parseKvRows('[{"name":"a","value":"1","enabled":true}]')).toEqual([
      { name: 'a', value: '1', enabled: true },
    ])
    expect(parseKvRows('[{"name":"a","value":"1"}]')).toEqual([{ name: 'a', value: '1' }])
    expect(parseKvRows('[{"name":"a","value":"1","enabled":"yes"}]')).toEqual([
      { name: 'a', value: '1' },
    ])
    expect(parseKvRows('[{"name":"a","value":"1","enabled":null}]')).toEqual([
      { name: 'a', value: '1' },
    ])
  })
})

describe('serializeKvRows', () => {
  it('序列化与解析往返一致（含全空行，所见即所得）', () => {
    const rows = [
      { name: 'a', value: '1' },
      { name: '', value: '' },
    ]
    const json = serializeKvRows(rows)
    expect(parseKvRows(json)).toEqual(rows)
  })

  it('可选字段按存在性携带：缺失不写出，写入后往返一致', () => {
    expect(serializeKvRows([{ name: 'a', value: '1' }])).toBe('[{"name":"a","value":"1"}]')
    expect(
      serializeKvRows([{ name: 'page', value: '1', type: 'integer', description: '页码' }]),
    ).toBe('[{"name":"page","value":"1","type":"integer","description":"页码"}]')
    const json = serializeKvRows([
      { name: 'page', value: '1', type: 'integer', description: '页码' },
    ])
    expect(parseKvRows(json)).toEqual([
      { name: 'page', value: '1', type: 'integer', description: '页码' },
    ])
  })

  it('键序规范化：无论输入行键序如何，输出恒为 name/value/type/description/enabled', () => {
    expect(
      serializeKvRows([
        { enabled: false, description: '页码', type: 'integer', name: 'page', value: '1' },
      ]),
    ).toBe('[{"name":"page","value":"1","type":"integer","description":"页码","enabled":false}]')
  })

  it('enabled 按存在性携带：缺失不写出，携带后往返一致', () => {
    expect(serializeKvRows([{ name: 'a', value: '1' }])).toBe('[{"name":"a","value":"1"}]')
    expect(serializeKvRows([{ name: 'a', value: '1', enabled: false }])).toBe(
      '[{"name":"a","value":"1","enabled":false}]',
    )
    expect(parseKvRows(serializeKvRows([{ name: 'a', value: '1', enabled: false }]))).toEqual([
      { name: 'a', value: '1', enabled: false },
    ])
  })

  it('空行表序列化为空数组', () => {
    expect(serializeKvRows([])).toBe('[]')
  })
})

describe('parseBulkKvText（批量编辑解析）', () => {
  it('每行一对 key: value，首个冒号分隔（值含冒号保留）', () => {
    expect(parseBulkKvText('a: 1\nb: x:y:z')).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: 'x:y:z' },
    ])
  })

  it('容忍空行与空白行；无冒号或冒号前无名称的行跳过', () => {
    expect(parseBulkKvText('\na: 1\n\n   \nb\n: novalue\nc: 3')).toEqual([
      { name: 'a', value: '1' },
      { name: 'c', value: '3' },
    ])
  })

  it('冒号前后空白容忍；值为空保留；同名行后值胜、按首次出现位置定序', () => {
    expect(parseBulkKvText('a : spaced\nempty:\na: second\nb: v')).toEqual([
      { name: 'a', value: 'second' },
      { name: 'empty', value: '' },
      { name: 'b', value: 'v' },
    ])
  })

  it('CRLF 行尾按行拆分', () => {
    expect(parseBulkKvText('a: 1\r\nb: 2')).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
    ])
  })
})

describe('formatBulkKvText（行集播种文本）', () => {
  it('每行输出 `名称: 值`，行集顺序即文本顺序', () => {
    expect(
      formatBulkKvText([
        { name: 'a', value: '1', type: 'integer' },
        { name: '', value: '' },
      ]),
    ).toBe('a: 1\n: ')
  })
})

describe('mergeBulkIntoRows（批量写回合并）', () => {
  const rows = [
    { name: 'a', value: '1', type: 'integer', description: '页码', enabled: false },
    { name: 'b', value: '2' },
  ]

  it('同名行仅覆盖值（type / description / enabled 保留），新行缺省追加', () => {
    expect(
      mergeBulkIntoRows(rows, [
        { name: 'a', value: '9' },
        { name: 'new', value: 'v' },
      ]),
    ).toEqual([
      { name: 'a', value: '9', type: 'integer', description: '页码', enabled: false },
      { name: 'b', value: '2' },
      { name: 'new', value: 'v' },
    ])
  })

  it('未命中的现有行原样保留（浅拷贝不改原数组）', () => {
    const merged = mergeBulkIntoRows(rows, [{ name: 'c', value: '3' }])
    expect(merged[1]).toEqual({ name: 'b', value: '2' })
    expect(rows[1]).toEqual({ name: 'b', value: '2' })
  })

  it('空键值对集合＝行集原样（批量文本全空时零改动）', () => {
    expect(mergeBulkIntoRows(rows, [])).toEqual(rows)
  })
})

/**
 * 用户数据 params/headers JSON 契约夹具（`src/test/fixtures/kv-contract.json`）：
 * 与 Rust `services/http/request.rs` 共用同一文件，双端钉住契约不漂移——
 * 前端（kv-editor 组装）与 Rust（引擎解析消费）对同一 JSON 的收发语义一致。
 */
describe('kv 契约夹具（双端钉住）', () => {
  it('夹具逐例与 parseKvRows 行为一致', () => {
    expect(contract.cases.length).toBeGreaterThan(0)
    for (const c of contract.cases) {
      const parsed = parseKvRows(c.json)
      if (c.invalid) {
        expect(parsed, `case ${c.name}`).toBeNull()
      } else {
        expect(parsed, `case ${c.name}`).toEqual(c.rows ?? [])
        // 合法形态另钉往返一致：Rust 侧解析的行集可由前端无损重组
        expect(serializeKvRows(parsed ?? []), `case ${c.name}`).toBe(JSON.stringify(c.rows ?? []))
      }
    }
  })
})
