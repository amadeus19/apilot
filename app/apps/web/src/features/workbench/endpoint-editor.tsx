import * as React from 'react'

import { BookOpenTextIcon, ChevronRightIcon, MoreHorizontalIcon, Settings2Icon } from 'lucide-react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  copyTextWithFeedback,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
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
  useUiText,
} from '@workspace/ui/components'
import { cn } from 'cn'

import { useI18n, type DictKey } from '@/i18n'
import { reportError } from '@/services/error-center'
import { toIpcError } from '@/services/ipc'
import { useIpcQuery } from '@/services/ipc-query'
import { selectResolvedTheme, useSettingsStore } from '@/stores/settings.store'
import {
  userDataGet,
  userDataUpsert,
  workbenchKeys,
  type EndpointNodeDto,
  type ManualEndpointInput,
  type ServiceNodeDto,
  type TreeDto,
  type UserDataDto,
} from '@/services/workbench-api'
import { useTabsStore, type TabMeta } from '@/stores/tabs.store'
import { useCurrentWorkspaceTreeQuery, useWorkspacesQuery } from '@/features/workspaces/api'
import { MethodBadge } from '@/features/api-tree/method-badge'
import { METHOD_TRIGGER_CLASS } from '@/features/api-tree/method-trigger-class'
import { useTreeMutations } from '@/features/api-tree/use-tree-mutations'
import { SEMANTIC_ICONS } from '@/features/icons/semantic-icons'
import { BaseUrlOverrideControl } from '@/features/variables/base-url-picker'
import { EnvQuickSwitchControl } from '@/features/variables/env-quick-switch'
import { VariableSuggestInput } from '@/features/variables/variable-suggest'
import {
  convertLiteralToSecret,
  isVariableReference,
} from '@/features/variables/auth-secret-conversion'
import {
  makeCategoryNodeId,
  makeEndpointNodeId,
  makeServiceNodeId,
} from '@/features/api-tree/selector'
import { locateInApiTree } from '@/features/api-tree/tree-locate'
import { useDebouncedWriter } from '@/services/debounced-writer'
import { HTTP_METHODS } from '@/lib/http-methods'
import { httpCancel } from '@/features/http/http-api'
import { nextExclusiveDrawerState, shouldShowDocEntry } from '@/features/http/endpoint-doc-logic'
import { EndpointDocDrawer } from '@/features/http/endpoint-doc-drawer'
import { registerSendDraft, runSend, currentBaseUrlOverride } from '@/features/http/send-bridge'
import { MonacoTextEditor } from '@/features/http/monaco-text-editor'
import { registerSendAction } from './send-action-bridge'
import { useResponseStore } from '@/features/http/response.store'

import { EndpointSettingsDrawer } from './endpoint-settings-drawer'
import { isPathTemplateShapeValid } from './history-draft'
import { serializeCurl } from './curl'
import { CurlImportDialog } from './curl-import-dialog'
import { usePromoteDraftData } from './draft-promotion'
import type { EndpointDraftData } from './draft.store'
import {
  isFormBodyKind,
  isTextBodyKind,
  parseBodyDraft,
  serializeBodyDraft,
  type BodyKind,
} from './body-envelope'
import { BodyTypeRow } from './body-type-row'
import { useXmlFormat } from './use-xml-format'
import { KvEditor } from './kv-editor'
import { parseKvRows, serializeKvRows, type KvRowType } from './kv-rows'
import {
  composeFinalUrl,
  mergeQueryIntoRows,
  parsePastedUrl,
  templatePlaceholders,
} from './url-draft'
import {
  AUTH_NONE,
  authTypeIdOf,
  parseAuthDraft,
  serializeAuthDraft,
  switchAuthType,
  type AuthTypeId,
} from './auth-config'

/** 参数行（query/path）与 x-www-form-urlencoded 行的类型集：表单值不承载
 *  文件，file 不可用 */
const PARAM_ROW_TYPES: readonly KvRowType[] = [
  'string',
  'integer',
  'boolean',
  'number',
  'array',
  'object',
]
/** form-data 行的类型集：参数行全集加 file（file 行当前按文本上线发送） */
const FORM_DATA_ROW_TYPES: readonly KvRowType[] = [...PARAM_ROW_TYPES, 'file']

/** 页签行数徽标（沿响应 Headers 计数样式；0 不显） */
function TabCount({ count }: { count: number }) {
  if (count === 0) return null
  return <span className="font-mono text-deco text-muted-foreground">{count}</span>
}

/**
 * 接口 Tab 编辑器：面包屑行 + URL 行 + 请求编辑表单（Params / Body /
 * Headers / Auth）。面包屑右侧设置按钮进入覆盖式抽屉：手工接口编辑
 * 标题 / 分类 / 超时，同步接口只覆写超时（实体只读，结构来自文档）。
 * 页签标签是领域高频词，恒英文原样（面板标签属领域通用语，不随语言变化）；
 * Auth 页签配置请求级认证（七类型，默认继承工作空间级）。
 *
 * 编辑模型（工作台草稿纪律）：
 * - 草稿＝endpoint_user_data 本身：挂载读一次，编辑实时防抖约 500ms 整包写，
 *   编辑期间不回读（本地状态为真相）；关/切 Tab 与应用退出立即 flush；
 *   例外＝同步应用失效该查询后重取回流：编辑未开始时全列重播种（Tab 按
 *   身份单实例复用，不重播种则对齐结果到不了已开 Tab），已编辑则绝不覆盖；
 * - 手工接口实体编辑（标题 / 方法 / 路径 / 分类，写 endpoints 表）同防抖规则；
 *   同步接口标题与分类锁定（随同步文档更新），路径可编辑＝覆写落草稿
 *   path_override 列（定义侧随文档更新、覆写随用户，发送时覆写优先）；
 * - 接口级超时（null 继承全局 / 0 不限制 / >0 秒）与请求级认证 JSON 归草稿整包写；
 * - 「发送」直传当前草稿给 http.send（后端先落库再发送——防抖未落的部分
 *   以此整包为准）；sending 态按钮变「取消」；预览 TAB 开始编辑自动转正；
 *   发送命令（Ctrl+Enter）经 send-action-bridge 调用与按钮同一动作。
 *
 * Body 草稿信封（契约见 body-envelope）：草稿 body 列的编辑视图渲染期
 * 派生（读侧容忍——legacy 纯文本嗅探回填类型显示，内容不改写）；类型切换
 * 只改信封 kind（两内容载体各自保留，绝不改写文本）；文本系编辑防抖写回
 * 信封。⋯更多菜单＝复制为 cURL（草稿 → bash 命令，URL 用最终组合口径、
 * 认证按发送侧注入规则编入）/ 从 cURL 导入（粘贴解析
 * → 新草稿 Tab，不动用户数据）/ 另存为新接口（转正原语落库、新接口常驻
 * Tab 打开）/ 删除接口：确认后硬删除（连带用户数据同事务）并关本 Tab，
 * 树失效归 useTreeMutations 单一约定。
 */

