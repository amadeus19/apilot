import { beforeEach, describe, expect, it } from 'vitest'

import { useTabsStore } from '@/stores/tabs.store'

import { resolveBaseUrlOverride, useVariableStore } from '../variable.store'

/**
 * 变量域 UI 会话状态测试：树展开 / 选中行、接口级 BaseUrl 覆写表、会话级
 * BaseUrl 档。覆写表生命周期（资源四问的落点）：关 Tab（tabs 集合收缩
 * 信号）同步清理，不随 Tab 开关累积；会话档不随 Tab 生命周期（所有 Tab
 * 生效、退出即清）。
 */

beforeEach(() => {
  useTabsStore.setState({ tabs: [], activeTabId: null })
  useVariableStore.setState({
    treeExpandedIds: [],
    treeSelectedNodeId: null,
    baseUrlOverrides: {},
    sessionBaseUrl: null,
  })
})

describe('variable store：树展开与选中行', () => {
  it('展开集替换式更新；选中行可设置与清空', () => {
    const store = useVariableStore.getState()
    store.setTreeExpandedIds(['vc1', 'vc2'])
    expect(useVariableStore.getState().treeExpandedIds).toEqual(['vc1', 'vc2'])
    useVariableStore.getState().setTreeSelectedNodeId('vc1')
    expect(useVariableStore.getState().treeSelectedNodeId).toBe('vc1')
    useVariableStore.getState().setTreeSelectedNodeId(null)
    expect(useVariableStore.getState().treeSelectedNodeId).toBeNull()
  })
})

describe('variable store：接口级 BaseUrl 覆写表', () => {
  it('设置覆写与清除覆写（null＝跟随工作空间）', () => {
    const store = useVariableStore.getState()
    store.setBaseUrlOverride('tab-1', 'http://override:8000')
    expect(useVariableStore.getState().baseUrlOverrides['tab-1']).toBe('http://override:8000')
    // 覆盖旧值（同 Tab 换目标）
    useVariableStore.getState().setBaseUrlOverride('tab-1', 'http://other:9000')
    expect(useVariableStore.getState().baseUrlOverrides['tab-1']).toBe('http://other:9000')
    useVariableStore.getState().setBaseUrlOverride('tab-1', null)
    expect(useVariableStore.getState().baseUrlOverrides['tab-1']).toBeUndefined()
  })

  it('关 Tab（tabs 集合收缩）同步摘除该 Tab 的覆写条目（有界）', () => {
    useTabsStore
      .getState()
      .openEndpoint({ serviceId: 's1', key: 'k1', title: '接口A' }, 'persistent')
    useTabsStore
      .getState()
      .openEndpoint({ serviceId: 's1', key: 'k2', title: '接口B' }, 'persistent')
    const store = useVariableStore.getState()
    store.setBaseUrlOverride('endpoint:s1:k1', 'http://a:1')
    store.setBaseUrlOverride('endpoint:s1:k2', 'http://b:2')

    useTabsStore.getState().close('endpoint:s1:k1')
    const after = useVariableStore.getState().baseUrlOverrides
    expect(after['endpoint:s1:k1']).toBeUndefined()
    expect(after['endpoint:s1:k2']).toBe('http://b:2')
  })

  it('关全部 Tab 清空覆写表', () => {
    useTabsStore
      .getState()
      .openEndpoint({ serviceId: 's1', key: 'k1', title: '接口A' }, 'persistent')
    useVariableStore.getState().setBaseUrlOverride('endpoint:s1:k1', 'http://a:1')
    useTabsStore.getState().closeAll()
    expect(Object.keys(useVariableStore.getState().baseUrlOverrides)).toHaveLength(0)
  })
})

describe('variable store：会话级 BaseUrl 档（地址栏手动会话档通道）', () => {
  it('resolveBaseUrlOverride 优先级：Tab 覆写 > 会话档 > null', () => {
    // 都无：null＝跟随工作空间生效值
    expect(resolveBaseUrlOverride('t1')).toBeNull()
    // 只会话档：所有 Tab 生效（含后开的新 Tab）
    useVariableStore.getState().setSessionBaseUrl('http://session:1')
    expect(resolveBaseUrlOverride('t1')).toBe('http://session:1')
    expect(resolveBaseUrlOverride('t2')).toBe('http://session:1')
    // Tab 覆写压过会话档（仅该 Tab）
    useVariableStore.getState().setBaseUrlOverride('t1', 'http://tab:1')
    expect(resolveBaseUrlOverride('t1')).toBe('http://tab:1')
    expect(resolveBaseUrlOverride('t2')).toBe('http://session:1')
    // 清 Tab 覆写回落会话档；清会话档回落 null
    useVariableStore.getState().setBaseUrlOverride('t1', null)
    expect(resolveBaseUrlOverride('t1')).toBe('http://session:1')
    useVariableStore.getState().setSessionBaseUrl(null)
    expect(resolveBaseUrlOverride('t1')).toBeNull()
  })

  it('会话档不随 Tab 关闭清理（不参与覆写表的有界订阅）', () => {
    useTabsStore
      .getState()
      .openEndpoint({ serviceId: 's1', key: 'k1', title: '接口A' }, 'persistent')
    useVariableStore.getState().setBaseUrlOverride('endpoint:s1:k1', 'http://tab:1')
    useVariableStore.getState().setSessionBaseUrl('http://session:1')
    useTabsStore.getState().close('endpoint:s1:k1')
    expect(useVariableStore.getState().sessionBaseUrl).toBe('http://session:1')
  })
})
