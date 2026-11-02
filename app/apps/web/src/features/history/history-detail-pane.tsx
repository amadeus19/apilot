import * as React from 'react'

import {
  Badge,
  Button,
  CopyButton,
  CopySurface,
  DetailContentColumn,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@workspace/ui/components'

import { useI18n, formatBytes, formatDuration } from '@/i18n'
import { SentRequestPane } from '@/features/http/sent-request-pane'
import { isSensitiveHeader, statusCodeClass } from '@/features/http/constants'
import type { RequestSnapshotDto, ResponseSnapshotDto } from '@/features/http/http-api'
import { useIpcQuery } from '@/services/ipc-query'
import { useWorkspacesQuery } from '@/features/workspaces/api'
import { draftSeedFromSnapshot } from '@/features/workbench/history-draft'
import { useDraftStore } from '@/features/workbench/draft.store'
import { useTabsStore } from '@/stores/tabs.store'
import { historyDetailKey, runGetDetail } from './history-api'

/**
 * 历史详情 Tab 的内容页（单例 Tab，runId 由 tabs store 的内容指针注入）：
 * 只读全量留痕——顶部只读声明、「恢复为草稿」动作、大号状态码＋state 徽标＋
 * runId、元信息表、「已发送请求」分区（脱敏回显，复用 http 域掩码与
 * SentRequestPane）、「响应快照」分区、错误 / 取消卡。**记录本体只读、
 * 不触碰 user_data**；恢复动作只做「快照 → 内存草稿副本」（新草稿 Tab），
 * 落库只经草稿的「另存为新接口」转正。接口已删历史行保留（按 runId
 * 直读记录，不依赖树）。
 *
 * runId 原位替换（点击新历史行）＝ queryKey 变化驱动新查询，无本地残留态。
 */

/** 快照形态守卫：request_json 解析失败时后端给 null / 空对象，渲染前收窄防炸 */
function isRequestSnapshot(value: unknown): value is RequestSnapshotDto {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.method === 'string' &&
    typeof record.url === 'string' &&
    Array.isArray(record.headers)
  )
}

/** 响应快照形态守卫（同上） */
function isResponseSnapshot(value: unknown): value is ResponseSnapshotDto {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.status === 'number' && Array.isArray(record.headers)
}

/**
 * 分节：节头（标题＋贯穿 hairline＋右侧槽）＋内容。右侧槽放该节的体量
 * 摘要（truncated 徽标 / 总量），与节标题同行不抢内容区高度。
 */
function Section({
  title,
  trailing,
  children,
}: {
  title: string
  trailing?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2">
        <h2 className="shrink-0 text-micro font-medium text-muted-foreground">{title}</h2>
        <span className="flex-1 border-b border-border/60" aria-hidden />
        {trailing}
      </div>
      {children}
    </section>
  )
}

