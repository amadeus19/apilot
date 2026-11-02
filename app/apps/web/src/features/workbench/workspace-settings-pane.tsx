import * as React from 'react'

import { useQueryClient } from '@tanstack/react-query'
import {
  BookOpenTextIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  GlobeIcon,
  GripVerticalIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  PlusIcon,
  SquarePenIcon,
  Trash2Icon,
} from 'lucide-react'

import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  DetailBanner,
  DetailContentColumn,
  DetailSectionCard,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  usePointContextMenu,
  type TreeDropMode,
} from '@workspace/ui/components'

import { useI18n, type DictKey } from '@/i18n'
import { useDraftField } from '@/lib/use-draft-field'
import { reportError } from '@/services/error-center'
import { useIpcMutation } from '@/services/ipc-query'
import type { ServiceDto } from '@/services/workbench-api'
import { workspaceSetAuth, workbenchKeys } from '@/services/workbench-api'
import { SEMANTIC_ICONS } from '@/features/icons/semantic-icons'
import { BaseUrlCandidatesControl } from '@/features/variables/base-url-picker'
import {
  useSetCurrentWorkspaceMutation,
  useWorkspaceMutations,
  useWorkspaceServicesQuery,
  useWorkspaceSortMutations,
  useWorkspacesQuery,
} from '@/features/workspaces/api'
import { useWorkspacesStore } from '@/features/workspaces/workspaces.store'
import { useNavDragSort } from '@/lib/use-nav-drag-sort'
import {
  computeNavDrop,
  type WorkspaceNavDropAction,
  type WorkspaceNavIndex,
  type WorkspaceNavNode,
} from '@/features/workspaces/workspace-nav-dnd'

import { useDebouncedWriter } from '@/services/debounced-writer'
import {
  AUTH_NONE,
  authTypeIdOf,
  parseAuthDraft,
  serializeAuthDraft,
  switchAuthType,
  type AuthDraft,
  type AuthTypeId,
} from './auth-config'

/**
 * 工作空间详情页（工作空间详情 Tab 的内容页）：按「正在查看的工作空间」
 * 参数化（props workspaceId 即身份；Tab 单例换内容指针时经 React key 重
 * 挂载——表单草稿与防抖 writer 实例随查看对象隔离，切换时旧实例 dispose
 * 把剩余编辑落回原空间，写目标不串）。
 *
 * 视觉版式（16 号拍板原型变体 D）：身份横幅＋居中限宽三卡——横幅＝图标块
 * ＋名称＋当前徽章/「设为当前」＋meta 摘要行（BaseUrl 等宽 · 认证方式 ·
 * 服务数）＋右侧整页保存态聚合回显（两条写通道合一处，不在字段旁重复）；
 * 身体＝居中单列三张分节卡：基本信息（名称 / BaseUrl 两列）、认证（类型
 * 选择＋动态字段）、服务（无表格线列表行）。
 *
 * 写通道（视觉层不动逻辑）：名称 / BaseUrl 与认证文本字段编辑实时防抖约
 * 500ms 写（文本类输入按草稿模型合并写），认证类型选择 change 即写
 * workspace.set_auth；写通道各自失效工作空间清单键（标题栏切换器与面包屑
 * 等消费方随之刷新）。表单草稿「跟随真值直到用户触碰」：他处（全局对话
 * 框）改名 / 改认证直写缓存后，未被本页触碰的字段随真值跟随，一动键才以
 * 草稿为基线写库——不以外来旧值脏写回滚。
 *
 * 服务列表：本空间服务清单（无排序 / 过滤 / 分页——数据量＝单空间服务数，
 * 全量渲染），新建服务与批量导入入口在卡头，手工容器（无文档地址）warning
 * 芯片标识，连通状态探测芯片保留在接口树行。行排序＝拖拽（手柄武装制；
 * 拖拽协议与 hint 守卫归 useNavDragSort 单点，落点判定复用
 * workspace-nav-dnd 纯函数）与右键上移 / 下移两条通道，mutation 与左栏树
 * 共享（失效同一前缀）。列表动作一律发 store 信号交给全局对话框宿主。
 *
 * 保存态回显：自动保存不能静默——保存中 / 已保存 / 失败三态常驻可查，
 * 失败给重试入口。状态由编辑动作与写闭包的结果驱动，不引入定时器
 * （因而没有需要清理的资源）。
 */

