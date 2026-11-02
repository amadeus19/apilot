/**
 * 同步向导的拉取段（服务选择态＋运行态）与完成段。
 *
 * 拉取段进入即暂停：逐服务卡片勾选（含可达芯片；
 * 无文档地址服务不可选），勾选后「开始同步 · N 服务」；未勾选服务本次
 * 跳过、不读不写。拉取为串联编排（store.startSync）：运行段顶部活动面板
 * 呈现当前拉取中的服务与总进度（已落定 n / m），一服务失败不影响后续。
 * 完成段呈现跨服务应用摘要与合并承诺计数。
 */

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { CheckCircle2Icon, CheckIcon, CircleDashed, Loader2Icon, XCircleIcon } from 'lucide-react'

import {
  Badge,
  Button,
  Checkbox,
  Empty,
  EmptyDescription,
  EmptyTitle,
} from '@workspace/ui/components'
import { cn } from 'cn'

import { SEMANTIC_ICONS } from '@/features/icons/semantic-icons'
import { useI18n } from '@/i18n'
import { probeStatusOf, useProbeStore } from '@/stores/probe.store'
import { useSyncWizardStore } from '@/stores/sync.store'
import { KIND_META, SYNC_KINDS } from './kind-meta'
import { useSyncServiceOptions } from './wizard-data'

