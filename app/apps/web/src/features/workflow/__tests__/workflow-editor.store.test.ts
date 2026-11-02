import { beforeEach, describe, expect, it, vi } from 'vitest'

import { queryClient } from '@/app/query-client'

import { useWorkflowEditorStore } from '../workflow-editor.store'
import type { WorkflowDto } from '../workflow-api'
import type { WorkflowGraph } from '../workflow-model'

// workflow-api 模块桩：IPC 不可直连（测试环境），保存编排是本测试对象
const workflowSave = vi.fn()
vi.mock('../workflow-api', () => ({
  workflowSave: (...args: unknown[]) => workflowSave(...args),
  workflowKeys: {
    list: (workspaceId: string) => ['workflow', 'list', workspaceId],
    load: (id: string) => ['workflow', 'load', id],
  },
}))

function graph(tag: string): WorkflowGraph {
  return {
    schemaVersion: 1,
    nodes: [{ id: 'n1', name: tag, position: { x: 0, y: 0 }, config: { type: 'start' } }],
    edges: [],
  }
}

function dto(id: string, name: string, tag: string): WorkflowDto {
  return {
    id,
    workspaceId: 'w1',
    name,
    graph: graph(tag),
    groupId: null,
    createdAt: '2026-10-24T00:00:00Z',
    updatedAt: '2026-10-24T00:00:00Z',
  }
}

beforeEach(() => {
  useWorkflowEditorStore.setState({ sessions: {} })
  vi.clearAllMocks()
})

describe('workflow editor store：会话生命周期', () => {
  it('seed 播种会话（非脏）；重复 seed 幂等——不覆盖已有编辑', () => {
    const store = useWorkflowEditorStore.getState()
    store.seed(dto('wf1', '登录链', 'first'))
    let session = useWorkflowEditorStore.getState().sessions['wf1']
    expect(session).toMatchObject({ workflowId: 'wf1', name: '登录链', dirty: false })
    expect(session?.graph.nodes[0]?.name).toBe('first')

    // 模拟编辑（脏）后重新加载同 id（Tab 重挂载 / 刷新查询）——保留编辑态
    useWorkflowEditorStore.getState().applyGraph('wf1', graph('edited'))
    expect(useWorkflowEditorStore.getState().sessions['wf1']?.dirty).toBe(true)
    useWorkflowEditorStore.getState().seed(dto('wf1', '登录链', 'second'))
    session = useWorkflowEditorStore.getState().sessions['wf1']
    expect(session?.graph.nodes[0]?.name).toBe('edited')
    expect(session?.dirty).toBe(true)
  })

  it('applyGraph 标脏；saveSession 落库后清脏、失败保持脏态', async () => {
    const store = useWorkflowEditorStore.getState()
    store.seed(dto('wf1', '链', 'base'))
    store.applyGraph('wf1', graph('changed'))
    expect(useWorkflowEditorStore.getState().sessions['wf1']?.dirty).toBe(true)

    workflowSave.mockResolvedValueOnce(undefined)
    await expect(useWorkflowEditorStore.getState().saveSession('wf1')).resolves.toBe(true)
    expect(workflowSave).toHaveBeenCalledWith('wf1', graph('changed'))
    expect(useWorkflowEditorStore.getState().sessions['wf1']?.dirty).toBe(false)

    // 再编辑后保存失败：脏态保留（用户可重试），返回 false 供调用方拦截
    // 依赖落库态的后续动作（如运行）
    useWorkflowEditorStore.getState().applyGraph('wf1', graph('again'))
    workflowSave.mockRejectedValueOnce(new Error('ipc down'))
    await expect(useWorkflowEditorStore.getState().saveSession('wf1')).resolves.toBe(false)
    expect(useWorkflowEditorStore.getState().sessions['wf1']?.dirty).toBe(true)
  })

  it('无会话保存视为无需保存（返回 true）', async () => {
    await expect(useWorkflowEditorStore.getState().saveSession('absent')).resolves.toBe(true)
    expect(workflowSave).not.toHaveBeenCalled()
  })

  it('保存期间的增量编辑不被吞：清脏仅以被保存的图为准', async () => {
    useWorkflowEditorStore.getState().seed(dto('wf1', '链', 'base'))
    useWorkflowEditorStore.getState().applyGraph('wf1', graph('v1'))
    workflowSave.mockImplementationOnce(async () => {
      // IPC 在途时用户继续编辑（applyGraph 生成新图对象）
      useWorkflowEditorStore.getState().applyGraph('wf1', graph('v2'))
    })
    await useWorkflowEditorStore.getState().saveSession('wf1')
    const session = useWorkflowEditorStore.getState().sessions['wf1']
    expect(session?.graph.nodes[0]?.name).toBe('v2')
    expect(session?.dirty, '保存时点之后的编辑必须保持脏态').toBe(true)
  })

  it('保存成功失效该工作流的 load 查询缓存；失败不失效', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined)
    try {
      useWorkflowEditorStore.getState().seed(dto('wf1', '链', 'base'))
      workflowSave.mockResolvedValueOnce(undefined)
      await useWorkflowEditorStore.getState().saveSession('wf1')
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['workflow', 'load', 'wf1'],
      })

      // 保存失败（脏态保留）不得动缓存——重开仍应读到库里最后一致图
      invalidate.mockClear()
      useWorkflowEditorStore.getState().applyGraph('wf1', graph('dirty'))
      workflowSave.mockRejectedValueOnce(new Error('ipc down'))
      await useWorkflowEditorStore.getState().saveSession('wf1')
      expect(invalidate).not.toHaveBeenCalled()
    } finally {
      invalidate.mockRestore()
    }
  })

  it('discard 释放会话；gcSessions 只留存活清单内的会话', () => {
    const store = useWorkflowEditorStore.getState()
    store.seed(dto('wf1', '一', 'a'))
    store.seed(dto('wf2', '二', 'b'))
    store.discard('wf1')
    expect(Object.keys(useWorkflowEditorStore.getState().sessions)).toEqual(['wf2'])

    useWorkflowEditorStore.getState().gcSessions(['wf2'])
    expect(useWorkflowEditorStore.getState().sessions['wf2']).toBeDefined()
    useWorkflowEditorStore.getState().gcSessions([])
    expect(useWorkflowEditorStore.getState().sessions).toEqual({})
  })
})

