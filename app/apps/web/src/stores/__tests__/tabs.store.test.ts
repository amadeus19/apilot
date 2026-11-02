import { beforeEach, describe, expect, it } from 'vitest'

import { makeEndpointNodeId } from '@/lib/tree-identity'
import {
  selectActiveTab,
  useTabsStore,
  HISTORY_DETAIL_TAB_ID,
  VARIABLES_TAB_ID_PREFIX,
  WORKFLOW_TAB_ID_PREFIX,
  WORKSPACE_SETTINGS_TAB_ID,
} from '../tabs.store'

const EP_A = { serviceId: 's1', key: 'k1', title: '接口A' }
const EP_B = { serviceId: 's1', key: 'k2', title: '接口B' }
const EP_C = { serviceId: 's2', key: 'k1', title: '接口C' }

/** 工作空间详情打开参数（内容指针＝workspaceId，标题＝空间名） */
const WS_A = { workspaceId: 'w1', name: '空间一' }
const WS_B = { workspaceId: 'w2', name: '空间二' }

beforeEach(() => {
  useTabsStore.setState({ tabs: [], activeTabId: null })
})

describe('tabs store：openTab 单实例契约与预览态', () => {
  it('单击来源（preview）：无既有 Tab 时新增预览 Tab 并激活', () => {
    useTabsStore.getState().openEndpoint(EP_A, 'preview')
    const state = useTabsStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]).toMatchObject({ id: makeEndpointNodeId('s1', 'k1'), preview: true })
    expect(state.activeTabId).toBe(makeEndpointNodeId('s1', 'k1'))
  })

  it('单击复用全局唯一预览槽位：原位换内容，不新增 Tab；换出旧 id 的页签记忆同步裁剪', () => {
    useTabsStore.getState().openEndpoint(EP_A, 'preview')
    const idA = makeEndpointNodeId('s1', 'k1')
    useTabsStore.getState().setEditorTab(idA, 'body')
    useTabsStore.getState().openEndpoint(EP_B, 'preview')
    const state = useTabsStore.getState()
    expect(state.tabs).toHaveLength(1) /* 预览槽位被复用 */
    expect(state.tabs[0]).toMatchObject({ id: makeEndpointNodeId('s1', 'k2'), preview: true })
    expect(state.activeTabId).toBe(makeEndpointNodeId('s1', 'k2'))
    /* 被换出的旧 id 不再存活：页签记忆不留永久条目（有界） */
    expect(state.editorTabs[idA]).toBeUndefined()
  })

  it('同身份已开：仅激活不重开（常驻 Tab 不受单击影响，预览标记不动）', () => {
    useTabsStore.getState().openEndpoint(EP_A, 'persistent')
    useTabsStore.getState().openEndpoint(EP_B, 'persistent')
    useTabsStore.getState().openEndpoint(EP_A, 'preview')
    const state = useTabsStore.getState()
    expect(state.tabs).toHaveLength(2)
    expect(state.tabs[0]?.preview).toBe(false) /* 常驻 Tab 不被单击转成预览 */
    expect(state.activeTabId).toBe(makeEndpointNodeId('s1', 'k1'))
  })

  it('双击 / Enter 来源（persistent）：目标在预览中则原地转正', () => {
    useTabsStore.getState().openEndpoint(EP_A, 'preview')
    useTabsStore.getState().openEndpoint(EP_A, 'persistent')
    const state = useTabsStore.getState()
    expect(state.tabs).toHaveLength(1) /* 原地转正不新增 Tab */
    expect(state.tabs[0]).toMatchObject({ preview: false })
    expect(state.activeTabId).toBe(makeEndpointNodeId('s1', 'k1'))
  })

  it('编辑自动转正（promote）：预览标记清除，位置不变', () => {
    useTabsStore.getState().openEndpoint(EP_A, 'preview')
    useTabsStore.getState().promote(makeEndpointNodeId('s1', 'k1'))
    expect(useTabsStore.getState().tabs[0]?.preview).toBe(false)
  })

  it('常驻打开：预览 Tab 保留，常驻追加激活（预览与新 Tab 并存合法）', () => {
    useTabsStore.getState().openEndpoint(EP_A, 'preview')
    useTabsStore.getState().openEndpoint(EP_B, 'persistent')
    const state = useTabsStore.getState()
    expect(state.tabs.map((tab) => tab.preview)).toEqual([true, false])
    expect(state.activeTabId).toBe(makeEndpointNodeId('s1', 'k2'))
  })

  it('工作空间详情 Tab：固定身份单实例（内容指针＋标题随参数），同一契约复用 / 转正', () => {
    useTabsStore.getState().openWorkspaceSettings({ ...WS_A, mode: 'preview' })
    useTabsStore.getState().openWorkspaceSettings({ ...WS_A, mode: 'preview' })
    expect(useTabsStore.getState().tabs).toHaveLength(1)
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      id: WORKSPACE_SETTINGS_TAB_ID,
      key: 'w1',
      title: '空间一',
    })
    useTabsStore.getState().openWorkspaceSettings({ ...WS_A, mode: 'persistent' })
    expect(useTabsStore.getState().tabs[0]?.preview).toBe(false)
  })

  it('工作空间详情 Tab：单例原位换内容指针并激活（比照历史详情）', () => {
    useTabsStore.getState().openEndpoint(EP_A, 'persistent')
    useTabsStore.getState().openWorkspaceSettings({ ...WS_A, mode: 'persistent' })
    let state = useTabsStore.getState()
    expect(state.tabs).toHaveLength(2)
    expect(state.tabs[1]).toMatchObject({ key: 'w1', title: '空间一' })

    // 点击另一空间行：不新增 Tab，指针与标题原位替换
    useTabsStore.getState().openWorkspaceSettings({ ...WS_B, mode: 'persistent' })
    state = useTabsStore.getState()
    expect(state.tabs).toHaveLength(2)
    expect(state.tabs[1]).toMatchObject({
      id: WORKSPACE_SETTINGS_TAB_ID,
      key: 'w2',
      title: '空间二',
    })
    expect(state.activeTabId).toBe(WORKSPACE_SETTINGS_TAB_ID)
  })

  it('历史详情 Tab：固定单例，原位替换 runId 内容指针并激活', () => {
    const store = useTabsStore.getState()
    store.openEndpoint(EP_A, 'persistent')
    store.openHistoryDetail('run-1')
    let state = useTabsStore.getState()
    expect(state.tabs).toHaveLength(2) /* 与接口 Tab 并存，不占预览槽位 */
    expect(state.tabs[1]).toMatchObject({
      id: HISTORY_DETAIL_TAB_ID,
      kind: 'historyDetail',
      key: 'run-1',
      preview: false,
    })
    expect(state.activeTabId).toBe(HISTORY_DETAIL_TAB_ID)

    // 点击新历史行：单例原位换内容（key 替换），不新增 Tab
    useTabsStore.getState().openHistoryDetail('run-2')
    state = useTabsStore.getState()
    expect(state.tabs).toHaveLength(2)
    expect(state.tabs[1]!.key).toBe('run-2')
    expect(state.activeTabId).toBe(HISTORY_DETAIL_TAB_ID)
  })
})

