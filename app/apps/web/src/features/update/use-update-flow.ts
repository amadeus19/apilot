import { create } from 'zustand'

import { reportError } from '@/services/error-center'
import { flushAllForExit } from '@/services/exit-flush'
import { checkUpdates, downloadUpdate, installUpdate, invoke } from '@/services/ipc'
import { presentCheckToast, presentDownloadVerified } from '@/services/update-check'
import { useUpdatePromptStore } from '@/stores/update-prompt.store'

/**
 * 更新流程状态机（单一事实源）：checking / installing / availableVersion
 * 由此独占持有，设置面板更新段与就绪对话框为纯视图（订阅本状态渲染）。
 *
 * 流程：检查（全状态 toast 反馈）→ 发现新版可下载 → 下载校验（toast 反馈）
 * → 就绪确认对话框（update-prompt store 承载请求）→ 确认安装（Rust 暂存
 * 安装请求并 arm 退出闸门 → 前端全量收尾后 ack 放行 → 退出序列末尾 spawn
 * 安装器，安装结果由下轮 boot 扫场反馈）。
 *
 * 任务归属（豁免记录）：检查 / 下载是秒级单次动作（Rust 侧超时兜底，5s/50s），
 * 生命周期随请求结束，无取消语义需求，不进 TaskRegistry；安装器 spawn 在
 * 退出序列内部（先于 exit），而 shutdown 会先排空 registry，二者天然互斥。
 */

interface UpdateFlowState {
  /** 手动检查进行中（防重入） */
  checking: boolean
  /** 安装推进中：下载校验阶段与确认安装阶段共用（同一安装流程的两段） */
  installing: boolean
  /** 手动检查发现的可安装版本（null = 无；升级与回滚同走下载确认安装路径） */
  availableVersion: string | null
  /** 可安装版本的方向：回滚（清单低于当前）时横幅文案与配色随之切换 */
  availableIsDowngrade: boolean
  /** 手动检查：全状态反馈 + 记录可安装版本 */
  checkUpdates: () => Promise<void>
  /** 下载校验就绪包，通过后请求就绪确认对话框 */
  downloadAndInstall: () => Promise<void>
  /** 确认安装就绪包：Rust 校验通过即暂存安装请求，前端收尾 ack 后进入退出序列（成功路径进程即将退出） */
  confirmInstall: () => Promise<void>
}

export const useUpdateFlow = create<UpdateFlowState>((set, get) => ({
  checking: false,
  installing: false,
  availableVersion: null,
  availableIsDowngrade: false,

  checkUpdates: async () => {
    if (get().checking) return
    set({ checking: true })
    try {
      const result = await checkUpdates()
      presentCheckToast(result)
      const installable =
        result.status === 'newer_available' || result.status === 'downgrade_available'
      set({
        availableVersion: installable ? (result.latestVersion ?? null) : null,
        availableIsDowngrade: result.status === 'downgrade_available',
      })
    } catch (error) {
      reportError(error)
    } finally {
      set({ checking: false })
    }
  },

  downloadAndInstall: async () => {
    if (get().installing) return
    set({ installing: true })
    try {
      const staged = await downloadUpdate()
      presentDownloadVerified(staged.version)
      useUpdatePromptStore.getState().show(staged)
    } catch (error) {
      reportError(error)
    } finally {
      set({ installing: false })
    }
  },

  confirmInstall: async () => {
    if (get().installing) return
    const pending = useUpdatePromptStore.getState().pending
    if (!pending) return
    set({ installing: true })
    try {
      await installUpdate(pending.version)
    } catch (error) {
      reportError(error)
      set({ installing: false })
      return
    }
    // Rust 已暂存安装请求并 arm 退出闸门。装更新旁路关窗决策层、不触发
    // CloseRequested，onCloseRequested 收尾通道不会运行——由此处全量收尾
    // （会话保存 + 草稿 flush，逐项容错）后 ack 放行，退出序列立即进入，
    // 不干等闸门超时。ack 失败只上报：退出已成定局（闸门超时兜底放行），
    // installing 保持锁定直至进程退出
    await flushAllForExit()
    await invoke<void>('app.ready_to_exit').catch((error: unknown) => reportError(error))
  },
}))
