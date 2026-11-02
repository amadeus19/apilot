import { Separator, toast } from '@workspace/ui/components'

import { SEMANTIC_ICONS } from '@/features/icons/semantic-icons'
import { executeWorkflowGuarded } from '@/features/workflow/run-flow'
import { workflowKeys, workflowList } from '@/features/workflow/workflow-api'
import { useWorkspacesQuery } from '@/features/workspaces/api'
import { useI18n } from '@/i18n'
import { useAppVersion } from '@/lib/use-app-version'
import { useIpcQuery } from '@/services/ipc-query'
import { useSettingsStore } from '@/stores/settings.store'
import { useSyncWizardStore, type ServiceRunState, type SyncWizardPhase } from '@/stores/sync.store'

/**
 * 状态栏：h-6 单行——工作空间 / 同步 / 固定工作流 / 版本。
 * 工作空间段回显当前工作空间名（与标题栏切换器同源 useWorkspacesQuery），
 * 无当前空间＝注意态语义点＋空态文案；同步段聚合同步向导的 per-service
 * 运行态（进行中 / 已同步 N 个服务 / 失败档，纯 store 派生，不引入轮询或
 * 事件订阅），本次会话无同步动作时整段不渲染——「尚未同步」的会话语义
 * 易被误读为工作空间从未同步，无信息就不占位；版本号取真实 getVersion()。
 * 固定段是唯一可点击段：每工作空间至多一个的固定工作流（Route 图标＋名
 * 称，点击直跑，与清单行同运行协议），名称从当前空间清单解析，无固定或
 * 固定 id 不在清单（被删自愈）＝整段不渲染；其余段保持只读回显语义。
 * 服务可达状态已由接口树行芯片呈现，此处不重复。计数与版本号走等宽字体
 * （tabular-nums），数字跳动不抖版。
 */

/** 同步段档位（从向导 store 只读派生的聚合面） */
type SyncSegment =
  { tier: 'idle' } | { tier: 'running' } | { tier: 'done'; applied: number; failed: number }

/**
 * 同步段聚合：runs 为空＝本次会话尚无同步（含向导关闭后的全量重置）；
 * 会话未收束（拉取 / 对比 / 待确认 / 应用中）一律视为进行中；done 段按
 * 应用结果计数——applied＝实际落应用事务的服务数，failed＝拉取或对比
 * 失败（skipped）的服务数。
 */
function deriveSyncSegment(
  phase: SyncWizardPhase,
  runs: Record<string, ServiceRunState>,
  applying: boolean,
  appliedCount: number,
): SyncSegment {
  if (Object.keys(runs).length === 0) return { tier: 'idle' }
  if (applying || phase === 'running' || phase === 'compare') return { tier: 'running' }
  if (phase === 'done') {
    const failed = Object.values(runs).filter((run) => run.status === 'skipped').length
    return { tier: 'done', applied: appliedCount, failed }
  }
  // select 段带残留 runs（正常流程不可达，向导关闭即全量重置）：按无会话呈现
  return { tier: 'idle' }
}

export function StatusBar() {
  const { t } = useI18n()
  const version = useAppVersion()
  const current = useWorkspacesQuery().data?.items.find((item) => item.isCurrent)
  const syncPhase = useSyncWizardStore((s) => s.phase)
  const syncRuns = useSyncWizardStore((s) => s.runs)
  const syncApplying = useSyncWizardStore((s) => s.applying)
  const appliedCount = Object.keys(useSyncWizardStore((s) => s.applyOutcomes)).length
  const sync = deriveSyncSegment(syncPhase, syncRuns, syncApplying, appliedCount)

  // 固定段（唯一可点击段）：名称从当前空间工作流清单解析（与第五视图同源
  // 同参查询）；固定 id 不在清单（被删自愈）＝解析不出名称，整段不渲染
  const workspaceId = current?.id ?? null
  const pinnedId = useSettingsStore((s) =>
    workspaceId !== null ? s.workflowPins[workspaceId] : undefined,
  )
  const listQuery = useIpcQuery({
    queryKey: workflowKeys.list(workspaceId ?? ''),
    queryFn: () => workflowList(workspaceId!),
    enabled: workspaceId !== null,
  })
  const pinned =
    pinnedId !== undefined ? listQuery.data?.items.find((item) => item.id === pinnedId) : undefined

  const syncText =
    sync.tier === 'running'
      ? t('statusBar.syncRunning')
      : sync.tier === 'done'
        ? sync.failed === 0
          ? t('statusBar.syncDone', { count: sync.applied })
          : sync.applied > 0
            ? t('statusBar.syncPartialFailed', { synced: sync.applied, failed: sync.failed })
            : t('statusBar.syncFailed')
        : null

  return (
    <footer className="flex h-6 shrink-0 items-center gap-2 border-t border-border bg-card px-2 text-micro text-muted-foreground">
      {current ? (
        <span data-testid="statusbar-workspace" className="flex max-w-56 items-center gap-1">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
          <span className="truncate">{current.name}</span>
        </span>
      ) : (
        <span data-testid="statusbar-workspace" className="flex items-center gap-1 text-warning">
          <span aria-hidden className="size-1.5 rounded-full bg-warning" />
          {t('statusBar.workspaceNotSelected')}
        </span>
      )}
      {syncText !== null && (
        <>
          <Separator orientation="vertical" className="h-3" />
          <span
            data-testid="statusbar-sync"
            className={sync.tier === 'done' && sync.failed > 0 ? 'text-destructive' : undefined}
          >
            {syncText}
          </span>
        </>
      )}
      <span className="flex-1" />
      {pinned && (
        <>
          <Separator orientation="vertical" className="h-3" />
          <button
            type="button"
            data-testid="statusbar-pinned"
            aria-label={t('statusBar.pinnedRun')}
            title={pinned.name}
            className="flex max-w-56 min-w-0 cursor-pointer items-center gap-1 text-micro text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => {
              executeWorkflowGuarded({
                workflowId: pinned.id,
                name: pinned.name,
                onIssues: (issues) => {
                  if (issues.length > 0) toast.error(t('workflows.runBlockedByIssues'))
                },
              })
            }}
          >
            <SEMANTIC_ICONS.workflow aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{pinned.name}</span>
          </button>
        </>
      )}
      <Separator orientation="vertical" className="h-3" />
      <span data-testid="statusbar-version" className="font-mono tabular-nums">
        {`v${version}`}
      </span>
    </footer>
  )
}