describe('tabs store：草稿 Tab（历史恢复的无实体形态）', () => {
  it('openDraft：每次调用新开一个草稿 Tab 并激活（多份草稿并存）；id 为草稿 store 键', () => {
    const idA = useTabsStore.getState().openDraft('GET /a')
    const idB = useTabsStore.getState().openDraft('POST /b')
    const state = useTabsStore.getState()
    expect(idA).toMatch(/^draft:/)
    expect(idB).toMatch(/^draft:/)
    expect(idA).not.toBe(idB)
    expect(state.tabs.map((tab) => tab.kind)).toEqual(['draft', 'draft'])
    expect(state.tabs.every((tab) => tab.preview === false)).toBe(true)
    expect(state.activeTabId).toBe(idB)
  })

  it('草稿 Tab 不占预览槽位：与接口预览 Tab 并存，互不换内容', () => {
    useTabsStore.getState().openEndpoint(EP_A, 'preview')
    useTabsStore.getState().openDraft('GET /a')
    let state = useTabsStore.getState()
    expect(state.tabs.map((tab) => tab.kind)).toEqual(['endpoint', 'draft'])

    // 再开一个接口预览：仍复用接口预览槽位，草稿 Tab 不受波及
    useTabsStore.getState().openEndpoint(EP_B, 'preview')
    state = useTabsStore.getState()
    expect(state.tabs.map((tab) => tab.kind)).toEqual(['endpoint', 'draft'])
  })

  it('serialize 过滤草稿 Tab（内存瞬态不入会话 JSON）', () => {
    useTabsStore.getState().openEndpoint(EP_A, 'persistent')
    const draftId = useTabsStore.getState().openDraft('GET /a')
    const saved = useTabsStore.getState().serialize()
    expect(saved.tabs.every((tab) => tab.kind !== 'draft')).toBe(true)
    expect(saved.tabs).toHaveLength(1)
    void draftId
  })

  it('会话恢复丢弃草稿残留：metaFromSession 对 draft 条目返回 null，激活指针回退有效 Tab', () => {
    useTabsStore.getState().restore({
      tabs: [
        { kind: 'endpoint', title: '接口A', serviceId: 's1', key: 'k1', preview: false },
        { kind: 'draft', title: 'GET /a', preview: false },
      ],
      // 会话里激活的可能正是被丢弃的草稿：回退首个有效 Tab
      activeTabId: 'draft:ghost',
    })
    const state = useTabsStore.getState()
    expect(state.tabs.map((tab) => tab.kind)).toEqual(['endpoint'])
    expect(state.activeTabId).toBe(makeEndpointNodeId('s1', 'k1'))
  })

  it('关闭草稿 Tab：激活转移语义与实体 Tab 一致（右邻优先）', () => {
    useTabsStore.getState().openDraft('GET /a')
    const draftId = useTabsStore.getState().activeTabId!
    useTabsStore.getState().openEndpoint(EP_A, 'persistent')
    useTabsStore.getState().close(draftId)
    expect(useTabsStore.getState().activeTabId).toBe(makeEndpointNodeId('s1', 'k1'))
  })
})

