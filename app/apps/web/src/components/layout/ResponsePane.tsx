import * as React from 'react'
import { ChevronDownIcon, ChevronUpIcon, Loader2Icon, RadioTowerIcon } from 'lucide-react'

import {
  Badge,
  Button,
  CopyButton,
  CopySurface,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  Input,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@workspace/ui/components'

import { formatBytes, formatDuration, useI18n } from '@/i18n'
import { selectActiveTab, useTabsStore } from '@/stores/tabs.store'
import { useAppStore } from '@/stores/app.store'
import { isTimeoutFailure } from '@/features/http/send-state'
import { isSensitiveHeader, statusCodeClass } from '@/features/http/constants'
import { useResponseStore, type ResponseEntry } from '@/features/http/response.store'
import { ResponseBodyPane } from '@/features/http/response-body-pane'
import { SentRequestPane } from '@/features/http/sent-request-pane'
import { SsePanel } from '@/features/http/sse-panel'
import { VariablePreview } from '@/features/http/variable-preview'
import { buildSendArgs, runSend } from '@/features/http/send-bridge'
import { useWorkspacesQuery } from '@/features/workspaces/api'
import { HeaderVariableButton } from '@/features/variables/header-variable-button'
import type { RunResultDto } from '@/features/http/http-api'

import { collapseResponsePanel, expandResponsePanel } from './panel-bridge'

/**
 * 响应区：结果态＝页签带同排承载状态（线型页签 Body / Headers 计数 / 已
 * 发送请求 ＋ 右侧状态摘要，无独立头行）；空态＝单行标题＋收起键；发送中
 * / 失败 / 取消与 SSE 流式视图保留面板头行形态。折叠态＝36px 条带，点击
 * 条带经 imperative expand() 恢复原高。
 *
 * 状态摘要（页签带右区 / 头行右区）：落定＝状态码语义着色（2xx 绿 / 4xx
 * 琥珀 / 5xx 红 / 无响应灰）＋耗时＋响应大小＋内存分级徽标；发送中＝标题
 * 旁进行中指示＋实时累计耗时（不进右区）。错误三分在内容区呈现：TIMEOUT 专属卡（含设置
 * 入口）、其他失败错误卡、取消中性提示；面板不被取消清空（cancelled 保留
 * 上次可展示结果，Body 区照旧、页签带右区回显「已取消」）。空态带「发送
 * 请求」动作（经草稿桥取当前编辑器草稿直接发送，与流式重放同一取值通道）。
 */

/**
 * 线型页签触发项样式（响应区页签带）：常态＝常规字重灰字、选中转主题色
 * 并加粗（底座默认所有项 font-medium 且选中只到 text-foreground，以同属性
 * 覆盖）。末一条 after:bottom-[-4px] 是强调条对齐：底座把 2px 强调条挂在
 * 触发项下方 5px，而触发项底边距页签带底线正好 4px，改为 -4px 后强调条
 * 下沿与底线重合、正好覆盖当前项那一段底线。
 */
const LINE_TAB_TRIGGER =
  'font-normal text-muted-foreground data-active:font-medium data-active:text-primary dark:data-active:text-primary group-data-horizontal/tabs:after:bottom-[-4px]'

/** 发送中的实时累计耗时（startedAt 起算，100ms 步进刷新） */
function SendingElapsed({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (startedAt === null) return
    const timer = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(timer)
  }, [startedAt])
  const elapsed = startedAt === null ? 0 : Math.max(0, now - startedAt)
  return (
    <span className="text-micro text-muted-foreground tabular-nums">{formatDuration(elapsed)}</span>
  )
}

/** Headers 过滤防抖窗口（输入停顿后才重算过滤列表） */
const HEADERS_FILTER_DEBOUNCE_MS = 250

