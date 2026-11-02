import { create } from 'zustand'

import { makeEndpointNodeId } from '@/lib/tree-identity'

/**
 * 工作台标签页状态（Zustand 单 slice；`workspace` 词专归领域工作空间）。
 *
 * 纯 UI 会话状态：Tab 元数据（身份 / 类型 / 标题 / 顺序 / 预览标记）+
 * 激活指针，不存业务数据——草稿与树数据全走 TanStack Query。
 *
 * openTab 单实例契约与预览态（VS Code 语义）：
 * - 同身份已开 → 仅激活不重开（预览 Tab 不受单击影响）；
 * - 单击来源（preview 模式）＝打开 / 复用全局唯一预览 Tab（原槽位换内容）；
 * - 双击 / Enter 来源（persistent 模式）＝常驻；目标恰在预览中则原地转正；
 * - 预览内开始编辑＝转正（promote，由编辑器接线调用）；
 * - 预览标记随会话落库，重启恢复保持。
 */

/** Tab 类型：endpoint / workspaceSettings / historyDetail / draft / variables / workflow 实装 */
export const TAB_KINDS = [
  'endpoint',
  'workspaceSettings',
  'historyDetail',
  'draft',
  'variables',
  'workflow',
] as const
export type TabKind = (typeof TAB_KINDS)[number]

export interface TabMeta {
  /** Tab 实例 id（单实例契约键）：endpoint＝`endpoint:{serviceId}:{key}`，draft＝`draft:{uuid}`，工作空间详情 / 历史详情＝固定 id */
  id: string
  kind: TabKind
  title: string
  /** endpoint 身份（恢复指针：重开经 user_data.get 拉同一份草稿）；workspaceSettings＝正在查看的工作空间 id；historyDetail＝当前展示的 runId（瞬态，不入会话恢复）；draft 无实体身份（id 即草稿 store 键） */
  serviceId?: string
  key?: string
  /** 预览态标记（全局唯一，标题去强调呈现，随会话落库）；draft 恒 false（不与接口预览槽位互斥） */
  preview: boolean
}

/** 工作空间设置 Tab 的固定身份 id（全局唯一实例） */
export const WORKSPACE_SETTINGS_TAB_ID = 'workspaceSettings'

/** 历史详情 Tab 的固定身份 id（全局唯一单例：点击历史行原位换内容） */
export const HISTORY_DETAIL_TAB_ID = 'historyDetail'

/** 草稿 Tab id 前缀（每次恢复请求生成新 uuid：多份草稿可并存对照） */
export const DRAFT_TAB_ID_PREFIX = 'draft:'

/** 变量配置 Tab id 前缀（每分类单实例：id＝`variables:{categoryId}`） */
export const VARIABLES_TAB_ID_PREFIX = 'variables:'

/** 工作流编辑 Tab id 前缀（每工作流单实例：id＝`workflow:{workflowId}`） */
export const WORKFLOW_TAB_ID_PREFIX = 'workflow:'

export type OpenMode = 'preview' | 'persistent'

interface TabsState {
  tabs: TabMeta[]
  activeTabId: string | null
  /**
   * 激活序号（单调递增）：打开 / 切换标签动作每次自增，目标已激活也自增。
   * TabBar 依此把激活 Tab 滚回可视区——树点击已激活 Tab 时 activeTabId
   * 不变，唯有该序号能表达「用户再次指向了这个 Tab」。
   */
  activationSeq: number
  /**
   * 接口编辑器页签选中态（tabId → params / headers / body）：切 Tab 重挂载
   * 后恢复上次所在页签；随 Tab 关闭清除（有界），会话恢复不还原（重启回默认）
   */
  editorTabs: Record<string, string>
  setEditorTab: (tabId: string, value: string) => void