describe('tabs store：关闭与激活', () => {
  it('关闭激活 Tab：右邻优先，无右邻取左邻', () => {
    const store = useTabsStore.getState()
    store.openEndpoint(EP_A, 'persistent')
    store.openEndpoint(EP_B, 'persistent')
    store.openWorkspaceSettings({ ...WS_A, mode: 'persistent' })
    // 关中间 → 激活右邻（设置 Tab）
    store.close(makeEndpointNodeId('s1', 'k2'))
    expect(useTabsStore.getState().activeTabId).toBe(WORKSPACE_SETTINGS_TAB_ID)
    // 关最后一个 → 左邻
    useTabsStore.getState().close(WORKSPACE_SETTINGS_TAB_ID)
    expect(useTabsStore.getState().activeTabId).toBe(makeEndpointNodeId('s1', 'k1'))
  })

  it('关闭非激活 Tab：激活指针不动', () => {
    const store = useTabsStore.getState()
    store.openEndpoint(EP_A, 'persistent')
    store.openEndpoint(EP_B, 'persistent')
    store.close(makeEndpointNodeId('s1', 'k1'))
    expect(useTabsStore.getState().activeTabId).toBe(makeEndpointNodeId('s1', 'k2'))
  })

  it('关闭全部：回到无激活空态（欢迎空态接手）', () => {
    const store = useTabsStore.getState()
    store.openEndpoint(EP_A, 'persistent')
    store.close(makeEndpointNodeId('s1', 'k1'))
    expect(useTabsStore.getState()).toMatchObject({ tabs: [], activeTabId: null })
  })

  it('closeOthers：仅保留目标并激活', () => {
    const store = useTabsStore.getState()
    store.openEndpoint(EP_A, 'persistent')
    store.openEndpoint(EP_B, 'persistent')
    store.openWorkspaceSettings({ ...WS_A, mode: 'persistent' })
    store.closeOthers(makeEndpointNodeId('s1', 'k1'))
    const state = useTabsStore.getState()
    expect(state.tabs.map((tab) => tab.id)).toEqual([makeEndpointNodeId('s1', 'k1')])
    expect(state.activeTabId).toBe(makeEndpointNodeId('s1', 'k1'))
  })

  it('closeToRight：截断目标右侧；激活被波及时改为激活目标', () => {
    const store = useTabsStore.getState()
    store.openEndpoint(EP_A, 'persistent')
    store.openEndpoint(EP_B, 'persistent')
    store.openWorkspaceSettings({ ...WS_A, mode: 'persistent' })
    // 激活＝最后打开的设置 Tab，位于目标右侧 → 波及，激活改为目标
    store.closeToRight(makeEndpointNodeId('s1', 'k1'))
    let state = useTabsStore.getState()
    expect(state.tabs.map((tab) => tab.id)).toEqual([makeEndpointNodeId('s1', 'k1')])
    expect(state.activeTabId).toBe(makeEndpointNodeId('s1', 'k1'))

    // 激活在目标左侧 → 不受影响；目标是末位 → 幂等
    store.openEndpoint(EP_B, 'persistent')
    store.setActive(makeEndpointNodeId('s1', 'k1'))
    store.closeToRight(makeEndpointNodeId('s1', 'k2'))
    state = useTabsStore.getState()
    expect(state.tabs.map((tab) => tab.id)).toEqual([
      makeEndpointNodeId('s1', 'k1'),
      makeEndpointNodeId('s1', 'k2'),
    ])
    expect(state.activeTabId).toBe(makeEndpointNodeId('s1', 'k1'))
  })

  it('编辑器页签记忆：随 Tab 关闭清理（有界），restore 整体归零', () => {
    const store = useTabsStore.getState()
    store.openEndpoint(EP_A, 'persistent')
    store.openEndpoint(EP_B, 'persistent')
    const idA = makeEndpointNodeId('s1', 'k1')
    const idB = makeEndpointNodeId('s1', 'k2')
    store.setEditorTab(idA, 'body')
    store.setEditorTab(idB, 'headers')
    expect(useTabsStore.getState().editorTabs).toEqual({ [idA]: 'body', [idB]: 'headers' })

    store.close(idA)
    expect(useTabsStore.getState().editorTabs).toEqual({ [idB]: 'headers' })

    store.closeToRight(idB)
    expect(useTabsStore.getState().editorTabs).toEqual({ [idB]: 'headers' })

    store.restore({
      tabs: [{ id: idB, kind: 'endpoint', title: 'B', serviceId: 's1', key: 'k2', preview: false }],
    })
    expect(useTabsStore.getState().editorTabs).toEqual({})
  })

  it('reorder：移动 Tab 位置；越界与原位为幂等', () => {
    const store = useTabsStore.getState()
    store.openEndpoint(EP_A, 'persistent')
    store.openEndpoint(EP_B, 'persistent')
    store.openWorkspaceSettings({ ...WS_A, mode: 'persistent' })
    useTabsStore.getState().reorder(WORKSPACE_SETTINGS_TAB_ID, 0)
    expect(useTabsStore.getState().tabs.map((tab) => tab.id)).toEqual([
      WORKSPACE_SETTINGS_TAB_ID,
      makeEndpointNodeId('s1', 'k1'),
      makeEndpointNodeId('s1', 'k2'),
    ])
    useTabsStore.getState().reorder(WORKSPACE_SETTINGS_TAB_ID, 9)
    useTabsStore.getState().reorder('nope', 0)
    expect(useTabsStore.getState().tabs[0]?.id).toBe(WORKSPACE_SETTINGS_TAB_ID)
  })

  it('setTabTitle：重命名同步单点', () => {
    useTabsStore.getState().openEndpoint(EP_A, 'persistent')
    useTabsStore.getState().setTabTitle(makeEndpointNodeId('s1', 'k1'), '新标题')
    expect(useTabsStore.getState().tabs[0]?.title).toBe('新标题')
  })
})

