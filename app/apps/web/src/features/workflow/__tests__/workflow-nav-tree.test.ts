import { describe, expect, it } from 'vitest'

import type { WorkflowGroupDto, WorkflowSummaryDto } from '../workflow-api'
import { buildWorkflowNavIndex } from '../workflow-nav-tree'

function group(id: string, name: string, createdAt: string): WorkflowGroupDto {
  return { id, name, createdAt }
}

function item(id: string, name: string, groupId: string | null): WorkflowSummaryDto {
  return {
    id,
    name,
    groupId,
    lastStatus: null,
    hasWriteback: false,
    updatedAt: '2026-10-24T00:00:00Z',
  }
}

describe('buildWorkflowNavIndex：第五视图分组树归约', () => {
  it('分组按创建序在前（repo 保序返回），未分组工作流尾置；组内行按清单序', () => {
    const index = buildWorkflowNavIndex(
      [
        item('wf1', '登录链', 'g2'),
        item('wf2', '冒烟', null),
        item('wf3', '下单链', 'g1'),
        item('wf4', '回归', 'g2'),
      ],
      [group('g2', '登录', 't0'), group('g1', '核心', 't1')],
      '',
    )
    expect(index.rootChildren).toEqual(['g2', 'g1', 'wf2'])
    expect(index.groupChildren.get('g2')).toEqual(['wf1', 'wf4'])
    expect(index.groupChildren.get('g1')).toEqual(['wf3'])
    expect(index.nodes.get('g1')).toEqual({ kind: 'group', id: 'g1', name: '核心' })
    expect(index.nodes.get('wf1')).toEqual({ kind: 'workflow', id: 'wf1', name: '登录链' })
  })

  it('搜索过滤工作流；命中空的组整组隐去（不出空组壳）', () => {
    const index = buildWorkflowNavIndex(
      [item('wf1', '登录链', 'g1'), item('wf2', '冒烟', 'g1'), item('wf3', '下单', 'g2')],
      [group('g1', '核心', 't1'), group('g2', '次要', 't0')],
      '登录',
    )
    expect(index.rootChildren).toEqual(['g1'])
    expect(index.groupChildren.get('g1')).toEqual(['wf1'])
    expect(index.nodes.has('g2')).toBe(false)
    expect(index.nodes.has('wf3')).toBe(false)
  })

  it('非搜索期空分组照常显示（分组先建、后放流的路径）', () => {
    const index = buildWorkflowNavIndex(
      [item('wf1', '登录链', null)],
      [group('g1', '空组', 't0')],
      '',
    )
    expect(index.rootChildren).toEqual(['g1', 'wf1'])
    expect(index.groupChildren.get('g1')).toEqual([])
  })

  it('groupId 指向不存在的分组（数据刷新过渡态）按未分组归位，不丢行', () => {
    const index = buildWorkflowNavIndex(
      [item('wf1', '登录链', 'g-gone')],
      [group('g1', '核心', 't0')],
      '',
    )
    expect(index.rootChildren).toEqual(['g1', 'wf1'])
    expect(index.nodes.get('wf1')).toBeDefined()
  })

  it('搜索词首尾空白不参与匹配（与全应用搜索口径一致）', () => {
    const index = buildWorkflowNavIndex([item('wf1', '登录链', null)], [], '  登录  ')
    expect(index.rootChildren).toEqual(['wf1'])
  })
})
