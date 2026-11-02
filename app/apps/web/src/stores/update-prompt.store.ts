import { create } from 'zustand'

import type { StagedUpdateInfo } from '@/services/ipc'

/**
 * 更新就绪确认对话框状态：服务层（下载校验后 / boot 续接扫描）
 * 通过 show() 请求弹框，根挂载的 UpdateReadyDialog 宿主消费。
 * 「稍后」= clear（就绪包保留在临时目录，下次启动续接）。
 */
interface UpdatePromptState {
  /** 待确认安装的就绪包（null = 对话框关闭） */
  pending: StagedUpdateInfo | null
  show: (pending: StagedUpdateInfo) => void
  clear: () => void
}

export const useUpdatePromptStore = create<UpdatePromptState>((set) => ({
  pending: null,
  show: (pending) => set({ pending }),
  clear: () => set({ pending: null }),
}))