describe('tabs store：批量条件关闭（closeWhere，删除联动）', () => {
  /** 服务删除谓词的真实形态：仅接口 Tab 且属于目标服务 */
  const closeServiceTabs = (serviceId: string) =>
    useTabsStore
      .getState()
      .closeWhere((tab) => tab.kind === 'endpoint' && tab.serviceId === serviceId)

  it('批量关闭非激活 Tab：其余 Tab 保留，激活指针不动', () => {
    const store = useTabsStore.getState()
    store.openEndpoint(EP_A, 'persistent')
    store.openEndpoint(EP_B, 'persistent')
    store.openEndpoint(EP_C, 'persistent') /* 激活＝s2 */
    closeServiceTabs('s1')
    const state = useTabsStore.getState()
    expect(state.tabs.map((tab) => tab.id)).toEqual([makeEndpointNodeId('s2', 'k1')])
    expect(state.activeTabId).toBe(makeEndpointNodeId('s2', 'k1'))
  })

  it('激活 Tab 被波及：落点右邻首个存活（同批被关的右邻越过）', () => {
    const store = useTabsStore.getState()
    store.openEndpoint(EP_A, 'persistent')
    store.openEndpoint(EP_B, 'persistent')
    store.openEndpoint(EP_C, 'persistent')
    useTabsStore.getState().setActive(makeEndpointNodeId('s1', 'k1'))
    closeServiceTabs('s1')
    const state = useTabsStore.getState()
    expect(state.tabs.map((tab) => tab.id)).toEqual([makeEndpointNodeId('s2', 'k1')])
    expect(state.activeTabId).toBe(makeEndpointNodeId('s2', 'k1'))
  })

  it('激活 Tab 被波及且右侧无存活：取左侧存活', () => {
    const store = useTabsStore.getState()
    store.openWorkspaceSettings({ ...WS_A, mode: 'persistent' })
    store.openEndpoint(EP_A, 'persistent')
    store.openEndpoint(EP_B, 'persistent') /* 激活＝末位 s1 */
    closeServiceTabs('s1')
    const state = useTabsStore.getState()
    expect(state.tabs.map((tab) => tab.id)).toEqual([WORKSPACE_SETTINGS_TAB_ID])
    expect(state.activeTabId).toBe(WORKSPACE_SETTINGS_TAB_ID)
  })

  it('全部 Tab 同批关闭：回无激活空态（欢迎空态接手）', () => {
    const store = useTabsStore.getState()
    store.openEndpoint(EP_A, 'persistent')
    closeServiceTabs('s1')
    expect(useTabsStore.getState()).toMatchObject({ tabs: [], activeTabId: null })
  })

  it('无匹配：幂等（tabs 与激活指针原样）', () => {
    const store = useTabsStore.getState()
    store.openEndpoint(EP_A, 'persistent')
    const before = useTabsStore.getState()
    closeServiceTabs('s2')
    const state = useTabsStore.getState()
    expect(state.tabs).toEqual(before.tabs)
    expect(state.activeTabId).toBe(before.activeTabId)
  })

  it('页签记忆同步裁剪：被关 Tab 清除，存活 Tab 保留', () => {
    const store = useTabsStore.getState()
    store.openEndpoint(EP_A, 'persistent')
    store.openEndpoint(EP_B, 'persistent')
    store.openEndpoint(EP_C, 'persistent')
    const idA = makeEndpointNodeId('s1', 'k1')
    const idB = makeEndpointNodeId('s1', 'k2')
    const idC = makeEndpointNodeId('s2', 'k1')
    useTabsStore.getState().setEditorTab(idA, 'body')
    useTabsStore.getState().setEditorTab(idB, 'headers')
    useTabsStore.getState().setEditorTab(idC, 'params')
    closeServiceTabs('s1')
    expect(useTabsStore.getState().editorTabs).toEqual({ [idC]: 'params' })
  })

  it('预览槽位随批量关闭释放：被关的预览 Tab 不阻碍下一次预览打开', () => {
    const store = useTabsStore.getState()
    store.openEndpoint(EP_A, 'preview') /* s1 预览 Tab */
    store.openEndpoint(EP_C, 'persistent')
    closeServiceTabs('s1')
    expect(useTabsStore.getState().tabs.map((tab) => tab.id)).toEqual([
      makeEndpointNodeId('s2', 'k1'),
    ])
    /* 预览槽位已空：再次单击预览打开正常新增并激活 */
    useTabsStore.getState().openEndpoint(EP_B, 'preview')
    const state = useTabsStore.getState()
    expect(state.tabs).toHaveLength(2)
    expect(state.tabs[1]).toMatchObject({ id: makeEndpointNodeId('s1', 'k2'), preview: true })
    expect(state.activeTabId).toBe(makeEndpointNodeId('s1', 'k2'))
  })

  it('kind 判定护住非接口 Tab：设置 / 历史详情 / 变量 Tab 不被服务删除误伤', () => {
    const store = useTabsStore.getState()
    store.openEndpoint(EP_A, 'persistent')
    store.openWorkspaceSettings({ ...WS_A, mode: 'persistent' })
    store.openHistoryDetail('run-1')
    store.openVariables({ categoryId: 'c1', name: '账号管理' })
    closeServiceTabs('s1')
    const state = useTabsStore.getState()
    expect(state.tabs.map((tab) => tab.kind)).toEqual([
      'workspaceSettings',
      'historyDetail',
      'variables',
    ])
    expect(state.activeTabId).toBe(`${VARIABLES_TAB_ID_PREFIX}c1`)
  })

  it('openWorkflow 每工作流单实例：同 id 仅激活不重开；重开不进预览槽', () => {
    const store = useTabsStore.getState()
    store.openWorkflow({ workflowId: 'wf1', name: '登录链' })
    store.openWorkflow({ workflowId: 'wf2', name: '下单链' })
    store.openWorkflow({ workflowId: 'wf1', name: '登录链' })
    const state = useTabsStore.getState()
    expect(state.tabs).toHaveLength(2)
    expect(state.tabs[0]).toMatchObject({
      id: `${WORKFLOW_TAB_ID_PREFIX}wf1`,
      kind: 'workflow',
      key: 'wf1',
      preview: false,
    })
    expect(state.activeTabId).toBe(`${WORKFLOW_TAB_ID_PREFIX}wf1`)
  })
})

