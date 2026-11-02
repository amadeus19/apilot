import { describe, expect, it } from 'vitest'

import type { TreeDto } from '@/services/workbench-api'
import contract from '@/test/fixtures/search-contract.json'

import { buildApiTreeIndex, filterApiTree } from '../selector'

/**
 * 搜索口径契约夹具：与 Rust `cli/api.rs` 的 matches_query 测试共享同一份
 * `src/test/fixtures/search-contract.json`（Rust 侧 include_str! 引用）——
 * 任一端改口径另一端立红。空白关键词语义两端有意分叉（前端＝非过滤
 * 模式 null、CLI＝INVALID_ARGUMENT fail-fast），各有专门测试钉住，
 * 故夹具不含空白关键词 case。
 */

/** 夹具行 → 树 DTO：同名分类共享实体；pinned 保留（buildApiTreeIndex 会
 * 提升到置顶组，但 categoryName 快照保留——匹配域与命中序不因此改变）。 */
function fixtureTree(): TreeDto {
  const categories = new Map<string, { id: string; name: string; sortOrder: number }>()
  let next = 0
  const endpoints = contract.endpoints.map((row) => {
    let categoryId: string | null = null
    if (row.categoryName !== null) {
      let category = categories.get(row.categoryName)
      if (category === undefined) {
        category = { id: `c${next}`, name: row.categoryName, sortOrder: next }
        next += 1
        categories.set(row.categoryName, category)
      }
      categoryId = category.id
    }
    return {
      serviceId: 's1',
      key: row.key,
      title: row.title,
      categoryId,
      definition: { method: row.method, pathTemplate: row.pathTemplate },
      isManual: false,
      pinned: row.pinned,
    }
  })
  return {
    workspaceId: 'w1',
    services: [
      {
        id: 's1',
        name: '服务',
        docUrl: null,
        docType: 'openapi',
        sortOrder: 0,
        categories: [...categories.values()],
        endpoints,
      },
    ],
  }
}

describe('搜索口径契约夹具（与 Rust cli 测试共享同一份表）', () => {
  it('四字段命中集逐 case 与夹具一致（顺序＝树序）', () => {
    const index = buildApiTreeIndex(fixtureTree())
    for (const { keyword, expect: expected } of contract.cases) {
      const result = filterApiTree(index, keyword)
      expect(result, `keyword=${keyword}`).not.toBeNull()
      const hits = [...result!.index.nodes.values()]
        .filter((node) => node.kind === 'endpoint')
        .map((node) => node.key)
      expect(hits, `keyword=${keyword}`).toEqual(expected)
    }
  })
})
