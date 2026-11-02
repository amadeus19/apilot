import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { BookOpenTextIcon, ChevronDownIcon, XIcon } from 'lucide-react'

import { Button, Sheet, SheetClose, SheetContent, SheetTitle } from '@workspace/ui/components'

import { MethodBadge } from '@/features/api-tree/method-badge'
import { useI18n } from '@/i18n'
import { invoke } from '@/services/ipc'
import { workbenchKeys } from '@/services/workbench-api'

import { statusCodeClass } from './constants'
import {
  colorizeJsonTokens,
  contentTypeLabel,
  flattenDocSchema,
  generateSample,
  groupParamsByLocation,
  isFormContentType,
  type EndpointDoc,
  type JsonToken,
} from './endpoint-doc-logic'

/**
 * 接口文档预览抽屉：渲染同步接口定义侧文档元数据（`endpoint.doc` IPC 数据源）。
 *
 * 形态：右侧局部锚定抽屉（与接口设置抽屉同
 * 锚定法：portal 宿主＝工作台主区、遮罩只罩主区），宽 540px；分区＝单列
 * 折叠流（摘要 → 参数三小节 → 请求体字段点路径 → 响应状态码手风琴＋
 * 「结构 / 示例」双轨）。JSON 示例轻量着色（不引 Monaco）；状态码色经
 * statusCodeClass 单一事实源。
 *
 * 入口显隐与互斥：入口仅同步接口渲染（手工接口与「另存为新接口」副本隐藏
 * 而非禁用——判定＝稳定键身份，见 [`shouldShowDocEntry`]）；与设置抽屉
 * 按钮并存、抽屉互斥切换（同钮再点收起，见 [`nextExclusiveDrawerState`]）。
 */

const TOKEN_CLASS: Record<JsonToken['kind'], string> = {
  key: 'text-sky-600 dark:text-sky-400',
  string: 'text-emerald-700 dark:text-emerald-400',
  number: 'text-amber-700 dark:text-amber-400',
  literal: 'text-purple-700 dark:text-purple-400',
  punct: 'text-muted-foreground',
}

/** 参数小节标签键（path / query / header；t() 参数须字面量键，不模板拼接） */
const DOC_LOCATION_KEYS = {
  path: 'response.docParamLocation_path',
  query: 'response.docParamLocation_query',
  header: 'response.docParamLocation_header',
} as const

function JsonView({ value }: { value: unknown }) {
  const text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? 'null')
  const tokens = React.useMemo(() => colorizeJsonTokens(text), [text])
  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs leading-5 whitespace-pre">
      {tokens.map((token, index) => (
        <span key={index} className={TOKEN_CLASS[token.kind]}>
          {token.text}
        </span>
      ))}
    </pre>
  )
}

// —— 组件 ——

/** 抽屉宿主：工作台主区容器（与接口设置抽屉同一锚定基准）；缺位兜底 body */
function drawerHost(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  return document.querySelector<HTMLElement>('[data-slot="workbench-main"]') ?? document.body
}

export interface EndpointDocDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 关闭后焦点归还的目标（面包屑文档按钮） */
  focusReturnRef: React.RefObject<HTMLButtonElement | null>
  serviceId: string
  key_: string
  /** 面包屑方法徽章来源（摘要区方法呈现与编辑区同源） */
  method: string
}

