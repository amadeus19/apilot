import { describe, expect, it } from 'vitest'

import { contentTypeFromHeaders, formatSnapshotBodyJson, tryFormatJson } from '../json-format'

/**
 * JSON 格式化共享纯函数直测：object / array 标量护栏、头列表取
 * content-type、历史详情体的截断不格式化与 content-type 优先两级判定。
 */

describe('tryFormatJson', () => {
  it('object / array parse 成功返回两空格缩进文本', () => {
    expect(tryFormatJson('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(tryFormatJson('[1,2]')).toBe('[\n  1,\n  2\n]')
    expect(tryFormatJson('  {"a":1}  ')).toBe('{\n  "a": 1\n}')
  })

  it('标量与解析失败返回 null（不误格式化普通文本）', () => {
    expect(tryFormatJson('42')).toBeNull()
    expect(tryFormatJson('"text"')).toBeNull()
    expect(tryFormatJson('true')).toBeNull()
    expect(tryFormatJson('null')).toBeNull()
    expect(tryFormatJson('plain text body')).toBeNull()
    expect(tryFormatJson('{"a":1')).toBeNull()
  })
})

describe('contentTypeFromHeaders', () => {
  it('头名大小写不敏感取 content-type；缺失返回 null', () => {
    expect(contentTypeFromHeaders([['Content-Type', 'application/json']])).toBe('application/json')
    expect(
      contentTypeFromHeaders([
        ['accept', '*/*'],
        ['CONTENT-TYPE', 'text/plain'],
      ]),
    ).toBe('text/plain')
    expect(contentTypeFromHeaders([['accept', '*/*']])).toBeNull()
  })
})

describe('formatSnapshotBodyJson（历史详情体格式化判定）', () => {
  it('截断段不格式化（摘录只展示原样）', () => {
    expect(formatSnapshotBodyJson('{"a":1}', true, 'application/json')).toBeNull()
    expect(formatSnapshotBodyJson('{"a":1}', true, null)).toBeNull()
  })

  it('content-type 为 JSON 家族（含 +json 后缀族）才走格式化', () => {
    expect(formatSnapshotBodyJson('{"a":1}', false, 'application/json')).toBe('{\n  "a": 1\n}')
    expect(formatSnapshotBodyJson('{"a":1}', false, 'application/vnd.api+json')).toBe(
      '{\n  "a": 1\n}',
    )
    expect(formatSnapshotBodyJson('{"a":1}', false, 'text/plain')).toBeNull()
    // 声明 JSON 但 parse 失败 / 标量：回落 null（原文展示）
    expect(formatSnapshotBodyJson('{"a":1', false, 'application/json')).toBeNull()
    expect(formatSnapshotBodyJson('42', false, 'application/json')).toBeNull()
  })

  it('content-type 缺失按「parse 得动且是 object / array」兜底', () => {
    expect(formatSnapshotBodyJson('{"a":1}', false, null)).toBe('{\n  "a": 1\n}')
    expect(formatSnapshotBodyJson('[1]', false, undefined)).toBe('[\n  1\n]')
    expect(formatSnapshotBodyJson('42', false, null)).toBeNull()
    expect(formatSnapshotBodyJson('{"a":1', false, undefined)).toBeNull()
  })
})