/** 状态摘要（落定态）：状态码着色＋耗时＋大小＋分级徽标 */
function StatusSummary({ result }: { result: RunResultDto }) {
  const { t } = useI18n()
  const status = result.statusCode
  // 分级徽标三分：文件档（responseId 凭据）＝全文（文件）；内存档（DTO 携带
  // 全量字节）＝全文（内存）；两者皆无＝超大响应只留前缀片段，＝预览
  const response = result.response
  const tier =
    result.responseId !== null
      ? 'file'
      : response?.body.rawBase64 !== undefined
        ? 'memory'
        : 'preview'
  const tierLabelKey =
    tier === 'file'
      ? 'response.tierFullFile'
      : tier === 'memory'
        ? 'response.tierFullMemory'
        : 'response.tierPreview'
  const tierHintKey =
    tier === 'file'
      ? 'response.tierFullFileHint'
      : tier === 'memory'
        ? 'response.tierFullMemoryHint'
        : 'response.tierPreviewHint'
  return (
    <>
      <span
        className={`font-mono text-xs font-medium tabular-nums ${statusCodeClass(status)}`}
        data-testid="response-status-code"
      >
        {status ?? t('response.noResponse')}
      </span>
      {result.durationMs !== null && (
        <span className="text-micro text-muted-foreground tabular-nums">
          {formatDuration(result.durationMs)}
        </span>
      )}
      {response && (
        <>
          <span className="text-micro text-muted-foreground tabular-nums">
            {formatBytes(response.body.totalSize)}
          </span>
          <Badge variant="outline" className="h-4 px-1.5 text-micro" title={t(tierHintKey)}>
            {t(tierLabelKey)}
          </Badge>
        </>
      )}
    </>
  )
}

/** 错误三分：超时专属卡（设置入口）/ 其他失败错误卡 / 取消中性提示 */
function ErrorCard({ entry }: { entry: ResponseEntry }) {
  const { t } = useI18n()
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)

  if (entry.phase === 'cancelled') {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyDescription>{t('response.cancelled')}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  // 错误来源优先级：invoke 层失败（请求未发出）→ RunResult 的 errorCode
  const errorCode = entry.error?.code ?? entry.result?.errorCode ?? 'UNKNOWN'
  const errorMessage = entry.error?.message ?? entry.result?.errorMessage ?? ''

  if (isTimeoutFailure(entry.phase, errorCode)) {
    return (
      <div
        className="m-3 rounded-md border border-warning/40 bg-warning/5 p-3"
        role="alert"
        data-testid="response-timeout-card"
      >
        <p className="text-sm font-medium text-warning">{t('response.timeoutTitle')}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t('response.timeoutMessage')}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-2 h-6 px-2 text-xs"
          onClick={() => setSettingsOpen(true, 'http')}
        >
          {t('response.timeoutOpenSettings')}
        </Button>
      </div>
    )
  }

  return (
    <div
      className="m-3 rounded-md border border-destructive/40 bg-destructive/5 p-3"
      role="alert"
      data-testid="response-error-card"
    >
      <p className="text-sm font-medium text-destructive">{t('response.errorTitle')}</p>
      <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
        {errorCode} · {errorMessage}
      </p>
    </div>
  )
}

/** 流式重放入口（头行 / 页签带右区共用）：事件流响应且流未在进行时出现 */
function StreamReplayButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-6 shrink-0 px-2 text-xs"
      onClick={onClick}
      data-testid="response-stream-button"
    >
      <RadioTowerIcon aria-hidden className="size-3.5" />
      {label}
    </Button>
  )
}