/** 保存态：idle＝尚无编辑（回显为空） */
type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed'

/** 空服务数组的稳定引用（防每次渲染换引用搅动 useMemo） */
const EMPTY_SERVICES: ServiceDto[] = []

/** 骨架行名称列宽（手挑伪随机，避免整齐划一的机器感） */
const SERVICE_SKELETON_WIDTHS = ['34%', '26%', '40%', '22%', '31%']

/** 空态图标（与左栏树服务行同一语义图标） */
const ServiceIcon = SEMANTIC_ICONS.service

/** 保存态回显：高度恒定（三态切换不推动页面），失败态带重试入口。
 *  整页单实例，呈现在页头：两条写通道（名称 / BaseUrl 防抖行、认证行）
 *  聚合为一个状态，不在字段旁各自重复 */
function SaveState({
  status,
  onRetry,
  testId = 'workspace-settings-save-state',
}: {
  status: SaveStatus
  onRetry: () => void
  testId?: string
}) {
  const { t } = useI18n()
  return (
    <div
      className="flex h-6 shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
      data-testid={testId}
      data-status={status}
      aria-live="polite"
    >
      {status === 'saving' && (
        <>
          <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin" />
          {t('workspaceSettings.saveSaving')}
        </>
      )}
      {status === 'saved' && (
        <>
          <CircleCheckIcon aria-hidden className="size-3.5" />
          {t('workspaceSettings.saveSaved')}
        </>
      )}
      {status === 'failed' && (
        <>
          <CircleAlertIcon aria-hidden className="size-3.5 text-destructive" />
          <span className="text-destructive">{t('workspaceSettings.saveFailed')}</span>
          <Button variant="ghost" size="xs" onClick={onRetry}>
            {t('workspaceSettings.saveRetry')}
          </Button>
        </>
      )}
    </div>
  )
}

/** 工作空间级认证的六类型（无「继承上级」——它就是链根；默认「不使用」） */
const WS_AUTH_TYPE_IDS: readonly AuthTypeId[] = [
  'none',
  'bearer',
  'basic',
  'apiKey-header',
  'apiKey-query',
  'apiKey-cookie',
]

/** 六类型的标签键（与请求级 Auth 页签共用类型名词典） */
const WS_AUTH_TYPE_LABEL_KEYS: Record<AuthTypeId, DictKey> = {
  inherit: 'editor.authTypeInherit',
  none: 'editor.authTypeNone',
  bearer: 'editor.authTypeBearer',
  basic: 'editor.authTypeBasic',
  'apiKey-header': 'editor.authTypeApiKeyHeader',
  'apiKey-query': 'editor.authTypeApiKeyQuery',
  'apiKey-cookie': 'editor.authTypeApiKeyCookie',
}

/** 工作空间级读模式：解析容错回落「不使用」；inherit 不属于工作空间级
 *  （链根无上级可继承），脏数据中出现的 inherit 同样按未配置呈现 */
function parseWorkspaceAuth(json: string | null): AuthDraft {
  const parsed = parseAuthDraft(json, AUTH_NONE)
  return parsed.type === 'inherit' ? AUTH_NONE : parsed
}

/** 认证字段行（设置页密度）：语义标签＋输入（字面量或 {{变量}}）；文本类
 *  输入走防抖落盘，失焦立即落盘不等窗口 */
function AuthField({
  label,
  value,
  placeholder,
  onChange,
  onBlur,
  testId,
}: {
  label: string
  value: string
  placeholder: string
  onChange: (value: string) => void
  /** 失焦立即落盘（防抖窗口的提前收敛通道） */
  onBlur: () => void
  testId: string
}) {
  return (
    <Field label={label} data-testid={testId}>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        aria-label={label}
        spellCheck={false}
        className="h-8 font-mono"
      />
    </Field>
  )
}