describe('tabs store：会话序列化与恢复', () => {
  it('serialize → restore 往返：顺序 / 激活态 / 预览标记全还原', () => {
    const store = useTabsStore.getState()
    store.openEndpoint(EP_A, 'persistent')
    store.openEndpoint(EP_B, 'preview')
    const saved = useTabsStore.getState().serialize()

    useTabsStore.setState({ tabs: [], activeTabId: null })
    useTabsStore.getState().restore({ tabs: saved.tabs, activeTabId: saved.activeTabId })

    const state = useTabsStore.getState()
    expect(state.tabs).toHaveLength(2)
    expect(state.tabs[1]?.preview).toBe(true) /* 预览标记随会话还原 */
    expect(state.activeTabId).toBe(makeEndpointNodeId('s1', 'k2'))
  })

  it('workflow Tab 会话往返：key＝工作流 id 恢复指针；缺 key 条目跳过', () => {
    const store = useTabsStore.getState()
    store.openWorkflow({ workflowId: 'wf1', name: '登录链' })
    const saved = useTabsStore.getState().serialize()

    useTabsStore.setState({ tabs: [], activeTabId: null })
    useTabsStore.getState().restore({ tabs: saved.tabs, activeTabId: saved.activeTabId })
    const restored = useTabsStore.getState()
    expect(restored.tabs[0]).toMatchObject({
      id: `${WORKFLOW_TAB_ID_PREFIX}wf1`,
      kind: 'workflow',
      key: 'wf1',
      title: '登录链',
    })
    expect(restored.activeTabId).toBe(`${WORKFLOW_TAB_ID_PREFIX}wf1`)

    // 旧版会话（参数化前写入、无 key）：无内容指针，不恢复
    useTabsStore.setState({ tabs: [], activeTabId: null })
    useTabsStore.getState().restore({
      tabs: [
        { kind: 'workflow', id: `${WORKFLOW_TAB_ID_PREFIX}wf9`, title: '旧条目', preview: false },
      ],
    })
    expect(useTabsStore.getState().tabs).toHaveLength(0)
  })

  it('恢复：激活指针失效时回退首个 Tab；空会话回空态', () => {
    useTabsStore.getState().restore({
      tabs: [{ kind: 'endpoint', title: '接口A', serviceId: 's1', key: 'k1', preview: false }],
      activeTabId: 'ghost',
    })
    expect(useTabsStore.getState().activeTabId).toBe(makeEndpointNodeId('s1', 'k1'))

    useTabsStore.getState().restore({ tabs: [] })
    expect(selectActiveTab(useTabsStore.getState())).toBeNull()
  })

  it('恢复容错：形态异常条目跳过（残缺会话不炸启动）', () => {
    useTabsStore.getState().restore({
      tabs: [
        'garbage',
        null,
        { kind: 'endpoint' },
        { kind: 'endpoint', serviceId: 's1', key: 'k1', title: '接口A' },
        { kind: 'unknown-kind', title: 'x' },
      ],
    })
    const state = useTabsStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]?.id).toBe(makeEndpointNodeId('s1', 'k1'))
  })

  it('历史详情不入会话恢复：瞬态查看不还原（残留条目被忽略，激活指针回退有效 Tab）', () => {
    useTabsStore.getState().restore({
      tabs: [
        { kind: 'endpoint', title: '接口A', serviceId: 's1', key: 'k1', preview: false },
        {
          id: HISTORY_DETAIL_TAB_ID,
          kind: 'historyDetail',
          title: '',
          key: 'run-1',
          preview: false,
        },
      ],
      // 会话里激活的可能正是被跳过的历史详情：回退首个有效 Tab
      activeTabId: HISTORY_DETAIL_TAB_ID,
    })
    const state = useTabsStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]?.kind).toBe('endpoint')
    expect(state.activeTabId).toBe(makeEndpointNodeId('s1', 'k1'))
  })

  it('工作空间详情入会话恢复：内容指针（workspaceId）随会话还原', () => {
    useTabsStore.getState().restore({
      tabs: [
        { kind: 'endpoint', title: '接口A', serviceId: 's1', key: 'k1', preview: false },
        {
          id: WORKSPACE_SETTINGS_TAB_ID,
          kind: 'workspaceSettings',
          title: '空间一',
          key: 'w1',
          preview: false,
        },
      ],
      activeTabId: WORKSPACE_SETTINGS_TAB_ID,
    })
    const state = useTabsStore.getState()
    expect(state.tabs).toHaveLength(2)
    expect(state.tabs[1]).toMatchObject({
      id: WORKSPACE_SETTINGS_TAB_ID,
      key: 'w1',
      title: '空间一',
    })
    expect(state.activeTabId).toBe(WORKSPACE_SETTINGS_TAB_ID)
  })

  it('无内容指针的 workspaceSettings 会话条目（参数化前 legacy）不恢复', () => {
    useTabsStore.getState().restore({
      tabs: [
        { kind: 'endpoint', title: '接口A', serviceId: 's1', key: 'k1', preview: false },
        { id: WORKSPACE_SETTINGS_TAB_ID, kind: 'workspaceSettings', title: '', preview: false },
      ],
    })
    const state = useTabsStore.getState()
    expect(state.tabs.map((tab) => tab.kind)).toEqual(['endpoint'])
  })

  it('恢复：激活态与 Tab 元数据以会话为准（重启恢复保持预览标记）', () => {
    useTabsStore.getState().restore({
      tabs: [
        { kind: 'endpoint', title: 'A', serviceId: 's1', key: 'k1', preview: false },
        { kind: 'endpoint', title: 'B', serviceId: 's1', key: 'k2', preview: true },
      ],
      activeTabId: makeEndpointNodeId('s1', 'k2'),
    })
    const state = useTabsStore.getState()
    expect(state.tabs[1]).toMatchObject({ preview: true })
    expect(state.activeTabId).toBe(makeEndpointNodeId('s1', 'k2'))
  })
})

