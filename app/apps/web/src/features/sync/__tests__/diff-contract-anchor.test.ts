import { describe, expect, it } from 'vitest'

import contract from '@/test/fixtures/sync-diff-contract.json'

import type { DiffOutcome } from '../diff-contract'

/**
 * 同步 diff 契约锚定（双端钉键序，沿 redact-contract 夹具先例）：
 * `src/test/fixtures/sync-diff-contract.json` 与 Rust 侧
 * `domain/sync/diff.rs` 的 `contract_serialization_pinned` 共享同一份表。
 *
 * 锚定两件事：
 * 1. **键序**——fixture 中每个对象的键序与下方期望清单逐层对照（期望清单
 *    即 Rust struct 声明序；`JSON.parse` 保插入序，前端消费依赖此序）；
 * 2. **空值省略口径**——Option 字段缺省时整个键不存在（下方 `absent`
 *    断言钉住），空集合保留为数组。
 *
 * 任一端改契约声明序 / 省略口径，另一端立红；演进通道＝两端同批改。
 */

/** 收集 fixture 中每个对象的实际键序（深度优先，按出现序） */
function keyOrders(node: unknown, prefix: string, out: Map<string, string[]>): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => keyOrders(child, `${prefix}[${i}]`, out))
    return
  }
  if (typeof node !== 'object' || node === null) return
  const record = node as Record<string, unknown>
  const keys = Object.keys(record)
  out.set(prefix || '<root>', keys)
  for (const key of keys) {
    keyOrders(record[key], prefix ? `${prefix}.${key}` : key, out)
  }
}

describe('同步 diff 契约锚定（双端钉键序）', () => {
  it('对象键序与契约声明序逐层一致', () => {
    const orders = new Map<string, string[]>()
    keyOrders(contract, '', orders)

    // 期望键序＝Rust struct 声明序（camelCase）；数组元素同构性不强求
    // （Option 省略使元素键集不同），断言口径＝「实际键序是期望清单的
    // 保序子序列」：缺席合法（空值省略）、乱序或多余键立红。
    const expected: Record<string, string[]> = {
      '<root>': ['summary', 'diffs'],
      summary: ['added', 'changed', 'removed', 'unchanged'],
      'diffs[*]': ['key', 'kind', 'title', 'category', 'params', 'bodyKeys', 'responses'],
      'diffs[*].params[*]': ['name', 'change', 'old', 'new'],
      'diffs[*].params[*].old': ['location', 'required', 'paramType', 'format', 'description'],
      'diffs[*].params[*].new': ['location', 'required', 'paramType', 'format', 'description'],
      'diffs[*].bodyKeys[*]': ['keyPath', 'change', 'old', 'new'],
      'diffs[*].bodyKeys[*].old': ['schemaType', 'required'],
      'diffs[*].bodyKeys[*].new': ['schemaType', 'required'],
      'diffs[*].responses[*]': ['status', 'change', 'oldDescription', 'newDescription', 'keys'],
      'diffs[*].responses[*].keys[*]': ['keyPath', 'change', 'old', 'new'],
    }

    // 归一：把 `diffs[0]`、`diffs[1]` 等数组下标折叠成 `diffs[*]` 再对照
    const fold = (path: string): string => path.replace(/\[\d+\]/g, '[*]')
    const folded = new Map<string, string[][]>()
    for (const [path, keys] of orders) {
      const key = fold(path)
      const list = folded.get(key)
      if (list) list.push(keys)
      else folded.set(key, [keys])
    }

    for (const [path, want] of Object.entries(expected)) {
      const actuals = folded.get(path)
      expect(actuals, `缺少契约对象：${path}`).toBeDefined()
      for (const actual of actuals!) {
        expect(
          want.filter((k) => actual.includes(k)),
          `键序漂移（${path}）：${actual.join(',')} 应为期望清单的保序子序列`,
        ).toEqual(actual)
      }
    }
  })

  it('空值省略口径：Option 缺省时键不存在、空集合保留', () => {
    const outcome = contract as unknown as DiffOutcome
    const changed = outcome.diffs.find((d) => d.kind === 'changed')
    expect(changed).toBeDefined()
    // Removed 行（lang 参数）无 new 键；Unchanged 行 old/new 都在
    const removedRow = changed!.params.find((p) => p.change === 'removed')
    expect(removedRow!.new).toBeUndefined()
    expect('new' in removedRow!).toBe(false)
    // 空集合保留：Added 接口的 bodyKeys 是数组（可能为空但不缺席）
    const added = outcome.diffs.find((d) => d.kind === 'added')
    expect(Array.isArray(added!.bodyKeys)).toBe(true)
  })

  it('夹具覆盖 Added / Changed / Removed 三态与全字段 summary', () => {
    const outcome = contract as unknown as DiffOutcome
    const kinds = new Set(outcome.diffs.map((d) => d.kind))
    expect(kinds.has('added')).toBe(true)
    expect(kinds.has('changed')).toBe(true)
    expect(kinds.has('removed')).toBe(true)
    expect(outcome.summary).toEqual({
      added: 1,
      changed: 1,
      removed: 1,
      unchanged: 0,
    })
  })
})
