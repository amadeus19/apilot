import * as React from 'react'

import { useQueryClient } from '@tanstack/react-query'
import { save as saveFileDialog, open as openFileDialog } from '@tauri-apps/plugin-dialog'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ClipboardPasteIcon,
  FileUpIcon,
  FolderPlusIcon,
  GripVerticalIcon,
  PlayIcon,
  PlusIcon,
  SquareIcon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import {
  Badge,
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  TreePrimitive,
  toast,
  usePointContextMenu,
  type TreeRowData,
} from '@workspace/ui/components'
import { cn } from 'cn'

import { reportError } from '@/services/error-center'
import { useIpcMutation, useIpcQuery } from '@/services/ipc-query'
import { useI18n } from '@/i18n'
import { useTabsStore, WORKFLOW_TAB_ID_PREFIX } from '@/stores/tabs.store'
import { useSettingsStore } from '@/stores/settings.store'
import { SEMANTIC_ICONS } from '@/features/icons/semantic-icons'
import { useWorkspacesQuery } from '@/features/workspaces/api'

import {
  workflowCancel,
  workflowDelete,
  workflowExport,
  workflowGroupDelete,
  workflowGroupList,
  workflowGroupMove,
  workflowImport,
  workflowKeys,
  workflowList,
  workflowLoad,
  workflowMove,
  workflowRename,
  workflowSetGroup,
  type WorkflowGroupDto,
  type WorkflowPasteReportDto,
  type WorkflowSummaryDto,
} from './workflow-api'
import { executeWorkflowGuarded } from './run-flow'
import { groupMoveNeighbors, workflowMoveNeighbors } from './workflow-dnd'
import { buildWorkflowNavIndex, type WorkflowNavNode } from './workflow-nav-tree'
import { useWorkflowDragSort } from './use-workflow-drag-sort'
import { useWorkflowClipboardStore } from './workflow-clipboard.store'
import { useWorkflowEditorStore } from './workflow-editor.store'
import {
  executionProgress,
  useWorkflowExecutionStore,
  type WorkflowExecutionUiState,
} from './execution.store'
import { reclaimClosedWorkflowTabs } from './workflow-close'
import { EXECUTION_STATUS_VISUALS } from './canvas/execution-state'
import {
  WorkflowCreateDialog,
  WorkflowDeleteDialog,
  WorkflowGroupCreateDialog,
  WorkflowGroupDeleteDialog,
  WorkflowGroupRenameDialog,
  WorkflowImportReportDialog,
  WorkflowPasteDialog,
  WorkflowRenameDialog,
} from './workflow-dialogs'

/**
 * 左栏「工作流」视图（第五视图完整形态）：分组树＝分组行（创建序，可
 * 折叠 / 右键改名删除）＋组内工作流＋未分组工作流尾置平铺。工作流行＝
 * 名称＋常显行内运行钮（运行中切停止并显示进度计数徽标「执行中 · N/M」，
 * 计数随事件流实时推进）＋行尾固定钮（把工作流钉到状态栏快捷触发，每
 * 空间至多一个，随设置 kv 持久化，分组行不参与）；历史结果不落行——执行
 * 完成经右下角 toast 呈现（协议单点在 run-flow）。行缩进与工作空间树同口径：
 * 无折叠指示的行补一格 chevron 空位，层级深度不因图标格数差而反转。
 * 右键菜单：工作流行＝重命名 / 复制 / 导出 / 移动到分组 / 删除；分组行＝
 * 改名 / 删除（组内成员回落未分组）。底部动作条「新建 ▾」＝新建工作流 /
 * 新建分组 / 粘贴工作流（剪贴板空置灰）/ 导入工作流。清单 mutation 失效
 * list 键重拉；删除连带关闭其编辑 Tab，重命名同步 Tab 标题（单一事实源在
 * tabs store）。导出导入的文件对话框＝系统级（tauri-plugin-dialog），路径
 * 选定后交 Rust 读写，UI 不直接操作文件。
 */

/** 树根 id（不渲染；与变量树 / 工作空间树同构的 dataLoader 形状） */
const NAV_ROOT_ID = 'workflow-nav-root'

/** 导出 / 导入的文件对话框类型限定（导出文件后缀 `.json`） */
const JSON_FILTERS = [{ name: 'JSON', extensions: ['json'] }]

/** 对话框槽位（单开：工作流四态＋分组三态） */
type DialogState =
  | { kind: 'create' }
  | { kind: 'paste' }
  | { kind: 'groupCreate' }
  | { kind: 'rename'; target: WorkflowSummaryDto }
  | { kind: 'delete'; target: WorkflowSummaryDto }
  | { kind: 'groupRename'; target: WorkflowGroupDto }
  | { kind: 'groupDelete'; target: WorkflowGroupDto }
  | null

