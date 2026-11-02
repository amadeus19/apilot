import * as React from 'react'

import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@workspace/ui/components'

import { useI18n } from '@/i18n'
import { selectResolvedTheme, useSettingsStore } from '@/stores/settings.store'
import { useTabsStore, type TabMeta } from '@/stores/tabs.store'
import { HTTP_METHODS } from '@/lib/http-methods'
import { MethodBadge } from '@/features/api-tree/method-badge'
import { METHOD_TRIGGER_CLASS } from '@/features/api-tree/method-trigger-class'
import { isSensitiveHeader } from '@/features/http/constants'
import { useWorkspacesQuery } from '@/features/workspaces/api'
import { cn } from 'cn'
import { parseKvRows, type KvRowType } from './kv-rows'
import { KvEditor } from './kv-editor'
import { isPathTemplateShapeValid } from './history-draft'
import { useDraftStore } from './draft.store'
import { usePromoteDraft } from './draft-promotion'
import {
  isFormBodyKind,
  isTextBodyKind,
  parseBodyDraft,
  parsesJson,
  serializeBodyDraft,
  type BodyKind,
} from './body-envelope'
import { BodyTypeRow } from './body-type-row'
import { useXmlFormat } from './use-xml-format'

/** Monaco 文本编辑器底座懒加载：未进入文本系 Body 视图不进任何 chunk */
const MonacoTextEditor = React.lazy(() =>
  import('@/features/http/monaco-text-editor').then((m) => ({ default: m.MonacoTextEditor })),
)

/** 参数行（query/path）的类型集：表单值不承载文件（与接口编辑器同口径） */
const PARAM_ROW_TYPES: readonly KvRowType[] = [
  'string',
  'integer',
  'boolean',
  'number',
  'array',
  'object',
]

/**
 * 草稿 Tab 编辑器（历史恢复的无实体草稿）：URL 行（方法 / 路径模板）＋
 * Params / Body / Headers 三页签。编辑只写内存草稿 store（不落库——恢复
 * 是「以历史为模板的新草稿」，落库只经「另存为新接口」转正动作）；
 * 敏感头按名单掩码显示、值保留（用户自己的凭据），揭示后可编辑。
 * 无 ⋯菜单与设置抽屉（无实体可删可设）；Auth / 超时不随快照回填，
 * 转正后由接口编辑器显式配置。
 */