/** 草稿六列的本地形态（整包写单位） */
interface DraftPayload {
  body: string | null
  params: string
  headers: string
  timeoutSeconds: number | null
  auth: string | null
  /** 路径覆写（null＝跟随定义；同步接口地址栏编辑的落点） */
  pathOverride: string | null
  /** 方法覆写（null＝跟随定义；同步接口方法选择器的落点） */
  methodOverride: string | null
}

/** 手工接口实体表单（防抖写单位） */
interface EntityForm {
  title: string
  method: string
  pathTemplate: string
  categoryId: string | null
}

/** endpoint Tab 的收窄身份（kind='endpoint' 恒携带 serviceId 与 key） */
export type EndpointTabMeta = TabMeta & { serviceId: string; key: string }

/** JSON 解析判定（格式化可用性与嗅探共用；空串视为不合法） */
function parsesJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** headers 草稿播种归一：空对象 `{}`（同步铺行的遗留初值形态，非用户键值
 *  数据）视同空行集 `"[]"`——Headers 页签直接呈现键值表格而非原文保真
 *  提示；行数组 / 非空对象 / 非 JSON 等其余形态原样不动 */
function normalizeSeedHeaders(headers: string | undefined): string {
  const source = headers ?? '[]'
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return source
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    Object.keys(parsed).length === 0
  ) {
    return '[]'
  }
  return source
}

/** 地址栏为完整 http(s):// 链接（绝对地址直发，BaseUrl 与覆写均被绕过） */
function isAbsoluteHttpUrl(template: string): boolean {
  return /^https?:\/\//i.test(template.trim())
}

/** 面包屑行：服务 › 分类 › 标题，段可点击＝在左栏树中定位并选中该节点 */
function BreadcrumbRow({
  service,
  category,
  title,
  endpointIdentity,
}: {
  service: ServiceNodeDto | null
  category: { id: string; name: string } | null
  title: string
  /** 接口身份（标题段定位用；树数据未到时为 null，标题段降级为纯展示） */
  endpointIdentity: { serviceId: string; key: string } | null
}) {
  const { t } = useI18n()
  const locateButton =
    'hover:bg-accent hover:text-foreground text-muted-foreground max-w-44 truncate rounded px-1 py-0.5'
  return (
    <nav
      aria-label={t('editor.breadcrumbLabel')}
      data-testid="endpoint-breadcrumb"
      className="flex min-w-0 flex-1 items-center gap-0.5 text-xs"
    >
      {service && (
        <>
          <button
            type="button"
            className={locateButton}
            title={t('editor.breadcrumbLocateHint', { name: service.name })}
            onClick={() => locateInApiTree(makeServiceNodeId(service.id))}
          >
            {service.name}
          </button>
          <ChevronRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </>
      )}
      {category && (
        <>
          <button
            type="button"
            className={locateButton}
            title={t('editor.breadcrumbLocateHint', { name: category.name })}
            onClick={() => locateInApiTree(makeCategoryNodeId(category.id))}
          >
            {category.name}
          </button>
          <ChevronRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </>
      )}
      {endpointIdentity ? (
        <button
          type="button"
          className={cn(locateButton, 'font-medium text-foreground')}
          title={t('editor.breadcrumbLocateHint', { name: title })}
          onClick={() =>
            locateInApiTree(makeEndpointNodeId(endpointIdentity.serviceId, endpointIdentity.key))
          }
        >
          {title}
        </button>
      ) : (
        <span className="max-w-44 truncate px-1 py-0.5 font-medium">{title}</span>
      )}
    </nav>
  )
}

/** 草稿加载失败空态（重试动作） */
function DraftLoadFailed({ onRetry, message }: { onRetry: () => void; message: string }) {
  const { t } = useI18n()
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyTitle>{t('editor.draftLoadFailedTitle')}</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" onClick={onRetry}>
          {t('editor.retry')}
        </Button>
      </EmptyContent>
    </Empty>
  )
}

/** 请求级认证的七类型（顺序即选择器呈现序：继承 / 不使用在前，具名随后） */
const AUTH_TYPE_IDS: readonly AuthTypeId[] = [
  'inherit',
  'none',
  'bearer',
  'basic',
  'apiKey-header',
  'apiKey-query',
  'apiKey-cookie',
]

/** 七类型的标签键（单选项文案经字典注入；UI 不展示未支持类型） */
const AUTH_TYPE_LABEL_KEYS: Record<AuthTypeId, DictKey> = {
  inherit: 'editor.authTypeInherit',
  none: 'editor.authTypeNone',
  bearer: 'editor.authTypeBearer',
  basic: 'editor.authTypeBasic',
  'apiKey-header': 'editor.authTypeApiKeyHeader',
  'apiKey-query': 'editor.authTypeApiKeyQuery',
  'apiKey-cookie': 'editor.authTypeApiKeyCookie',
}

/**
 * 认证字段行：语义标签 + 输入（字面量或 {{变量}}，等宽紧凑密度）。
 * 凭据值字段（secretVarKey 提供时）带行内「转为 Secret 变量」入口：
 * 值为字面量（非空且非 `{{` 引用）才可转——在目标分类（默认激活分类）
 * 建同名 Secret 变量＋原字段改引用 `{{变量名}}`。
 */
function AuthFieldRow({
  label,
  value,
  placeholder,
  onChange,
  testId,
  secretVarKey,
  workspaceId,
}: {
  label: string
  value: string
  placeholder: string
  onChange: (value: string) => void
  testId: string
  /** 提供时＝凭据字段（转换后的变量名；undefined＝普通字段不渲染入口） */
  secretVarKey?: string
  /** 转换目标归属的工作空间（缺省＝入口不渲染） */
  workspaceId?: string | null
}) {
  const { t } = useI18n()
  const [converting, setConverting] = React.useState(false)
  const convertible =
    secretVarKey !== undefined && value.trim() !== '' && !isVariableReference(value)

  const handleConvert = async () => {
    if (!secretVarKey || !workspaceId || !convertible || converting) return
    setConverting(true)
    try {
      const reference = await convertLiteralToSecret(workspaceId, secretVarKey, value)
      if (reference) onChange(reference)
    } finally {
      setConverting(false)
    }
  }

  return (
    <div className="flex items-center gap-1.5" data-testid={testId}>
      <label className="flex min-w-0 flex-1 items-center gap-2">
        <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          aria-label={label}
          spellCheck={false}
          className="h-7 min-w-0 flex-1 font-mono text-xs"
        />
      </label>
      {secretVarKey !== undefined && workspaceId && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground"
          disabled={!convertible || converting}
          aria-label={t('variables.toSecret.buttonLabel')}
          title={t('variables.toSecret.buttonLabel')}
          data-testid={`${testId}-to-secret`}
          onClick={() => void handleConvert()}
        >
          <SEMANTIC_ICONS.secretConvert aria-hidden />
        </Button>
      )}
    </div>
  )
}