/** 行菜单锚（工作流行 / 分组行二态；空白区右键清锚） */
type MenuTarget =
  { kind: 'workflow'; item: WorkflowSummaryDto } | { kind: 'group'; item: WorkflowGroupDto } | null

/** 树行内容壳（分组行 / 工作流行 / 缺行兜底共用的行容器形状）；group/row
 * 供行尾拖拽手柄的 hover 显现（与接口树行同一口径） */
const ROW_SHELL_CLASS = 'group/row flex min-w-0 flex-1 items-center gap-1'

/** 工作流行徽标公共形状（行高 / 圆角 / 内距 / 字号下限；状态配色由分支注入） */
const ROW_BADGE_CLASS = 'h-4 gap-0.5 rounded-4xl px-1.5 text-micro'

/** 树行语义图标公共类（与接口树行图标同一口径） */
const ROW_ICON_CLASS = 'size-3.5 shrink-0 text-muted-foreground'

/** 无折叠指示行的缩进补偿（px）：补一格折叠指示空位（指示器 14px＋行距
 * 4px），与工作空间树子行同口径——层级深度不因图标格数差而反转 */
const CHEVRON_SLOT_PX = 18

/** 「新建」动作集（底部动作条下拉与树空白区右键菜单共用：同项同序同禁用
 * 态；菜单项组件随宿主菜单各取 DropdownMenuItem / ContextMenuItem） */
type NewActionKind = 'create' | 'groupCreate' | 'paste' | 'import'

const NEW_ACTIONS: readonly {
  action: NewActionKind
  labelKey:
    | 'workflows.newWorkflow'
    | 'workflows.newGroup'
    | 'workflows.pasteWorkflow'
    | 'workflows.importWorkflow'
  icon: LucideIcon
  /** 真＝剪贴板空时置灰（仅粘贴项） */
  needsClipboard?: boolean
  testId: string
}[] = [
  {
    action: 'create',
    labelKey: 'workflows.newWorkflow',
    icon: SEMANTIC_ICONS.workflow,
    testId: 'workflows-menu-create',
  },
  {
    action: 'groupCreate',
    labelKey: 'workflows.newGroup',
    icon: FolderPlusIcon,
    testId: 'workflows-menu-group-create',
  },
  {
    action: 'paste',
    labelKey: 'workflows.pasteWorkflow',
    icon: ClipboardPasteIcon,
    needsClipboard: true,
    testId: 'workflows-menu-paste',
  },
  {
    action: 'import',
    labelKey: 'workflows.importWorkflow',
    icon: FileUpIcon,
    testId: 'workflows-menu-import',
  },
]

/** 拖拽手柄：TreePrimitive 手柄武装制的唯一拖拽入口（按住才解锁该行
 * draggable）；与接口树行同形，hover 行内才显现 */
function DragHandle({ className }: { className?: string }) {
  return (
    <GripVerticalIcon
      data-drag-handle
      aria-hidden
      className={cn(
        'size-3.5 shrink-0 cursor-grab text-muted-foreground/50 opacity-0 transition-opacity group-hover/row:text-muted-foreground group-hover/row:opacity-100',
        className,
      )}
    />
  )
}

/** 分组行内容：折叠指示（数据标记供树 chevron 语义）＋分组图标（与接口树
 * 分类同语义的文件夹态变体）＋名称 */
function GroupRowContent({
  row,
  showDragHandle,
}: {
  row: TreeRowData<WorkflowNavNode>
  showDragHandle: boolean
}) {
  const GroupIcon = row.isExpanded ? SEMANTIC_ICONS.categoryExpanded : SEMANTIC_ICONS.category
  return (
    <span className={ROW_SHELL_CLASS} style={{ paddingInlineStart: row.indentPx }}>
      <span
        aria-hidden
        data-tree-chevron
        className="relative grid size-3.5 shrink-0 place-items-center text-muted-foreground after:absolute after:-inset-x-2 after:-inset-y-1.5"
      >
        <ChevronRightIcon
          className={cn(
            'size-3.5 transition-transform duration-150',
            row.isExpanded && 'rotate-90',
          )}
        />
      </span>
      <GroupIcon aria-hidden className={ROW_ICON_CLASS} />
      <span className="min-w-0 truncate text-xs font-medium" title={row.name}>
        {row.name}
      </span>
      {showDragHandle && <DragHandle className="ml-auto" />}
    </span>
  )
}

