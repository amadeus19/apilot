import { expandLeftPanel } from '@/components/layout/panel-bridge'
import { useAppStore } from '@/stores/app.store'

/**
 * 接口树定位接缝（imperative 桥，panel-bridge 先例）：
 * 面包屑 / 命令面板等外部动作请求树定位某节点。「定位生效」的前置——
 * 接口树视图可见＋左栏展开——由本接缝自保证，发起方一行调用即可，
 * 不再各自拼装（拼漏一处就是静默 no-op：点按无反馈、无报错可追）。
 *
 * 挂起机制：左栏不在接口树视图时 ApiTreePanel 已卸载（处理器未注册），
 * 切回视图是 React 状态更新、处理器注册必然晚于本次调用——请求先挂起，
 * 面板挂载登记处理器时即刻消费。
 */

export type TreeLocateHandler = (nodeId: string) => void

let handler: TreeLocateHandler | null = null
/** 视图切换挂起的定位请求（ApiTreePanel 挂载时消费一次） */
let pendingNodeId: string | null = null

/**
 * 定位 / 开对话框等动作的公共前置：接口树视图可见（切视图＋展开面板）。
 * 返回树是否已在挂载态——false 表示视图刚切换，树侧动作须走挂起通道。
 */
export function ensureApiTreeVisible(): boolean {
  // 收起态先展开面板（展开是「用户要看这棵树」语义的一部分；已展开时不动）
  expandLeftPanel()
  if (handler === null) {
    useAppStore.getState().setLeftView('apis')
    return false
  }
  return true
}

/**
 * ApiTreePanel 挂载登记 / 卸载注销（传 null 清除）。
 * 挂起请求不在登记时兑现：挂载瞬间树索引必然未就绪（查询异步），
 * 兑现点在面板的数据就绪通知（notifyTreeDataReady）。
 */
export function registerTreeLocateHandler(next: TreeLocateHandler | null): void {
  handler = next
}

/** 数据就绪通知（ApiTreePanel 树索引可用时调用）：兑现挂起的定位请求 */
export function notifyTreeDataReady(): void {
  if (handler !== null && pendingNodeId !== null) {
    const nodeId = pendingNodeId
    pendingNodeId = null
    handler(nodeId)
  }
}

/** 请求树定位：前置自保证后交处理器（展开祖先并选中目标行）；视图切换中则挂起 */
export function locateInApiTree(nodeId: string): void {
  if (!ensureApiTreeVisible()) {
    pendingNodeId = nodeId
    return
  }
  handler?.(nodeId)
}