export function ResponsePane() {
  const { t } = useI18n()
  const collapsed = useAppStore((s) => s.responseCollapsed)
  const activeTab = useTabsStore(selectActiveTab)
  // 「存为变量」的写入目标空间（响应面板只在 endpoint Tab 呈现，工作空间
  // 恒有 current；无 current 的防御态＝不出存变量按钮）
  const currentWorkspaceId =
    useWorkspacesQuery().data?.items.find((item) => item.isCurrent)?.id ?? null
  const tabId = activeTab?.kind === 'endpoint' ? activeTab.id : null
  const entry = useResponseStore((s) => (tabId !== null ? s.entries[tabId] : undefined))
  const stream = useResponseStore((s) => (tabId !== null ? s.streams[tabId] : undefined))
  const startStream = useResponseStore((s) => s.startStream)

  const phase = entry?.phase ?? 'idle'
  const result = entry?.result ?? null

  // —— Headers 过滤（草稿/已提交分持：输入即时回显，停顿 250ms 才重算过
  //    滤列表；ResponsePane 常驻不随 Tab 卸载，过滤随 tabId+runId 变化在
  //    渲染期重置——切 Tab 与新响应到达都是新过滤场景）——
  const [headerFilterDraft, setHeaderFilterDraft] = React.useState('')
  const [headerFilter, setHeaderFilter] = React.useState('')
  const headerFilterTimerRef = React.useRef(0)
  // 敏感头「显示敏感值」放行（仅展示侧；复制口径恒掩码，与已发送请求面板
  // 同构）：随 Tab / 响应场景一并重置——上一场景的放行不默认延续到新场景
  const [revealSecrets, setRevealSecrets] = React.useState(false)
  const filterSeedKey = tabId === null ? null : `${tabId}:${result?.runId ?? ''}`
  const [filterSeed, setFilterSeed] = React.useState<string | null>(filterSeedKey)
  if (filterSeed !== filterSeedKey) {
    setFilterSeed(filterSeedKey)
    setHeaderFilterDraft('')
    setHeaderFilter('')
    setRevealSecrets(false)
  }
  // 防抖窗口内切 Tab / 新响应到达：丢弃 pending 提交（防旧值落进新场景）
  React.useEffect(() => {
    return () => window.clearTimeout(headerFilterTimerRef.current)
  }, [filterSeedKey])

  const handleHeaderFilterInput = (value: string) => {
    setHeaderFilterDraft(value)
    window.clearTimeout(headerFilterTimerRef.current)
    headerFilterTimerRef.current = window.setTimeout(() => {
      headerFilterTimerRef.current = 0
      setHeaderFilter(value)
    }, HEADERS_FILTER_DEBOUNCE_MS)
  }
  // 「流式」重放入口：最近响应是事件流时可切 SSE 渐进渲染链路（重放以
  // 编辑器当前草稿为准，经发送草稿桥取值）
  const streamable =
    result?.response?.contentType?.toLowerCase().includes('text/event-stream') === true

  const handleStream = () => {
    if (tabId === null || !activeTab?.serviceId || !activeTab.key) return
    const args = buildSendArgs({ tabId, serviceId: activeTab.serviceId, key: activeTab.key })
    if (!args) return
    void startStream(tabId, args)
  }

  // 空态「发送请求」：与流式重放同经草稿桥取当前编辑器草稿发送（发送
  // 三态与历史失效统一在 runSend；草稿未就绪＝无操作，不报错）
  const handleSendFromEmpty = () => {
    if (tabId === null || !activeTab?.serviceId || !activeTab.key) return
    const args = buildSendArgs({ tabId, serviceId: activeTab.serviceId, key: activeTab.key })
    if (!args) return
    void runSend(args)
  }

  if (collapsed) {
    return (
      <button
        type="button"
        className="flex h-full w-full items-center gap-2 border-t border-border px-3 text-left transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
        aria-label={t('shell.responseExpandLabel')}
        onClick={expandResponsePanel}
      >
        <span className="text-xs font-medium text-foreground">{t('shell.responseTitle')}</span>
        <span className="text-micro text-muted-foreground">{t('shell.responseStatusLabel')}</span>
        <ChevronUpIcon aria-hidden className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
      </button>
    )
  }

  // 内容优先级：SSE 流视图（最近动作是流式接收）＞ 错误三分（failed 恒无
  // 响应体；cancelled 无历史结果时中性提示）＞ 三分区（passed / cancelled
  // 保留的上次结果；sending 不进页签带——重发期间旧结果让位，状态行恒为
  // 「发送中＋计时」，与首发一致）＞ 空态
  const showSse = tabId !== null && stream !== undefined
  const showError = entry !== undefined && phase === 'failed'
  const showCancelledEmpty = entry !== undefined && phase === 'cancelled' && result === null
  const showTabs = result !== null && !showSse && !showError && phase !== 'sending'
  // 空态标题行：无发送记录（idle）且无流视图——单行标题＋收起键常显
  const showEmptyHeader = phase === 'idle' && !showSse
  const streamReplayButton = streamable && stream?.phase !== 'streaming' && (
    <StreamReplayButton onClick={handleStream} label={t('response.streamButton')} />
  )

  if (showTabs && result) {
    // Headers 过滤（仅前端）：子串、大小写不敏感；空查询恒全显
    const filterQuery = headerFilter.trim().toLowerCase()
    const visibleHeaders = (result.response?.headers ?? []).filter(
      ([name, value]) =>
        name.toLowerCase().includes(filterQuery) || value.toLowerCase().includes(filterQuery),
    )
    return (
      <Tabs defaultValue="body" className="flex h-full min-h-0 flex-col gap-0">
        {/* 页签带：线型页签＋右区并排状态摘要（cancelled 回显已取消）、流式
            入口与收起键（ChevronDown ghost，常显于最右端）。底线全宽通栏；
            行内 px-3 与请求区页签带同基准——TabsList 左内边归零，激活线
            起点＝行内容左缘（与地址栏起点同口径） */}
        <div
          className="flex h-8 shrink-0 items-center border-b border-border px-3"
          data-testid="response-tab-strip"
        >
          <TabsList variant="line" className="pl-0">
            <TabsTrigger value="body" className={LINE_TAB_TRIGGER}>
              Body
            </TabsTrigger>
            <TabsTrigger value="headers" className={LINE_TAB_TRIGGER}>
              Headers
              <span className="font-mono text-deco text-muted-foreground">
                {result.response?.headers.length ?? 0}
              </span>
            </TabsTrigger>
            <TabsTrigger value="sent" className={LINE_TAB_TRIGGER}>
              {t('response.sentRequest')}
            </TabsTrigger>
          </TabsList>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {phase === 'cancelled' ? (
              <span className="text-xs text-muted-foreground">{t('response.cancelled')}</span>
            ) : (
              <StatusSummary result={result} />
            )}
            {streamReplayButton}
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground"
              aria-label={t('shell.responseCollapseLabel')}
              onClick={collapseResponsePanel}
              data-testid="response-collapse-button"
            >
              <ChevronDownIcon aria-hidden />
            </Button>
          </div>
        </div>
        <TabsContent value="body" className="min-h-0 flex-1">
          {tabId !== null && <ResponseBodyPane result={result} tabId={tabId} />}
        </TabsContent>
        <TabsContent value="headers" className="flex min-h-0 flex-col">
          {/* 工具行与 Body 视图同构：敏感值放行切换＋过滤输入（仅前端过滤）＋
              复制口径＝每行 name: value（敏感头值掩码，与已发送请求面板同口径） */}
          <div className="mx-3 mt-2 flex h-8 shrink-0 items-center justify-end gap-2 border-b border-border">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              aria-pressed={revealSecrets}
              onClick={() => setRevealSecrets((prev) => !prev)}
              data-testid="response-headers-reveal"
            >
              {revealSecrets ? t('response.hideSecrets') : t('response.showSecrets')}
            </Button>
            <Input
              value={headerFilterDraft}
              onChange={(event) => handleHeaderFilterInput(event.target.value)}
              placeholder={t('response.headersFilterPlaceholder')}
              aria-label={t('response.headersFilterLabel')}
              spellCheck={false}
              className="h-6 w-44 text-xs"
              data-testid="response-headers-filter"
            />
            <CopyButton
              variant="ghost"
              className="h-6 px-2 text-xs"
              label={t('response.copyAllHeaders')}
              title={t('response.copyAllHeadersHint')}
              getText={() =>
                (result.response?.headers ?? [])
                  .map(([name, value]) => {
                    const sensitive = isSensitiveHeader(name, result.request.redactions.headerNames)
                    return `${name}: ${sensitive ? '***' : value}`
                  })
                  .join('\n')
              }
            />
          </div>
          <CopySurface className="min-h-0 flex-1 overflow-y-auto">
            <dl className="flex flex-col gap-0.5 p-3" data-testid="response-headers">
              {/* 展示默认脱敏（全路径脱敏纪律）：敏感头值渲染 *** 且不挂
                  title 全文；「显示敏感值」仅放行本面板展示。「存为变量」
                  ＝key 名即入口（悬浮高亮主题色、点击弹浮层；敏感头默认勾
                  Secret；存值恒明文——变量值明文入库，脱敏只约束展示与复制
                  面）。无工作空间防御态退回纯展示 key */}
              {visibleHeaders.map(([name, value], index) => {
                const sensitive = isSensitiveHeader(name, result.request.redactions.headerNames)
                const masked = sensitive && !revealSecrets
                return (
                  <div key={`${index}-${name}`} className="flex gap-2 text-xs">
                    {currentWorkspaceId !== null ? (
                      <HeaderVariableButton
                        workspaceId={currentWorkspaceId}
                        headerName={name}
                        headerValue={value}
                        defaultSecret={sensitive}
                      />
                    ) : (
                      <dt className="w-48 shrink-0 truncate text-muted-foreground" title={name}>
                        {name}
                      </dt>
                    )}
                    <dd
                      className={`min-w-0 flex-1 truncate font-mono ${
                        masked ? 'text-muted-foreground' : ''
                      }`}
                      title={masked ? undefined : value}
                    >
                      {masked ? '***' : value}
                    </dd>
                  </div>
                )
              })}
              {visibleHeaders.length === 0 && (
                <div className="text-xs text-muted-foreground">
                  {t('response.headersFilterEmpty')}
                </div>
              )}
            </dl>
          </CopySurface>
        </TabsContent>
        <TabsContent value="sent" className="min-h-0 flex-1 overflow-y-auto">
          <SentRequestPane request={result.request} />
          {/* 变量解析预览（发送前确认命中情况）：resolved 信息随发送响应附带，
              无独立 IPC；与镜像回显同页签呈现 */}
          <VariablePreview resolved={result.resolved} />
        </TabsContent>
      </Tabs>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col border-t">
      {showEmptyHeader ? (
        // 空态标题行：单行标题＋右端收起键（常显），与三态头行同构
        <div
          className="flex h-9 shrink-0 items-center border-b border-border px-3"
          data-testid="response-empty-header"
        >
          <span className="text-xs font-medium">{t('shell.responseTitle')}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto shrink-0 text-muted-foreground"
            aria-label={t('shell.responseCollapseLabel')}
            onClick={collapseResponsePanel}
            data-testid="response-collapse-button"
          >
            <ChevronDownIcon aria-hidden />
          </Button>
        </div>
      ) : (
        // 发送中 / 失败 / 取消（无结果）／ SSE 流视图：保留面板头行形态。
        // 发送中指示跟随标题（左）；状态摘要、流式入口与收起键整组 ml-auto
        // 贴右（与页签带右区同构），不随流式入口在场与否改变对齐
        <div
          className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3"
          data-testid="response-header"
        >
          <span className="text-xs font-medium">{t('shell.responseTitle')}</span>
          {phase === 'sending' && (
            <>
              <Loader2Icon aria-hidden className="size-3.5 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">{t('response.sending')}</span>
              <SendingElapsed startedAt={entry?.startedAt ?? null} />
            </>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {phase === 'cancelled' && (
              <span className="text-xs text-muted-foreground">{t('response.cancelled')}</span>
            )}
            {(phase === 'done' || phase === 'failed') &&
              (result ? (
                <StatusSummary result={result} />
              ) : (
                <span className="text-xs text-muted-foreground">{t('response.noResponse')}</span>
              ))}
            {streamReplayButton}
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground"
              aria-label={t('shell.responseCollapseLabel')}
              onClick={collapseResponsePanel}
            >
              <ChevronDownIcon aria-hidden />
            </Button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {showSse && tabId !== null && stream ? (
          <SsePanel tabId={tabId} stream={stream} />
        ) : showError && entry ? (
          <ErrorCard entry={entry} />
        ) : showCancelledEmpty && entry ? (
          <ErrorCard entry={entry} />
        ) : phase === 'sending' ? (
          // 发送中占位：只留安静提示，不放动作按钮——「发送请求」CTA 在在途
          // 期间语义不明（点它是再发一次而非取消；取消入口在地址栏按钮）
          <p
            className="grid h-full place-items-center text-xs text-muted-foreground"
            data-testid="response-waiting"
          >
            {t('response.waitingResponse')}
          </p>
        ) : (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyDescription>{t('shell.responseEmptyDescription')}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                variant="outline"
                data-testid="response-empty-send"
                onClick={handleSendFromEmpty}
              >
                {t('response.emptySendCta')}
              </Button>
            </EmptyContent>
          </Empty>
        )}
      </div>
    </div>
  )
}
