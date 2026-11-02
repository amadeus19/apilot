/**
 * 同步向导壳：居中模态（约 880×660）＋顶部水平阶段轨常显＋四段分发
 * （拉取 / 对比 / 确认 / 完成）。入口＝标题栏同步钮
 * （TitleBar 触发 store.open）；关闭＝放弃——进行中拉取取消、本地态全量
 * 重置（closeWizard），应用完成段的关闭＝正常结束（同为重置，落库不回退）；
 * 应用段进行中拒绝关闭（onOpenChange 守卫，与确认按钮禁用口径一致）。
 */

import { CheckIcon } from 'lucide-react'

import { useI18n } from '@/i18n'
import { useSyncWizardStore, type SyncWizardPhase } from '@/stores/sync.store'
import { cn } from 'cn'

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@workspace/ui/components'

import { CompareStep } from './wizard-compare'
import { DoneStep, RunningStep, SelectStep } from './wizard-steps'
import { formatSyncClock, useLastSyncedAt } from './wizard-data'

export function SyncWizard() {
  const { t } = useI18n()
  const open = useSyncWizardStore((s) => s.open)
  const phase = useSyncWizardStore((s) => s.phase)
  const applying = useSyncWizardStore((s) => s.applying)
  const closeWizard = useSyncWizardStore((s) => s.closeWizard)
  const lastSyncedAt = useLastSyncedAt()

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 应用段进行中忽略一切关闭请求（Esc / 遮罩 / X）：closeWizard 会全量
        // 重置 store，打断了 applyAll 的落库链路与完成摘要呈现（应用含移除
        // 语义，静默中断不可接受）；与底部按钮 disabled={applying} 口径一致。
        // 拉取段的关闭取消链路不受影响（applying 仅在应用段为真）。
        if (!next && applying) return
        if (!next) closeWizard()
      }}
    >
      <DialogContent
        className="flex h-[660px] max-w-[880px] flex-col gap-0 sm:max-w-[880px]"
        data-testid="sync-wizard"
      >
        <header className="shrink-0 px-6 pt-4 pr-10 pb-1">
          <div className="flex items-baseline justify-between gap-3">
            <DialogTitle className="leading-none">{t('sync.wizard.title')}</DialogTitle>
            {/* 上次同步＝最近一次全量应用时刻；从未同步（无已应用快照）不呈现 */}
            {lastSyncedAt && (
              <span
                className="shrink-0 font-mono text-[11px] text-muted-foreground"
                data-testid="wizard-last-synced"
              >
                {t('sync.wizard.lastSyncedAt', { time: formatSyncClock(lastSyncedAt) })}
              </span>
            )}
          </div>
          <DialogDescription className="sr-only">{t('sync.wizard.description')}</DialogDescription>
          <TrackBar phase={phase} />
        </header>
        {phase === 'select' && <SelectStep />}
        {phase === 'running' && <RunningStep />}
        {phase === 'compare' && <CompareStep />}
        {phase === 'done' && <DoneStep />}
      </DialogContent>
    </Dialog>
  )
}

/**
 * 阶段轨（四段常显进度；拉取段含服务选择与运行两态，步骤不细分）：
 * 已过＝实心对勾节点＋填充连线，当前＝实心节点带光环，未到＝描边节点。
 */
function TrackBar({ phase }: { phase: SyncWizardPhase }) {
  const { t } = useI18n()
  const steps = [
    { key: 'select', label: t('sync.wizard.stepFetch') },
    { key: 'running', label: t('sync.wizard.stepCompare') },
    { key: 'compare', label: t('sync.wizard.stepConfirm') },
    { key: 'done', label: t('sync.wizard.stepDone') },
  ] as const
  const currentIndex = steps.findIndex((s) => s.key === phase)
  // 拉取运行态在阶段轨上落在「拉取」一档（拉取步骤进行中）
  const activeIndex = phase === 'running' ? 0 : currentIndex

  return (
    <div className="mt-4 mb-3 flex items-center" data-testid="wizard-stepbar">
      {steps.map((step, index) => {
        const state = index < activeIndex ? 'done' : index === activeIndex ? 'current' : 'pending'
        return (
          <span
            key={step.key}
            className={cn('flex items-center', index < steps.length - 1 && 'min-w-0 flex-1')}
          >
            <span className="flex shrink-0 items-center gap-2">
              <span
                aria-current={state === 'current' ? 'step' : undefined}
                className={cn(
                  'grid size-[18px] place-items-center rounded-full',
                  state === 'done' && 'bg-primary text-primary-foreground',
                  state === 'current' && 'bg-primary ring-4 ring-primary/15',
                  state === 'pending' && 'border-2 border-border bg-popover dark:border-input',
                )}
              >
                {state === 'done' && <CheckIcon aria-hidden className="size-2.5" />}
              </span>
              <span
                className={cn(
                  'text-xs whitespace-nowrap',
                  state === 'current' ? 'font-medium text-foreground' : 'text-muted-foreground',
                  state === 'pending' && 'text-muted-foreground/70',
                )}
              >
                {step.label}
              </span>
            </span>
            {index < steps.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  'mx-3 h-px min-w-4 flex-1',
                  index < activeIndex ? 'bg-primary/60' : 'bg-border',
                )}
              />
            )}
          </span>
        )
      })}
    </div>
  )
}
