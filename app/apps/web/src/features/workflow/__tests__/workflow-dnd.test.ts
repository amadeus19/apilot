import { describe, expect, it } from 'vitest'

import { computeWorkflowTreeDrop, groupMoveNeighbors, workflowMoveNeighbors } from '../workflow-dnd'
import type { WorkflowNavIndex, WorkflowNavNode } from '../workflow-nav-tree'

/**
 * 工作流树拖拽落点判定：工作流→分组行恒为移入组尾、→工作流行按上下半分
 * 插入（桶随目标行，含跨组与未分组）；分组→分组行为组间序列重排；分组不
 * 落工作流行、自身不可落。序号基线＝排除被拖项后的桶现序。
 */

function makeIndex(): WorkflowNavIndex {
  const node = (id: string, name: string): WorkflowNavNode => ({
    kind: id.startsWith('g') ? 'group' : 'workflow',
    id,
    name,
  })
  const entries: [string, string][] = [
    ['g1', '甲'],
    ['g2', '乙'],
    ['w1', '一'],
    ['w2', '二'],
    ['w3', '三'],
    ['w4', '四'],
  ]
  return {
    nodes: new Map(entries.map(([id, name]) => [id, node(id, name)])),
    rootChildren: ['g1', 'g2', 'w4'],
    groupChildren: new Map([
      ['g1', ['w1', 'w2']],
      ['g2', ['w3']],
    ]),
  }
}

const workflow = (id: string): WorkflowNavNode => ({ kind: 'workflow', id, name: id })
const group = (id: string): WorkflowNavNode => ({ kind: 'group', id, name: id })

describe('computeWorkflowTreeDrop：工作流落点', () => {
  it('拖到分组行：整行视为进入，action 为移入该组尾部', () => {
    const result = computeWorkflowTreeDrop(workflow('w1'), group('g2'), 0.5, makeIndex())
    expect(result).toEqual({
      indicator: 'inside',
      action: { kind: 'workflow', id: 'w1', groupId: 'g2', index: 1 },
    })
  })

  it('拖到同组工作流行：排除自身后的插入位（下半行＝目标后一位）', () => {
    const index = makeIndex()
    const before = computeWorkflowTreeDrop(workflow('w2'), workflow('w1'), 0.3, index)
    expect(before).toEqual({
      indicator: 'before',
      action: { kind: 'workflow', id: 'w2', groupId: 'g1', index: 0 },
    })
    const after = computeWorkflowTreeDrop(workflow('w2'), workflow('w1'), 0.7, index)
    expect(after).toEqual({
      indicator: 'after',
      action: { kind: 'workflow', id: 'w2', groupId: 'g1', index: 1 },
    })
  })

  it('拖到其他组的工作流行：桶随目标行（跨组移动）', () => {
    const result = computeWorkflowTreeDrop(workflow('w1'), workflow('w3'), 0.7, makeIndex())
    expect(result).toEqual({
      indicator: 'after',
      action: { kind: 'workflow', id: 'w1', groupId: 'g2', index: 1 },
    })
  })

  it('拖到未分组工作流行：groupId 为 null（未分组桶）', () => {
    const result = computeWorkflowTreeDrop(workflow('w1'), workflow('w4'), 0.3, makeIndex())
    expect(result).toEqual({
      indicator: 'before',
      action: { kind: 'workflow', id: 'w1', groupId: null, index: 0 },
    })
  })

  it('自身不可落', () => {
    expect(computeWorkflowTreeDrop(workflow('w1'), workflow('w1'), 0.5, makeIndex())).toBeNull()
  })
})

describe('computeWorkflowTreeDrop：分组落点', () => {
  it('拖到其他分组行：组间序列重排（排除自身后的插入位）', () => {
    const index = makeIndex()
    const before = computeWorkflowTreeDrop(group('g2'), group('g1'), 0.3, index)
    expect(before).toEqual({ indicator: 'before', action: { kind: 'group', id: 'g2', index: 0 } })
    const after = computeWorkflowTreeDrop(group('g1'), group('g2'), 0.7, index)
    expect(after).toEqual({ indicator: 'after', action: { kind: 'group', id: 'g1', index: 1 } })
  })

  it('分组不可落工作流行（不嵌套）', () => {
    expect(computeWorkflowTreeDrop(group('g1'), workflow('w1'), 0.5, makeIndex())).toBeNull()
  })
})

describe('workflowMoveNeighbors / groupMoveNeighbors：上移下移落点', () => {
  it('工作流行：桶内相邻位，两端不可移', () => {
    const index = makeIndex()
    expect(workflowMoveNeighbors(index, 'w1')).toEqual({ bucket: 'g1', up: null, down: 1 })
    expect(workflowMoveNeighbors(index, 'w2')).toEqual({ bucket: 'g1', up: 0, down: null })
    // 单行桶：两个方向都不可移
    expect(workflowMoveNeighbors(index, 'w3')).toEqual({ bucket: 'g2', up: null, down: null })
    // 未分组桶：只含未分组工作流段（根子级里的分组行不参与）
    expect(workflowMoveNeighbors(index, 'w4')).toEqual({ bucket: null, up: null, down: null })
  })

  it('分组行：分组序列相邻位，两端不可移', () => {
    const index = makeIndex()
    expect(groupMoveNeighbors(index, 'g1')).toEqual({ up: null, down: 1 })
    expect(groupMoveNeighbors(index, 'g2')).toEqual({ up: 0, down: null })
  })
})