export function SelectStep() {
  const { t } = useI18n()
  const services = useSyncServiceOptions()
  const selected = useSyncWizardStore((s) => s.selectedServiceIds)
  const toggleService = useSyncWizardStore((s) => s.toggleService)
  const setSelected = useSyncWizardStore((s) => s.setSelected)
  const startSync = useSyncWizardStore((s) => s.startSync)
  const statuses = useProbeStore((s) => s.statuses)

  const selectable = services.filter((s) => s.docUrl !== null)
  const canStart = selected.length > 0
  // 已全选时「全选」钮语义翻转为全不选（aria-pressed 表达按压态）
  const allSelected = selectable.length > 0 && selectable.every((s) => selected.includes(s.id))

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="wizard-select">
      <p className="px-6 pb-3 text-xs text-muted-foreground">{t('sync.wizard.selectHint')}</p>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-3">
        {selectable.length === 0 ? (
          <Empty>
            <EmptyTitle>{t('sync.wizard.selectTitle')}</EmptyTitle>
            <EmptyDescription>{t('sync.wizard.noDocUrl')}</EmptyDescription>
          </Empty>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {services.map((service) => {
              const disabled = service.docUrl === null
              const checked = selected.includes(service.id)
              return (
                <div
                  key={service.id}
                  data-service-id={service.id}
                  onClick={() => !disabled && toggleService(service.id)}
                  className={cn(
                    'flex flex-col gap-1.5 rounded-lg border p-3 transition-colors',
                    !disabled && 'cursor-pointer',
                    checked && !disabled && 'border-primary/50 bg-selection/60',
                    !checked && !disabled && 'hover:bg-accent/50',
                    disabled && 'opacity-55',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={checked}
                      disabled={disabled}
                      onCheckedChange={() => toggleService(service.id)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={service.name}
                    />
                    <SEMANTIC_ICONS.service
                      aria-hidden
                      className="size-4 shrink-0 text-muted-foreground/70"
                    />
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-[13px] font-medium',
                        disabled && 'text-muted-foreground',
                      )}
                    >
                      {service.name}
                    </span>
                    {disabled ? (
                      <Badge variant="outline" className="text-[11px] text-muted-foreground">
                        {t('sync.wizard.noDocUrl')}
                      </Badge>
                    ) : (
                      <ProbeChip status={probeStatusOf(statuses, service.id)} />
                    )}
                  </div>
                  {service.docUrl !== null && (
                    <p className="truncate pl-7 font-mono text-[11px] text-muted-foreground">
                      {service.docUrl}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      <div className="flex h-[52px] shrink-0 items-center gap-3 border-t px-6">
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={allSelected}
          onClick={() => setSelected(allSelected ? [] : selectable.map((s) => s.id))}
        >
          {t('sync.wizard.selectAll')}
        </Button>
        <span className="text-[11px] text-muted-foreground">
          {t('sync.wizard.selectFooterCount', {
            selected: selected.length,
            total: selectable.length,
          })}
        </span>
        <span className="flex-1" />
        <Button size="sm" disabled={!canStart} onClick={() => void startSync(services)}>
          {t('sync.wizard.startSync', { count: selected.length })}
        </Button>
      </div>
    </div>
  )
}

/** 可达芯片（复用探测四态呈现，只读不写入） */
function ProbeChip({ status }: { status: 'reachable' | 'unreachable' | 'unknown' | 'probing' }) {
  const { t } = useI18n()
  // t() 须字面量键：四态各一分支，不做模板拼接
  const label =
    status === 'reachable'
      ? t('apiTree.probeReachable')
      : status === 'unreachable'
        ? t('apiTree.probeUnreachable')
        : status === 'probing'
          ? t('apiTree.probeProbing')
          : t('apiTree.probeUnknown')
  return (
    <Badge
      variant="outline"
      className={cn(
        'text-[11px]',
        status === 'reachable' && 'text-success',
        status === 'unreachable' && 'text-destructive',
      )}
      data-probe-status={status}
    >
      {label}
    </Badge>
  )
}

/** 运行态文案（t() 须字面量键：状态 → 键映射表） */
const RUN_LABEL_KEY = {
  queued: 'sync.wizard.runQueued',
  fetching: 'sync.wizard.runFetching',
  diffing: 'sync.wizard.runDiffing',
  ok: 'sync.wizard.runOk',
  skipped: 'sync.wizard.runSkipped',
} as const

export function RunningStep() {
  const { t } = useI18n()
  const runs = useSyncWizardStore((s) => s.runs)
  const cancelService = useSyncWizardStore((s) => s.cancelService)
  const services = useSyncServiceOptions()

  const entries = Object.entries(runs)
  // 串联编排下至多一个进行中服务（fetching / diffing）
  const activeEntry = entries.find(
    ([, run]) => run.status === 'fetching' || run.status === 'diffing',
  )
  const settledCount = entries.filter(
    ([, run]) => run.status === 'ok' || run.status === 'skipped',
  ).length

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-3" data-testid="wizard-running">
        {activeEntry && (
          <div className="mb-3 flex items-center gap-3 rounded-md border bg-muted/30 p-3">
            <Loader2Icon aria-hidden className="size-4 shrink-0 animate-spin text-primary" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] leading-tight">
                {t('sync.wizard.runActivity', {
                  name: services.find((s) => s.id === activeEntry[0])?.name ?? activeEntry[0],
                })}
              </p>
              <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                {services.find((s) => s.id === activeEntry[0])?.docUrl ?? activeEntry[0]}
                {activeEntry[1].startedAt !== undefined && (
                  <span>
                    {' · '}
                    {t('sync.wizard.runElapsed')} <Elapsed since={activeEntry[1].startedAt} />
                  </span>
                )}
              </p>
              <span className="mt-2 block h-1 overflow-hidden rounded-full bg-border">
                <span
                  className="block h-full rounded-full bg-primary"
                  style={{
                    width: `${entries.length === 0 ? 0 : (settledCount / entries.length) * 100}%`,
                  }}
                />
              </span>
            </div>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              {settledCount} / {entries.length}
            </span>
          </div>
        )}
        <ul className="flex flex-col divide-y rounded-md border">
          {entries.map(([serviceId, run]) => {
            const name = services.find((s) => s.id === serviceId)?.name ?? serviceId
            return (
              <li
                key={serviceId}
                className="flex items-center gap-2 px-3 py-2 text-sm"
                data-service-id={serviceId}
              >
                <RunIcon status={run.status} cancelled={run.cancelled === true} />
                <span className="flex-1 truncate">{name}</span>
                <span
                  className={cn(
                    'max-w-[50%] truncate text-xs',
                    run.status === 'skipped' && run.cancelled !== true
                      ? 'text-destructive'
                      : 'text-muted-foreground',
                  )}
                >
                  {run.cancelled === true
                    ? t('sync.wizard.runCancelled')
                    : run.status === 'skipped' && run.errorMessage
                      ? run.errorMessage
                      : run.status === 'ok' && run.durationMs !== undefined
                        ? `${t('sync.wizard.runOk')} · ${formatDuration(run.durationMs)}`
                        : t(RUN_LABEL_KEY[run.status])}
                </span>
                {/* 拉取中行内取消（拉取不设超时后的挂起兜底）；diffing 是只读
                    短任务不取消；取消落定转中性「已取消」，可走重试 */}
                {run.status === 'fetching' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 shrink-0 px-2 text-xs"
                    onClick={() => cancelService(serviceId)}
                    data-testid="wizard-cancel-fetch"
                  >
                    {t('sync.wizard.cancelFetch')}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      </div>
      {/* 取消语义可见化：关闭向导＝取消剩余拉取（closeWizard 已实现取消链路） */}
      <div className="flex h-[52px] shrink-0 items-center gap-3 border-t px-6">
        <span className="text-xs text-muted-foreground/70">
          {t('sync.wizard.runningCloseHint')}
        </span>
      </div>
    </div>
  )
}

/** 运行耗时格式：60s 内一位小数秒（0.8s），之上走分秒（1m 05s） */
function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const totalSeconds = Math.floor(ms / 1000)
  return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, '0')}s`
}

/** 已用时读秒（0.1s 粒度；卸载即清理——关闭向导 / 段位切换不停表是噪音） */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(timer)
  }, [])
  return <span className="tabular-nums">{formatDuration(now - since)}</span>
}

function RunIcon({
  status,
  cancelled = false,
}: {
  status: 'queued' | 'fetching' | 'diffing' | 'ok' | 'skipped'
  cancelled?: boolean
}) {
  if (status === 'ok') return <CheckCircle2Icon className="size-4 text-success" />
  if (status === 'skipped')
    return (
      <XCircleIcon
        className={cancelled ? 'size-4 text-muted-foreground' : 'size-4 text-destructive'}
      />
    )
  if (status === 'fetching' || status === 'diffing')
    return <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
  return <CircleDashed className="size-4 text-muted-foreground/60" />
}

/** 完成段统计卡四格（标签与语义色取自变更种类单源；无变化行取前景色） */
const DONE_STAT_META = [
  ...SYNC_KINDS.map((kind) => ({
    key: kind,
    labelKey: KIND_META[kind].labelKey,
    text: KIND_META[kind].text,
  })),
  {
    key: 'unchanged' as const,
    labelKey: 'sync.wizard.doneUnchanged' as const,
    text: 'text-foreground',
  },
]

export function DoneStep() {
  const { t } = useI18n()
  const closeWizard = useSyncWizardStore((s) => s.closeWizard)
  const summary = useSyncWizardStore((s) => s.lastSummary)
  const queryClient = useQueryClient()

  const finish = () => {
    closeWizard()
    // 应用已落库：树面 / 文档 / 用户数据查询全量失效重取
    void queryClient.invalidateQueries()
  }

  if (!summary) return null

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="wizard-done">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <span className="grid size-11 place-items-center rounded-full border-2 border-success/30 bg-success/10">
          <CheckIcon aria-hidden className="size-5 text-success" />
        </span>
        <span className="text-[15px] font-medium">{t('sync.wizard.doneTitle')}</span>
        {/* 应用摘要四格：数字大号等宽、语义色区分，与对比段页签同一色系 */}
        <div
          className="grid w-full max-w-md grid-cols-4 divide-x rounded-md border bg-muted/20"
          data-testid="wizard-done-stats"
        >
          {DONE_STAT_META.map((stat) => (
            <div key={stat.key} className="px-4 py-3">
              <p className={cn('text-xl leading-none font-semibold tabular-nums', stat.text)}>
                {summary[stat.key]}
              </p>
              <p className="mt-1.5 text-[11px] leading-none text-muted-foreground">
                {t(stat.labelKey)}
              </p>
            </div>
          ))}
        </div>
        <p className="max-w-sm text-[11px] leading-relaxed text-muted-foreground/80">
          {t('sync.wizard.doneBadgeNote')}
        </p>
      </div>
      <div className="flex h-[52px] shrink-0 items-center justify-end border-t px-6">
        <Button size="sm" onClick={finish}>
          {t('sync.wizard.finishButton')}
        </Button>
      </div>
    </div>
  )
}