export function DraftEditor({ tab }: { tab: TabMeta }) {
  const { t } = useI18n()
  const draft = useDraftStore((s) => s.drafts[tab.id])

  // 页签选中态按 tabId 记忆（tabs store，与接口编辑器共用通道）
  const editorTab = useTabsStore((s) => s.editorTabs[tab.id] ?? 'params')
  const setEditorTab = useTabsStore((s) => s.setEditorTab)

  // 敏感值揭示（Headers 页签局部会话态）
  const [revealHeaders, setRevealHeaders] = React.useState(false)

  // 转正在途标记：防重复点击（IPC 两步非原子）
  const [promoting, setPromoting] = React.useState(false)
  const promoteDraft = usePromoteDraft()

  const update = React.useCallback(
    (patch: Partial<NonNullable<typeof draft>>) => {
      const current = useDraftStore.getState().drafts[tab.id]
      if (!current) return
      useDraftStore.getState().updateDraft(tab.id, { ...current, ...patch })
    },
    [tab.id],
  )

  // resolved 主题供 Monaco 文本系编辑面
  const resolvedTheme = useSettingsStore(selectResolvedTheme)
  const [bodyWordWrap, setBodyWordWrap] = React.useState(false)
  const bodyView = React.useMemo(() => parseBodyDraft(draft?.body ?? null), [draft?.body])

  // 变量联想的工作空间上下文（当前工作空间；无工作空间面不启用）
  const { data: workspaces } = useWorkspacesQuery()
  const suggestWorkspaceId = workspaces?.items.find((w) => w.isCurrent)?.id ?? null

  // —— Body 格式化分派（hooks 段）：json 走主线程同步重排；xml 经共享
  //    worker 缩进规整（请求 / 响应两侧同一格式化入口）——
  const formatXmlText = useXmlFormat()
  // xml 异步回写的存活守卫（ref 只在 effect 与回调读写，不参与渲染输出）：
  // 组件卸载（关 Tab / 切走视图）后不再写回草稿；格式化在途草稿已前进
  // （键击 / 切类型）时保持现状不改写
  const aliveRef = React.useRef(true)
  const draftBodyRef = React.useRef<string | null>(draft?.body ?? null)
  React.useEffect(() => {
    aliveRef.current = true
    draftBodyRef.current = draft?.body ?? null
    return () => {
      aliveRef.current = false
    }
  }, [draft?.body])

  if (!draft) {
    return (
      <div
        data-testid="draft-editor-loading"
        className="flex flex-1 items-center justify-center text-sm text-muted-foreground"
      >
        {tab.title}
      </div>
    )
  }

  const templateValid = isPathTemplateShapeValid(draft.pathTemplate)

  const changeBodyKind = (kind: BodyKind) => {
    update({ body: serializeBodyDraft({ kind, text: bodyView.text, rows: bodyView.rows }) })
  }
  const updateBodyText = (text: string) => {
    update({ body: serializeBodyDraft({ kind: bodyView.kind, text, rows: bodyView.rows }) })
  }
  const updateBodyRows = (json: string) => {
    // KvEditor 行模式输出恒为合法 name/value JSON；解析失败保持原行（数据保真）
    const rows = parseKvRows(json) ?? bodyView.rows
    update({ body: serializeBodyDraft({ kind: bodyView.kind, text: bodyView.text, rows }) })
  }
  // 格式化可用性按类型派生：json 需内容解析合法；xml 内容非空即可（XML 无
  // 解析失败概念，畸形输入由格式化器原样返回）。hint 只对禁用原因不同的
  // 类型给出（与接口编辑器同口径）
  const formatEnabled =
    bodyView.kind === 'xml'
      ? bodyView.text.trim() !== ''
      : bodyView.kind === 'json' && bodyView.text.trim() !== '' && parsesJson(bodyView.text)
  const formatHint =
    bodyView.kind === 'text'
      ? t('editor.bodyFormatHintPlainText')
      : bodyView.kind === 'xml' || formatEnabled
        ? null
        : t('editor.bodyFormatHintInvalidJson')
  const formatBodyJson = () => {
    if (bodyView.kind !== 'json') return
    try {
      const parsed: unknown = JSON.parse(bodyView.text)
      updateBodyText(JSON.stringify(parsed, null, 2))
    } catch {
      // 解析合法才可点（按钮禁用兜底）；竞态键击时保持原文不改写
    }
  }
  const formatBody = () => {
    if (bodyView.kind === 'xml') {
      if (bodyView.text.trim() === '') return
      const textAtClick = bodyView.text
      const bodyAtClick = draft?.body ?? null
      void formatXmlText(textAtClick).then((formatted) => {
        // 畸形输入原样返回（与原文相等）不产生改写与编辑事件
        if (formatted === textAtClick) return
        if (!aliveRef.current || draftBodyRef.current !== bodyAtClick) return
        updateBodyText(formatted)
      })
      return
    }
    formatBodyJson()
  }

  const handleSaveAsEndpoint = async () => {
    setPromoting(true)
    try {
      await promoteDraft(tab.id)
    } finally {
      setPromoting(false)
    }
  }

  const sensitiveExtra = draft.sensitiveHeaderNames

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="draft-editor">
      {/* 顶部行：草稿来源说明（无定位面包屑——草稿无实体可定位） */}
      <div
        data-testid="draft-editor-header"
        className="flex h-8 shrink-0 items-center border-b border-border px-3 text-xs text-muted-foreground"
      >
        {t('editor.draftHeaderNotice')}
      </div>

      {/* URL 行：方法（七选）＋ 路径模板＋ 另存为新接口（转正） */}
      <div
        data-testid="draft-editor-url-row"
        className="flex h-10 shrink-0 items-center gap-2 px-3"
      >
        {/* 触发器＝方法徽章本身（浅底深字，与接口编辑器地址栏同构，下拉
            箭头包在色块内、随字色） */}
        <Select value={draft.method} onValueChange={(value) => update({ method: value ?? 'GET' })}>
          <SelectTrigger
            size="sm"
            className={cn(
              'shrink-0 rounded-md border-none px-2 font-mono text-[13px] font-medium tracking-wide uppercase shadow-none [&>svg:last-child]:size-3 [&>svg:last-child]:text-current',
              METHOD_TRIGGER_CLASS[draft.method],
            )}
            aria-label={t('apiTree.endpointMethodLabel')}
          >
            <SelectValue>
              {(value: string) => <span className="font-mono">{value}</span>}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {HTTP_METHODS.map((method) => (
              <SelectItem key={method} value={method}>
                {/* 选项行不带底色（悬浮高亮归菜单行 focus 底），大字号彩字 */}
                <MethodBadge method={method} size="lg" />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={draft.pathTemplate}
          onChange={(event) => update({ pathTemplate: event.target.value })}
          aria-label={t('apiTree.endpointPathLabel')}
          className="h-7 min-w-0 flex-1 font-mono text-xs"
        />
        <Button
          size="sm"
          className="ml-auto shrink-0"
          disabled={!templateValid || promoting}
          onClick={() => void handleSaveAsEndpoint()}
          data-testid="draft-save-as-endpoint"
        >
          {t('editor.saveAsEndpoint')}
        </Button>
      </div>

      <Tabs
        value={editorTab}
        onValueChange={(value) => setEditorTab(tab.id, value ?? 'params')}
        className="flex min-h-0 flex-1 flex-col gap-0"
        data-testid="draft-editor-form"
      >
        <div className="shrink-0 border-y border-border px-3" data-testid="draft-editor-tab-strip">
          <TabsList variant="line" className="pl-0">
            <TabsTrigger value="params">Params</TabsTrigger>
            <TabsTrigger value="body">Body</TabsTrigger>
            <TabsTrigger value="headers">Headers</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="params" className="min-h-0 flex-1 overflow-y-auto">
          <KvEditor
            json={draft.paramsJson}
            onChange={(json) => update({ paramsJson: json })}
            allowedTypes={PARAM_ROW_TYPES}
          />
        </TabsContent>
        <TabsContent value="body" className="flex min-h-0 flex-1 flex-col">
          {draft.bodyTruncated && (
            <p
              className="px-3 pt-2 text-micro text-muted-foreground"
              data-testid="draft-body-truncated"
            >
              {t('editor.draftBodyTruncatedNotice')}
            </p>
          )}
          <BodyTypeRow
            kind={bodyView.kind}
            onKindChange={changeBodyKind}
            formatEnabled={formatEnabled}
            formatHint={formatHint}
            onFormat={formatBody}
            wordWrap={bodyWordWrap}
            onWordWrapChange={setBodyWordWrap}
          />
          {bodyView.kind === 'none' ? (
            <div
              className="grid min-h-0 flex-1 place-items-center px-6 text-center text-xs text-muted-foreground"
              data-testid="draft-body-empty"
            >
              {t('editor.bodyEmpty')}
            </div>
          ) : isFormBodyKind(bodyView.kind) ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <KvEditor
                json={JSON.stringify(bodyView.rows)}
                onChange={updateBodyRows}
                allowedTypes={PARAM_ROW_TYPES}
              />
            </div>
          ) : isTextBodyKind(bodyView.kind) ? (
            <div className="relative min-h-0 flex-1 overflow-hidden">
              <div className="absolute inset-0">
                <React.Suspense fallback={null}>
                  <MonacoTextEditor
                    value={bodyView.text}
                    language={
                      bodyView.kind === 'json'
                        ? 'json'
                        : bodyView.kind === 'xml'
                          ? 'xml'
                          : 'plaintext'
                    }
                    theme={resolvedTheme}
                    wordWrap={bodyWordWrap}
                    onChange={updateBodyText}
                    variableSuggest={
                      suggestWorkspaceId === null ? null : { workspaceId: suggestWorkspaceId }
                    }
                  />
                </React.Suspense>
              </div>
            </div>
          ) : null}
        </TabsContent>
        <TabsContent value="headers" className="min-h-0 flex-1 overflow-y-auto">
          {/* 敏感头掩码行：名单命中值显示 ***（数据保留），揭示后可编辑 */}
          <div
            className="flex items-center justify-between gap-2 px-3 pt-2"
            data-testid="draft-headers-notice"
          >
            <p className="text-micro text-muted-foreground">{t('editor.headersMaskedHint')}</p>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-2 text-xs text-muted-foreground"
              onClick={() => setRevealHeaders((reveal) => !reveal)}
            >
              {revealHeaders ? t('editor.hideSecrets') : t('editor.showSecrets')}
            </Button>
          </div>
          <KvEditor
            json={draft.headersJson}
            onChange={(json) => update({ headersJson: json })}
            maskValueOf={(name) => isSensitiveHeader(name, sensitiveExtra)}
            revealValues={revealHeaders}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