  /** 打开接口 Tab（树交互 / 命令面板 / 面包屑定位共用入口） */
  openEndpoint: (input: { serviceId: string; key: string; title: string }, mode: OpenMode) => void
  /**
   * 打开工作空间详情 Tab（单例：内容指针 key＝workspaceId，同身份已开
   * 则原位替换指针与标题并激活；title＝工作空间名，重命名经 setTabTitle 同步）
   */
  openWorkspaceSettings: (input: { workspaceId: string; name: string; mode: OpenMode }) => void
  /**
   * 打开变量配置 Tab（每分类单实例）：title＝分类名（行内改名后经
   * setTabTitle 同步；TabBar 标题格式化「变量 · {name}」走 i18n）
   */
  openVariables: (input: { categoryId: string; name: string }) => void
  /**
   * 打开工作流编辑 Tab（每工作流单实例）：title＝工作流名（重命名经
   * setTabTitle 同步）；key＝工作流 id（会话恢复指针）
   */
  openWorkflow: (input: { workflowId: string; name: string }) => void
  /** 打开历史详情 Tab（单例：同身份已开则原位替换 runId 并激活） */
  openHistoryDetail: (runId: string) => void
  /**
   * 打开草稿 Tab（无实体身份的历史恢复草稿）：每次调用新开一个（多份
   * 草稿可并存）；返回 Tab id（同时是草稿 store 的键，调用方以此 seed
   * 草稿数据）。恒常驻形态（preview=false，不与接口预览槽位互斥）。
   */
  openDraft: (title: string) => string
  /** 预览转常驻（编辑自动转正的单点） */
  promote: (tabId: string) => void
  setActive: (tabId: string) => void
  /** 关闭：激活 Tab 关闭后激活右邻，无右邻取左邻（VS Code 语义） */
  close: (tabId: string) => void
  /**
   * 批量条件关闭（删除联动：服务 / 分类删除时一并关闭其下接口 Tab）：
   * 一次 set 移除全部匹配 Tab；激活 Tab 被波及时按其原位置右邻优先、
   * 无右邻取左邻（单 Tab close 语义的批量推广），全部关闭回空态
   */
  closeWhere: (predicate: (tab: TabMeta) => boolean) => void
  closeOthers: (tabId: string) => void
  /** 关闭目标右侧全部（右键菜单；激活 Tab 被波及时改为激活目标） */
  closeToRight: (tabId: string) => void
  /** 关闭全部（命令面板命令；回到无 Tab 空态） */
  closeAll: () => void
  reorder: (tabId: string, toIndex: number) => void
  /** 标题同步（实体重命名后由树接线调用，TabBar 显示单一事实源在此） */
  setTabTitle: (tabId: string, title: string) => void
  /** 会话恢复（启动 / 切换工作空间；残留 Tab 已由 Rust 侧过滤） */
  restore: (session: { tabs: unknown[]; activeTabId?: unknown }) => void
  /** 会话序列化（Tab 顺序 / 激活态 / 预览标记） */
  serialize: () => { tabs: TabMeta[]; activeTabId: string | null }
}

/** 页签记忆的存活裁剪：只保留仍在开的 Tab（关闭路径共用） */
function pickEditorTab(
  editorTabs: Record<string, string>,
  aliveTabIds: string[],
): Record<string, string> {
  const alive = new Set(aliveTabIds)
  const next: Record<string, string> = {}
  for (const [tabId, value] of Object.entries(editorTabs)) {
    if (alive.has(tabId)) next[tabId] = value
  }
  return next
}

/**
 * openTab 四段逻辑（唯一一份）：existing 查找（id＝单实例契约键，全等即
 * 同身份）、persistent 转正、预览槽位原位换内容（换出的旧 id 不再存活，
 * 页签记忆同步裁剪——与「随关闭清除」同一有界语义，不留永久条目）、
 * activationSeq 自增。openEndpoint / openWorkspaceSettings 只差身份构造。
 */