describe('tabs store：激活序号（TabBar 滚回可视区的触发源）', () => {
  it('打开已激活 Tab：activeTabId 不变，activationSeq 仍自增', () => {
    useTabsStore.getState().openEndpoint(EP_A, 'persistent')
    const first = useTabsStore.getState().activationSeq
    useTabsStore.getState().openEndpoint(EP_A, 'preview')
    const state = useTabsStore.getState()
    expect(state.activeTabId).toBe(makeEndpointNodeId('s1', 'k1'))
    expect(state.activationSeq).toBe(first + 1)
  })

  it('切换到已激活 Tab（setActive）：序号自增；目标不存在则不动', () => {
    useTabsStore.getState().openEndpoint(EP_A, 'persistent')
    useTabsStore.getState().openEndpoint(EP_B, 'persistent')
    useTabsStore.getState().setActive(makeEndpointNodeId('s1', 'k1'))
    const seqAfterSwitch = useTabsStore.getState().activationSeq
    useTabsStore.getState().setActive(makeEndpointNodeId('s1', 'k1'))
    expect(useTabsStore.getState().activationSeq).toBe(seqAfterSwitch + 1)
    const before = useTabsStore.getState().activationSeq
    useTabsStore.getState().setActive('no-such-tab')
    expect(useTabsStore.getState().activationSeq).toBe(before)
  })

  it('打开工作空间设置 Tab：同一序号契约自增', () => {
    useTabsStore.getState().openWorkspaceSettings({ ...WS_A, mode: 'persistent' })
    const first = useTabsStore.getState().activationSeq
    useTabsStore.getState().openWorkspaceSettings({ ...WS_A, mode: 'persistent' })
    expect(useTabsStore.getState().activationSeq).toBe(first + 1)
  })
})