/** 工作流行内容：名称＋常显行内运行钮（运行中切停止钮并显示进度计数
 * 徽标「执行中 · N/M」；事件未达的乐观态只显示「执行中」）。历史结果不
 * 落行，执行完成反馈由 run-flow 的右下角 toast 承担。缩进补一格 chevron
 * 空位与工作空间树行同口径。行尾固定钮（每空间至多一个的状态栏快捷
 * 触发引用）：未固定 hover 显现、已固定常亮，与行尾拖拽手柄同 hover
 * 口径。导出供组件测试直测（execution-panel 同款做法）。
 * memo 化：执行期事件只替换在途行的槽位对象，其余行的 props 引用恒定，
 * 树级重渲（整表订阅驱动）被逐行拦截，重渲止步于在途行。 */
function WorkflowRowContentImpl({
  row,
  execution,
  onRun,
  onStop,
  showDragHandle = false,
  pinned = false,
  onTogglePin,
}: {
  row: TreeRowData<WorkflowNavNode>
  /** 在途执行槽位（undefined＝不在途；running 态由槽位状态驱动） */
  execution: WorkflowExecutionUiState | undefined
  onRun: () => void
  onStop: () => void
  /** 真＝行尾渲染拖拽手柄（搜索过滤态整树禁拖，不渲染） */
  showDragHandle?: boolean
  /** 真＝已固定到状态栏（常亮态，aria-label 随态切换） */
  pinned?: boolean
  /** 固定 / 取消固定切换（undefined = 宿主未接线，整钮不渲染） */
  onTogglePin?: () => void
}) {
  const { t } = useI18n()
  const running = execution?.status === 'running'
  // 进度计数纯派生：事件未达（乐观态 order 空）无计数，只显示「执行中」
  const progress = running && execution ? executionProgress(execution) : null
  const runningVisual = EXECUTION_STATUS_VISUALS.running
  return (
    <span
      className={ROW_SHELL_CLASS}
      style={{ paddingInlineStart: row.indentPx + CHEVRON_SLOT_PX }}
    >
      <SEMANTIC_ICONS.workflow aria-hidden className={ROW_ICON_CLASS} />
      <span className="min-w-0 truncate text-xs" title={row.name}>
        {row.name}
      </span>
      {running && (
        <Badge
          className={cn(ROW_BADGE_CLASS, runningVisual.badgeClassName)}
          data-testid="workflows-row-progress"
        >
          <runningVisual.icon aria-hidden className="size-2.5" />
          {progress
            ? t('workflows.rowRunningProgress', { done: progress.done, total: progress.total })
            : t(runningVisual.labelKey)}
        </Badge>
      )}
      {onTogglePin && (
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(
            'ml-auto size-5 shrink-0 transition-opacity',
            pinned
              ? 'text-primary opacity-100'
              : 'opacity-0 group-hover/row:text-muted-foreground group-hover/row:opacity-100',
          )}
          onClick={(event) => {
            event.stopPropagation()
            onTogglePin()
          }}
          aria-label={pinned ? t('workflows.rowUnpin') : t('workflows.rowPin')}
          title={pinned ? t('workflows.rowUnpin') : t('workflows.rowPin')}
          data-testid="workflows-row-pin"
        >
          <SEMANTIC_ICONS.pinnedWorkflow aria-hidden className="size-3" />
        </Button>
      )}
      {running ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn('size-5 shrink-0', !onTogglePin && 'ml-auto')}
          onClick={(event) => {
            event.stopPropagation()
            onStop()
          }}
          aria-label={t('workflows.rowStop')}
          title={t('workflows.toolbarStopHint')}
          data-testid="workflows-row-stop"
        >
          <SquareIcon aria-hidden className="size-3 text-destructive" />
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn('size-5 shrink-0 opacity-40 hover:opacity-100', !onTogglePin && 'ml-auto')}
          onClick={(event) => {
            event.stopPropagation()
            onRun()
          }}
          aria-label={t('workflows.rowRun')}
          title={t('workflows.rowRun')}
          data-testid="workflows-row-run"
        >
          <PlayIcon aria-hidden className="size-3" />
        </Button>
      )}
      {showDragHandle && <DragHandle />}
    </span>
  )
}

export const WorkflowRowContent = React.memo(WorkflowRowContentImpl)