/**
 * Auth 页签：请求级认证配置。类型选择器七项（继承上级＝默认），按类型
 * 渲染字段（Bearer=Token / Basic=Username·Password / API Key=Key·Value，
 * position 由所选类型决定）；继承 / 不使用无字段，给一行说明文字。
 * 编辑即时上抛序列化 JSON（调用方经草稿防抖整包写）。
 */
function AuthPane({
  authJson,
  onChange,
  workspaceId,
}: {
  authJson: string | null
  onChange: (auth: string | null) => void
  /** 转 Secret 变量的目标归属（当前工作空间；null＝入口不渲染） */
  workspaceId: string | null
}) {
  const { t } = useI18n()
  // 解析容错：非法 / 空 JSON 回落继承呈现（不改写用户数据）
  const draft = parseAuthDraft(authJson)
  const typeId = authTypeIdOf(draft)
  const fieldPlaceholder = t('editor.authFieldPlaceholder')
  const selectItems: Record<string, React.ReactNode> = Object.fromEntries(
    AUTH_TYPE_IDS.map((id) => [id, t(AUTH_TYPE_LABEL_KEYS[id])]),
  )
  return (
    <div className="flex flex-col gap-2.5 p-3" data-testid="editor-auth">
      <Select
        items={selectItems}
        value={typeId}
        onValueChange={(value) => {
          const next = AUTH_TYPE_IDS.find((candidate) => candidate === value)
          if (next) onChange(serializeAuthDraft(switchAuthType(draft, next)))
        }}
      >
        <SelectTrigger size="sm" className="w-48" aria-label={t('editor.authTypeLabel')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {AUTH_TYPE_IDS.map((id) => (
            <SelectItem key={id} value={id}>
              {t(AUTH_TYPE_LABEL_KEYS[id])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {draft.type === 'inherit' && (
        <p className="text-xs text-muted-foreground">{t('editor.authInheritHint')}</p>
      )}
      {draft.type === 'none' && (
        <p className="text-xs text-muted-foreground">{t('editor.authNoneHint')}</p>
      )}
      {draft.type === 'bearer' && (
        <AuthFieldRow
          label={t('editor.authTokenLabel')}
          value={draft.token}
          placeholder={fieldPlaceholder}
          onChange={(token) => onChange(serializeAuthDraft({ type: 'bearer', token }))}
          testId="editor-auth-token"
          secretVarKey="token"
          workspaceId={workspaceId}
        />
      )}
      {draft.type === 'basic' && (
        <>
          <AuthFieldRow
            label={t('editor.authUsernameLabel')}
            value={draft.username}
            placeholder={fieldPlaceholder}
            onChange={(username) =>
              onChange(serializeAuthDraft({ type: 'basic', username, password: draft.password }))
            }
            testId="editor-auth-username"
            secretVarKey="username"
            workspaceId={workspaceId}
          />
          <AuthFieldRow
            label={t('editor.authPasswordLabel')}
            value={draft.password}
            placeholder={fieldPlaceholder}
            onChange={(password) =>
              onChange(serializeAuthDraft({ type: 'basic', username: draft.username, password }))
            }
            testId="editor-auth-password"
            secretVarKey="password"
            workspaceId={workspaceId}
          />
        </>
      )}
      {draft.type === 'apiKey' && (
        <>
          <AuthFieldRow
            label={t('editor.authKeyLabel')}
            value={draft.key}
            placeholder={fieldPlaceholder}
            onChange={(key) =>
              onChange(
                serializeAuthDraft({
                  type: 'apiKey',
                  position: draft.position,
                  key,
                  value: draft.value,
                }),
              )
            }
            testId="editor-auth-key"
          />
          <AuthFieldRow
            label={t('editor.authValueLabel')}
            value={draft.value}
            placeholder={fieldPlaceholder}
            onChange={(value) =>
              onChange(
                serializeAuthDraft({
                  type: 'apiKey',
                  position: draft.position,
                  key: draft.key,
                  value,
                }),
              )
            }
            testId="editor-auth-value"
            secretVarKey="apiKeyValue"
            workspaceId={workspaceId}
          />
        </>
      )}
    </div>
  )
}

export function EndpointEditor({ tab }: { tab: EndpointTabMeta }) {
  const { t } = useI18n()
  // 复制类菜单项（⋯菜单「复制为 cURL」）与 CopyButton 共用剪贴板＋toast 实现源
  const uiText = useUiText()
  const { serviceId, key } = tab

  // —— 树全量（与左栏共享缓存）：面包屑、实体初值、分类选项 ——
  const treeQuery = useCurrentWorkspaceTreeQuery()
  const tree: TreeDto | undefined = treeQuery.data
  const service = tree?.services.find((s) => s.id === serviceId) ?? null
  const endpoint: EndpointNodeDto | null = service?.endpoints.find((e) => e.key === key) ?? null
  const isManual = endpoint?.isManual === true
  const category =
    endpoint?.categoryId != null
      ? (service?.categories.find((c) => c.id === endpoint.categoryId) ?? null)
      : null

  // —— 工作空间 BaseUrl 与认证（最终 URL 预览 / cURL 序列化的输入；与发送侧
  //    同源——当前工作空间配置直读，清单查询与树查询共享 ['workspaces'] 缓存） ——
  const { data: workspaces } = useWorkspacesQuery()
  const currentWorkspace = workspaces?.items.find((workspace) => workspace.isCurrent) ?? null
  const baseUrl = currentWorkspace?.baseUrl ?? null

  // —— 草稿：挂载读一次（含恢复），编辑期间不回读 ——
  const userDataQuery = useIpcQuery({
    queryKey: workbenchKeys.userData(serviceId, key),
    queryFn: () => userDataGet(serviceId, key),
    staleTime: Infinity,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  const [draft, setDraft] = React.useState<DraftPayload | null>(null)
  const [draftSeeded, setDraftSeeded] = React.useState(false)
  // 编辑已开始标记（参与播种守卫故用 state；事件回调经 markEditing 置位）
  const [editMarked, setEditMarked] = React.useState(false)
  // 播种来源快照（undefined＝从未播种）：失效重取回流判定基准
  const [seededSource, setSeededSource] = React.useState<UserDataDto | null | undefined>(undefined)
  // 草稿播种（渲染期调整模式）：取数成功且不在在途 refetch 时定初值。
  // 缓存快照先行到达时不播种：重开 Tab 时缓存里是上次挂载的旧值，
  // 挂载 refetch（always）在途期间等到本次取数完成再定初值，
  // 否则关 Tab 前落库的草稿会被缓存旧值锁在外面。
  // 同步应用失效该服务用户数据查询后，重取回流新引用即重播种——仅当
  // 编辑未开始（已编辑草稿绝不被后台同步覆盖，全列以本地为真相）；
  // 无实际变化时结构共享保持原引用，不触发重播种。
  if (userDataQuery.isSuccess && !userDataQuery.isFetching) {
    const dto = userDataQuery.data ?? null
    if (seededSource === undefined || (!editMarked && dto !== seededSource)) {
      setSeededSource(dto)
      if (!draftSeeded) setDraftSeeded(true)
      setDraft({
        body: dto?.body ?? null,
        params: dto?.params ?? '[]',
        headers: normalizeSeedHeaders(dto?.headers),
        timeoutSeconds: dto?.timeoutSeconds ?? null,
        auth: dto?.auth ?? null,
        pathOverride: dto?.pathOverride ?? null,
        methodOverride: dto?.methodOverride ?? null,
      })
    }
  }

  // —— 实体表单：树 DTO 一次性初始化（渲染期调整模式；树刷新不覆盖编辑中的
  //    表单）。手工接口即刻播种（路径＝定义值）；同步接口的路径初值取草稿
  //    覆写（无覆写＝定义值），故等草稿就绪再播种（草稿加载失败也放行——
  //    回落定义值，不阻塞地址栏） ——
  const [entity, setEntity] = React.useState<EntityForm | null>(null)
  if (entity === null && endpoint && (isManual || draftSeeded || userDataQuery.isError)) {
    setEntity({
      title: endpoint.title,
      method:
        isManual || draft?.methodOverride == null
          ? endpoint.definition.method
          : draft.methodOverride,
      pathTemplate:
        isManual || draft?.pathOverride == null
          ? endpoint.definition.pathTemplate
          : draft.pathOverride,
      categoryId: endpoint.categoryId,
    })
  }

  // —— 预览转正：开始编辑（草稿或实体）单次触发 ——
  const promote = useTabsStore((s) => s.promote)
  // 页签选中态按 tabId 记忆（tabs store）：切 Tab 重挂载后恢复上次页签
  const editorTab = useTabsStore((s) => s.editorTabs[tab.id] ?? 'params')
  const setEditorTab = useTabsStore((s) => s.setEditorTab)
  const markEditing = React.useCallback(() => {
    if (editMarked) return
    setEditMarked(true)
    if (tab.preview) promote(tab.id)
  }, [editMarked, tab.preview, tab.id, promote])

  // —— 草稿防抖写（整包五列；mutation 不失效任何 query key） ——
  const draftWriter = useDebouncedWriter<DraftPayload>({
    flusherId: 'endpoint-draft',
    write: (payload) =>
      userDataUpsert(
        serviceId,
        key,
        payload.body,
        payload.params,
        payload.headers,
        payload.timeoutSeconds,
        payload.auth,
        payload.pathOverride,
        payload.methodOverride,
      ).then(() => undefined),
    onError: reportError,
  })
  const updateDraft = (patch: Partial<DraftPayload>) => {
    if (!draft) return
    const next = { ...draft, ...patch }
    setDraft(next)
    markEditing()
    draftWriter.schedule(next)
  }

  // —— Body 草稿信封：编辑视图渲染期纯派生（读侧容忍，内容不改写）——
  // resolved 主题供 Monaco 文本系编辑面
  const resolvedTheme = useSettingsStore(selectResolvedTheme)
  // 自动换行是编辑器视图偏好（本会话本地，不入草稿）
  const [bodyWordWrap, setBodyWordWrap] = React.useState(false)
  const bodyView = React.useMemo(() => parseBodyDraft(draft?.body ?? null), [draft?.body])
  const bodyRowsJson = React.useMemo(() => JSON.stringify(bodyView.rows), [bodyView.rows])
  // 格式化可用性按类型派生：json 需内容解析合法；xml 内容非空即可
  // （XML 无解析失败概念，畸形输入由格式化器原样返回）。hint 只对禁用
  // 原因不同的类型给出：text 无需格式化、json 非法有专提示、xml 无
  // 禁用态提示
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

  /** 类型切换只改信封 kind：两内容载体原样保留（内容属用户数据，绝不改写） */
  const changeBodyKind = (kind: BodyKind) => {
    updateDraft({ body: serializeBodyDraft({ kind, text: bodyView.text, rows: bodyView.rows }) })
  }
  const updateBodyText = (text: string) => {
    updateDraft({
      body: serializeBodyDraft({ kind: bodyView.kind, text, rows: bodyView.rows }),
    })
  }
  const updateBodyRows = (json: string) => {
    // KvEditor 行模式输出恒为合法 name/value JSON；解析失败保持原行（数据保真）
    const rows = parseKvRows(json) ?? bodyView.rows
    updateDraft({ body: serializeBodyDraft({ kind: bodyView.kind, text: bodyView.text, rows }) })
  }
  const formatBodyJson = () => {
    if (bodyView.kind !== 'json') return
    try {
      const parsed: unknown = JSON.parse(bodyView.text)
      updateBodyText(JSON.stringify(parsed, null, 2))
    } catch {
      // 解析合法才可点（按钮禁用兜底）；竞态键击时保持原文不改写
    }
  }

  // —— 页签行数徽标（渲染期纯派生）：Params / Headers 按 KV 行数（原文
  //    模式解析不出行即 0 不显）；Auth 无行概念，按「已配置（类型非继承 /
  //    不使用）＝1」计——与「0 不显」同收敛 ——

  // params 列的行集解析一次共用：徽标计数与最终 URL 预览同一快照
  const previewRows = draft === null ? null : parseKvRows(draft.params)
  const paramsCount = previewRows?.length ?? 0
  const headersCount = draft === null ? 0 : (parseKvRows(draft.headers)?.length ?? 0)
  const authConfigured =
    draft !== null && !['inherit', 'none'].includes(authTypeIdOf(parseAuthDraft(draft.auth)))
  const authCount = authConfigured ? 1 : 0

  // —— 发送链路（http.send 直传当前草稿；后端先落库再发送）——
  const phase = useResponseStore((s) => s.entries[tab.id]?.phase ?? 'idle')

  // 草稿 getter 桥（响应面板「流式」重放取当前防抖前草稿）：ref 承载最新
  // 草稿供异步回调读取（不参与渲染输出，模板 1 写法）
  const draftRef = React.useRef(draft)
  React.useEffect(() => {
    draftRef.current = draft
  })
  React.useEffect(() => registerSendDraft(tab.id, () => draftRef.current), [tab.id])

  // —— Body 格式化分派：json 走 formatBodyJson 的主线程同步重排（实现零
  //    变化）；xml 经共享 worker 缩进规整（请求 / 响应两侧同一格式化入口）——
  const formatXmlText = useXmlFormat()
  // xml 异步回写的存活守卫：组件卸载（关 Tab / 切走视图）后不再写回草稿
  // （ref 只在 effect 与回调读写，不参与渲染输出）
  const aliveRef = React.useRef(true)
  React.useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])
  const formatBody = () => {
    if (bodyView.kind === 'xml') {
      if (bodyView.text.trim() === '') return
      const textAtClick = bodyView.text
      const bodyAtClick = draft?.body ?? null
      void formatXmlText(textAtClick).then((formatted) => {
        // 畸形输入原样返回（与原文相等）不产生改写与编辑事件；异步期间
        // 草稿已前进（键击 / 切类型）时保持现状不改写
        if (formatted === textAtClick) return
        if (!aliveRef.current || (draftRef.current?.body ?? null) !== bodyAtClick) return
        updateBodyText(formatted)
      })
      return
    }
    formatBodyJson()
  }

  const handleSendClick = async () => {
    // sending 态＝取消（按钮语义切换；终态由后端 cancelled RunResult 回写）
    if (phase === 'sending') {
      void httpCancel(tab.id).catch((err) => reportError(toIpcError(err)))
      return
    }
    const payload = draft
    if (!payload) return
    // 发送三态与历史失效的统一编排在 send-bridge（与响应区空态 CTA 共用）；
    // 接口级 BaseUrl 覆写随 invoke 携带（variable store 的 Tab 会话态）
    await runSend({
      serviceId,
      key,
      tabId: tab.id,
      body: payload.body,
      params: payload.params,
      headers: payload.headers,
      timeoutSeconds: payload.timeoutSeconds,
      auth: payload.auth,
      pathOverride: payload.pathOverride,
      methodOverride: payload.methodOverride,
      baseUrlOverride: currentBaseUrlOverride(tab.id),
    })
  }

  // 在途请求生命周期与编辑器挂载解耦：切 Tab 只卸载编辑器组件，不取消
  // 在途发送（Rust 侧任务在 TaskRegistry 按 tabId 登记，结果照常落 store
  // 与 Run Record）。取消仅由三类信号触发：关 Tab 与切工作空间（tabs 集合
  // 收缩 → http.tab_closed：取消在途＋删临时文件，见 response.store）、
  // 应用退出（既有 Shutdown 序列）。发送中切回时上方 phase 订阅从
  // response store 条目恢复 sending 态，耗时计时以条目 startedAt 续算。

  // 发送动作登记（发送命令 Ctrl+Enter 的路由终点）：ref 承载最新动作供
  // 全局命令经桥异步读取（不参与渲染输出，模板 1 写法）；登记的动作与
  // 发送按钮是同一函数——命令入口唯一，取消与草稿未就绪语义不复制
  const sendActionRef = React.useRef<() => void>(() => undefined)
  React.useEffect(() => {
    sendActionRef.current = () => void handleSendClick()
  })
  React.useEffect(() => registerSendAction(tab.id, () => sendActionRef.current()), [tab.id])

  // —— 手工实体防抖写（标题 / 方法 / 路径 / 分类 → endpoints 表）——
  // 失效策略归 useTreeMutations 单一约定（显式 workspaceId 失效树键：
  // 切换空间瞬间在途写不得失效成新当前空间），本组件不自建 mutation、
  // 只注入自己的副作用（Tab 标题同步）
  const treeMutations = useTreeMutations(treeQuery.workspaceId ?? '')
  const entityWriter = useDebouncedWriter<ManualEndpointInput & { key: string }>({
    flusherId: 'endpoint-entity',
    write: (input) =>
      treeMutations.endpointUpdateMutation
        .mutateAsync(input)
        .then((updated) => {
          // TabBar 显示单一事实源在 tabs store；树刷新经统一失效策略（面包屑随之更新）
          useTabsStore.getState().setTabTitle(makeEndpointNodeId(serviceId, key), updated.title)
        })
        .then(() => undefined),
    onError: reportError,
  })
  const updateEntity = (patch: Partial<EntityForm>) => {
    if (!entity) return
    const next = { ...entity, ...patch }
    setEntity(next)
    markEditing()
    if (!isManual) {
      // 同步接口：仅路径 / 方法可写（标题 / 分类锁定，不产生编辑事件）。
      // 路径形状非法的中间态不落库（描边提示反馈）；改回定义值＝清除覆写
      // （回跟随定义）
      const patchDraft: Partial<DraftPayload> = {}
      if (patch.pathTemplate !== undefined && isPathTemplateShapeValid(next.pathTemplate)) {
        patchDraft.pathOverride =
          next.pathTemplate === endpoint?.definition.pathTemplate ? null : next.pathTemplate
      }
      if (patch.method !== undefined) {
        patchDraft.methodOverride = next.method === endpoint?.definition.method ? null : next.method
      }
      if (Object.keys(patchDraft).length === 0) return
      updateDraft(patchDraft)
      return
    }
    // 手工接口：明显非法的中间态不发起写（标题空 / 路径非基本形态），合法值到达后合并落库
    const title = next.title.trim()
    if (title === '' || !isPathTemplateShapeValid(next.pathTemplate)) return
    entityWriter.schedule({
      serviceId,
      key,
      method: next.method,
      pathTemplate: next.pathTemplate,
      title,
      categoryId: next.categoryId,
    })
  }

  // —— URL 行联动：模板形状反馈 / 粘贴拆分 / 最终 URL 预览 ——
  // 手工路径框的形状校验失败态：不再静默（描边＋行内提示解释为什么不保存），
  // 非法中间态仍不落库（updateEntity 内拦截不变）
  const pathShapeInvalid = entity !== null && !isPathTemplateShapeValid(entity.pathTemplate)
  // 生效路径模板（预览 / 占位符 / 绝对链接判定 / cURL 的同一口径）：手工与
  // 同步都取本地编辑态——同步 entity 播种自覆写 ?? 定义，编辑实时跟随
  const previewPathTemplate =
    entity?.pathTemplate ?? (isManual ? '' : (endpoint?.definition.pathTemplate ?? ''))
  // 模板占位符名集（与预览同一快照）：传入 Params 页签，命中行是 path 参数
  // （渲染 path 只读芯片、不出启停勾选——占位填充不受行启停影响）
  const pathParamNames = React.useMemo(
    () => templatePlaceholders(previewPathTemplate),
    [previewPathTemplate],
  )

  /** 粘贴带 query 的 URL 到路径框：path 段写路径模板、query 串按
   *  urlencoded 语义拆行并入 params（同名行覆盖值、其余行保留） */
  const handlePathPaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text')
    if (!text.includes('?')) return // 普通粘贴走默认行为
    event.preventDefault()
    const { pathTemplate, queryParams } = parsePastedUrl(text)
    // path 段为空（粘贴以 ? 起头）＝只拆参数，路径保持现状
    if (pathTemplate !== '') updateEntity({ pathTemplate })
    if (queryParams.length === 0 || draft === null) return
    // params 列处于原文保真模式时不合并：不改写不可解析的用户数据
    const rows = parseKvRows(draft.params)
    if (rows === null) return
    updateDraft({ params: serializeKvRows(mergeQueryIntoRows(rows, queryParams)) })
  }

  // 最终 URL 预览（渲染期纯派生）：发送侧 build_url 的前端镜像，组合口径
  // 由共享契约夹具双端钉住。形状非法时预览让位给错误提示（发送会被后端
  // 校验拒绝，预告 URL 无意义）；params 列原文保真模式发送将 fail-fast，
  // 预览无意义不渲染（absent）
  const previewState = (() => {
    if (pathShapeInvalid) return { kind: 'path-invalid' as const }
    if (previewRows === null) return { kind: 'absent' as const }
    const outcome = composeFinalUrl(baseUrl, previewPathTemplate, previewRows)
    return 'url' in outcome ? { kind: 'url' as const, url: outcome.url } : { kind: outcome.error }
  })()

  // —— 复制为 cURL（工具行动作）：URL 用最终组合口径（与预览行同快照），
  //    认证按发送侧注入规则编入（请求级继承时回落工作空间级配置）；预览
  //    不可组合（BaseUrl 缺失 / 形态非法 / 草稿未就绪）时按钮禁用——无最终
  //    URL 无可执行命令
  const curlReady = draft !== null && endpoint !== null && previewState.kind === 'url'
  const copyCurlText = () => {
    if (previewState.kind !== 'url' || endpoint === null) return ''
    const method = entity?.method ?? endpoint.definition.method
    return serializeCurl({
      method,
      url: previewState.url,
      headers: draft === null ? [] : (parseKvRows(draft.headers) ?? []),
      body: bodyView,
      requestAuth: parseAuthDraft(draft?.auth ?? null),
      workspaceAuth: parseAuthDraft(currentWorkspace?.auth ?? null, AUTH_NONE),
    })
  }

  // —— 另存为新接口（⋯菜单动作）：当前草稿经转正原语落为当前服务下未分类
  //    的新手工接口（同步接口＝以当前用户数据＋定义生成手工副本，不含同步
  //    身份），新接口以常驻 Tab 打开、本 Tab 原样保留
  const promoteData = usePromoteDraftData()
  const [savingAsNew, setSavingAsNew] = React.useState(false)
  const saveAsNewDisabled = draft === null || endpoint === null || pathShapeInvalid || savingAsNew
  const handleSaveAsNew = async () => {
    if (saveAsNewDisabled) return
    const data: EndpointDraftData = {
      method: isManual
        ? (entity?.method ?? endpoint.definition.method)
        : endpoint.definition.method,
      pathTemplate: previewPathTemplate,
      paramsJson: draft.params,
      headersJson: draft.headers,
      body: draft.body,
      bodyTruncated: false,
      sensitiveHeaderNames: [],
      sourceServiceId: serviceId,
    }
    setSavingAsNew(true)
    try {
      const created = await promoteData(data)
      if (created) {
        useTabsStore
          .getState()
          .openEndpoint(
            { serviceId: created.serviceId, key: created.key, title: created.title },
            'persistent',
          )
      }
    } finally {
      setSavingAsNew(false)
    }
  }

  // —— 从 cURL 导入（⋯菜单动作 → 粘贴对话框）：解析产物落新草稿 Tab
  //    （内存态，不动用户数据；转正才落库） ——
  const [importOpen, setImportOpen] = React.useState(false)

  // —— ⋯更多菜单＝删除接口（手工与同步同权：树侧删除语义不分 isManual）——
  const [deleteConfirmOpen, setDeleteConfirmOpen] = React.useState(false)
  const confirmDeleteEndpoint = () => {
    setDeleteConfirmOpen(false)
    // 硬删除连带用户数据同事务（后端契约）；树失效归 mutation 单一约定，
    // 关本 Tab 后 tabs 收缩信号统一做在途请求与临时文件的关 Tab 清理
    treeMutations.endpointDeleteMutation.mutate(
      { serviceId, key },
      { onSuccess: () => useTabsStore.getState().close(tab.id), onError: reportError },
    )
  }

  const breadcrumbTitle = endpoint?.title ?? tab.title

  // —— 设置抽屉（超时覆写共有；标题 / 分类编辑面仅手工接口）＋文档抽屉
  //    （仅同步接口）：两钮并存、抽屉互斥切换（同钮再点收起） ——
  const [drawerOpen, setDrawerOpen] = React.useState(false)
  const [docDrawerOpen, setDocDrawerOpen] = React.useState(false)
  const settingsButtonRef = React.useRef<HTMLButtonElement | null>(null)
  const docButtonRef = React.useRef<HTMLButtonElement | null>(null)
  const toggleDrawer = (clicked: 'settings' | 'doc') => {
    const [nextSettings, nextDoc] = nextExclusiveDrawerState(drawerOpen, docDrawerOpen, clicked)
    setDrawerOpen(nextSettings)
    setDocDrawerOpen(nextDoc)
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="endpoint-editor">
      {/* 面包屑行：左侧定位面包屑 + 右侧设置入口（手工与同步接口都有——
          手工编辑标题 / 分类 / 超时，同步只覆写超时）。
          底边线把面包屑区与 URL 区隔开，行内 h-8 + items-center 保证线上下
          间距对称；请求区竖向分隔节奏＝标签栏底线 / 面包屑线 / 页签带上下线，
          URL 行不再另设线 */}
      <div
        data-testid="editor-breadcrumb-row"
        className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-3"
      >
        <BreadcrumbRow
          service={service}
          category={category}
          title={breadcrumbTitle}
          endpointIdentity={service ? { serviceId: service.id, key } : null}
        />
        {endpoint && (
          <Button
            ref={settingsButtonRef}
            variant="ghost"
            size="icon-sm"
            className="-mr-1 shrink-0 text-muted-foreground"
            aria-label={t('editor.settingsButton')}
            title={t('editor.settingsButton')}
            aria-expanded={drawerOpen}
            onClick={() => toggleDrawer('settings')}
          >
            <Settings2Icon aria-hidden />
          </Button>
        )}
        {/* 文档抽屉入口：仅同步接口渲染（手工接口与另存副本隐藏而非禁用） */}
        {endpoint && shouldShowDocEntry(isManual) && (
          <Button
            ref={docButtonRef}
            variant="ghost"
            size="icon-sm"
            className="-mr-1 shrink-0 text-muted-foreground"
            aria-label={t('response.docButton')}
            title={t('response.docButton')}
            aria-expanded={docDrawerOpen}
            onClick={() => toggleDrawer('doc')}
          >
            <BookOpenTextIcon aria-hidden />
          </Button>
        )}
      </div>

      {/* URL 行：一体地址栏（Apifox 式伪输入框——方法选择器＋BaseUrl 地址块＋
          路径框＋尾部环境快切换内嵌同组，容器承担边框与 focus 光环）+ 发送/取消 +
          ⋯更多。手工与同步同构：方法七选、路径可编辑；同步的改动落用户数据
          覆写列（method_override / path_override），定义侧随同步文档更新。
          路径形状非法时整组描边转 destructive（非法态仍可见，但不再由内嵌
          真实输入框自绘红边破坏一体感）。不设底边线——URL 区与页签区的分隔
          由页签带顶线（border-y 上线）承担，避免双线夹空破坏竖向节奏。行高
          h-12：32px 地址栏上下各留 8px，拉开面包屑底线与页签带顶线的间距 */}
      <div data-testid="editor-url-row" className="flex h-12 shrink-0 items-center gap-2 px-3">
        <div
          data-testid="editor-url-box"
          data-invalid={pathShapeInvalid || undefined}
          className="flex h-8 min-w-0 flex-1 items-center gap-0.5 rounded-md border border-input bg-transparent py-0.5 pr-1 pl-1 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 data-[invalid]:border-destructive!"
        >
          {entity ? (
            <Select
              value={entity.method}
              onValueChange={(value) => updateEntity({ method: value ?? 'GET' })}
            >
              {/* 触发器＝方法徽章本身（浅底深字，底与字随当前方法语义色，
                  下拉箭头包在色块内、随字色）；宽度随方法自然伸缩；h-6 同
                  变体覆盖 sm 档 h-7——色块上下留 4px，与左缘 pl-1 一致 */}
              <SelectTrigger
                size="sm"
                className={cn(
                  'shrink-0 rounded-md border-none px-2 font-mono text-[13px] font-medium tracking-wide uppercase shadow-none data-[size=sm]:h-6 [&>svg:last-child]:size-3 [&>svg:last-child]:text-current',
                  METHOD_TRIGGER_CLASS[entity.method],
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
          ) : (
            <MethodBadge method={endpoint?.definition.method ?? ''} size="md" />
          )}
          {/* BaseUrl 地址块（可点击＝候选下拉，内存级 Tab 会话态覆写）：直接
              显示当前生效值——未覆写＝工作空间 base_url，已覆写＝覆写值（主色
              点亮）。地址栏已是完整 http(s):// 链接（变量解析后判定）时隐藏——
              绝对地址直发，覆写无意义。发送时覆写值经 send-bridge 随 http.send
              携带（值列口径解析后优先于工作空间生效值） */}
          {currentWorkspace && !isAbsoluteHttpUrl(previewPathTemplate) && (
            <BaseUrlOverrideControl
              workspaceId={currentWorkspace.id}
              tabId={tab.id}
              effectiveUrl={baseUrl}
            />
          )}
          {entity ? (
            <VariableSuggestInput
              value={entity.pathTemplate}
              onChange={(pathTemplate) => updateEntity({ pathTemplate })}
              onPaste={handlePathPaste}
              aria-label={t('apiTree.endpointPathLabel')}
              aria-invalid={pathShapeInvalid || undefined}
              title={pathShapeInvalid ? t('editor.pathInvalidHint') : undefined}
              workspaceId={currentWorkspace?.id}
              className="h-7 min-w-0 flex-1 border-transparent bg-transparent px-0.5 font-mono text-xs shadow-none focus-visible:border-transparent focus-visible:ring-0 aria-invalid:border-transparent aria-invalid:ring-0 dark:aria-invalid:border-transparent dark:aria-invalid:ring-0"
            />
          ) : (
            <span className="min-w-0 flex-1 truncate px-0.5 font-mono text-xs text-muted-foreground">
              {endpoint?.definition.pathTemplate ?? ''}
            </span>
          )}
          {/* 环境块（激活分类快捷切换）：地址栏 box 内尾部控件（发送按钮在
              box 外）；不随路径形状显隐——{{变量}} 在 headers / body 同样
              生效，绝对地址下环境切换仍有意义 */}
          {currentWorkspace && <EnvQuickSwitchControl workspaceId={currentWorkspace.id} />}
        </div>
        {/* 发送 / 取消：sending 态按钮变「取消」（点击调 http.cancel）；
            草稿未就绪（加载中）不可发送。h-8 / text-sm 覆盖 sm 档位：与
            32px 地址栏等高、字号大一号（「发 送」的字间空格由文案承载） */}
        <Button
          size="sm"
          disabled={draft === null}
          onClick={() => void handleSendClick()}
          className="h-8 shrink-0 text-sm"
          data-testid="editor-send-button"
        >
          {phase === 'sending' ? t('editor.sendCancel') : t('editor.send')}
        </Button>
        {/* ⋯更多菜单：复制最终 URL / 复制为 cURL（两者都＝最终组合口径——
            复制统一走 copyTextWithFeedback，剪贴板＋toast 唯一实现源；组合
            不可得时禁用）/ 从 cURL 导入 / 另存为新接口 / 删除接口
            （destructive——无图标，常态普通文字，悬浮 / 聚焦转红＋起
            destructive 底，覆写底座 destructive 的常态红字）。触发按钮与
            输入组等高（size-8 覆盖 icon-sm 档）；outline 常显边框降为透明
            占位、悬浮才显——防边框有无造成行内几何跳动 */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="outline"
                size="icon-sm"
                className="size-8 shrink-0 border-transparent hover:border-input dark:border-transparent"
                aria-label={t('editor.moreButton')}
                title={t('editor.moreButton')}
                data-testid="editor-more-button"
              />
            }
          >
            <MoreHorizontalIcon aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem
              disabled={previewState.kind !== 'url'}
              onClick={() => {
                if (previewState.kind !== 'url') return
                void copyTextWithFeedback(() => previewState.url, uiText)
              }}
            >
              {t('editor.finalUrlCopy')}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!curlReady}
              onClick={() => void copyTextWithFeedback(copyCurlText, uiText)}
            >
              {t('editor.copyAsCurl')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setImportOpen(true)}>
              {t('editor.curlImportMenu')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={saveAsNewDisabled} onClick={() => void handleSaveAsNew()}>
              {t('editor.saveAsEndpoint')}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              className="data-[variant=destructive]:text-foreground"
              onClick={() => setDeleteConfirmOpen(true)}
            >
              {t('editor.deleteEndpoint')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 请求编辑表单：Params / Body / Headers / Auth（编辑的是草稿）。
          页签标签恒英文——面板标签属领域通用语，两种语言下原样 */}
      {userDataQuery.isError ? (
        <DraftLoadFailed
          message={userDataQuery.error.message}
          onRetry={() => void userDataQuery.refetch()}
        />
      ) : draft === null ? (
        <div
          data-testid="editor-loading"
          className="flex flex-1 items-center justify-center text-sm text-muted-foreground"
        >
          {tab.title}
        </div>
      ) : (
        <Tabs
          value={editorTab}
          onValueChange={(value) => setEditorTab(tab.id, value ?? 'params')}
          className="flex min-h-0 flex-1 flex-col gap-0"
          data-testid="editor-form"
        >
          {/* 页签带＝上下通栏线框住（两线全宽从面板左缘到右缘，行内 px-3
              只约束内容起点、与地址栏同基准）；顶线直接承接地址栏区块底，
              不留上外距——地址栏内容到上下两线间距对称。TabsList 左内边
              归零使首个触发项左缘＝激活线起点＝地址栏内容左缘，垂直 3px
              内边保留（激活线与底线重合的落线几何）——与 TabBar 的
              「线归容器、激活项连通」同一形态语言 */}
          <div className="shrink-0 border-y border-border px-3" data-testid="editor-tab-strip">
            <TabsList variant="line" className="pl-0">
              <TabsTrigger value="params">
                Params
                <TabCount count={paramsCount} />
              </TabsTrigger>
              <TabsTrigger value="body">Body</TabsTrigger>
              <TabsTrigger value="headers">
                Headers
                <TabCount count={headersCount} />
              </TabsTrigger>
              <TabsTrigger value="auth">
                Auth
                <TabCount count={authCount} />
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="params" className="min-h-0 flex-1 overflow-y-auto">
            <KvEditor
              json={draft.params}
              onChange={(json) => updateDraft({ params: json })}
              allowedTypes={PARAM_ROW_TYPES}
              pathParamNames={pathParamNames}
              suggestWorkspaceId={currentWorkspace?.id}
            />
          </TabsContent>
          {/* Body 页签：类型行（六分段 pill ＋ 文本系工具）与三编辑形态——
              none 空态 / form 系 KvEditor 行编辑 / 文本系 Monaco（同步加载） */}
          <TabsContent value="body" className="flex min-h-0 flex-1 flex-col">
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
                data-testid="editor-body-empty"
              >
                {t('editor.bodyEmpty')}
              </div>
            ) : isFormBodyKind(bodyView.kind) ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <KvEditor
                  json={bodyRowsJson}
                  onChange={updateBodyRows}
                  allowedTypes={
                    bodyView.kind === 'form-data' ? FORM_DATA_ROW_TYPES : PARAM_ROW_TYPES
                  }
                  suggestWorkspaceId={currentWorkspace?.id}
                />
              </div>
            ) : isTextBodyKind(bodyView.kind) ? (
              <div className="relative min-h-0 flex-1 overflow-hidden">
                <div className="absolute inset-0">
                  {/* 进入文本编辑面（状态转换）时的淡入：编辑器 mount 播放一次 */}
                  <div className="absolute inset-0 animate-in duration-150 fade-in">
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
                        currentWorkspace ? { workspaceId: currentWorkspace.id } : null
                      }
                    />
                  </div>
                </div>
              </div>
            ) : null}
          </TabsContent>
          <TabsContent value="headers" className="min-h-0 flex-1 overflow-y-auto">
            <KvEditor
              json={draft.headers}
              onChange={(json) => updateDraft({ headers: json })}
              suggestWorkspaceId={currentWorkspace?.id}
            />
          </TabsContent>
          {/* Auth 页签：请求级认证（七类型，默认继承工作空间级）；
            编辑经草稿防抖整包写（updateDraft 通道）；凭据字段带
            「转为 Secret 变量」行内入口 */}
          <TabsContent value="auth" className="min-h-0 flex-1 overflow-y-auto">
            <AuthPane
              authJson={draft.auth}
              onChange={(auth) => updateDraft({ auth })}
              workspaceId={currentWorkspace?.id ?? null}
            />
          </TabsContent>
        </Tabs>
      )}

      {/* 删除确认（destructive 的 AlertDialog 形态）：硬删除连带用户数据，
          级联范围在描述文案中明示；Esc 可关（Base UI 内建） */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('editor.deleteConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('editor.deleteConfirmDescription', { title: breadcrumbTitle })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('editor.deleteConfirmCancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={confirmDeleteEndpoint}
              data-testid="editor-delete-confirm"
            >
              {t('editor.deleteConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 从 cURL 导入（⋯菜单入口的对话框宿主）：解析产物落新草稿 Tab，
          不动任何用户数据（转正才落库） */}
      <CurlImportDialog open={importOpen} baseUrl={baseUrl} onClose={() => setImportOpen(false)} />

      {/* 设置抽屉（portal 到工作台主区：覆盖参数区与响应区，不遮面包屑）。
          超时行手工与同步共有；标题 / 分类行恒渲染——同步接口置灰锁定
          （随同步文档更新，禁止本地编辑） */}
      {endpoint && (
        <EndpointSettingsDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          focusReturnRef={settingsButtonRef}
          entityLocked={!isManual}
          title={entity?.title ?? ''}
          categoryId={entity?.categoryId ?? null}
          categories={service?.categories ?? []}
          onTitleChange={(title) => updateEntity({ title })}
          onCategoryChange={(categoryId) => updateEntity({ categoryId })}
          timeoutSeconds={draft?.timeoutSeconds ?? null}
          onTimeoutChange={(timeoutSeconds) => updateDraft({ timeoutSeconds })}
        />
      )}

      {/* 文档抽屉（与设置抽屉同锚定法、互斥切换）：定义侧文档元数据渲染，
          仅同步接口挂载（入口显隐见 shouldShowDocEntry；数据无则空态） */}
      {endpoint && shouldShowDocEntry(isManual) && (
        <EndpointDocDrawer
          open={docDrawerOpen}
          onOpenChange={setDocDrawerOpen}
          focusReturnRef={docButtonRef}
          serviceId={serviceId}
          key_={key}
          method={
            isManual ? (entity?.method ?? endpoint.definition.method) : endpoint.definition.method
          }
        />
      )}
    </div>
  )
}
