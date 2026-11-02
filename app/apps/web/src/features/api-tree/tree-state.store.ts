import { create } from 'zustand'

/**
 * 接口树展开状态（按当前工作空间隔离的会话态）：
 * 展开节点 id 数组是 workspace_sessions.tree_expanded 的内存真相，
 * 随 Tab 会话同一事务保存 / 恢复（接线在 features/workbench 会话钩子）。
 * 切换工作空间时整体替换（restore / clear）。
 *
 * 另持两项树会话态：
 * - activeNodeId：当前选中行（Ctrl+T 目标服务等跨组件消费）；
 * - newEndpointRequest：新建接口请求信号（Ctrl+T 等外部入口 → ApiTreePanel
 *   消费开对话框；nonce 防同值重放，消费即清空）。
 */

interface NewEndpointRequest {
  /** 递增序号：同值请求不重放 */
  nonce: number
  /** 目标服务；null＝无服务，引导先建服务 */
  serviceId: string | null
}

interface TreeExpandedState {
  expandedIds: string[]
  setExpanded: (ids: string[]) => void
  /** 当前选中行（树行 id；无选中＝null） */
  activeNodeId: string | null
  setActiveNode: (id: string | null) => void
  /** 新建接口请求信号（null＝无挂起请求） */
  newEndpointRequest: NewEndpointRequest | null
  requestNewEndpoint: (serviceId: string | null) => void
  clearNewEndpointRequest: () => void
  /** 会话恢复（整体替换） */
  restore: (ids: unknown) => void
  /** 切换工作空间 / 加载前清空 */
  clear: () => void
}

let requestNonce = 0

export const useTreeExpandedStore = create<TreeExpandedState>((set) => ({
  expandedIds: [],
  setExpanded: (ids) => set({ expandedIds: ids }),
  activeNodeId: null,
  setActiveNode: (id) => set({ activeNodeId: id }),
  newEndpointRequest: null,
  requestNewEndpoint: (serviceId) =>
    set({ newEndpointRequest: { nonce: (requestNonce += 1), serviceId } }),
  clearNewEndpointRequest: () => set({ newEndpointRequest: null }),
  restore: (ids) => {
    if (!Array.isArray(ids)) {
      set({ expandedIds: [] })
      return
    }
    set({ expandedIds: ids.filter((id): id is string => typeof id === 'string') })
  },
  clear: () => set({ expandedIds: [], activeNodeId: null, newEndpointRequest: null }),
}))
