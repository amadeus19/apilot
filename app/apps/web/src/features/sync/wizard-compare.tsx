/**
 * 同步向导确认段（重心）：统计页签＋清单（行级勾选默认全选——应用按勾选集
 * 只落勾选行）＋行内展开明细。统计页签＝汇总与分组的融合面：三组计数只
 * 在页签上出现一次（选中组＝着色芯片形态，未选组灰字带计数），一次只呈现
 * 一组清单。明细按 2026-10-05 定案的 Monaco 混合案——参数 / 响应页签
 * DiffEditor 全量替代，请求体页签＝Schema diff 折叠区（参数与请求体在应用
 * 事务内静默对齐，无裁决面）；新增行＝轻定义卡片、移除行＝用户数据保留卡
 * （均不用 diff）。
 *
 * 拉取失败的服务呈现逐行失败明细（全跳过＝独立失败面、部分跳过＝清单后
 * 失败小节），行级「重试」重走单服务拉取→对比；应用前零落盘副作用（底部
 * 常驻预览承诺条）；应用＝按勾选集逐服务 sync.apply，完成后 store.phase 转
 * done、壳层切完成段。
 */

import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  RotateCwIcon,
  ShieldCheckIcon,
  XCircleIcon,
} from 'lucide-react'

import {
  Badge,
  Button,
  Checkbox,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@workspace/ui/components'
import { cn } from 'cn'

import { useI18n } from '@/i18n'
import { reportError } from '@/services/error-center'
import { selectResolvedTheme, useSettingsStore } from '@/stores/settings.store'
import { useSyncWizardStore, type ServiceRunState } from '@/stores/sync.store'
import { MethodBadge } from '@/features/api-tree/method-badge'
import { useIpcQuery } from '@/services/ipc-query'
import {
  workflowEndpointUsage,
  workflowKeys,
  type WorkflowRefUsageDto,
} from '@/features/workflow/workflow-api'
import { useCurrentWorkspaceTreeQuery } from '@/features/workspaces/api'
import { KIND_META } from './kind-meta'
import { useSyncServiceOptions } from './wizard-data'

import type { EndpointDiff } from './diff-contract'
import {
  aggregateTotals,
  bodySchemaJsonText,
  changeCounts,
  groupDiffsByKind,
  paramsJsonText,
  responsesJsonText,
  splitStableKey,
} from './diff-json'

/** Monaco diff 底座懒加载：未展开明细不进任何 chunk */
const MonacoDiffEditor = React.lazy(() =>
  import('./monaco-diff-editor').then((m) => ({ default: m.MonacoDiffEditor })),
)

export function CompareStep() {
  const { t } = useI18n()
  const runs = useSyncWizardStore((s) => s.runs)
  const applying = useSyncWizardStore((s) => s.applying)
  const applyAll = useSyncWizardStore((s) => s.applyAll)
  const retryService = useSyncWizardStore((s) => s.retryService)
  const closeWizard = useSyncWizardStore((s) => s.closeWizard)
  const queryClient = useQueryClient()
  const services = useSyncServiceOptions()
  const serviceNames = new Map(services.map((s) => [s.id, s.name]))

  // 接口粒度勾选用排除式集合（rowId → 是否被取消勾选）：默认全选语义下
  // 重试新成功的键无需补录即勾选
  const [unchecked, setUnchecked] = React.useState<ReadonlySet<string>>(new Set())
  const toggleChecked = (rowId: string) => {
    setUnchecked((prev) => {
      const next = new Set(prev)
      if (next.has(rowId)) next.delete(rowId)
      else next.add(rowId)
      return next
    })
  }

  // 行内展开明细（跨组共享：切组不丢展开态）
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set())
  const toggleExpanded = (rowId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(rowId)) next.delete(rowId)
      else next.add(rowId)
      return next
    })
  }

  // 拉取 / 对比成功的 run 必带 diff（store 状态机：转 ok 即写入 diff）
  const okDiffs = Object.entries(runs)
    .filter(([, run]) => run.status === 'ok')
    .flatMap(([, run]) => (run.diff ? [run.diff] : []))
  const skippedEntries = Object.entries(runs).filter(([, run]) => run.status === 'skipped')
  const skippedCount = skippedEntries.length

  const addedRows = groupDiffsByKind(okDiffs, 'added')
  const changedRows = groupDiffsByKind(okDiffs, 'changed')
  const removedRows = groupDiffsByKind(okDiffs, 'removed')
  const allRows = [...addedRows, ...changedRows, ...removedRows]
  const rowsOfGroup = { added: addedRows, changed: changedRows, removed: removedRows }

  // 「将删除」行的引用计数（提示不阻断：反查在途 / 失败时行尾无徽章，
  // 应用照常可用；悬停徽章列出引用工作流名）。键集每渲染重算（轻量
  // flatMap）；queryKey 由 TanStack Query 结构化比较，内容不变即命中缓存
  const { workspaceId } = useCurrentWorkspaceTreeQuery()
  const removedKeys = [
    ...new Set(
      okDiffs.flatMap((outcome) =>
        outcome.diffs.filter((d) => d.kind === 'removed').map((d) => d.key),
      ),
    ),
  ]
  const usageQuery = useIpcQuery({
    queryKey: workflowKeys.endpointUsage(workspaceId ?? '', removedKeys),
    queryFn: () => workflowEndpointUsage(workspaceId ?? '', removedKeys),
    enabled: workspaceId !== null && removedKeys.length > 0,
  })
  const usageByKey = usageQuery.data

  // 统计页签：当前呈现组（清单一次一组；勾选集跨组累计）。默认落在首个
  // 非空组——无新增时直接呈现变更 / 移除，不落空清单
  const [groupTab, setGroupTab] = React.useState<EndpointDiff['kind']>(() =>
    addedRows.length > 0 ? 'added' : changedRows.length > 0 ? 'changed' : 'removed',
  )

  // 应用载荷＝勾选行按服务归并的稳定键集（空集服务不进载荷＝不写）
  const selections: Record<string, string[]> = {}
  let checkedCount = 0
  for (const { serviceId, diff } of allRows) {
    if (unchecked.has(rowIdOf(serviceId, diff.key))) continue
    ;(selections[serviceId] ??= []).push(diff.key)
    checkedCount += 1
  }

  const totals = aggregateTotals(okDiffs)
  const changeTotal = totals.added + totals.changed + totals.removed

  const apply = () => {
    // queryClient 随行注入：applyAll 逐服务成功即失效其用户数据查询前缀
    void applyAll(selections, queryClient)
      .then(() => {
        // 应用已落库：树面（徽标）全量失效重取（完成段呈现归壳层）
        void queryClient.invalidateQueries()
      })
      .catch((err) => reportError(err))
  }

  // 全部跳过（拉取 / 对比失败）：不是「无变化」——呈现逐服务失败原因＋
  // 行级重试（曾因误呈现「无变化」让首次同步看似无路可走）
  if (okDiffs.length === 0 && Object.keys(runs).length > 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="wizard-all-skipped">
        <p className="px-6 py-2 text-center text-sm text-muted-foreground">
          {t('sync.wizard.allSkippedTitle')}
        </p>
        <ul className="min-h-0 flex-1 overflow-y-auto px-6">
          {Object.entries(runs).map(([serviceId, run]) => (
            <SkippedRow
              key={serviceId}
              serviceId={serviceId}
              name={serviceNames.get(serviceId) ?? serviceId}
              run={run}
              onRetry={() => void retryService(serviceId)}
            />
          ))}
        </ul>
        <p className="px-6 pb-2 text-xs text-muted-foreground">{t('sync.wizard.allSkippedHint')}</p>
        <div className="flex h-[52px] shrink-0 items-center justify-end gap-3 border-t px-6">
          <Button variant="outline" size="sm" onClick={closeWizard}>
            {t('sync.wizard.closeWizardButton')}
          </Button>
        </div>
      </div>
    )
  }

  // 无差异终态：所选项与快照一致 → 无应用按钮。成功服务全部无变化但
  // 存在拉取失败时是混合终态——失败清单与行级重试不得被「无变化」吞掉
  if (changeTotal === 0) {
    if (skippedCount > 0) {
      return (
        <div className="flex min-h-0 flex-1 flex-col" data-testid="wizard-no-changes-skipped">
          <p className="px-6 py-2 text-center text-sm text-muted-foreground">
            {t('sync.wizard.noChangesSkippedTitle', {
              services: okDiffs.length,
              skipped: skippedCount,
            })}
          </p>
          <ul className="min-h-0 flex-1 overflow-y-auto px-6">
            {skippedEntries.map(([serviceId, run]) => (
              <SkippedRow
                key={serviceId}
                serviceId={serviceId}
                name={serviceNames.get(serviceId) ?? serviceId}
                run={run}
                onRetry={() => void retryService(serviceId)}
              />
            ))}
          </ul>
          <div className="flex h-[52px] shrink-0 items-center justify-end gap-3 border-t px-6">
            <Button size="sm" onClick={closeWizard}>
              {t('sync.wizard.finishButton')}
            </Button>
          </div>
        </div>
      )
    }
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="wizard-no-changes">
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <p className="text-center text-sm text-muted-foreground">{t('sync.wizard.noChanges')}</p>
        </div>
        <div className="flex h-[52px] shrink-0 items-center justify-end gap-3 border-t px-6">
          <Button size="sm" onClick={closeWizard}>
            {t('sync.wizard.finishButton')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="wizard-compare">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-3">
        {/* 统计页签：汇总与分组融合——计数只出现一次（选中组＝着色芯片，
            未选组灰字带计数）；右侧勾选计数随行勾选即时收敛 */}
        <div className="flex items-center gap-1">
          {(Object.keys(KIND_META) as EndpointDiff['kind'][]).map((kind) => {
            const meta = KIND_META[kind]
            const active = groupTab === kind
            return (
              <button
                key={kind}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`wizard-tab-${kind}`}
                onClick={() => setGroupTab(kind)}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors',
                  active
                    ? cn('font-medium', meta.bg, meta.text)
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
              >
                <span
                  aria-hidden
                  className={cn('font-mono text-[11px] font-semibold', active && meta.text)}
                >
                  {meta.symbol}
                </span>
                {t(meta.labelKey)}
                <span
                  className={cn(
                    'font-mono font-semibold tabular-nums',
                    active ? meta.text : 'text-muted-foreground',
                  )}
                >
                  {totals[kind]}
                </span>
              </button>
            )
          })}
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">
            {t('sync.wizard.compareSelectedCount', {
              checked: checkedCount,
              total: allRows.length,
            })}
          </span>
        </div>
        <div className="flex items-center justify-between px-1 py-2">
          <span className="text-[11px] text-muted-foreground">
            {/* MergeVerdictSummary / interface 无 index signature，逐字段展开喂 t() */}
            {t('sync.wizard.summarySecondary', {
              unchanged: totals.unchanged,
              skipped: skippedCount,
            })}
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <ShieldCheckIcon aria-hidden className="size-3" />
            {t('sync.wizard.promiseData')}
          </span>
        </div>

        {/* 当前组清单（一次一组；行级勾选默认全选） */}
        <ul
          className="flex flex-col divide-y rounded-md border"
          data-testid={`wizard-group-${groupTab}`}
        >
          {rowsOfGroup[groupTab].map(({ serviceId, diff }) => {
            const rowId = rowIdOf(serviceId, diff.key)
            return (
              <li key={rowId}>
                <EndpointRow
                  serviceId={serviceId}
                  serviceName={serviceNames.get(serviceId) ?? serviceId}
                  diff={diff}
                  expanded={expanded.has(rowId)}
                  onToggle={() => toggleExpanded(rowId)}
                  checked={!unchecked.has(rowId)}
                  onCheckedChange={() => toggleChecked(rowId)}
                  usage={diff.kind === 'removed' ? usageByKey?.[diff.key] : undefined}
                />
              </li>
            )
          })}
        </ul>
        {/* 部分跳过：失败小节与清单同区滚动，行级重试与全跳过面共用 */}
        {skippedCount > 0 && (
          <section className="mt-2 mb-2" data-testid="wizard-skipped-section">
            <h3 className="px-1 py-1 text-xs font-medium text-destructive">
              {t('sync.wizard.skippedSection')}
            </h3>
            <ul className="flex flex-col">
              {skippedEntries.map(([serviceId, run]) => (
                <SkippedRow
                  key={serviceId}
                  serviceId={serviceId}
                  name={serviceNames.get(serviceId) ?? serviceId}
                  run={run}
                  onRetry={() => void retryService(serviceId)}
                />
              ))}
            </ul>
          </section>
        )}
      </div>

      <div className="flex h-[52px] shrink-0 items-center gap-3 border-t px-6">
        {/* 提示恒在左侧、不与动作按钮同侧混排（避免挤占与误读操作区） */}
        <span className="text-xs text-muted-foreground">{t('sync.wizard.previewBar')}</span>
        <span className="text-xs text-muted-foreground/70">{t('sync.wizard.closeHint')}</span>
        <span className="flex-1" />
        <Button size="sm" disabled={applying || checkedCount === 0} onClick={apply}>
          {applying
            ? t('sync.wizard.applying')
            : t('sync.wizard.applyButton', { count: checkedCount })}
        </Button>
      </div>
    </div>
  )
}