export function WorkflowsView({
  searchQuery = '',
  onSearchChange,
}: {
  /** 搜索词（宿主持有；缺省空串＝不过滤） */
  searchQuery?: string
  /** 搜索词回调（空态「清除搜索」按钮经它清词；宿主接线前可为空） */
  onSearchChange?: (value: string) => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const workspacesQuery = useWorkspacesQuery()
  const workspaceId = workspacesQuery.data?.currentId ?? null
  const openWorkflow = useTabsStore((s) => s.openWorkflow)
  const closeWhere = useTabsStore((s) => s.closeWhere)
  const setTabTitle = useTabsStore((s) => s.setTabTitle)
  const renameSession = useWorkflowEditorStore((s) => s.renameSession)
  const clipboardEntry = useWorkflowClipboardStore((s) => s.entry)
  const workflowPins = useSettingsStore((s) => s.workflowPins)
  const setWorkflowPin = useSettingsStore((s) => s.setWorkflowPin)
  const menu = usePointContextMenu()

  const listQuery = useIpcQuery({
    queryKey: workflowKeys.list(workspaceId ?? ''),
    queryFn: () => workflowList(workspaceId!),
    enabled: workspaceId !== null,
  })
  const groupsQuery = useIpcQuery({
    queryKey: workflowKeys.groups(workspaceId ?? ''),
    queryFn: () => workflowGroupList(workspaceId!),
    enabled: workspaceId !== null,
  })
  const items = listQuery.data?.items ?? EMPTY_ITEMS
  const groups = groupsQuery.data?.items ?? EMPTY_GROUPS

  // 搜索过滤＋树归约（纯函数单测点）：分组（创建序）→ 组内 → 未分组尾置
  const index = React.useMemo(
    () => buildWorkflowNavIndex(items, groups, searchQuery),
    [items, groups, searchQuery],
  )
  const itemById = React.useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const groupById = React.useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups])

  // 折叠态（会话 UI 态；新分组默认展开——折叠集合只增不删，缺省即展开）
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(new Set())
  const expandedItems = React.useMemo(
    () => groups.map((group) => group.id).filter((id) => !collapsed.has(id)),
    [groups, collapsed],
  )

  const dataLoader = React.useMemo(
    () => ({
      // 索引缺行时以占位行防炸（数据刷新瞬间的过渡态，下一帧消失；与
      // 接口树 / 变量树同一兜底口径）
      getItem: (id: string): WorkflowNavNode =>
        index.nodes.get(id) ?? { kind: 'workflow', id, name: '' },
      getChildren: (id: string) =>
        id === NAV_ROOT_ID ? index.rootChildren : (index.groupChildren.get(id) ?? []),
    }),
    [index],
  )

  // —— 对话框与菜单行（事件回调写入，渲染期只读） ——
  const [dialog, setDialog] = React.useState<DialogState>(null)
  const [menuTarget, setMenuTarget] = React.useState<MenuTarget>(null)
  // 导入完成报告（导入流程无中间对话框：文件选择即输入相，报告即终相）
  const [importReport, setImportReport] = React.useState<WorkflowPasteReportDto | null>(null)

  // 在途执行槽位（订阅整表：行内运行钮的 running 切换 reactive 跟随事件流）
  const executions = useWorkflowExecutionStore((s) => s.executions)

  const invalidateList = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: workflowKeys.listPrefix })
  }, [queryClient])

  const deleteMutation = useIpcMutation({
    mutationFn: (id: string) => workflowDelete(id),
    onSuccess: (_data, id) => {
      // 删除联动＝不保存关闭（删除已确认，脏编辑必然丢弃）：Tab 关闭与
      // 编辑会话、执行槽回收走域内同一关闭编排
      reclaimClosedWorkflowTabs(() => {
        closeWhere((tab) => tab.kind === 'workflow' && tab.key === id)
      })
      invalidateList()
    },
    onError: reportError,
  })

  const renameMutation = useIpcMutation({
    mutationFn: (input: { id: string; name: string }) => workflowRename(input.id, input.name),
    onSuccess: (dto) => {
      setTabTitle(`${WORKFLOW_TAB_ID_PREFIX}${dto.id}`, dto.name)
      renameSession(dto.id, dto.name)
      invalidateList()
    },
    onError: reportError,
  })

  const groupDeleteMutation = useIpcMutation({
    mutationFn: (id: string) => workflowGroupDelete(id),
    onSuccess: () => {
      // 组行消失与组内成员回落未分组分属两份缓存：groups 前缀失效刷组
      // 清单（与改名同口径），list 前缀失效刷工作流的分组归属
      void queryClient.invalidateQueries({ queryKey: workflowKeys.groupsPrefix })
      invalidateList()
    },
    onError: reportError,
  })

  const setGroupMutation = useIpcMutation({
    mutationFn: (input: { id: string; groupId: string | null }) =>
      workflowSetGroup(input.id, input.groupId),
    onSuccess: invalidateList,
    onError: reportError,
  })

  // 树拖拽移动：工作流（组内重排 / 跨组）失效 list；分组重排失效 groups
  const workflowMoveMutation = useIpcMutation({
    mutationFn: (input: { id: string; groupId: string | null; index: number }) =>
      workflowMove(input.id, input.groupId, input.index),
    onSuccess: invalidateList,
    onError: reportError,
  })
  const groupMoveMutation = useIpcMutation({
    mutationFn: (input: { id: string; index: number }) => workflowGroupMove(input.id, input.index),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workflowKeys.groupsPrefix })
    },
    onError: reportError,
  })

  const openEditor = React.useCallback(
    (item: WorkflowSummaryDto) => {
      openWorkflow({ workflowId: item.id, name: item.name })
    },
    [openWorkflow],
  )

  /** 复制到应用内剪贴板：编辑会话在则复制当前编辑态（所见即所得），
   * 否则取落库图；只写内存会话态，不碰系统剪贴板。 */
  const copyWorkflow = React.useCallback(
    (item: WorkflowSummaryDto) => {
      const session = useWorkflowEditorStore.getState().sessions[item.id]
      const name = session?.name ?? item.name
      void (
        session ? Promise.resolve(session.graph) : workflowLoad(item.id).then((dto) => dto.graph)
      )
        .then((graph) => {
          useWorkflowClipboardStore.getState().copy({ name, graph })
          toast.success(t('workflows.copiedToast', { name }))
        })
        .catch((error) => reportError(error))
    },
    [t],
  )

  /** 行内运行（不开编辑器）：协议单点在 run-flow（校验闸 → 乐观置
   * running → 阻塞执行至终态 → 记录对齐＋清单失效）。本入口差异项＝
   * 校验落库图＋问题只 toast 指路（编辑器才有定位面板） */
  const runInline = React.useCallback(
    (item: WorkflowSummaryDto) => {
      executeWorkflowGuarded({
        workflowId: item.id,
        name: item.name,
        onIssues: (issues) => {
          if (issues.length > 0) toast.error(t('workflows.runBlockedByIssues'))
        },
      })
    },
    [t],
  )

  /** 导出工作流为 `.json` 文件：系统保存对话框选路径 → Rust 落盘（空间
   * 作用域读取——跨空间 id 视同不存在；落库图经读时脱敏投影，敏感覆写
   * 字面量不进文件）；取消为正常路径静默。默认文件名取工作流名（Windows
   * 保留字符替换为连字符，改名窗口内可再调）。 */
  const exportWorkflow = React.useCallback(
    async (targetWorkspaceId: string, item: WorkflowSummaryDto) => {
      const target = await saveFileDialog({
        defaultPath: `${item.name.replace(/[\\/:*?"<>|]/g, '-')}.json`,
        filters: JSON_FILTERS,
      })
      if (target === null) return
      try {
        const result = await workflowExport(targetWorkspaceId, item.id, target)
        toast.success(t('workflows.exportedToast', { path: result.path }))
      } catch (error) {
        reportError(error)
      }
    },
    [t],
  )

  /** 导入工作流：系统打开对话框选导出文件 → Rust 封皮版本闸＋粘贴解析链
   * 落地 → 报告对话框（与粘贴报告同体）；取消为正常路径静默，失败走统一
   * 错误上报（版本过高按 `errors.WORKFLOW_IMPORT_VERSION_UNSUPPORTED` 呈现）。 */
  const importWorkflow = React.useCallback(
    async (targetWorkspaceId: string) => {
      const picked = await openFileDialog({ multiple: false, filters: JSON_FILTERS })
      if (picked === null) return
      try {
        const report = await workflowImport(targetWorkspaceId, picked)
        invalidateList()
        setImportReport(report)
      } catch (error) {
        reportError(error)
      }
    },
    [invalidateList],
  )

  const stopInline = React.useCallback((item: WorkflowSummaryDto) => {
    void workflowCancel(item.id).catch((error) => reportError(error))
  }, [])

  /** 固定 / 取消固定到状态栏（每空间至多一个，随设置 kv 持久化）：
   * 已固定同行再点即取消；键按 workspaceId 索引，切换空间自动跟随 */
  const togglePin = React.useCallback(
    (item: WorkflowSummaryDto) => {
      if (workspaceId === null) return
      const pinned = useSettingsStore.getState().workflowPins[workspaceId] === item.id
      setWorkflowPin(workspaceId, pinned ? null : item.id)
    },
    [workspaceId, setWorkflowPin],
  )

  /** 「新建」动作分发（底部动作条与树空白区右键共用同一入口）：粘贴在
   * 剪贴板空时为不可达分支，导入需工作空间就绪 */
  const pickNewAction = React.useCallback(
    (action: NewActionKind) => {
      if (action === 'create') setDialog({ kind: 'create' })
      else if (action === 'groupCreate') setDialog({ kind: 'groupCreate' })
      else if (action === 'paste') {
        if (clipboardEntry) setDialog({ kind: 'paste' })
      } else if (workspaceId !== null) {
        void importWorkflow(workspaceId)
      }
    },
    [clipboardEntry, workspaceId, importWorkflow],
  )

  // 树拖拽排序接线（搜索过滤中整树禁拖；落点判定单点在 workflow-dnd）
  const searchActive = searchQuery.trim() !== ''
  const dragSort = useWorkflowDragSort({
    index,
    searchActive,
    onMoveWorkflow: (input) => workflowMoveMutation.mutate(input),
    onMoveGroup: (input) => groupMoveMutation.mutate(input),
  })

  // —— 树回调（行数据 → 实体的映射；数据刷新瞬间的缺行静默忽略） ——

  const renderRow = React.useCallback(
    (row: TreeRowData<WorkflowNavNode>) => {
      if (row.data.kind === 'group')
        return <GroupRowContent row={row} showDragHandle={!searchActive} />
      const item = itemById.get(row.id)
      // 数据刷新瞬间的缺行兜底（下一帧消失；与接口树同一口径）
      if (!item) {
        return (
          <span
            className={cn(ROW_SHELL_CLASS, 'text-xs')}
            style={{
              paddingInlineStart:
                row.data.kind === 'workflow' ? row.indentPx + CHEVRON_SLOT_PX : row.indentPx,
            }}
          >
            <span className="min-w-0 truncate">{row.name}</span>
          </span>
        )
      }
      return (
        <WorkflowRowContent
          row={row}
          execution={executions[row.id]}
          onRun={() => runInline(item)}
          onStop={() => stopInline(item)}
          showDragHandle={!searchActive}
          pinned={workspaceId !== null && workflowPins[workspaceId] === item.id}
          onTogglePin={() => togglePin(item)}
        />
      )
    },
    [
      itemById,
      executions,
      runInline,
      stopInline,
      searchActive,
      workspaceId,
      workflowPins,
      togglePin,
    ],
  )

  const hasEntities = items.length > 0 || groups.length > 0

  // 行菜单的上移 / 下移落点：菜单是拖拽的键盘等价路径（手柄只有指针通道）；
  // 搜索过滤态树是子图，序号不可信，菜单项禁用
  const menuNeighbors =
    menuTarget === null
      ? null
      : menuTarget.kind === 'workflow'
        ? workflowMoveNeighbors(index, menuTarget.item.id)
        : groupMoveNeighbors(index, menuTarget.item.id)

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workflows-view">
      {workspaceId !== null && (
        <>
          {/* 主体区（空态 / 搜索空态 / 树共用同一空白右键面：「新建」动作集
              在三种形态下都可直达） */}
          <div
            className="flex min-h-0 flex-1 flex-col"
            onContextMenu={(event) => {
              // 树行的右键归 TreePrimitive 回调；空白区右键清行锚点
              if ((event.target as HTMLElement).closest('[role="treeitem"]')) return
              event.preventDefault()
              setMenuTarget(null)
              menu.openAt(event.clientX, event.clientY)
            }}
          >
            {!hasEntities ? (
              <Empty className="min-h-0 flex-1 border-0">
                <EmptyHeader>
                  <EmptyTitle>{t('workflows.emptyTitle')}</EmptyTitle>
                  <EmptyDescription>{t('workflows.emptyDescription')}</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button size="sm" onClick={() => setDialog({ kind: 'create' })}>
                    <PlusIcon aria-hidden className="size-3.5" />
                    {t('workflows.newWorkflow')}
                  </Button>
                </EmptyContent>
              </Empty>
            ) : items.length > 0 && index.rootChildren.length === 0 ? (
              <Empty className="min-h-0 flex-1 border-0">
                <EmptyHeader>
                  <EmptyTitle>{t('workflows.searchEmptyTitle')}</EmptyTitle>
                </EmptyHeader>
                <EmptyContent>
                  <Button variant="outline" size="sm" onClick={() => onSearchChange?.('')}>
                    {t('workflows.searchClear')}
                  </Button>
                </EmptyContent>
              </Empty>
            ) : (
              <TreePrimitive<WorkflowNavNode>
                dataLoader={dataLoader}
                rootId={NAV_ROOT_ID}
                ariaLabel={t('shell.viewWorkflows')}
                isItemFolder={(node) => node.kind === 'group'}
                expandedItems={expandedItems}
                onExpandedItemsChange={(ids) => {
                  const expanded = new Set(ids)
                  setCollapsed(new Set(groups.filter((g) => !expanded.has(g.id)).map((g) => g.id)))
                }}
                isRowDraggable={dragSort.isRowDraggable}
                onRowDragStart={dragSort.handleRowDragStart}
                onRowDragOver={dragSort.handleRowDragOver}
                onRowDrop={dragSort.handleRowDrop}
                onRowDragEnd={dragSort.handleRowDragEnd}
                onRowActivate={(row) => {
                  if (row.data.kind !== 'workflow') return
                  const item = itemById.get(row.id)
                  if (item) openEditor(item)
                }}
                onRowContextMenu={(rowId, position) => {
                  const group = groupById.get(rowId)
                  if (group) {
                    setMenuTarget({ kind: 'group', item: group })
                  } else {
                    const item = itemById.get(rowId)
                    if (!item) return
                    setMenuTarget({ kind: 'workflow', item })
                  }
                  menu.openAt(position.x, position.y)
                }}
                renderRow={renderRow}
                className="min-h-0"
              />
            )}
          </div>

          {/* 底部动作条：「新建 ▾」（新建工作流 / 新建分组 / 粘贴工作流 / 导入工作流） */}
          <div className="shrink-0 border-t border-border p-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start text-xs text-muted-foreground"
                    data-testid="workflows-new-menu"
                  >
                    <PlusIcon aria-hidden className="size-3.5" />
                    {t('workflows.newButton')}
                    <ChevronDownIcon aria-hidden className="ml-auto size-3.5" />
                  </Button>
                }
              />
              <DropdownMenuContent align="start" className="w-44">
                {NEW_ACTIONS.map((action) => (
                  <DropdownMenuItem
                    key={action.action}
                    disabled={action.needsClipboard === true && clipboardEntry == null}
                    onClick={() => pickNewAction(action.action)}
                    title={
                      action.needsClipboard === true && clipboardEntry == null
                        ? t('workflows.pasteDisabledHint')
                        : undefined
                    }
                    data-testid={action.testId}
                  >
                    <action.icon aria-hidden className="size-3.5" />
                    {t(action.labelKey)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </>
      )}

      {/* 行上下文菜单（受控开合；menuTarget 缺失＝数据刷新瞬间，菜单空壳） */}
      <ContextMenu open={menu.open} onOpenChange={(open) => !open && menu.close()}>
        <ContextMenuContent anchor={menu.anchor}>
          {/* 空白区右键（无行锚）：呈现「新建」动作集——与底部动作条同项同序 */}
          {menuTarget === null &&
            NEW_ACTIONS.map((action) => (
              <ContextMenuItem
                key={action.action}
                disabled={action.needsClipboard === true && clipboardEntry == null}
                onClick={() => pickNewAction(action.action)}
                title={
                  action.needsClipboard === true && clipboardEntry == null
                    ? t('workflows.pasteDisabledHint')
                    : undefined
                }
                data-testid={action.testId}
              >
                <action.icon aria-hidden className="size-3.5" />
                {t(action.labelKey)}
              </ContextMenuItem>
            ))}
          {menuTarget?.kind === 'workflow' && (
            <>
              <ContextMenuItem
                onClick={() => setDialog({ kind: 'rename', target: menuTarget.item })}
              >
                {t('workflows.rowMenuRename')}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => copyWorkflow(menuTarget.item)}>
                {t('workflows.rowMenuCopy')}
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => {
                  if (workspaceId !== null) void exportWorkflow(workspaceId, menuTarget.item)
                }}
              >
                {t('workflows.rowMenuExport')}
              </ContextMenuItem>
              <ContextMenuSub>
                <ContextMenuSubTrigger>{t('workflows.rowMenuMoveToGroup')}</ContextMenuSubTrigger>
                <ContextMenuSubContent className="w-44">
                  {groups.length === 0 && (
                    <ContextMenuItem disabled>{t('workflows.moveToGroupEmpty')}</ContextMenuItem>
                  )}
                  {groups.map((group) => (
                    <ContextMenuItem
                      key={group.id}
                      disabled={menuTarget.item.groupId === group.id}
                      onClick={() =>
                        setGroupMutation.mutate({ id: menuTarget.item.id, groupId: group.id })
                      }
                    >
                      {group.name}
                    </ContextMenuItem>
                  ))}
                  {menuTarget.item.groupId != null && (
                    <ContextMenuItem
                      onClick={() =>
                        setGroupMutation.mutate({ id: menuTarget.item.id, groupId: null })
                      }
                    >
                      {t('workflows.rowMenuMoveOut')}
                    </ContextMenuItem>
                  )}
                </ContextMenuSubContent>
              </ContextMenuSub>
              <ContextMenuItem
                disabled={searchActive || menuNeighbors?.up == null}
                onClick={() => {
                  if (menuNeighbors?.up == null) return
                  workflowMoveMutation.mutate({
                    id: menuTarget.item.id,
                    groupId: menuTarget.item.groupId,
                    index: menuNeighbors.up,
                  })
                }}
              >
                {t('workflows.rowMenuMoveUp')}
              </ContextMenuItem>
              <ContextMenuItem
                disabled={searchActive || menuNeighbors?.down == null}
                onClick={() => {
                  if (menuNeighbors?.down == null) return
                  workflowMoveMutation.mutate({
                    id: menuTarget.item.id,
                    groupId: menuTarget.item.groupId,
                    index: menuNeighbors.down,
                  })
                }}
              >
                {t('workflows.rowMenuMoveDown')}
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => setDialog({ kind: 'delete', target: menuTarget.item })}
              >
                {t('workflows.rowMenuDelete')}
              </ContextMenuItem>
            </>
          )}
          {menuTarget?.kind === 'group' && (
            <>
              <ContextMenuItem
                onClick={() => setDialog({ kind: 'groupRename', target: menuTarget.item })}
              >
                {t('workflows.rowMenuRename')}
              </ContextMenuItem>
              <ContextMenuItem
                disabled={searchActive || menuNeighbors?.up == null}
                onClick={() => {
                  if (menuNeighbors?.up == null) return
                  groupMoveMutation.mutate({ id: menuTarget.item.id, index: menuNeighbors.up })
                }}
              >
                {t('workflows.rowMenuMoveUp')}
              </ContextMenuItem>
              <ContextMenuItem
                disabled={searchActive || menuNeighbors?.down == null}
                onClick={() => {
                  if (menuNeighbors?.down == null) return
                  groupMoveMutation.mutate({ id: menuTarget.item.id, index: menuNeighbors.down })
                }}
              >
                {t('workflows.rowMenuMoveDown')}
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => setDialog({ kind: 'groupDelete', target: menuTarget.item })}
              >
                {t('workflows.rowMenuDelete')}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {dialog?.kind === 'create' && workspaceId !== null && (
        <WorkflowCreateDialog
          workspaceId={workspaceId}
          onCreated={(dto) => {
            openWorkflow({ workflowId: dto.id, name: dto.name })
            setDialog(null)
          }}
          onOpenChange={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'paste' && workspaceId !== null && clipboardEntry != null && (
        <WorkflowPasteDialog
          workspaceId={workspaceId}
          entry={clipboardEntry}
          onOpen={(dto) => {
            openWorkflow({ workflowId: dto.id, name: dto.name })
            setDialog(null)
          }}
          onOpenChange={() => setDialog(null)}
        />
      )}
      {importReport && (
        <WorkflowImportReportDialog
          report={importReport}
          onOpen={(dto) => {
            openWorkflow({ workflowId: dto.id, name: dto.name })
            setImportReport(null)
          }}
          onOpenChange={() => setImportReport(null)}
        />
      )}
      {dialog?.kind === 'groupCreate' && workspaceId !== null && (
        <WorkflowGroupCreateDialog
          workspaceId={workspaceId}
          onCreated={() => setDialog(null)}
          onOpenChange={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'rename' && (
        <WorkflowRenameDialog
          target={dialog.target}
          pending={renameMutation.isPending}
          onSubmit={(name) =>
            renameMutation.mutate(
              { id: dialog.target.id, name },
              { onSuccess: () => setDialog(null) },
            )
          }
          onOpenChange={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'delete' && (
        <WorkflowDeleteDialog
          target={dialog.target}
          pending={deleteMutation.isPending}
          onSubmit={() =>
            deleteMutation.mutate(dialog.target.id, { onSuccess: () => setDialog(null) })
          }
          onOpenChange={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'groupRename' && (
        <WorkflowGroupRenameDialog target={dialog.target} onOpenChange={() => setDialog(null)} />
      )}
      {dialog?.kind === 'groupDelete' && (
        <WorkflowGroupDeleteDialog
          target={dialog.target}
          pending={groupDeleteMutation.isPending}
          onSubmit={() =>
            groupDeleteMutation.mutate(dialog.target.id, { onSuccess: () => setDialog(null) })
          }
          onOpenChange={() => setDialog(null)}
        />
      )}
    </div>
  )
}

const EMPTY_ITEMS: WorkflowSummaryDto[] = []
const EMPTY_GROUPS: WorkflowGroupDto[] = []
