import { describe, expect, it } from 'vitest'

import type { RunListItemDto } from '../history-api'
import { filterHistoryItems, urlPathNameOf, urlPathOf } from '../history-grouping'

/** 构造历史行（createdAt 为 ISO UTC 串） */
function item(
  runId: string,
  createdAt: string,
  url = 'http://localhost:8080/api/orders?page=1',
): RunListItemDto {
  return {
    runId,
    state: 'passed',
    method: 'GET',
    url,
    statusCode: 200,
    durationMs: 340,
    source: 'gui',
    createdAt,
    endpointName: null,
  }
}

describe('urlPathOf / urlPathNameOf：URL 路径提取', () => {
  it('路径含 query（首行列口径）；接口名回落列不含 query（次行口径）', () => {
    expect(urlPathOf('http://localhost:8080/api/orders?page=1&size=20')).toBe(
      '/api/orders?page=1&size=20',
    )
    expect(urlPathNameOf('http://localhost:8080/api/orders?page=1&size=20')).toBe('/api/orders')
  })

  it('仅 origin 的 URL 回退根路径；解析失败回退原串', () => {
    expect(urlPathOf('http://localhost:8080')).toBe('/')
    expect(urlPathNameOf('http://localhost:8080')).toBe('/')
    expect(urlPathOf('not a url')).toBe('not a url')
    expect(urlPathNameOf('not a url')).toBe('not a url')
  })
})

describe('filterHistoryItems：本地子串过滤', () => {
  const rows = [
    item('r1', new Date(2026, 9, 2, 10, 0, 0).toISOString(), 'http://localhost/api/orders?page=1'),
    item('r2', new Date(2026, 9, 2, 9, 0, 0).toISOString(), 'http://localhost/api/users/42'),
  ]

  it('路径子串匹配（大小写不敏感）；query 段参与匹配', () => {
    expect(filterHistoryItems(rows, 'orders').map((row) => row.runId)).toEqual(['r1'])
    expect(filterHistoryItems(rows, 'ORDERS').map((row) => row.runId)).toEqual(['r1'])
    expect(filterHistoryItems(rows, 'page=1').map((row) => row.runId)).toEqual(['r1'])
    expect(filterHistoryItems(rows, '/api/').map((row) => row.runId)).toEqual(['r1', 'r2'])
  })

  it('空与纯空白查询＝不过滤；无命中返回空数组', () => {
    expect(filterHistoryItems(rows, '')).toHaveLength(2)
    expect(filterHistoryItems(rows, '   ')).toHaveLength(2)
    expect(filterHistoryItems(rows, 'payments')).toEqual([])
  })

  it('口径并列命中：method 与状态码子串（大小写不敏感、数字串包含）', () => {
    const at = new Date(2026, 9, 2, 10, 0, 0).toISOString()
    const mixed = [
      item('r-get', at),
      { ...item('r-post', at, 'http://localhost/api/submit'), method: 'POST' },
      { ...item('r-404', at, 'http://localhost/api/missing'), statusCode: 404 },
      {
        ...item('r-none', at, 'http://localhost/api/other'),
        statusCode: null,
        state: 'cancelled' as const,
      },
    ]

    // method 命中（小写比较）
    expect(filterHistoryItems(mixed, 'post').map((row) => row.runId)).toEqual(['r-post'])
    expect(filterHistoryItems(mixed, 'GET').map((row) => row.runId)).toEqual([
      'r-get',
      'r-404',
      'r-none',
    ])
    // 状态码命中（子串口径：「40」命中 404）
    expect(filterHistoryItems(mixed, '404').map((row) => row.runId)).toEqual(['r-404'])
    expect(filterHistoryItems(mixed, '40').map((row) => row.runId)).toEqual(['r-404'])
    // 状态码 null（取消行）不参与状态码匹配，也不误命中
    expect(filterHistoryItems(mixed, 'null')).toEqual([])
    // 三口径并列：URL / method / status 任一命中即保留
    expect(filterHistoryItems(mixed, 'users')).toEqual([])
    expect(filterHistoryItems(mixed, 'missing').map((row) => row.runId)).toEqual(['r-404'])
  })
})