/** 确认段行的稳定标识（服务 × 稳定键；跨服务同名键不混淆） */
function rowIdOf(serviceId: string, key: string): string {
  return `${serviceId}\n${key}`
}

function EndpointRow({
  serviceId,
  serviceName,
  diff,
  expanded,
  onToggle,
  checked,
  onCheckedChange,
  usage,
}: {
  serviceId: string
  serviceName: string
  diff: EndpointDiff
  expanded: boolean
  onToggle: () => void
  checked: boolean
  onCheckedChange: () => void
  /** 「将删除」行的引用工作流清单（其余组不传；空 / 在途＝无徽章） */
  usage?: WorkflowRefUsageDto[]
}) {
  const { t } = useI18n()
  const { method, path } = splitStableKey(diff.key)
  const counts = changeCounts(diff)
  const changeTotal = counts.added + counts.removed + counts.changed
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon

  return (
    <div className="rounded-md" data-endpoint-key={diff.key} data-service-id={serviceId}>
      {/* 勾选独立于展开按钮：交互元素不嵌套，勾选不触发明细展开 */}
      <div className="flex items-center gap-1 px-2">
        <Checkbox
          checked={checked}
          onCheckedChange={onCheckedChange}
          aria-label={`${t('sync.wizard.rowCheckLabel')}：${method} ${path}`}
          data-testid="wizard-row-check"
        />
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1.5 text-left text-sm hover:bg-accent/50"
        >
          <Chevron className="size-3.5 shrink-0 text-muted-foreground" />
          <MethodBadge method={method} />
          <span className="shrink-0 font-mono text-xs">{path}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {diff.title}
          </span>
          {usage != null && usage.length > 0 && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className="shrink-0 cursor-default rounded-sm bg-destructive/10 px-1 py-0.5 font-mono text-[11px] text-destructive"
                    data-testid="wizard-removed-usage"
                  >
                    {t('sync.wizard.removedUsageCount', { count: usage.length })}
                  </span>
                }
              />
              <TooltipContent>{usage.map((row) => row.workflowName).join('、')}</TooltipContent>
            </Tooltip>
          )}
          {changeTotal > 0 && (
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              {t('sync.wizard.changeChip', counts)}
            </span>
          )}
        </button>
      </div>
      {expanded && (
        <div className="ml-4">
          <p className="px-1 text-[11px] text-muted-foreground/70">{serviceName}</p>
          <EndpointDetail diff={diff} />
        </div>
      )}
    </div>
  )
}

