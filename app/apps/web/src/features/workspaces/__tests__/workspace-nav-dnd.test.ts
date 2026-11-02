import { describe, expect, it } from 'vitest'

import { computeNavDrop, type WorkspaceNavIndex, type WorkspaceNavNode } from '../workspace-nav-dnd'

/**
 * 两级导航树拖拽落点判定测试：工作空间根层 before/after（整批有序 id
 * 表）、服务同空间 before/after（摘除自身后的插入位）、跨空间拒绝、
 * inside 拒绝、未知 id 拒绝、自拖自拒绝。
 */

const ws = (id: string, isCurrent = false): WorkspaceNavNode => ({
  kind: 'workspace',
  id,
  name: id,
  isCurrent,
})
const svc = (id: string, workspaceId: string): WorkspaceNavNode => ({
  kind: 'service',
  id,
  workspaceId,
  name: id,
  docUrl: null,
})

/** 根层 [w1, w2, w3]；w1 服务 [s1, s2]；w2 服务 [s9] */
const index: WorkspaceNavIndex = {
  nodes: new Map([
    ['w1', ws('w1')],
    ['w2', ws('w2')],
    ['w3', ws('w3', true)],
    ['s1', svc('s1', 'w1')],
    ['s2', svc('s2', 'w1')],
    ['s9', svc('s9', 'w2')],
  ]),
  rootChildren: ['w1', 'w2', 'w3'],
  childrenOf: new Map([
    ['w1', ['s1', 's2']],
    ['w2', ['s9']],
  ]),
}

describe('computeNavDrop：工作空间行', () => {
  it('拖到目标前＝整批有序 id 表（摘自身后插到目标位）', () => {
    const result = computeNavDrop(ws('w2'), ws('w1'), 0.3, index)
    expect(result).toEqual({
      indicator: 'before',
      action: { kind: 'workspace', orderedIds: ['w2', 'w1', 'w3'] },
    })
  })

  it('拖到目标后＝插到目标位之后', () => {
    const result = computeNavDrop(ws('w1'), ws('w2'), 0.7, index)
    expect(result).toEqual({
      indicator: 'after',
      action: { kind: 'workspace', orderedIds: ['w2', 'w1', 'w3'] },
    })
  })

  it('拖到末位工作空间之后＝整批表收尾', () => {
    const result = computeNavDrop(ws('w1'), ws('w3'), 0.7, index)
    expect(result?.action).toEqual({ kind: 'workspace', orderedIds: ['w2', 'w3', 'w1'] })
  })

  it('中段悬停折算上下半分，绝无 inside', () => {
    expect(computeNavDrop(ws('w2'), ws('w1'), 0.49, index)?.indicator).toBe('before')
    expect(computeNavDrop(ws('w2'), ws('w1'), 0.5, index)?.indicator).toBe('after')
  })

  it('拖到服务行拒绝（跨层级无容器落点）', () => {
    expect(computeNavDrop(ws('w1'), svc('s1', 'w1'), 0.5, index)).toBeNull()
  })

  it('未知目标 id 拒绝', () => {
    expect(computeNavDrop(ws('w1'), ws('ghost'), 0.3, index)).toBeNull()
  })

  it('未知源 id（占位行）拒绝', () => {
    expect(computeNavDrop(ws('ghost'), ws('w1'), 0.3, index)).toBeNull()
  })

  it('自身拖到自身拒绝', () => {
    expect(computeNavDrop(ws('w1'), ws('w1'), 0.5, index)).toBeNull()
  })
})

describe('computeNavDrop：服务行', () => {
  it('同空间 before＝摘除自身后的插入位', () => {
    // w1 服务序 [s1, s2]：s2 拖到 s1 前 → 摘除 s2 后 [s1]，before(s1)=0
    const result = computeNavDrop(svc('s2', 'w1'), svc('s1', 'w1'), 0.3, index)
    expect(result).toEqual({
      indicator: 'before',
      action: { kind: 'service', id: 's2', index: 0 },
    })
  })

  it('同空间 after＝插入位＋1', () => {
    // s1 拖到 s2 后 → 摘除 s1 后 [s2]，after(s2)=1
    const result = computeNavDrop(svc('s1', 'w1'), svc('s2', 'w1'), 0.7, index)
    expect(result).toEqual({
      indicator: 'after',
      action: { kind: 'service', id: 's1', index: 1 },
    })
  })

  it('跨空间服务行拒绝', () => {
    expect(computeNavDrop(svc('s1', 'w1'), svc('s9', 'w2'), 0.5, index)).toBeNull()
  })

  it('服务拖到工作空间行拒绝（含自身所属空间行）', () => {
    expect(computeNavDrop(svc('s1', 'w1'), ws('w2'), 0.5, index)).toBeNull()
    expect(computeNavDrop(svc('s1', 'w1'), ws('w1'), 0.5, index)).toBeNull()
  })

  it('未知服务目标 id 拒绝', () => {
    expect(computeNavDrop(svc('s1', 'w1'), svc('ghost', 'w1'), 0.3, index)).toBeNull()
  })

  it('源 id 不在所属空间服务序（占位行 / 陈旧数据）拒绝', () => {
    expect(computeNavDrop(svc('ghost', 'w1'), svc('s1', 'w1'), 0.3, index)).toBeNull()
  })

  it('自身拖到自身拒绝', () => {
    expect(computeNavDrop(svc('s1', 'w1'), svc('s1', 'w1'), 0.5, index)).toBeNull()
  })
})