function openTabWithIdentity(state: TabsState, meta: TabMeta, mode: OpenMode): Partial<TabsState> {
  const existing = state.tabs.find((tab) => tab.id === meta.id)
  if (existing) {
    const tabs =
      mode === 'persistent' && existing.preview
        ? state.tabs.map((tab) => (tab.id === existing.id ? { ...tab, preview: false } : tab))
        : state.tabs
    return { tabs, activeTabId: existing.id, activationSeq: state.activationSeq + 1 }
  }
  if (mode === 'preview') {
    const previewIndex = state.tabs.findIndex((tab) => tab.preview)
    if (previewIndex >= 0) {
      // 复用全局唯一预览槽位：原位换内容
      const tabs = state.tabs.map((tab, index) => (index === previewIndex ? meta : tab))
      const editorTabs = pickEditorTab(
        state.editorTabs,
        tabs.map((tab) => tab.id),
      )
      return { tabs, editorTabs, activeTabId: meta.id, activationSeq: state.activationSeq + 1 }
    }
  }
  return {
    tabs: [...state.tabs, meta],
    activeTabId: meta.id,
    activationSeq: state.activationSeq + 1,
  }
}

/** 会话条目容错恢复：形态异常的条目跳过（残缺会话不炸启动） */
function metaFromSession(item: unknown): TabMeta | null {
  if (typeof item !== 'object' || item === null) return null
  const record = item as Record<string, unknown>
  const kind = record.kind
  const title = typeof record.title === 'string' ? record.title : ''
  const preview = record.preview === true
  if (kind === 'endpoint') {
    const { serviceId, key } = record
    if (typeof serviceId !== 'string' || typeof key !== 'string') return null
    return { id: makeEndpointNodeId(serviceId, key), kind, title, serviceId, key, preview }
  }
  if (kind === 'workspaceSettings') {
    // 内容指针（key＝workspaceId）随会话恢复；无 key 的 legacy 条目
    // （参数化前写入的会话）无内容可指，不恢复
    if (typeof record.key !== 'string' || record.key === '') return null
    return { id: WORKSPACE_SETTINGS_TAB_ID, kind, title, key: record.key, preview }
  }
  // 历史详情不入会话恢复：瞬态查看（重开会话不该还原，Tab 关闭即消失；
  // 会话 JSON 里的残留条目在此被忽略）
  if (kind === 'historyDetail') {
    return null
  }
  // 草稿 Tab 同样不入会话恢复：草稿是「以历史为模板的新草稿」的会话内
  // 瞬态（内存态、不落库），重开会话不得还原；serialize 已在源头过滤，
  // 此处兜底忽略会话 JSON 里的残留条目（双端同一丢弃口径）
  if (kind === 'draft') {
    return null
  }
  // 变量配置 / 工作流 Tab 的恢复形态（key＝配置对象 id，恢复指针指向编辑面）
  if (kind === 'variables') {
    const id = typeof record.id === 'string' ? record.id : null
    const categoryId = typeof record.key === 'string' ? record.key : null
    if (!id || !categoryId) return null
    return { id, kind, title, key: categoryId, preview }
  }
  if (kind === 'workflow') {
    const id = typeof record.id === 'string' ? record.id : null
    const workflowId = typeof record.key === 'string' ? record.key : null
    if (!id || !workflowId) return null
    return { id, kind, title, key: workflowId, preview }
  }
  return null
}

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  activationSeq: 0,
  editorTabs: {},

  setEditorTab: (tabId, value) => {
    set((state) => ({ editorTabs: { ...state.editorTabs, [tabId]: value } }))
  },

  openEndpoint: (input, mode) => {
    const { serviceId, key, title } = input
    set((state) =>
      openTabWithIdentity(
        state,
        {
          id: makeEndpointNodeId(serviceId, key),
          kind: 'endpoint',
          title,
          serviceId,
          key,
          preview: mode === 'preview',
        },
        mode,
      ),
    )
  },

  openWorkspaceSettings: ({ workspaceId, name, mode }) => {
    set((state) => {
      // 单例原位换内容：内容指针（key＝workspaceId）与标题替换并激活，
      // 不新增 Tab（比照 openHistoryDetail；详情恒常驻形态，不与接口
      // 预览 Tab 抢槽）
      const existing = state.tabs.find((tab) => tab.id === WORKSPACE_SETTINGS_TAB_ID)
      if (existing) {
        return {
          tabs: state.tabs.map((tab) =>
            tab.id === WORKSPACE_SETTINGS_TAB_ID
              ? { ...tab, key: workspaceId, title: name, preview: false }
              : tab,
          ),
          activeTabId: WORKSPACE_SETTINGS_TAB_ID,
          activationSeq: state.activationSeq + 1,
        }
      }
      return openTabWithIdentity(
        state,
        {
          id: WORKSPACE_SETTINGS_TAB_ID,
          kind: 'workspaceSettings',
          title: name,
          key: workspaceId,
          preview: mode === 'preview',
        },
        mode,
      )
    })
  },

  // 恒常驻形态（不与接口预览槽位互斥——配置页是低频设置入口）
  openVariables: ({ categoryId, name }) => {
    set((state) =>
      openTabWithIdentity(
        state,
        {
          id: `${VARIABLES_TAB_ID_PREFIX}${categoryId}`,
          kind: 'variables',
          title: name,
          key: categoryId,
          preview: false,
        },
        'persistent',
      ),
    )
  },

  // 工作流编辑 Tab：每工作流单实例，恒常驻形态（编辑器非低频浏览态）
  openWorkflow: ({ workflowId, name }) => {
    set((state) =>
      openTabWithIdentity(
        state,
        {
          id: `${WORKFLOW_TAB_ID_PREFIX}${workflowId}`,
          kind: 'workflow',
          title: name,
          key: workflowId,
          preview: false,
        },
        'persistent',
      ),
    )
  },

  openHistoryDetail: (runId) => {
    set((state) => {
      const existing = state.tabs.find((tab) => tab.id === HISTORY_DETAIL_TAB_ID)
      // 单例原位换内容：内容指针（key＝runId）替换并激活，不新增 Tab、
      // 不走预览槽位（历史详情恒常驻形态，不与接口预览 Tab 抢槽）
      if (existing) {
        return {
          tabs: state.tabs.map((tab) =>
            tab.id === HISTORY_DETAIL_TAB_ID ? { ...tab, key: runId } : tab,
          ),
          activeTabId: HISTORY_DETAIL_TAB_ID,
          activationSeq: state.activationSeq + 1,
        }
      }
      return openTabWithIdentity(
        state,
        {
          id: HISTORY_DETAIL_TAB_ID,
          kind: 'historyDetail',
          title: '',
          key: runId,
          preview: false,
        },
        'persistent',
      )
    })
  },

  promote: (tabId) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, preview: false } : tab)),
    }))
  },

  openDraft: (title) => {
    const id = `${DRAFT_TAB_ID_PREFIX}${crypto.randomUUID()}`
    set((state) =>
      openTabWithIdentity(
        state,
        {
          id,
          kind: 'draft',
          title,
          preview: false,
        },
        'persistent',
      ),
    )
    return id
  },

  setActive: (tabId) => {
    set((state) =>
      state.tabs.some((tab) => tab.id === tabId)
        ? { activeTabId: tabId, activationSeq: state.activationSeq + 1 }
        : {},
    )
  },

  close: (tabId) => {
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === tabId)
      if (index < 0) return {}
      const tabs = state.tabs.filter((tab) => tab.id !== tabId)
      const { [tabId]: _removed, ...editorTabs } = state.editorTabs
      let activeTabId = state.activeTabId
      if (activeTabId === tabId) {
        // 右邻优先，无右邻取左邻；空列表回到无激活
        const neighbor = tabs[Math.min(index, tabs.length - 1)] ?? null
        activeTabId = neighbor?.id ?? null
      }
      return { tabs, activeTabId, editorTabs }
    })
  },

  closeWhere: (predicate) => {
    set((state) => {
      const matchedIds = new Set(state.tabs.filter((tab) => predicate(tab)).map((tab) => tab.id))
      if (matchedIds.size === 0) return {}
      const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? null
      const tabs = state.tabs.filter((tab) => !matchedIds.has(tab.id))
      let activeTabId = state.activeTabId
      // 激活 Tab 被波及才转移落点：右邻优先（原位置向右首个存活），无则左邻
      if (activeTab && matchedIds.has(activeTab.id)) {
        const activeIndex = state.tabs.indexOf(activeTab)
        const neighbor =
          state.tabs.slice(activeIndex + 1).find((tab) => !matchedIds.has(tab.id)) ??
          [...state.tabs.slice(0, activeIndex)].reverse().find((tab) => !matchedIds.has(tab.id)) ??
          null
        activeTabId = neighbor?.id ?? null
      }
      return {
        tabs,
        activeTabId,
        editorTabs: pickEditorTab(
          state.editorTabs,
          tabs.map((tab) => tab.id),
        ),
      }
    })
  },

  closeOthers: (tabId) => {
    set((state) => {
      const keep = state.tabs.find((tab) => tab.id === tabId)
      if (!keep) return {}
      return {
        tabs: [keep],
        activeTabId: tabId,
        editorTabs: pickEditorTab(state.editorTabs, [tabId]),
      }
    })
  },

  closeToRight: (tabId) => {
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === tabId)
      if (index < 0) return {}
      const tabs = state.tabs.slice(0, index + 1)
      const activeTabId =
        state.activeTabId && tabs.some((tab) => tab.id === state.activeTabId)
          ? state.activeTabId
          : tabId
      return {
        tabs,
        activeTabId,
        editorTabs: pickEditorTab(
          state.editorTabs,
          tabs.map((tab) => tab.id),
        ),
      }
    })
  },

  closeAll: () => {
    set({ tabs: [], activeTabId: null, editorTabs: {} })
  },

  reorder: (tabId, toIndex) => {
    set((state) => {
      const from = state.tabs.findIndex((tab) => tab.id === tabId)
      if (from < 0 || toIndex < 0 || toIndex >= state.tabs.length || from === toIndex) return {}
      const tabs = [...state.tabs]
      const [moved] = tabs.splice(from, 1)
      tabs.splice(toIndex, 0, moved!)
      return { tabs }
    })
  },

  setTabTitle: (tabId, title) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, title } : tab)),
    }))
  },

  restore: (session) => {
    const items = Array.isArray(session.tabs) ? session.tabs : []
    const tabs = items.map(metaFromSession).filter((meta): meta is TabMeta => meta !== null)
    const requested = typeof session.activeTabId === 'string' ? session.activeTabId : null
    const activeTabId =
      requested && tabs.some((tab) => tab.id === requested) ? requested : (tabs[0]?.id ?? null)
    // 页签记忆是会话内 UI 态：整体替换（启动 / 切空间）时归零回默认
    set({ tabs, activeTabId, editorTabs: {} })
  },

  serialize: () => {
    const { tabs, activeTabId } = get()
    // 草稿 Tab 不入会话（内存瞬态，重开即弃）：序列化在源头过滤；
    // activeTabId 指向被过滤草稿时由 restore 侧的「激活指针失效回退」兜底
    return { tabs: tabs.filter((tab) => tab.kind !== 'draft'), activeTabId }
  },
}))

/** 当前激活 Tab 选择器（内容宿主与 TabBar 共用） */
export const selectActiveTab = (s: TabsState): TabMeta | null =>
  s.tabs.find((tab) => tab.id === s.activeTabId) ?? null