/** 拉取失败行（全跳过面与部分跳过小节共用）：失败原因＋行级重试；重试中
 *  呈现进行态、按钮禁用保留占位（不隐藏——防行尾宽度跳动；重试完成面随
 *  runs 即时收敛） */
function SkippedRow({
  serviceId,
  name,
  run,
  onRetry,
}: {
  serviceId: string
  name: string
  run: ServiceRunState
  onRetry: () => void
}) {
  const { t } = useI18n()
  const retrying = run.status === 'fetching' || run.status === 'diffing'
  return (
    <li
      className="flex items-center gap-2 border-b border-border/40 px-1 py-2 text-xs last:border-b-0"
      data-service-id={serviceId}
      data-status={run.status}
    >
      {retrying ? (
        <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <XCircleIcon className="size-3.5 shrink-0 text-destructive" />
      )}
      <span className="shrink-0 font-medium">{name}</span>
      <span className="min-w-0 flex-1 truncate text-destructive">
        {retrying
          ? t('sync.wizard.runFetching')
          : (run.errorMessage ?? t('sync.wizard.runSkipped'))}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 shrink-0 px-2 text-xs"
        disabled={retrying}
        onClick={onRetry}
      >
        <RotateCwIcon className="size-3" />
        {t('sync.wizard.retryButton')}
      </Button>
    </li>
  )
}

