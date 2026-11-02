import {
  checkUpdates,
  discardStagedUpdate,
  listStagedUpdates,
  type CheckUpdatesResult,
} from './ipc'

import { reportError } from './error-center'
import { translate } from '@/i18n/core'
import { toast } from '@workspace/ui/components'
import { selectResolvedLocale, useSettingsStore } from '@/stores/settings.store'
import { useUpdatePromptStore } from '@/stores/update-prompt.store'

/**
 * 更新链路服务层：boot 扫场（就绪包续接 / 完成提示 / 安装失败反馈 / 自动
 * 检查）与流程反馈文案。用户发起的检查 / 下载 / 安装状态机在
 * features/update/use-update-flow.ts（单一事实源），本模块的反馈文案函数
 * 为两方共用（文案单点）。
 * boot 扫场是启动期一次性动作（setTimeout 后自跑，无组件生命周期），
 * 不属流程状态机。
 */

/** 延迟时长：boot 渲染完成后等 UI（Toaster 宿主等）就绪再扫场检查 */
const AUTO_CHECK_DELAY_MS = 3000

function t(key: Parameters<typeof translate>[1], params?: Record<string, string | number>): string {
  return translate(selectResolvedLocale(useSettingsStore.getState()), key, params)
}

/** 检查结果反馈（全状态文案）：流程状态机与自动检查共用。
 * 发现新版的去向按当前更新源类型分叉：folder 源由用户到源目录获取，
 * cloud 源由应用直接从仓库下载安装，文案随之区分。 */
export function presentCheckToast(result: CheckUpdatesResult): void {
  const cloudSource = useSettingsStore.getState().updateSource.kind === 'cloud'
  switch (result.status) {
    case 'newer_available':
      // 无说明时不传选项（toast 调用形态保持单一）
      toast.info(
        t(cloudSource ? 'settings.checkUpdateAvailableCloud' : 'settings.checkUpdateAvailable', {
          version: result.latestVersion ?? '',
        }),
        {
          description: result.notes ?? undefined,
        },
      )
      break
    case 'downgrade_available':
      // 回滚是用户主动发起的关注点，自动检查静默（不弹），只影响手动检查反馈
      toast.info(
        t('settings.checkUpdateDowngradeAvailable', { version: result.latestVersion ?? '' }),
        {
          description: result.notes ?? undefined,
        },
      )
      break
    case 'up_to_date':
      toast.success(t('settings.checkUpdateUpToDate'))
      break
    case 'not_configured':
      toast.info(t('settings.checkUpdateNotConfigured'))
      break
    case 'unreachable':
      toast.error(t('settings.checkUpdateUnreachable'))
      break
    case 'invalid_manifest':
      toast.error(t('settings.checkUpdateInvalidManifest'))
      break
  }
}

/** 下载校验通过反馈（就绪确认对话框弹出前） */
export function presentDownloadVerified(version: string): void {
  toast.success(t('settings.updateVerified', { version }))
}

/** 自动检查（开关闸门）：关闭即不检查；检查失败静默（不打扰启动），
 * 仅 newer_available 弹提示。boot 扫场无就绪包时回落复用。 */
function runAutoCheckUpdates(): void {
  if (!useSettingsStore.getState().autoCheckUpdates.enabled) return
  void checkUpdates()
    .then((result) => {
      if (result.status === 'newer_available') presentCheckToast(result)
    })
    .catch(() => {
      // 自动检查静默失败：更新源不可达 / 清单异常不构成启动期打扰
    })
}

/**
 * boot 更新扫场：先扫描临时目录就绪包——
 * installFailed（上次安装未完成，Rust 侧标记已一次性读清）→ toast 反馈；
 * ready（上次「稍后」留下的）→ 优先弹就绪确认对话框并跳过自动检查（同版本
 * toast 会重复打扰）；finished（版本 = 当前的残留包）→ 覆盖安装已完成，
 * 一次性完成提示 + 清理；两者皆无 → 回落自动检查（受 autoCheckUpdates 开关
 * 控制）。续接上次明确的安装意向与完成提示是一次性事件，独立于该开关。
 */
export function scheduleStartupUpdateSweep(): void {
  window.setTimeout(() => {
    void (async () => {
      const staged = await listStagedUpdates().catch((error) => {
        reportError(error)
        return null
      })
      if (staged?.installFailed) {
        toast.error(t('settings.updateInstallFailed', { version: staged.installFailed.version }))
      }
      if (staged?.ready) {
        useUpdatePromptStore.getState().show(staged.ready)
        return
      }
      if (staged?.finished) {
        toast.success(t('settings.updateCompletedToast', { version: staged.finished.version }))
        await discardStagedUpdate(staged.finished.version).catch(() => undefined)
      }
      runAutoCheckUpdates()
    })()
  }, AUTO_CHECK_DELAY_MS)
}
