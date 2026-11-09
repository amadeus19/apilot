import { create } from 'zustand'

/**
 * 关闭确认对话框状态：服务层（exit-flush 的 `app://close-requested` 监听）
 * 通过 show() 请求弹框，根挂载的 CloseConfirmDialog 宿主消费。
 * pending＝窗口关闭请求正等待用户决策（Rust ask 分支语义＝询问用户）；
 * clear＝用户已决策（含取消）或决策动作已发起，弹窗退场。
 */
interface CloseConfirmState {
  /** 待决策的关闭请求（true = 对话框在场） */
  pending: boolean
  show: () => void
  clear: () => void
}

export const useCloseConfirmStore = create<CloseConfirmState>((set) => ({
  pending: false,
  show: () => set({ pending: true }),
  clear: () => set({ pending: false }),
}))