// —— 明细（三页签 / 轻卡 / 保留卡）——

function EndpointDetail({ diff }: { diff: EndpointDiff }) {
  if (diff.kind === 'added') return <AddedLightCard diff={diff} />
  if (diff.kind === 'removed') return <RemovedKeepCard />
  return <ChangedTabs diff={diff} />
}

/** 新增＝轻定义卡片（方法＋路径＋分类＋摘要计数；不用 diff） */
function AddedLightCard({ diff }: { diff: EndpointDiff }) {
  const { t } = useI18n()
  const { method, path } = splitStableKey(diff.key)
  return (
    <div
      className="mb-1 flex flex-col gap-1 rounded-md border bg-muted/30 p-2 text-xs"
      data-testid="added-card"
    >
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="text-[11px] text-success">
          {t('sync.wizard.lightCardLabel')}
        </Badge>
        <MethodBadge method={method} />
        <span className="font-mono">{path}</span>
        {diff.category && <span className="text-muted-foreground">{diff.category}</span>}
      </div>
      <div className="flex gap-3 text-muted-foreground">
        <span>{t('sync.wizard.lightCardParams', { count: diff.params.length })}</span>
        <span>{t('sync.wizard.lightCardBodyKeys', { count: diff.bodyKeys.length })}</span>
        <span>{t('sync.wizard.lightCardResponses', { count: diff.responses.length })}</span>
      </div>
    </div>
  )
}

