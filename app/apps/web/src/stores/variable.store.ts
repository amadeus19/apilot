import { create } from 'zustand'

import { useTabsStore } from '@/stores/tabs.store'

/**
 * 变量域 UI 会话状态（Zustand 单 slice）：
 * - 左栏变量树的展开行集与选中行（受控数组形态供 TreePrimitive，会话内
 *   UI 态，不落库）；
 * - 接口级 BaseUrl 覆写表（tabId → 覆写值）：内存态、不落库，仅当前 Tab
 *   生效（spec 定案——单接口临时指向另一环境）；
 * - 会话级 BaseUrl 档（所有 Tab 生效、退出即清）：地址栏覆写控件的手动
 *   会话档通道，优先级低于 Tab 覆写（resolveBaseUrlOverride 单点）。
 *
 * 资源四问（覆写表／会话档）：
 * - 谁拥有：本 store（不归编辑器组件——切 Tab 卸载编辑器覆写必须留存，
 *   重挂后入口回显覆写态）；
 * - 何时创建：地址栏覆写控件选候选时写入覆写表；覆写控件会话档动作时
 *   写入会话档；
 * - 何时释放：覆写表——清除（置 null）与关 Tab（tabs 集合收缩信号，见
 *   模块级订阅）同步摘除；会话档——手动清除或应用退出（纯内存态，
 *   新 Tab 开启即受其生效）；
 * - 异常兜底：两者均纯内存态，无失败面；订阅清理幂等（无死 Tab 即空转）。
 */

interface VariableUiState {
  /** 树展开行 id 集（分组＋分类，受控数组；替换式更新） */
  treeExpandedIds: string[]
  setTreeExpandedIds: (ids: string[]) => void
  /** 树选中行 id（分类 / 变量行；分组行仅视觉选中） */
  treeSelectedNodeId: string | null
  setTreeSelectedNodeId: (id: string | null) => void
  /** 接口级 BaseUrl 覆写（tabId → 覆写值；有界：随 Tab 关闭清理） */
  baseUrlOverrides: Record<string, string>
  /** 设置 / 清除覆写（url null＝清除，等价跟随工作空间） */
  setBaseUrlOverride: (tabId: string, url: string | null) => void
  /** 会话级 BaseUrl 档（所有 Tab 生效；null＝无档，回工作空间生效值） */
  sessionBaseUrl: string | null
  setSessionBaseUrl: (url: string | null) => void
}

export const useVariableStore = create<VariableUiState>((set) => ({
  treeExpandedIds: [],
  setTreeExpandedIds: (ids) => set({ treeExpandedIds: ids }),
  treeSelectedNodeId: null,
  setTreeSelectedNodeId: (id) => set({ treeSelectedNodeId: id }),
  baseUrlOverrides: {},
  setBaseUrlOverride: (tabId, url) =>
    set((state) => {
      const next = { ...state.baseUrlOverrides }
      if (url === null) delete next[tabId]
      else next[tabId] = url
      return { baseUrlOverrides: next }
    }),
  sessionBaseUrl: null,
  setSessionBaseUrl: (url) => set({ sessionBaseUrl: url }),
}))

/**
 * 该 Tab 当前的 BaseUrl 覆写生效值（发送与地址栏展示共用的解析单点）：
 * Tab 覆写 > 会话档 > null（跟随工作空间生效值）。发送侧一次性取值、
 * 地址栏响应式订阅各自的消费形态在此之上。
 */
export function resolveBaseUrlOverride(tabId: string): string | null {
  const state = useVariableStore.getState()
  return state.baseUrlOverrides[tabId] ?? state.sessionBaseUrl ?? null
}

// —— 关 Tab 清理（沿 response.store 先例）：tabs 集合收缩时摘除死 Tab 的
//    覆写条目（有界性：覆写表不得随 Tab 开关累积；会话档不随 Tab 生命周期，
//    不参与本订阅） ——

useTabsStore.subscribe((state, prevState) => {
  if (state.tabs === prevState.tabs) return
  const alive = new Set(state.tabs.map((tab) => tab.id))
  const overrides = useVariableStore.getState().baseUrlOverrides
  const deadIds = Object.keys(overrides).filter((id) => !alive.has(id))
  if (deadIds.length === 0) return
  const store = useVariableStore.getState()
  for (const tabId of deadIds) store.setBaseUrlOverride(tabId, null)
})
