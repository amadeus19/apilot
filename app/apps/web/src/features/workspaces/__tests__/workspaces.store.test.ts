import { beforeEach, describe, expect, it } from 'vitest'

import { annotateImportGroups, defaultCheckedIndexes, importSelectAllState } from '../import-groups'
import { useWorkspacesStore } from '../workspaces.store'

// 模块级 store 用例间隔离：恢复初始状态（partial 合并保留 action 引用）
beforeEach(() => {
  useWorkspacesStore.setState({
    dialog: null,
    importStep: 'entry',
    importEntryUrl: '',
    importGroups: [],
    importChecked: [],
    treeSelectedWorkspaceId: null,
    treeExpandedIds: [],
  })
})

describe('import-groups（批量导入查重纯函数）', () => {
  const existing = [
    { name: 'V1', docUrl: '/swagger/v1/swagger.json' },
    { name: '手工', docUrl: null },
  ]

  it('标注名称与文档地址撞车（各自独立判定）', () => {
    const annotated = annotateImportGroups(
      [
        { name: 'V1', docUrl: '/swagger/other/swagger.json' },
        { name: '新分组', docUrl: '/swagger/v1/swagger.json' },
        { name: '全新', docUrl: '/swagger/new/swagger.json' },
      ],
      existing,
    )
    expect(annotated.map((g) => [g.nameExists, g.urlExists])).toEqual([
      [true, false], // 名称撞：默认不勾选
      [false, true], // 地址撞：仅标注
      [false, false], // 全新
    ])
  })

  it('无文档地址的现有服务不参与地址比对（null 不进比对集）', () => {
    // existing 里的「手工」服务 docUrl=null：分组地址不可能与其撞车
    const annotated = annotateImportGroups(
      [{ name: 'x', docUrl: '/swagger/v1/swagger.json' }],
      [{ name: '手工', docUrl: null }],
    )
    expect(annotated[0]?.urlExists).toBe(false)
  })

  it('默认勾选剔除名称撞车分组，保留地址撞车分组', () => {
    const annotated = annotateImportGroups(
      [
        { name: 'V1', docUrl: '/a.json' },
        { name: '新分组', docUrl: '/swagger/v1/swagger.json' },
        { name: '全新', docUrl: '/c.json' },
      ],
      existing,
    )
    expect(defaultCheckedIndexes(annotated)).toEqual([1, 2])
  })
})

describe('importSelectAllState（表头全选三态，全集＝可勾行）', () => {
  /** 三个分组，index 1 为名称撞车（禁选行，仍可强行勾选但不在全集内） */
  const groups = annotateImportGroups(
    [
      { name: 'A', docUrl: '/a.json' },
      { name: 'V1', docUrl: '/b.json' },
      { name: 'C', docUrl: '/c.json' },
    ],
    [{ name: 'V1', docUrl: null }],
  )

  it('空列表：无可勾集，恒为 none', () => {
    expect(importSelectAllState([], [])).toBe('none')
  })

  it('全不选 / 部分 / 全选：按可勾行集合推导三态', () => {
    expect(importSelectAllState(groups, [])).toBe('none')
    expect(importSelectAllState(groups, [0])).toBe('partial')
    expect(importSelectAllState(groups, [0, 2])).toBe('all')
  })

  it('含禁选行：强行勾选撞车行不改变三态判定（不参与全集）', () => {
    // 只勾禁选行：可勾行全未勾 → none
    expect(importSelectAllState(groups, [1])).toBe('none')
    // 可勾行全勾之外多勾了禁选行：仍为 all
    expect(importSelectAllState(groups, [0, 1, 2])).toBe('all')
  })

  it('全部禁选：无任何可勾行，恒为 none', () => {
    const allExists = annotateImportGroups(
      [{ name: 'V1', docUrl: '/a.json' }],
      [{ name: 'V1', docUrl: null }],
    )
    expect(importSelectAllState(allExists, [])).toBe('none')
    expect(importSelectAllState(allExists, [0])).toBe('none')
  })
})