export function HistoryDetailPane({ runId }: { runId: string }) {
  const { t, formatDateTime } = useI18n()
  const detailQuery = useIpcQuery({
    queryKey: historyDetailKey(runId),
    queryFn: () => runGetDetail(runId),
    // 与列表同域覆写：窗口焦点（focus-bridge）触发重取，全局默认 false 不动
    refetchOnWindowFocus: true,
  })
  const detail = detailQuery.data
  // 响应头脱敏的「显示敏感值」放行（仅展示侧，与实时响应区同款语义）：
  // 随 run 切换重置——上一条记录的放行不默认延续（渲染期调整模式）
  const [seededRunId, setSeededRunId] = React.useState(runId)
  const [revealSecrets, setRevealSecrets] = React.useState(false)
  if (seededRunId !== runId) {
    setSeededRunId(runId)
    setRevealSecrets(false)
  }
  // URL 拆分的 BaseUrl 参照（当前工作空间；清单查询与标题栏共用缓存）
  const { data: workspaces } = useWorkspacesQuery()
  const baseUrl = workspaces?.items.find((workspace) => workspace.isCurrent)?.baseUrl ?? null

  if (detailQuery.isError) {
    return (
      <div className="flex flex-1 items-center justify-center" data-testid="history-detail-error">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t('history.loadFailedTitle')}</EmptyTitle>
            <EmptyDescription>{detailQuery.error.message}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  if (detail === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {t('history.loading')}
      </div>
    )
  }

  // 记录不存在（已被封顶修剪 / 会话残留 runId）：终态空态，不提供重试
  if (detail === null) {
    return (
      <div className="flex flex-1 items-center justify-center" data-testid="history-detail-missing">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t('historyDetail.notFoundTitle')}</EmptyTitle>
            <EmptyDescription>{t('historyDetail.notFoundDescription')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  const request = isRequestSnapshot(detail.request) ? detail.request : null
  const response = isResponseSnapshot(detail.response) ? detail.response : null
  const stateLabel =
    detail.state === 'passed'
      ? t('historyDetail.statePassed')
      : detail.state === 'cancelled'
        ? t('historyDetail.stateCancelled')
        : t('historyDetail.stateFailed')
  // createdAt 解析失败的兜底：显示原串（不炸渲染）
  const createdTs = Date.parse(detail.createdAt)
  // 请求体快照局部收窄：属性窄化不保留进复制口径闭包，先取定值
  const requestBody = request?.body ?? null

  // 恢复动作（快照缺失时禁用）：构造内存草稿副本并开新草稿 Tab——历史
  // 记录与用户数据零改动；落库只经草稿 Tab 的「另存为新接口」转正
  const restoreAsDraft = () => {
    if (!request) return
    const seed = draftSeedFromSnapshot({
      method: request.method,
      url: request.url,
      headers: request.headers,
      bodyExcerpt: request.body?.excerpt ?? null,
      bodyTruncated: request.body?.truncated ?? false,
      sensitiveHeaderNames: request.redactions.headerNames,
      sourceServiceId: detail.serviceId,
      baseUrl,
    })
    const draftId = useTabsStore.getState().openDraft(seed.title)
    useDraftStore.getState().seedDraft(draftId, seed)
  }

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto"
      data-testid="history-detail"
      data-run-id={runId}
    >
      {/* 限宽列：历史详情页形态＝左对齐窄间距（mx-0 gap-4 覆盖详情页默认的
          居中 gap-5——本页无横幅等全宽锚点，拍板形态即靠左限宽） */}
      <DetailContentColumn className="mx-0 gap-4">
        {/* 只读声明行：记录本体只展示；「恢复为草稿」产出内存副本（不落库） */}
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">{t('historyDetail.readOnlyNotice')}</p>
          <Button
            variant="outline"
            size="sm"
            className="h-6 shrink-0 px-2 text-xs"
            disabled={request === null}
            onClick={restoreAsDraft}
            data-testid="history-restore-draft-button"
          >
            {t('historyDetail.restoreAsDraft')}
          </Button>
        </div>

        {/* 状态行：大号状态码＋state 徽章＋runId（等宽小字；复制钮无底色、
            悬浮状态行才显现） */}
        <div className="group/status-row flex items-baseline gap-3">
          <span
            className={`font-mono text-3xl font-semibold tabular-nums ${statusCodeClass(detail.statusCode)}`}
            data-testid="history-detail-status"
          >
            {detail.statusCode === null ? '—' : detail.statusCode}
          </span>
          <Badge
            variant={detail.state === 'failed' ? 'destructive' : 'secondary'}
            className={detail.state === 'passed' ? 'text-success' : undefined}
          >
            {stateLabel}
          </Badge>
          <CopySurface className="flex min-w-0 items-center gap-0.5">
            <span className="min-w-0 truncate font-mono text-micro text-muted-foreground">
              {detail.runId}
            </span>
            <CopyButton
              variant="ghost"
              getText={() => detail.runId}
              aria-label={t('historyDetail.copyRunId')}
              className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/status-row:opacity-100 focus-visible:opacity-100 [&_svg]:size-3"
            />
          </CopySurface>
        </div>

        {/* 错误卡（failed；TIMEOUT 用与响应面板同款文案） / 取消中性卡 */}
        {detail.state === 'failed' && (
          <div
            className="rounded-sm border border-destructive/30 bg-destructive/5 p-3"
            data-testid="history-detail-error-card"
          >
            <p className="text-xs font-medium text-destructive">
              {detail.errorCode === 'TIMEOUT'
                ? t('response.timeoutTitle')
                : t('historyDetail.errorCardTitle')}
            </p>
            {detail.errorCode === 'TIMEOUT' ? (
              <p className="mt-1 text-xs text-muted-foreground">{t('response.timeoutMessage')}</p>
            ) : (
              detail.errorMessage && (
                <p className="mt-1 text-xs text-muted-foreground">{detail.errorMessage}</p>
              )
            )}
            {detail.errorCode && (
              <p className="mt-1 font-mono text-micro text-muted-foreground">{detail.errorCode}</p>
            )}
          </div>
        )}
        {detail.state === 'cancelled' && (
          <div
            className="rounded-sm border border-border p-3"
            data-testid="history-detail-cancelled-card"
          >
            <p className="text-xs font-medium text-muted-foreground">
              {t('historyDetail.stateCancelled')}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{t('historyDetail.cancelledCard')}</p>
          </div>
        )}

        {/* 元信息行：耗时 · 时间 · 来源收拢一行（方法与 URL 只在「已发送请求」
            分区呈现，全页不重复；错误码在错误卡，不再单列） */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            {t('historyDetail.durationLabel')}{' '}
            <span className="font-mono text-foreground/80">
              {detail.durationMs === null ? '—' : formatDuration(detail.durationMs)}
            </span>
          </span>
          <span>
            {t('historyDetail.timeLabel')}{' '}
            <span className="font-mono text-foreground/80">
              {Number.isNaN(createdTs) ? detail.createdAt : formatDateTime(createdTs)}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            {t('historyDetail.sourceLabel')}
            <span className="rounded-sm border border-border px-1 font-mono text-micro leading-4">
              {detail.source === 'cli' ? t('history.sourceCli') : t('history.sourceGui')}
            </span>
          </span>
        </div>

        {/* 已发送请求（节头＋卡：SentRequestPane 承载方法＋最终 URL＋headers
            与脱敏回显；请求体为卡内尾随分区） */}
        <Section title={t('historyDetail.sectionRequest')}>
          {request ? (
            <div className="rounded-md border bg-card" data-testid="history-detail-request">
              <SentRequestPane request={request} />
              {requestBody && (
                <div className="flex flex-col gap-2 border-t border-border px-3 py-3">
                  <div className="flex items-center gap-2">
                    <h3 className="text-xs font-medium text-muted-foreground">
                      {t('historyDetail.requestBody')}
                    </h3>
                    {requestBody.truncated && (
                      <Badge variant="secondary">{t('response.truncated')}</Badge>
                    )}
                    <span className="text-micro text-muted-foreground">
                      {formatBytes(requestBody.totalSize)}
                    </span>
                  </div>
                  <CopySurface getText={() => requestBody.excerpt}>
                    <pre className="max-h-40 overflow-auto rounded-sm bg-muted/50 p-2 font-mono text-xs break-words whitespace-pre-wrap">
                      {requestBody.excerpt}
                    </pre>
                  </CopySurface>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t('historyDetail.noSnapshot')}</p>
          )}
        </Section>

        {/* 响应快照（failed / cancelled 无快照：虚线空态） */}
        <Section
          title={t('historyDetail.sectionResponse')}
          trailing={
            response ? (
              <>
                {response.body.truncated && (
                  <Badge variant="secondary">{t('response.truncated')}</Badge>
                )}
                <span className="text-micro text-muted-foreground">
                  {formatBytes(response.body.totalSize)}
                </span>
              </>
            ) : undefined
          }
        >
          {response ? (
            <div
              className="flex flex-col gap-2 rounded-md border bg-card p-3"
              data-testid="history-detail-response"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`font-mono text-sm font-medium tabular-nums ${statusCodeClass(response.status)}`}
                >
                  {response.status}
                </span>
                {response.contentType && (
                  <span className="min-w-0 truncate font-mono text-micro text-muted-foreground">
                    {response.contentType}
                  </span>
                )}
                {/* 响应头脱敏放行（仅展示侧）：与实时响应区 / 已发送请求同款语义 */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-6 shrink-0 px-2 text-xs"
                  aria-pressed={revealSecrets}
                  onClick={() => setRevealSecrets((prev) => !prev)}
                  data-testid="history-detail-response-reveal"
                >
                  {revealSecrets ? t('response.hideSecrets') : t('response.showSecrets')}
                </Button>
              </div>
              <dl className="flex flex-col gap-0.5">
                {response.headers.map(([name, value], index) => {
                  // 全路径脱敏：敏感头（标准名单＋本次请求 redactions 提示）
                  // 默认掩码且不挂 title 全文；行级复制恒掩码（复制内容可能
                  // 被粘贴到日志 / 工单，不给出泄露通道——与实时区同口径）
                  const sensitive = isSensitiveHeader(name, request?.redactions.headerNames ?? [])
                  const masked = sensitive && !revealSecrets
                  return (
                    <div
                      key={`${index}-${name}`}
                      className="group/header-row flex items-center gap-2 text-xs"
                    >
                      <dt className="w-48 shrink-0 truncate text-muted-foreground" title={name}>
                        {name}
                      </dt>
                      <dd
                        className={`min-w-0 flex-1 truncate font-mono ${masked ? 'text-muted-foreground' : ''}`}
                        title={masked ? undefined : value}
                      >
                        {masked ? '***' : value}
                      </dd>
                      {/* 行级一键复制（悬浮显现；敏感头恒掩码） */}
                      <CopyButton
                        variant="ghost"
                        getText={() => `${name}: ${sensitive ? '***' : value}`}
                        className="size-5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/header-row:opacity-100 focus-visible:opacity-100 [&_svg]:size-3"
                      />
                    </div>
                  )
                })}
              </dl>
              <CopySurface getText={() => response.body.excerpt}>
                <pre className="max-h-80 overflow-auto rounded-sm bg-muted/50 p-2 font-mono text-xs break-words whitespace-pre-wrap">
                  {response.body.excerpt}
                </pre>
              </CopySurface>
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
              {t('historyDetail.noResponse')}
            </div>
          )}
        </Section>
      </DetailContentColumn>
    </div>
  )
}