describe('workflow editor store：撤销 / 重做', () => {
  it('commitGraph 记撤销条目（标脏、清重做栈）；undo 逐步回退、redo LIFO', () => {
    useWorkflowEditorStore.getState().seed(dto('wf1', '链', 'base'))
    const store = useWorkflowEditorStore.getState()
    store.commitGraph('wf1', graph('v1'), 'add')
    expect(store.canUndo('wf1')).toBe(true)
    expect(store.canRedo('wf1')).toBe(false)
    expect(useWorkflowEditorStore.getState().sessions['wf1']?.dirty).toBe(true)

    store.commitGraph('wf1', graph('v2'), 'connect')

    // undo 一步回最近快照（撤销连线）、标脏；栈内仍有 base 可继续回退
    expect(store.undo('wf1')?.nodes[0]?.name).toBe('v1')
    expect(useWorkflowEditorStore.getState().sessions['wf1']?.dirty).toBe(true)
    expect(store.canUndo('wf1')).toBe(true)
    expect(store.canRedo('wf1')).toBe(true)

    expect(store.undo('wf1')?.nodes[0]?.name).toBe('base')
    expect(store.canUndo('wf1')).toBe(false)
    // 重做栈 LIFO：redo 到 v1，undo 回 base 后 redo 重放同一步（v1），
    // 连续 redo 才达 v2——经典双栈语义
    expect(store.redo('wf1')?.nodes[0]?.name).toBe('v1')
    expect(store.undo('wf1')?.nodes[0]?.name).toBe('base')
    expect(store.redo('wf1')?.nodes[0]?.name).toBe('v1')
    expect(store.redo('wf1')?.nodes[0]?.name).toBe('v2')
  })

  it('新编辑清空重做栈（分叉即弃重做）', () => {
    useWorkflowEditorStore.getState().seed(dto('wf1', '链', 'base'))
    const store = useWorkflowEditorStore.getState()
    store.commitGraph('wf1', graph('v1'), 'add')
    store.undo('wf1')
    expect(store.canRedo('wf1')).toBe(true)
    store.commitGraph('wf1', graph('branched'), 'add')
    expect(store.canRedo('wf1')).toBe(false)
  })

  it('合并窗：显式合并通道（同 label 连续）折算一条，结构操作独立成条', () => {
    useWorkflowEditorStore.getState().seed(dto('wf1', '链', 'base'))
    const store = useWorkflowEditorStore.getState()
    // 同节点连续配置编辑（节点内逐键通道，coalesce=true）→ 一条
    store.commitGraph('wf1', graph('key1'), 'config:n1', true)
    store.commitGraph('wf1', graph('key2'), 'config:n1', true)
    store.commitGraph('wf1', graph('key3'), 'config:n1', true)
    expect(useWorkflowEditorStore.getState().sessions['wf1']?.past).toHaveLength(1)
    // 结构操作（连线）→ 新条目
    store.commitGraph('wf1', graph('connected'), 'connect')
    expect(useWorkflowEditorStore.getState().sessions['wf1']?.past).toHaveLength(2)
    // 同 label 但未声明合并（结构操作）→ 独立成条
    store.commitGraph('wf1', graph('del1'), 'delete')
    store.commitGraph('wf1', graph('del2'), 'delete')
    expect(useWorkflowEditorStore.getState().sessions['wf1']?.past).toHaveLength(4)

    // 逐步回退（每个提交都是独立可回退状态）：
    // del2 → del1 → connected → key3（合并后的配置态）→ base（播种态）
    expect(store.undo('wf1')?.nodes[0]?.name).toBe('del1')
    expect(store.undo('wf1')?.nodes[0]?.name).toBe('connected')
    expect(store.undo('wf1')?.nodes[0]?.name).toBe('key3')
    expect(store.undo('wf1')?.nodes[0]?.name).toBe('base')
    expect(store.undo('wf1')).toBeNull()
  })

  it('撤销栈有界：超上限丢最旧', () => {
    useWorkflowEditorStore.getState().seed(dto('wf1', '链', 'base'))
    const store = useWorkflowEditorStore.getState()
    for (let i = 0; i < 105; i++) {
      store.commitGraph('wf1', graph(`v${i}`), `label-${i}`)
    }
    const past = useWorkflowEditorStore.getState().sessions['wf1']?.past ?? []
    expect(past).toHaveLength(100)
    // 105 条快照挤出最旧 5 条（base 与 v0..v3），栈底是 v4
    expect(past[0]?.nodes[0]?.name).toBe('v4')
  })

  it('拖动收口：commitSnapshot 补记撤销；位置未变不记、不脏', () => {
    useWorkflowEditorStore.getState().seed(dto('wf1', '链', 'base'))
    const store = useWorkflowEditorStore.getState()
    const base = useWorkflowEditorStore.getState().sessions['wf1']?.graph

    // 拖动过程（applyGraph 连续通道）后收口：一条撤销、标脏
    store.applyGraph('wf1', graph('moved'))
    store.commitSnapshot('wf1', base!)
    expect(useWorkflowEditorStore.getState().sessions['wf1']?.past).toHaveLength(1)
    expect(useWorkflowEditorStore.getState().sessions['wf1']?.dirty).toBe(true)

    // 回原位（graph === snapshot）不记
    store.undo('wf1')
    const snapshot = useWorkflowEditorStore.getState().sessions['wf1']?.graph
    store.applyGraph('wf1', graph('moved-again'))
    store.applyGraph('wf1', snapshot!)
    store.commitSnapshot('wf1', snapshot!)
    expect(useWorkflowEditorStore.getState().sessions['wf1']?.past).toHaveLength(0)
  })

  it('拖动收口去重只认快照引用：独立拖动紧邻各成一条，同快照重复收口合并', () => {
    useWorkflowEditorStore.getState().seed(dto('wf1', '链', 'base'))
    const store = useWorkflowEditorStore.getState()
    const base = useWorkflowEditorStore.getState().sessions['wf1']?.graph

    // 第一次拖动：拖前快照 base 推栈
    store.applyGraph('wf1', graph('moved-a'))
    store.commitSnapshot('wf1', base!)
    // 第二次独立拖动紧随其后（快照不同）：必须各成一条——undo 一步只
    // 回退一步，不吞用户步骤
    const afterFirst = useWorkflowEditorStore.getState().sessions['wf1']?.graph
    store.applyGraph('wf1', graph('moved-b'))
    store.commitSnapshot('wf1', afterFirst!)
    expect(useWorkflowEditorStore.getState().sessions['wf1']?.past).toHaveLength(2)

    // 同一快照引用的重复收口（一次手势对多节点各发一次 dragStop）不重复推栈
    store.applyGraph('wf1', graph('moved-c'))
    store.commitSnapshot('wf1', afterFirst!)
    expect(useWorkflowEditorStore.getState().sessions['wf1']?.past).toHaveLength(2)

    // 逐步回退：moved-b → moved-a → base
    expect(store.undo('wf1')?.nodes[0]?.name).toBe('moved-a')
    expect(store.undo('wf1')?.nodes[0]?.name).toBe('base')
    expect(store.undo('wf1')).toBeNull()
  })

  it('节点改名走 config 合并窗：与后续同节点配置编辑折算一条，撤销一次恢复原名', () => {
    useWorkflowEditorStore.getState().seed(dto('wf1', '链', 'base'))
    const store = useWorkflowEditorStore.getState()
    // 节点标题条改名与随后的同节点配置编辑同走 `config:n1` 合并窗
    // （coalesce=true、同 label）——两个动作只记一条撤销
    store.commitGraph('wf1', graph('renamed'), 'config:n1', true)
    store.commitGraph('wf1', graph('recfg'), 'config:n1', true)
    expect(useWorkflowEditorStore.getState().sessions['wf1']?.past).toHaveLength(1)

    // 一次撤销同时回到改名前：改名与撤销链一致（不残留改名痕迹）
    expect(store.undo('wf1')?.nodes[0]?.name).toBe('base')
    // 重做重放改名后的态
    expect(store.redo('wf1')?.nodes[0]?.name).toBe('recfg')
  })

  it('保存不清撤销栈：撤销已保存编辑重新标脏', async () => {
    useWorkflowEditorStore.getState().seed(dto('wf1', '链', 'base'))
    const store = useWorkflowEditorStore.getState()
    store.commitGraph('wf1', graph('saved-edit'), 'add')
    workflowSave.mockResolvedValueOnce(undefined)
    await useWorkflowEditorStore.getState().saveSession('wf1')
    expect(useWorkflowEditorStore.getState().sessions['wf1']?.dirty).toBe(false)

    expect(store.undo('wf1')?.nodes[0]?.name).toBe('base')
    expect(useWorkflowEditorStore.getState().sessions['wf1']?.dirty).toBe(true)
    expect(store.redo('wf1')?.nodes[0]?.name).toBe('saved-edit')
  })
})
