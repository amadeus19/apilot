import { beforeEach, describe, expect, it } from 'vitest'

import { useDraftStore, type EndpointDraftData } from '../draft.store'
import { useTabsStore } from '@/stores/tabs.store'

function makeData(overrides?: Partial<EndpointDraftData>): EndpointDraftData {
  return {
    method: 'GET',
    pathTemplate: '/users',
    paramsJson: '[{"name":"id","value":"42"}]',
    headersJson: '[{"name":"authorization","value":"Bearer t"}]',
    body: null,
    bodyTruncated: false,
    sensitiveHeaderNames: ['x-custom-key'],
    sourceServiceId: 's1',
    ...overrides,
  }
}

/** 草稿 Tab 全链路（openDraft → seed） */
function seedDraftTab(title = 'GET /users'): string {
  const id = useTabsStore.getState().openDraft(title)
  useDraftStore.getState().seedDraft(id, makeData())
  return id
}

beforeEach(() => {
  useTabsStore.setState({ tabs: [], activeTabId: null, editorTabs: {} })
  useDraftStore.setState({ drafts: {} })
})

describe('draft store：内存草稿态（无持久化）', () => {
  it('seed / update：按草稿 Tab id 存取与整包替换', () => {
    const id = seedDraftTab()
    expect(useDraftStore.getState().drafts[id]).toEqual(makeData())

    useDraftStore.getState().updateDraft(id, makeData({ pathTemplate: '/orders' }))
    expect(useDraftStore.getState().drafts[id]?.pathTemplate).toBe('/orders')
    // 整包替换语义：其余字段不丢
    expect(useDraftStore.getState().drafts[id]?.method).toBe('GET')
  })

  it('update 不认识的键为幂等（不新增孤儿条目）', () => {
    useDraftStore.getState().updateDraft('ghost', makeData())
    expect(useDraftStore.getState().drafts).toEqual({})
  })

  it('多份草稿并存（每次恢复独立 Tab 与草稿条目）', () => {
    const a = seedDraftTab('GET /a')
    const b = seedDraftTab('POST /b')
    expect(Object.keys(useDraftStore.getState().drafts)).toHaveLength(2)
    expect(useTabsStore.getState().activeTabId).toBe(b)
    expect(a).not.toBe(b)
  })
})

describe('draft store：生命周期（tabs 收缩信号统一清理）', () => {
  it('关闭草稿 Tab：条目随之丢弃（未转正关闭即弃）', () => {
    const id = seedDraftTab()
    useTabsStore.getState().close(id)
    expect(useDraftStore.getState().drafts).toEqual({})
  })

  it('closeOthers / closeToRight / closeAll 波及草稿 Tab：同样清理', () => {
    useTabsStore
      .getState()
      .openEndpoint({ serviceId: 's1', key: 'k1', title: '接口A' }, 'persistent')
    seedDraftTab()
    useTabsStore
      .getState()
      .closeOthers(useTabsStore.getState().tabs.find((tab) => tab.kind === 'endpoint')!.id)
    expect(useDraftStore.getState().drafts).toEqual({})

    seedDraftTab('POST /b')
    useTabsStore.getState().closeAll()
    expect(useDraftStore.getState().drafts).toEqual({})
  })

  it('会话恢复整体替换：草稿条目全部丢弃（瞬态不还原）', () => {
    seedDraftTab()
    seedDraftTab('POST /b')
    useTabsStore.getState().restore({
      tabs: [{ kind: 'endpoint', title: '接口A', serviceId: 's1', key: 'k1', preview: false }],
    })
    expect(useDraftStore.getState().drafts).toEqual({})
    // 恢复后只剩实体 Tab
    expect(useTabsStore.getState().tabs.map((tab) => tab.kind)).toEqual(['endpoint'])
  })

  it('切工作空间（restore 空会话）：草稿丢弃', () => {
    seedDraftTab()
    useTabsStore.getState().restore({ tabs: [] })
    expect(useDraftStore.getState().drafts).toEqual({})
  })
})