export function WorkspaceSettingsPane({ workspaceId }: { workspaceId: string }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const { data } = useWorkspacesQuery()
  // 查看对象由 props 唯一确定（组件实例与空间一一绑定），不再解析 current
  const workspace = data?.items.find((item) => item.id === workspaceId) ?? null
  const servicesQuery = useWorkspaceServicesQuery(workspaceId)
  const setCurrent = useSetCurrentWorkspaceMutation()
  const openDialog = useWorkspacesStore((s) => s.openDialog)
  // 服务列表动作入口（列表头与空态两处共用同一回调，目标＝查看对象）
  const openNewService = React.useCallback(
    () => openDialog({ type: 'service-new', workspaceId }),
    [openDialog, workspaceId],
  )
  const openImport = React.useCallback(
    () => openDialog({ type: 'import', workspaceId }),
    [openDialog, workspaceId],
  )
  const [saveStatus, setSaveStatus] = React.useState<SaveStatus>('idle')

  // 名称 / BaseUrl 写通道：与工作空间管理面共享 mutation 组（失效面单点，
  // 含该空间生效变量集的内置 {{baseUrl}} 条目失效）
  const { renameMutation } = useWorkspaceMutations()

  // —— 服务列表排序：mutation 与左栏树共享（失效同一前缀）；拖拽协议
  //     （源行共享、hint 守卫）归 useNavDragSort 单点，落点判定复用
  //     workspace-nav-dnd 纯函数（单空间单层，before/after） ——
  const sortMutations = useWorkspaceSortMutations()
  const menu = usePointContextMenu()
  const [menuServiceId, setMenuServiceId] = React.useState<string | null>(null)
  const [dragArmedId, setDragArmedId] = React.useState<string | null>(null)
  const [dropHint, setDropHint] = React.useState<{ id: string; mode: TreeDropMode } | null>(null)

  // —— 服务清单与落点判定索引（单空间单层：childrenOf 只有一组） ——
  const services = servicesQuery.data ?? EMPTY_SERVICES
  const navIndex = React.useMemo<WorkspaceNavIndex>(() => {
    const nodes = new Map<string, WorkspaceNavNode>()
    for (const service of services) {
      nodes.set(service.id, {
        kind: 'service',
        id: service.id,
        workspaceId: service.workspaceId,
        name: service.name,
        docUrl: service.docUrl,
      })
    }
    return {
      nodes,
      rootChildren: [],
      childrenOf: new Map([[workspaceId, services.map((service) => service.id)]]),
    }
  }, [services, workspaceId])

  const serviceDrag = useNavDragSort<WorkspaceNavNode, ServiceDto, WorkspaceNavDropAction>({
    getNode: (service) => navIndex.nodes.get(service.id) ?? null,
    computeDrop: (source, target, ratio) => computeNavDrop(source, target, ratio, navIndex),
    onAction: (action) => {
      if (action.kind === 'service') {
        sortMutations.serviceMoveToMutation.mutate(
          { id: action.id, index: action.index },
          { onError: reportError },
        )
      }
    },
  })

  const handleServiceDragOver = (service: ServiceDto, event: React.DragEvent): void => {
    const mode = serviceDrag.handleDragOver(service, event)
    setDropHint((prev) =>
      prev?.id === service.id && prev.mode === mode ? prev : mode ? { id: service.id, mode } : null,
    )
    if (mode) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
    }
  }

  /** 落下：hint 守卫归协议 hook 单点（仅最后悬停判定可落且目标行一致才
   *  下发 move_to；失败靠缓存失效重拉回真值）；武装与指示线是本页 UI
   *  状态，随落下复位 */
  const handleServiceDrop = (service: ServiceDto): void => {
    serviceDrag.handleDrop(service)
    setDropHint(null)
    setDragArmedId(null)
  }

  const clearServiceDrag = (): void => {
    serviceDrag.handleDragEnd()
    setDropHint(null)
    setDragArmedId(null)
  }

  /** 上移 / 下移（拖拽的键盘替代通道）：service.move 相邻交换，边界由
   *  菜单项禁用承担（首行禁上、末行禁下） */
  const moveService = (id: string, direction: 'up' | 'down'): void => {
    sortMutations.serviceMoveMutation.mutate({ id, direction }, { onError: reportError })
  }

  // —— 认证写通道：文本字段本地草稿＋防抖落盘（writer id 与名称 / BaseUrl
  //     通道区分），认证类型选择 change 即写。写 workspace.set_auth，成功后
  //     失效工作空间清单键（WorkspaceDto 含 auth 字段，缓存随之刷新） ——
  const setAuthMutation = useIpcMutation({
    mutationFn: (input: { id: string; auth: string | null }) =>
      workspaceSetAuth(input.id, input.auth),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workbenchKeys.workspaces() })
    },
  })
  const [authSaveStatus, setAuthSaveStatus] = React.useState<SaveStatus>('idle')

  // 认证草稿：跟随真值直到触碰（set_auth 落库失效重拉后，未触碰即随真值）
  const authField = useDraftField(parseWorkspaceAuth(workspace?.auth ?? null))
  const authRenderDraft = authField.value

  const authWriter = useDebouncedWriter<AuthDraft>({
    flusherId: 'workspace-settings-auth',
    write: (draft) =>
      setAuthMutation
        .mutateAsync({ id: workspaceId, auth: serializeAuthDraft(draft) })
        .then(() => setAuthSaveStatus('saved')),
    onError: (error) => {
      setAuthSaveStatus('failed')
      reportError(error)
    },
  })

  /** 认证文本字段编辑：更新草稿并防抖落盘（窗口内多次键入合并一次写） */
  const updateAuth = (next: AuthDraft) => {
    authField.set(next)
    setAuthSaveStatus('saving')
    authWriter.schedule(next)
  }

  /** 认证文本字段失焦：立即落盘（防抖窗口的提前收敛通道） */
  const flushAuth = () => {
    void authWriter.flushNow()
  }

  // 重试＝按当前显示值（草稿优先）重发（失败时写入被丢弃，只有重发才能补上）
  const retryAuthSave = () => {
    setAuthSaveStatus('saving')
    authWriter.schedule(authRenderDraft)
    void authWriter.flushNow()
  }

  // —— 名称 / BaseUrl 表单：字段级「跟随真值直到用户触碰」——他处（全局
  //     对话框）改名直写缓存后，未触碰字段跟随新值；一动键才以草稿为基线 ——
  const nameField = useDraftField(workspace?.name ?? '')
  const baseUrlField = useDraftField(workspace?.baseUrl ?? '')
  /** 名称清空＝行内校验反馈（写入侧空名不落库，等待有效输入） */
  const nameEmpty = nameField.value.trim() === ''

  // 名称 / BaseUrl 防抖 writer（退出收尾注册名与认证通道 'workspace-settings-auth'
  // 区分——多 writer 不得重名）
  const writer = useDebouncedWriter<{ name: string; baseUrl: string }>({
    flusherId: 'workspace-settings',
    write: (payload) => {
      // 写目标＝props 的查看对象（闭包捕获；实例随空间重挂载，不存在
      // 同一实例写到另一空间的路径）
      const name = payload.name.trim()
      // 空名不落库（等有效输入；名称非空由 Rust 侧校验兜底）。没有要保存的
      // 内容，保存态回落 idle——否则会永远停在「保存中」
      if (name === '') {
        setSaveStatus('idle')
        return Promise.resolve()
      }
      const baseUrl = payload.baseUrl.trim()
      return renameMutation
        .mutateAsync({ id: workspaceId, name, baseUrl: baseUrl === '' ? null : baseUrl })
        .then(() => setSaveStatus('saved'))
    },
    onError: (error) => {
      setSaveStatus('failed')
      reportError(error)
    },
  })

  const updateForm = (patch: Partial<{ name: string; baseUrl: string }>) => {
    // 提交组合值：被编辑字段取输入值，未触碰字段跟随当前真值（不以陈旧
    // 基线把外部改名写回旧值）
    const next = {
      name: patch.name !== undefined ? patch.name : nameField.value,
      baseUrl: patch.baseUrl !== undefined ? patch.baseUrl : baseUrlField.value,
    }
    if (patch.name !== undefined) nameField.set(patch.name)
    if (patch.baseUrl !== undefined) baseUrlField.set(patch.baseUrl)
    setSaveStatus('saving')
    writer.schedule(next)
  }

  // 重试＝把当前表单值（草稿优先，未触碰字段即真值）重新入队并立即写出
  // （失败时写入被丢弃，只有重发才能补上）
  const retrySave = () => {
    setSaveStatus('saving')
    writer.schedule({ name: nameField.value, baseUrl: baseUrlField.value })
    void writer.flushNow()
  }

  // —— 整页保存态聚合（两写通道在页头一处呈现）：任一在途＝保存中；
  //     全部落定后失败优先于已保存；两通道均无动作＝idle。重试只重发
  //     失败通道（未失败通道重发同值属无谓写入） ——
  const pageSaveStatus: SaveStatus =
    saveStatus === 'saving' || authSaveStatus === 'saving'
      ? 'saving'
      : saveStatus === 'failed' || authSaveStatus === 'failed'
        ? 'failed'
        : saveStatus === 'saved' || authSaveStatus === 'saved'
          ? 'saved'
          : 'idle'
  const retryPageSave = () => {
    if (saveStatus === 'failed') retrySave()
    if (authSaveStatus === 'failed') retryAuthSave()
  }

  // —— 认证渲染派生值（草稿跟随已兜底「不使用」，防御空态） ——
  const fieldPlaceholder = t('editor.authFieldPlaceholder')
  const selectItems: Record<string, React.ReactNode> = Object.fromEntries(
    WS_AUTH_TYPE_IDS.map((id) => [id, t(WS_AUTH_TYPE_LABEL_KEYS[id])]),
  )

  // 查看对象不可达：清单加载中＝占位；已删除 / 加载失败＝明示空态
  // （Tab 内容指针指向的空间可能先于本页被删）
  if (data === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {t('tabs.workspaceSettingsTitle')}
      </div>
    )
  }
  if (!workspace) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {t('workspaceSettings.notFound')}
      </div>
    )
  }

  // —— 右键菜单派生值（菜单目标行的序列位置：首行禁上、末行禁下） ——
  const menuService = menuServiceId ? (services.find((s) => s.id === menuServiceId) ?? null) : null
  const menuServiceAt = menuService ? services.findIndex((s) => s.id === menuService.id) : -1
  const menuIsFirst = menuServiceAt <= 0
  const menuIsLast = menuServiceAt < 0 || menuServiceAt >= services.length - 1

  // —— 横幅 meta 摘要行（BaseUrl 随编辑实时、认证按已落库值） ——
  const isCurrent = workspace.id === data.currentId
  const metaBaseUrl = baseUrlField.value.trim()
  const metaAuthType = authTypeIdOf(parseWorkspaceAuth(workspace.auth))
  const metaAuthLabel =
    metaAuthType === 'none'
      ? t('workspaceSettings.metaAuthNone')
      : t(WS_AUTH_TYPE_LABEL_KEYS[metaAuthType])

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="workspace-settings">
      {/* 横幅：身份锚点（图标块＋名称＋当前徽章/「设为当前」）＋meta 摘要行
          （BaseUrl 等宽 · 认证方式 · 服务数——全貌打开即读）＋右侧整页保存态
          聚合回显（两写通道合一处，高度恒定不推动内容） */}
      <DetailBanner
        icon={<SEMANTIC_ICONS.workspace aria-hidden className="size-6" />}
        title={workspace.name}
        badges={
          isCurrent ? (
            <span
              data-testid="workspace-current-badge"
              className="inline-flex shrink-0 items-center rounded-sm bg-selection px-1.5 py-0.5 text-micro font-medium text-primary"
            >
              {t('workspace.currentBadge')}
            </span>
          ) : (
            <Button
              variant="outline"
              size="xs"
              className="shrink-0"
              onClick={() =>
                setCurrent.mutate(workspace.id, { onError: (error) => reportError(error) })
              }
              data-testid="workspace-set-current"
            >
              {t('workspace.actionSetCurrent')}
            </Button>
          )
        }
        meta={
          <>
            <span className="truncate font-mono">
              {metaBaseUrl === '' ? t('workspaceSettings.metaNoBaseUrl') : metaBaseUrl}
            </span>
            <span aria-hidden>·</span>
            <span className="shrink-0">{metaAuthLabel}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0 tabular-nums">
              {t('workspaceSettings.metaServicesCount', { count: services.length })}
            </span>
          </>
        }
        actions={<SaveState status={pageSaveStatus} onRetry={retryPageSave} />}
      />

      {/* 身体：居中限宽单列三张分节卡（拍板变体 D）——配置与服务逐块纵向
          阅读，任意窗宽不失衡（窄窗两列字段回落单列，无独立分栏退化态） */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DetailContentColumn>
          {/* 卡：基本信息（名称 / BaseUrl 两列） */}
          <DetailSectionCard
            icon={<GlobeIcon aria-hidden className="size-4 text-muted-foreground" />}
            title={t('workspaceSettings.sectionBasic')}
          >
            <div className="grid grid-cols-1 gap-4 px-4 py-4 sm:grid-cols-2">
              <Field label={t('workspaceSettings.nameLabel')}>
                <Input
                  value={nameField.value}
                  onChange={(event) => updateForm({ name: event.target.value })}
                  aria-label={t('workspaceSettings.nameLabel')}
                  aria-invalid={nameEmpty || undefined}
                  aria-errormessage={nameEmpty ? 'workspace-name-empty-error' : undefined}
                  className="h-8"
                />
                {/* 名称清空＝行内 destructive 校验（空名不落库，保存态回落
                    idle 不误导「已保存」） */}
                {nameEmpty && (
                  <p
                    id="workspace-name-empty-error"
                    className="text-xs text-destructive"
                    data-testid="workspace-name-empty-error"
                  >
                    {t('workspaceSettings.nameEmptyError')}
                  </p>
                )}
              </Field>
              <Field label={t('workspaceSettings.baseUrlLabel')}>
                {/* BaseUrl 行＝编辑框内嵌候选触发器（悬浮 / 聚焦 / 展开时显形）：
                    选候选即替换生效值（走本页防抖写 workspace.rename）；候选的
                    新增 / 行内删除归变量域控件（纯备选清单，不触碰生效值） */}
                <div className="group/field relative w-full">
                  <Input
                    value={baseUrlField.value}
                    onChange={(event) => updateForm({ baseUrl: event.target.value })}
                    placeholder={t('workspaceSettings.baseUrlPlaceholder')}
                    aria-label={t('workspaceSettings.baseUrlLabel')}
                    className="h-8 w-full pr-8 font-mono"
                  />
                  <BaseUrlCandidatesControl
                    workspaceId={workspaceId}
                    currentBaseUrl={baseUrlField.value}
                    onPick={(url) => updateForm({ baseUrl: url })}
                  />
                </div>
              </Field>
            </div>
          </DetailSectionCard>

          {/* 卡：认证（继承链的根——无「继承上级」项，默认「不使用」；类型
              选择 change 即写、文本字段防抖 / 失焦落盘，保存态汇入横幅聚合回显） */}
          <DetailSectionCard
            icon={<KeyRoundIcon aria-hidden className="size-4 text-muted-foreground" />}
            title={t('workspaceSettings.sectionAuth')}
          >
            <div className="grid grid-cols-1 gap-4 px-4 py-4 sm:grid-cols-2">
              <Field label={t('workspaceSettings.authTypeLabel')} data-testid="workspace-auth-type">
                <Select
                  items={selectItems}
                  value={authTypeIdOf(authRenderDraft)}
                  onValueChange={(value) => {
                    const next = WS_AUTH_TYPE_IDS.find((candidate) => candidate === value)
                    if (!next) return
                    // 类型切换 change 即写：草稿更新后立即落盘（覆盖未到期的
                    // 防抖排队值——切换基于当前显示值生成，同族字段已含未落盘输入）
                    const draft = switchAuthType(authRenderDraft, next)
                    authField.set(draft)
                    setAuthSaveStatus('saving')
                    authWriter.schedule(draft)
                    void authWriter.flushNow()
                  }}
                >
                  <SelectTrigger
                    className="w-full"
                    aria-label={t('workspaceSettings.authTypeLabel')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WS_AUTH_TYPE_IDS.map((id) => (
                      <SelectItem key={id} value={id}>
                        {t(WS_AUTH_TYPE_LABEL_KEYS[id])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {authRenderDraft.type === 'bearer' && (
                <AuthField
                  label={t('editor.authTokenLabel')}
                  value={authRenderDraft.token}
                  placeholder={fieldPlaceholder}
                  onChange={(token) => updateAuth({ type: 'bearer', token })}
                  onBlur={flushAuth}
                  testId="workspace-auth-token"
                />
              )}
              {authRenderDraft.type === 'basic' && (
                <>
                  <AuthField
                    label={t('editor.authUsernameLabel')}
                    value={authRenderDraft.username}
                    placeholder={fieldPlaceholder}
                    onChange={(username) =>
                      updateAuth({ type: 'basic', username, password: authRenderDraft.password })
                    }
                    onBlur={flushAuth}
                    testId="workspace-auth-username"
                  />
                  <AuthField
                    label={t('editor.authPasswordLabel')}
                    value={authRenderDraft.password}
                    placeholder={fieldPlaceholder}
                    onChange={(password) =>
                      updateAuth({ type: 'basic', username: authRenderDraft.username, password })
                    }
                    onBlur={flushAuth}
                    testId="workspace-auth-password"
                  />
                </>
              )}
              {authRenderDraft.type === 'apiKey' && (
                <>
                  <AuthField
                    label={t('editor.authKeyLabel')}
                    value={authRenderDraft.key}
                    placeholder={fieldPlaceholder}
                    onChange={(key) =>
                      updateAuth({
                        type: 'apiKey',
                        position: authRenderDraft.position,
                        key,
                        value: authRenderDraft.value,
                      })
                    }
                    onBlur={flushAuth}
                    testId="workspace-auth-key"
                  />
                  <AuthField
                    label={t('editor.authValueLabel')}
                    value={authRenderDraft.value}
                    placeholder={fieldPlaceholder}
                    onChange={(value) =>
                      updateAuth({
                        type: 'apiKey',
                        position: authRenderDraft.position,
                        key: authRenderDraft.key,
                        value,
                      })
                    }
                    onBlur={flushAuth}
                    testId="workspace-auth-value"
                  />
                </>
              )}
            </div>
          </DetailSectionCard>

          {/* 卡：服务（卡头＝节标题＋计数＋动作入口；正文＝无表格线列表行，
              拖拽排序 / 悬浮操作 / 手工容器芯片 / 骨架与空态语义照搬现状） */}
          <DetailSectionCard
            data-testid="workspace-service-list"
            icon={<BookOpenTextIcon aria-hidden className="size-4 text-muted-foreground" />}
            title={
              <>
                {t('workspace.serviceSectionTitle')}
                {!servicesQuery.isPending && (
                  <span className="ml-1.5 font-mono text-xs text-muted-foreground tabular-nums">
                    {services.length}
                  </span>
                )}
              </>
            }
            actions={
              <>
                <Button
                  variant="outline"
                  size="xs"
                  data-testid="workspace-service-new"
                  onClick={openNewService}
                >
                  <PlusIcon aria-hidden data-icon="inline-start" />
                  {t('workspace.newService')}
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-muted-foreground"
                  data-testid="workspace-service-import"
                  onClick={openImport}
                >
                  {t('workspace.importEntry')}
                </Button>
              </>
            }
          >
            {servicesQuery.isPending ? (
              // 加载骨架：形状匹配列表行的占位行（宽度手挑伪随机），数据到位
              // 不整块突跳；aria-hidden＝纯装饰
              <ul data-testid="workspace-service-skeleton">
                {SERVICE_SKELETON_WIDTHS.map((width, index) => (
                  <li
                    key={index}
                    aria-hidden
                    className="flex items-center gap-6 border-t border-border px-4 py-2.5 first:border-t-0"
                  >
                    <div className="h-3 animate-pulse rounded-sm bg-muted" style={{ width }} />
                  </li>
                ))}
              </ul>
            ) : services.length === 0 ? (
              // 空态＝引导：图标＋说明＋两个动作入口（与卡头动作同一回调）
              <div className="px-4 py-6">
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <ServiceIcon />
                    </EmptyMedia>
                    <EmptyTitle>{t('workspace.serviceEmptyTitle')}</EmptyTitle>
                    <EmptyDescription>{t('workspace.serviceListEmpty')}</EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={openNewService}>
                        {t('workspace.newService')}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={openImport}>
                        {t('workspace.importEntry')}
                      </Button>
                    </div>
                  </EmptyContent>
                </Empty>
              </div>
            ) : (
              <ul>
                {services.map((service) => {
                  const hint = dropHint?.id === service.id ? dropHint.mode : null
                  return (
                    <li
                      key={service.id}
                      data-testid="workspace-service-row"
                      className={
                        hint === 'before'
                          ? 'group/row flex items-center gap-3 border-t border-border px-4 py-2.5 shadow-[inset_0_2px_0_0_var(--primary)] first:border-t-0'
                          : hint === 'after'
                            ? 'group/row flex items-center gap-3 border-t border-border px-4 py-2.5 shadow-[inset_0_-2px_0_0_var(--primary)] first:border-t-0'
                            : 'group/row flex items-center gap-3 border-t border-border px-4 py-2.5 first:border-t-0'
                      }
                      // 手柄武装制：仅按住行内手柄的 mousedown 解锁该行拖拽
                      draggable={dragArmedId === service.id || undefined}
                      onMouseDown={(event) => {
                        setDragArmedId(
                          event.target instanceof Element &&
                            event.target.closest('[data-drag-handle]')
                            ? service.id
                            : null,
                        )
                      }}
                      onMouseUp={() => setDragArmedId(null)}
                      onDragStart={(event) => serviceDrag.handleDragStart(service, event)}
                      onDragOver={(event) => handleServiceDragOver(service, event)}
                      onDrop={() => handleServiceDrop(service)}
                      onDragEnd={clearServiceDrag}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        setMenuServiceId(service.id)
                        menu.openAt(event.clientX, event.clientY)
                      }}
                    >
                      {/* 拖拽手柄＝命中目标芯片：行悬浮时亮底色显形，按住解锁
                          该行拖拽（武装制判定归 data-drag-handle，语义不变） */}
                      <span
                        data-drag-handle
                        aria-hidden
                        className="grid size-5 shrink-0 cursor-grab place-items-center rounded-sm text-muted-foreground opacity-0 transition-[opacity,background-color] duration-150 group-hover/row:bg-muted group-hover/row:opacity-100 active:cursor-grabbing"
                      >
                        <GripVerticalIcon className="size-3.5 shrink-0" />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm">{service.name}</span>
                      <span className="hidden min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground sm:block">
                        {service.docUrl === null ? (
                          '—'
                        ) : (
                          <span className="block truncate" title={service.docUrl}>
                            {service.docUrl}
                          </span>
                        )}
                      </span>
                      {service.docUrl === null && (
                        // 手工容器标识＝warning 浅底芯片（语义色仅此一处；
                        // 树行不重复标注）
                        <span className="inline-flex shrink-0 items-center rounded-sm bg-warning-bg px-1.5 py-0.5 text-micro text-warning">
                          {t('workspace.serviceNoDoc')}
                        </span>
                      )}
                      {/* 行内操作悬浮 / 键盘聚焦显现（与树行手柄同款纪律），
                          删除 hover 染危险色标示破坏性通道 */}
                      <div className="flex shrink-0 items-center opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t('workspace.actionEdit')}
                          data-testid="workspace-service-edit"
                          onClick={() =>
                            openDialog({
                              type: 'service-edit',
                              id: service.id,
                              name: service.name,
                              docUrl: service.docUrl,
                            })
                          }
                        >
                          <SquarePenIcon aria-hidden />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t('workspace.actionDelete')}
                          className="hover:text-destructive"
                          data-testid="workspace-service-delete"
                          onClick={() =>
                            openDialog({
                              type: 'service-delete',
                              id: service.id,
                              name: service.name,
                            })
                          }
                        >
                          <Trash2Icon aria-hidden />
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </DetailSectionCard>
        </DetailContentColumn>
      </div>

      {/* 行右键菜单：上移 / 下移（service.move 相邻交换；边界禁用） */}
      <ContextMenu open={menu.open} onOpenChange={(open) => !open && menu.close()}>
        <ContextMenuContent anchor={menu.anchor}>
          {menuService && (
            <>
              <ContextMenuItem
                disabled={menuIsFirst}
                onClick={() => moveService(menuService.id, 'up')}
              >
                {t('workspace.moveUp')}
              </ContextMenuItem>
              <ContextMenuItem
                disabled={menuIsLast}
                onClick={() => moveService(menuService.id, 'down')}
              >
                {t('workspace.moveDown')}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}