export function EndpointDocDrawer({
  open,
  onOpenChange,
  focusReturnRef,
  serviceId,
  key_,
  method,
}: EndpointDocDrawerProps) {
  const { t } = useI18n()
  // 文档数据随抽屉打开才拉取（enabled 门控）；定义侧元数据只在同步应用后
  // 变化，staleTime 放宽到会话级（重开抽屉复用缓存）；同步应用按服务前缀
  // 失效回流（workbenchKeys 单一事实源），打开中的抽屉即时重取更新
  const docQuery = useQuery({
    queryKey: workbenchKeys.endpointDoc(serviceId, key_),
    queryFn: () => invoke<EndpointDoc | null>('endpoint.doc', { serviceId, key: key_ }),
    enabled: open,
    staleTime: Number.POSITIVE_INFINITY,
  })

  const docButtonId = React.useId()
  // 响应手风琴展开集合（默认展开首个状态码）与「结构 / 示例」轨切换
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set())
  const [sampleMode, setSampleMode] = React.useState(true)
  const [prevOpen, setPrevOpen] = React.useState(open)
  // 渲染期调整：每次打开重置手风琴（默认展开首个）与示例轨
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) {
      const first = docQuery.data?.responses[0]?.status
      setExpanded(first ? new Set([first]) : new Set())
      setSampleMode(true)
    }
  }

  // 关闭时焦点归还触发按钮（打开时刻定格归还目标，与设置抽屉同款）
  React.useEffect(() => {
    if (!open) return
    const returnNode = focusReturnRef.current
    return () => returnNode?.focus()
  }, [open, focusReturnRef])

  const toggleStatus = (status: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })
  }

  const doc = docQuery.data
  const paramGroups = doc ? groupParamsByLocation(doc.parameters) : null
  const bodyRows = doc?.requestBody ? flattenDocSchema(doc.requestBody.schema) : []

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        portalContainer={drawerHost() ?? undefined}
        overlayClassName="absolute"
        className="absolute w-[540px] gap-0 sm:max-w-none"
        data-testid="endpoint-doc-drawer"
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
          <BookOpenTextIcon aria-hidden className="size-4 text-muted-foreground" />
          <SheetTitle className="text-sm font-medium">{t('response.docTitle')}</SheetTitle>
          <SheetClose
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto text-muted-foreground"
                aria-label={t('response.docClose')}
              />
            }
          >
            <XIcon aria-hidden />
          </SheetClose>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto p-4" data-testid="endpoint-doc-body">
          {docQuery.isPending && (
            <p className="text-sm text-muted-foreground">{t('response.docLoading')}</p>
          )}
          {docQuery.isError && (
            <p className="text-sm text-destructive">{t('response.docLoadFailed')}</p>
          )}
          {doc === null && !docQuery.isPending && !docQuery.isError && (
            <p className="text-sm text-muted-foreground">{t('response.docEmpty')}</p>
          )}

          {doc && (
            <>
              {/* 摘要：方法徽章 + 路径 mono + 标题 + 描述长文 */}
              <section className="grid gap-1.5" aria-label={t('response.docSummarySection')}>
                <div className="flex items-center gap-2">
                  <MethodBadge method={method} size="md" />
                  <code className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                    {key_.split(' ')[1] ?? ''}
                  </code>
                </div>
                <h3 className="text-sm leading-5 font-medium">{doc.title}</h3>
                {doc.description ? (
                  <p className="text-sm leading-5 whitespace-pre-wrap text-muted-foreground">
                    {doc.description}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground/70">
                    {t('response.docNoDescription')}
                  </p>
                )}
              </section>

              {/* 参数：path / query / header 三小节行式 */}
              {paramGroups &&
                (paramGroups.path.length > 0 ||
                  paramGroups.query.length > 0 ||
                  paramGroups.header.length > 0) && (
                  <section className="grid gap-2" aria-label={t('response.docParamsSection')}>
                    <h4 className="text-xs leading-none font-semibold tracking-wide text-muted-foreground uppercase">
                      {t('response.docParamsSection')}
                    </h4>
                    {(['path', 'query', 'header'] as const).map((location) =>
                      paramGroups[location].length > 0 ? (
                        <div key={location} className="grid gap-1">
                          <span className="text-xs font-medium">
                            {t(DOC_LOCATION_KEYS[location])}
                          </span>
                          {paramGroups[location].map((param) => (
                            <div
                              key={`${location}-${param.name}`}
                              className="grid gap-0.5 rounded-md border border-border px-2 py-1.5"
                              data-testid="endpoint-doc-param"
                            >
                              <span className="flex items-center gap-1.5 font-mono text-xs">
                                {param.required && <span className="text-destructive">*</span>}
                                {param.name}
                                {param.paramType && (
                                  <span className="rounded-sm bg-muted px-1 font-sans text-micro text-muted-foreground">
                                    {param.paramType}
                                  </span>
                                )}
                              </span>
                              {param.description && (
                                <span className="text-xs leading-4 text-muted-foreground">
                                  {param.description}
                                </span>
                              )}
                              {param.example !== undefined && (
                                <span className="font-mono text-micro text-muted-foreground/80">
                                  {t('response.docExamplePrefix')}
                                  {typeof param.example === 'string'
                                    ? param.example
                                    : JSON.stringify(param.example)}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : null,
                    )}
                  </section>
                )}

              {/* 请求体：媒型归一标签 + 字段点路径缩进 */}
              {doc.requestBody ? (
                <section className="grid gap-1.5" aria-label={t('response.docBodySection')}>
                  <h4 className="text-xs leading-none font-semibold tracking-wide text-muted-foreground uppercase">
                    {t('response.docBodySection')}
                  </h4>
                  <span className="font-mono text-xs text-muted-foreground">
                    {contentTypeLabel(doc.requestBody.contentType)}
                  </span>
                  {bodyRows.length === 0 ? (
                    <p className="text-xs text-muted-foreground/70">
                      {t(
                        isFormContentType(doc.requestBody.contentType)
                          ? 'response.docBodyFormNoFields'
                          : 'response.docBodyNoFields',
                      )}
                    </p>
                  ) : (
                    <div className="grid gap-0.5" data-testid="endpoint-doc-body-fields">
                      {bodyRows.map((row) => (
                        <div
                          key={row.keyPath}
                          className="flex items-baseline gap-1.5 text-xs"
                          style={{ paddingLeft: `${row.depth * 14}px` }}
                        >
                          <span className="font-mono">
                            {row.required && <span className="text-destructive">*</span>}
                            {row.keyPath.split('.').pop()}
                          </span>
                          <span className="rounded-sm bg-muted px-1 text-micro text-muted-foreground">
                            {row.schemaType}
                          </span>
                          {row.description && (
                            <span className="min-w-0 truncate text-muted-foreground">
                              {row.description}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {/* 示例：文档 example 优先，无 example 时按 schema 生成
                      （响应侧「定义侧 example 回退」同一先例——Swashbuckle
                      类生成器常不emit请求体 example） */}
                  <details className="grid gap-1">
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      {t('response.docBodyExample')}
                    </summary>
                    <JsonView
                      value={doc.requestBody.example ?? generateSample(doc.requestBody.schema)}
                    />
                  </details>
                </section>
              ) : (
                <p className="text-xs text-muted-foreground/70">{t('response.docNoRequestBody')}</p>
              )}

              {/* 响应：状态码手风琴 + 结构/示例双轨 */}
              {doc.responses.length > 0 && (
                <section className="grid gap-1.5" aria-label={t('response.docResponsesSection')}>
                  <h4 className="text-xs leading-none font-semibold tracking-wide text-muted-foreground uppercase">
                    {t('response.docResponsesSection')}
                  </h4>
                  {doc.responses.map((response) => {
                    const statusNumber = Number.parseInt(response.status, 10)
                    const isOpen = expanded.has(response.status)
                    return (
                      <div key={response.status} className="rounded-md border border-border">
                        <button
                          type="button"
                          id={`${docButtonId}-${response.status}`}
                          aria-expanded={isOpen}
                          onClick={() => toggleStatus(response.status)}
                          className="flex h-8 w-full items-center gap-2 px-2 text-left"
                          data-testid="endpoint-doc-status"
                        >
                          <ChevronDownIcon
                            aria-hidden
                            className={`size-3.5 text-muted-foreground transition-transform ${isOpen ? '' : '-rotate-90'}`}
                          />
                          <span
                            className={`font-mono text-xs font-medium ${statusCodeClass(Number.isNaN(statusNumber) ? null : statusNumber)}`}
                          >
                            {response.status}
                          </span>
                          {response.description && (
                            <span className="min-w-0 truncate text-xs text-muted-foreground">
                              {response.description}
                            </span>
                          )}
                        </button>
                        {isOpen && (
                          <div className="grid gap-2 border-t border-border px-2 py-2">
                            {response.schema ? (
                              <>
                                <div
                                  role="tablist"
                                  aria-label={t('response.docResponseTrack')}
                                  className="flex gap-1 text-xs"
                                >
                                  {([true, false] as const).map((isSample) => (
                                    <button
                                      key={String(isSample)}
                                      type="button"
                                      role="tab"
                                      aria-selected={sampleMode === isSample}
                                      onClick={() => setSampleMode(isSample)}
                                      className={`rounded-sm px-1.5 py-0.5 ${sampleMode === isSample ? 'bg-muted font-medium' : 'text-muted-foreground'}`}
                                    >
                                      {t(
                                        isSample
                                          ? 'response.docTrackSample'
                                          : 'response.docTrackStructure',
                                      )}
                                    </button>
                                  ))}
                                </div>
                                {sampleMode ? (
                                  <div className="grid gap-1">
                                    <span className="text-micro text-muted-foreground/80">
                                      {t(
                                        response.example !== undefined
                                          ? 'response.docSourceDefined'
                                          : 'response.docSourceGenerated',
                                      )}
                                    </span>
                                    <JsonView
                                      value={response.example ?? generateSample(response.schema)}
                                    />
                                  </div>
                                ) : (
                                  <div className="grid gap-0.5">
                                    {flattenDocSchema(response.schema).map((row) => (
                                      <div
                                        key={row.keyPath}
                                        className="flex items-baseline gap-1.5 text-xs"
                                        style={{ paddingLeft: `${row.depth * 14}px` }}
                                      >
                                        <span className="font-mono">
                                          {row.required && (
                                            <span className="text-destructive">*</span>
                                          )}
                                          {row.keyPath}
                                        </span>
                                        <span className="rounded-sm bg-muted px-1 text-micro text-muted-foreground">
                                          {row.schemaType}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </>
                            ) : (
                              <p className="text-xs text-muted-foreground/70">
                                {t('response.docResponseNoBody')}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </section>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