/** 已移除＝用户数据保留卡（承诺文案；数据统计面不进向导契约） */
function RemovedKeepCard() {
  const { t } = useI18n()
  return (
    <div className="mb-1 flex flex-col gap-1 rounded-md border p-2 text-xs" data-testid="keep-card">
      <span className="font-medium">{t('sync.wizard.keepCardTitle')}</span>
      <span className="text-muted-foreground">{t('sync.wizard.keepCardBody')}</span>
    </div>
  )
}

/** 变更＝三页签（参数 / 请求体 / 响应）Monaco 混合案 */
function ChangedTabs({ diff }: { diff: EndpointDiff }) {
  const { t } = useI18n()
  const params = paramsJsonText(diff.params)
  const responses = responsesJsonText(diff.responses)
  return (
    <Tabs defaultValue="params" className="mb-2">
      <TabsList>
        <TabsTrigger value="params">{t('sync.wizard.tabParams')}</TabsTrigger>
        <TabsTrigger value="body">{t('sync.wizard.tabBody')}</TabsTrigger>
        <TabsTrigger value="responses">{t('sync.wizard.tabResponses')}</TabsTrigger>
      </TabsList>
      <TabsContent value="params">
        <DiffPane original={params.original} modified={params.modified} testId="params-diff" />
      </TabsContent>
      <TabsContent value="body">
        <BodyTab diff={diff} />
      </TabsContent>
      <TabsContent value="responses">
        <DiffPane
          original={responses.original}
          modified={responses.modified}
          testId="responses-diff"
        />
      </TabsContent>
    </Tabs>
  )
}

/** DiffEditor 懒加载容器（Suspense 边界在展开点；两侧同文＝空态页签） */
function DiffPane({
  original,
  modified,
  testId,
}: {
  original: string
  modified: string
  testId: string
}) {
  const { t } = useI18n()
  const theme = useSettingsStore(selectResolvedTheme)
  if (original === modified) {
    return (
      <p className="px-2 py-4 text-center text-xs text-muted-foreground">
        {t('sync.wizard.emptyTab')}
      </p>
    )
  }
  return (
    <div className="h-64 overflow-hidden rounded-md border" data-testid={testId}>
      <React.Suspense fallback={<DiffLoading />}>
        <MonacoDiffEditor original={original} modified={modified} language="json" theme={theme} />
      </React.Suspense>
    </div>
  )
}

function DiffLoading() {
  const { t } = useI18n()
  return (
    <div
      className="flex h-64 items-center justify-center text-xs text-muted-foreground"
      role="status"
    >
      …{/* 裸省略号对屏幕阅读器不可读：sr-only 补进行中文案 */}
      <span className="sr-only">{t('sync.wizard.diffLoading')}</span>
    </div>
  )
}

/** 请求体页签：Schema diff 折叠区（参数与请求体在应用事务内静默对齐） */
function BodyTab({ diff }: { diff: EndpointDiff }) {
  const { t } = useI18n()
  const schema = bodySchemaJsonText(diff.bodyKeys)
  const schemaChanged = schema.original !== schema.modified

  return (
    <div className="flex flex-col gap-2">
      {schemaChanged ? (
        <details className="rounded-md border">
          <summary className="cursor-pointer px-2 py-1.5 text-xs text-muted-foreground">
            {t('sync.wizard.schemaSection')}
          </summary>
          <div className="border-t">
            <DiffPane original={schema.original} modified={schema.modified} testId="schema-diff" />
          </div>
        </details>
      ) : (
        <EmptyTabNote />
      )}
    </div>
  )
}

function EmptyTabNote() {
  const { t } = useI18n()
  return (
    <p className={cn('px-2 py-4 text-center text-xs text-muted-foreground')}>
      {t('sync.wizard.emptyTab')}
    </p>
  )
}
