import { beforeEach, describe, expect, it } from 'vitest'

import { probeStatusOf, useProbeStore } from '../probe.store'

/**
 * 可达性探测状态面：reducer（事件回流 / 快照播种）、「缺 record＝未知」
 * 归一与可达宣告标记（reachShown）生命周期。ensureProbeInit 的 IPC / 事件
 * 通道不在测试环境触发（环境守卫静默）。
 */

describe('可达性探测状态面', () => {
  beforeEach(() => {
    useProbeStore.setState({ statuses: {}, reachShown: {} })
  })

  it('缺 record 的服务归一为「未知」', () => {
    expect(probeStatusOf({}, 's1')).toBe('unknown')
    expect(probeStatusOf({ s1: 'reachable' }, 's2')).toBe('unknown')
  })

  it('事件回流更新对应服务（四态均可流转）', () => {
    const { applyEvent } = useProbeStore.getState()
    applyEvent({ serviceId: 's1', status: 'probing' })
    applyEvent({ serviceId: 's1', status: 'reachable', checkedAt: '2026-10-05T00:00:00Z' })
    applyEvent({ serviceId: 's2', status: 'unreachable' })
    const { statuses } = useProbeStore.getState()
    expect(statuses).toEqual({ s1: 'reachable', s2: 'unreachable' })
  })

  it('快照播种整体替换（不残留上轮状态与宣告标记）', () => {
    useProbeStore.getState().applyEvent({ serviceId: 'old', status: 'reachable' })
    useProbeStore.getState().markReachShown('old')
    useProbeStore.getState().seedSnapshot([
      { serviceId: 'a', status: 'unreachable' },
      { serviceId: 'b', status: 'unknown' },
    ])
    expect(useProbeStore.getState().statuses).toEqual({ a: 'unreachable', b: 'unknown' })
    expect(useProbeStore.getState().reachShown).toEqual({})
  })

  it('可达宣告标记：标记后离开可达的事件清除（新一轮探测重新宣告），可达事件不清', () => {
    const { applyEvent, markReachShown } = useProbeStore.getState()
    applyEvent({ serviceId: 's1', status: 'reachable' })
    markReachShown('s1')
    expect(useProbeStore.getState().reachShown).toEqual({ s1: true })
    // 可达事件重复回流：宣告已消费，不清标记（徽标不重现）
    applyEvent({ serviceId: 's1', status: 'reachable', checkedAt: '2026-10-05T00:00:00Z' })
    expect(useProbeStore.getState().reachShown).toEqual({ s1: true })
    // 新一轮探测（probing 在前）：清标记，探测结果需重新宣告
    applyEvent({ serviceId: 's1', status: 'probing' })
    expect(useProbeStore.getState().reachShown).toEqual({})
    applyEvent({ serviceId: 's1', status: 'reachable' })
    expect(useProbeStore.getState().reachShown).toEqual({})
    expect(useProbeStore.getState().statuses.s1).toBe('reachable')
  })
})
