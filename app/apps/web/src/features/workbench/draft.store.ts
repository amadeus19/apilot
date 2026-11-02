import { create } from 'zustand'

import { useTabsStore } from '@/stores/tabs.store'

/**
 * 历史恢复草稿的内存态 store：键＝草稿 Tab id（`draft:{uuid}`，由
 * tabs store 的 openDraft 生成）。草稿是「以历史为模板的新草稿」——
 * 只读快照的副本，编辑不落库（转正＝「另存为新接口」显式落库）。
 *
 * 资源四问：
 * - 谁拥有：本 store（内存态，无持久化、无 IPC 写）；
 * - 何时创建：历史详情「恢复为草稿」动作 seed（与 openDraft 同一交互）；
 * - 何时释放：草稿 Tab 关闭 / 转正换装 / 会话恢复整体替换——都表现为
 *   tabs 集合收缩，经下方收缩信号统一清理（有界，无孤儿条目）；
 * - 应用退出：内存态自然消失（不入会话序列化，重启不还原）。
 */

/** 草稿数据形态（快照回填口径见 history-draft.ts 的构造函数） */
export interface EndpointDraftData {
  /** HTTP 方法（七选） */
  method: string
  /** 路径模板：BaseUrl 命中拆分＝相对路径；否则完整绝对 URL */
  pathTemplate: string
  /** 参数行 JSON（快照 query 拆行；kv-editor 存储契约同构） */
  paramsJson: string
  /** 请求头行 JSON（快照 headers 回填，含认证派生头的真实值） */
  headersJson: string
  /** Body 信封（快照 excerpt 按信封读侧嗅探回填；null＝无体） */
  body: string | null
  /** 快照 body 超出保留范围（仅回填前缀，编辑面提示） */
  bodyTruncated: boolean
  /** 快照 redactions 提示的自定义敏感头名（展示掩码判定用） */
  sensitiveHeaderNames: string[]
  /** 来源服务（转正落点优先级：仍在树中的来源服务 → 树首个服务） */
  sourceServiceId: string | null
}

interface DraftState {
  drafts: Record<string, EndpointDraftData>
  /** 播种草稿（恢复动作；Tab 由 openDraft 先行创建） */
  seedDraft: (id: string, data: EndpointDraftData) => void
  /** 整包替换（编辑面受控更新，内存态无防抖——不落库） */
  updateDraft: (id: string, data: EndpointDraftData) => void
}

export const useDraftStore = create<DraftState>((set) => ({
  drafts: {},
  seedDraft: (id, data) => {
    set((state) => ({ drafts: { ...state.drafts, [id]: data } }))
  },
  updateDraft: (id, data) => {
    set((state) => (id in state.drafts ? { drafts: { ...state.drafts, [id]: data } } : {}))
  },
}))

/**
 * 草稿清理接线（tabs 收缩信号，与响应面板的死 Tab 清理同一模式）：
 * 关闭草稿 Tab / 关闭其他 / 关闭右侧 / 关闭全部 / 转正换装（close 后重开）
 * / 会话恢复整体替换，都表现为 tabs 集合收缩——死 Tab 的草稿条目随之
 * 丢弃，不泄漏。
 */
useTabsStore.subscribe((state, prevState) => {
  if (state.tabs === prevState.tabs) return
  const alive = new Set(state.tabs.map((tab) => tab.id))
  const drafts = useDraftStore.getState().drafts
  const deadIds = Object.keys(drafts).filter((id) => !alive.has(id))
  if (deadIds.length === 0) return
  useDraftStore.setState((prev) => {
    const next = { ...prev.drafts }
    for (const id of deadIds) delete next[id]
    return { drafts: next }
  })
})