describe('workspaces.store（管理视图对话框与导入向导状态机）', () => {
  it('对话框开合：openDialog / closeDialog', () => {
    useWorkspacesStore.getState().openDialog({ type: 'ws-new' })
    expect(useWorkspacesStore.getState().dialog).toEqual({ type: 'ws-new' })
    useWorkspacesStore.getState().closeDialog()
    expect(useWorkspacesStore.getState().dialog).toBeNull()
  })

  it('导入向导：beginImport 进入输入步并清残留；发现成功进勾选步', () => {
    const store = useWorkspacesStore.getState()
    store.setImportEntryUrl('/old')
    store.beginImport('w1')
    // 重新开始导入：入口地址保留修正便利、分组与勾选清空、停在输入步
    expect(useWorkspacesStore.getState().dialog).toEqual({ type: 'import', workspaceId: 'w1' })
    expect(useWorkspacesStore.getState().importStep).toBe('entry')
    expect(useWorkspacesStore.getState().importGroups).toEqual([])

    const groups = annotateImportGroups(
      [{ name: 'V1', docUrl: '/a.json' }],
      [{ name: '其他', docUrl: null }],
    )
    useWorkspacesStore.getState().importDiscovered(groups, [0])
    expect(useWorkspacesStore.getState().importStep).toBe('groups')
    expect(useWorkspacesStore.getState().importChecked).toEqual([0])
  })

  it('导入向导：勾选切换增删且保持升序', () => {
    const groups = annotateImportGroups(
      [
        { name: 'A', docUrl: '/a.json' },
        { name: 'B', docUrl: '/b.json' },
        { name: 'C', docUrl: '/c.json' },
      ],
      [],
    )
    const store = useWorkspacesStore.getState()
    store.importDiscovered(groups, defaultCheckedIndexes(groups))
    expect(useWorkspacesStore.getState().importChecked).toEqual([0, 1, 2])

    store.toggleImportChecked(1)
    expect(useWorkspacesStore.getState().importChecked).toEqual([0, 2])
    store.toggleImportChecked(1)
    expect(useWorkspacesStore.getState().importChecked).toEqual([0, 1, 2])
  })

  it('导入向导：批量置勾选集一次到位（全选传全集 / 清空传空数组两用）', () => {
    const groups = annotateImportGroups(
      [
        { name: 'A', docUrl: '/a.json' },
        { name: 'B', docUrl: '/b.json' },
        { name: 'C', docUrl: '/c.json' },
      ],
      [],
    )
    useWorkspacesStore.getState().importDiscovered(groups, [])
    // 全选：乱序传入也归一为升序不变式
    useWorkspacesStore.getState().setImportChecked(defaultCheckedIndexes(groups).reverse())
    expect(useWorkspacesStore.getState().importChecked).toEqual([0, 1, 2])
    // 清空
    useWorkspacesStore.getState().setImportChecked([])
    expect(useWorkspacesStore.getState().importChecked).toEqual([])
  })

  it('导入向导：失败退回输入步清空分组（地址保留）', () => {
    const groups = annotateImportGroups([{ name: 'A', docUrl: '/a.json' }], [])
    useWorkspacesStore.getState().importDiscovered(groups, [0])
    useWorkspacesStore.getState().backToImportEntry()
    expect(useWorkspacesStore.getState().importStep).toBe('entry')
    expect(useWorkspacesStore.getState().importGroups).toEqual([])
    expect(useWorkspacesStore.getState().importChecked).toEqual([])
  })

  it('关闭对话框整体重置向导残留', () => {
    const groups = annotateImportGroups([{ name: 'A', docUrl: '/a.json' }], [])
    useWorkspacesStore.getState().beginImport('w1')
    useWorkspacesStore.getState().setImportEntryUrl('/swagger')
    useWorkspacesStore.getState().importDiscovered(groups, [0])
    useWorkspacesStore.getState().closeDialog()
    const state = useWorkspacesStore.getState()
    expect(state.dialog).toBeNull()
    expect(state.importStep).toBe('entry')
    expect(state.importEntryUrl).toBe('')
    expect(state.importGroups).toEqual([])
    expect(state.importChecked).toEqual([])
  })

  it('树会话态：选中行与展开集独立更新、可置空', () => {
    useWorkspacesStore.getState().setTreeSelectedWorkspace('w1')
    useWorkspacesStore.getState().setTreeExpandedIds(['w1', 'w2'])
    expect(useWorkspacesStore.getState().treeSelectedWorkspaceId).toBe('w1')
    expect(useWorkspacesStore.getState().treeExpandedIds).toEqual(['w1', 'w2'])
    useWorkspacesStore.getState().setTreeSelectedWorkspace(null)
    expect(useWorkspacesStore.getState().treeSelectedWorkspaceId).toBeNull()
  })

  it('对话框携带目标工作空间（服务新建与导入随树行空间）', () => {
    useWorkspacesStore.getState().openDialog({ type: 'service-new', workspaceId: 'w2' })
    expect(useWorkspacesStore.getState().dialog).toEqual({ type: 'service-new', workspaceId: 'w2' })
    useWorkspacesStore.getState().closeDialog()
    useWorkspacesStore.getState().beginImport('w3')
    expect(useWorkspacesStore.getState().dialog).toEqual({ type: 'import', workspaceId: 'w3' })
  })
})
