import * as React from 'react'

import { useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ChevronRightIcon,
  DownloadIcon,
  EyeIcon,
  PlusIcon,
  SquarePenIcon,
  Trash2Icon,
  UploadIcon,
} from 'lucide-react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  CopyButton,
  copyTextWithFeedback,
  DetailBanner,
  DetailContentColumn,
  DetailSectionCard,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RadioGroup,
  RadioGroupItem,
  Switch,
  Textarea,
  toast,
  useUiText,
} from '@workspace/ui/components'
import { cn } from 'cn'

import { useI18n, type DictKey } from '@/i18n'
import { useDraftField } from '@/lib/use-draft-field'
import { toIpcError } from '@/services/ipc'
import { useIpcQuery } from '@/services/ipc-query'
import { VARIABLES_TAB_ID_PREFIX, useTabsStore } from '@/stores/tabs.store'
import { useWorkspacesQuery } from '@/features/workspaces/api'
import { SEMANTIC_ICONS } from '@/features/icons/semantic-icons'

import { applyVariablesList, useVariableMutations } from './variable-mutations'
import { RenameCategoryDialog } from './category-dialogs'
import {
  variableCreateVariable,
  variableEffective,
  variableKeys,
  variableListCategories,
  variableListVariables,
  variableUpdateVariable,
  type EffectiveVariableDto,
  type VariableDto,
} from './variable-api'
import {
  exportCategoryJson,
  parseBulkVariableLines,
  parseImportedVariables,
  type ImportParseError,
} from './variable-transfer'

/** Secret 展示掩码（固定八圆点，不泄露值长度） */
const SECRET_MASK = '••••••••'

/** 加载骨架占位行宽度（手挑伪随机，避免整齐划一的机器感） */
const TABLE_SKELETON_WIDTHS = ['38%', '24%', '45%']

/** 键值表虚拟化切换阈值：超过后行改虚拟渲染（导入大 JSON 后数百行现实可达） */
const VIRTUALIZE_ROW_THRESHOLD = 50

/** 键值行高（px）：h-7 输入 28＋上下 py-2 共 16＋border-t 1 */
const VARIABLE_ROW_HEIGHT = 45

/**
 * 变量配置页（「变量 · <分类名>」Tab 的内容页）。
 *
 * 布局（变量页拍板版式）：身份横幅＋居中限宽键值表卡——横幅＝分类图标块
 * ＋只读大标题（改名走弹窗，与左栏树 F2 同一对话框；工作空间详情同形）
 * ＋激活 / 全局徽章＋meta 摘要行（变量数 · 是否参与生效集）＋右侧动作组
 * （改名 / 激活切换 / 导出 / 导入 / 删除分类）；身体＝居中单列一张「变量」
 * 卡（卡头＝变量计数＋生效预览＋新增变量；卡体＝键值列表行，行内 key /
 * value 编辑＋Secret 开关＋行尾动作悬浮显形）。
 *
 * 生效变量集＝卡头「生效预览」按钮弹出的 Popover（按需查看的次要信息，
 * 不与内容分栏抢宽度；优先级链 chips＋恒掩码清单＋来源徽标，查询键与
 * staleTime 不变），右栏分栏形态移除。
 *
 * 行内编辑：值列与变量名列都是「点击才成为输入框」的静默单元格——
 * 失焦 / 回车落盘，Esc 退出不落；变量名是身份的组成（复合主键），改名
 * 走 variable.rename_variable 原子改主键列，新名撞车稳定报错。
 *
 * Secret 纪律：
 * - 配置页值列：默认掩码（password 形态输入框）、眼睛图标临时明文（会话级
 *   切换态，不持久）、复制直接明文（复制是用户主动行为，明文即得）；
 * - 生效预览：恒掩码（不提供明文切换，不放复制按钮）。
 *
 * 缓存策略收口在 variable-mutations（变量 / 分类 mutation 返回刷新后的
 * 视图直写＋失效 effective 键）；本页只带自己的 UI 副作用——Tab 标题随
 * 分类改名同步、删除分类成功后关闭本 Tab（级联删除其下全部变量，确认
 * 弹窗明示）。
 */

/** Secret 值输入行内件：掩码输入＋眼睛临时明文＋复制直接明文 */
function SecretValueInput({
  value,
  secret,
  onCommit,
  testId,
}: {
  value: string
  secret: boolean
  /** 失焦落盘（值有变化才会上抛） */
  onCommit: (value: string) => void
  testId: string
}) {
  const { t } = useI18n()
  // 眼睛切换是临时明文（会话级，不持久、不落库）
  const [revealed, setRevealed] = React.useState(false)
  // 编辑草稿（null＝跟随已落盘值；失焦提交后归 null 回跟随）
  const [draft, setDraft] = React.useState<string | null>(null)
  const shown = draft ?? value

  return (
    <div className="flex w-full min-w-0 items-center gap-1">
      <Input
        value={shown}
        type={secret && !revealed ? 'password' : 'text'}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== null && draft !== value) onCommit(draft)
          setDraft(null)
        }}
        spellCheck={false}
        aria-label={t('variables.config.valueColumn')}
        className="h-7 min-w-0 flex-1 font-mono text-xs"
        data-testid={testId}
      />
      {secret && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground"
          aria-label={
            revealed ? t('variables.config.hideSecret') : t('variables.config.showSecret')
          }
          title={revealed ? t('variables.config.hideSecret') : t('variables.config.showSecret')}
          aria-pressed={revealed}
          data-testid={`${testId}-reveal`}
          onClick={() => setRevealed((open) => !open)}
        >
          {revealed ? (
            <SEMANTIC_ICONS.secretHide aria-hidden />
          ) : (
            <SEMANTIC_ICONS.secretReveal aria-hidden />
          )}
        </Button>
      )}
      {/* 复制直接明文（用户主动行为，明文即得）；口径＝当前显示的草稿值 */}
      <CopyButton
        variant="ghost"
        className="h-6 shrink-0 px-1.5 text-muted-foreground"
        aria-label={t('variables.config.copySecret')}
        title={t('variables.config.copySecret')}
        data-testid={`${testId}-copy`}
        getText={() => shown}
      />
    </div>
  )
}

/** 变量名单元格：静默文本，点击才成为输入框（失焦 / 回车落盘，Esc 退出） */
function VariableKeyCell({
  variable,
  onRename,
}: {
  variable: VariableDto
  /** 改名上抛（新名规范化与撞车校验在后端） */
  onRename: (key: string, newKey: string) => void
}) {
  const { t } = useI18n()
  const [editing, setEditing] = React.useState(false)
  // 草稿字段：点击编辑时建立（基线＝当时的真值）；编辑会话外跟随真值
  const keyField = useDraftField(variable.key)

  if (!editing) {
    return (
      <button
        type="button"
        className="-mx-1 block max-w-full cursor-text truncate rounded-sm px-1 py-0.5 text-left transition-colors duration-150 outline-none hover:bg-accent focus-visible:ring-[2px] focus-visible:ring-ring/50"
        title={variable.key}
        aria-label={t('variables.config.editKey', { key: variable.key })}
        data-testid={`variable-key-${variable.key}`}
        onClick={() => {
          keyField.begin()
          setEditing(true)
        }}
      >
        {variable.key}
      </button>
    )
  }

  const commit = () => {
    setEditing(false)
    keyField.commitIfChanged((draft) => {
      const nextKey = draft.trim()
      if (nextKey === '' || nextKey === variable.key) return
      onRename(variable.key, nextKey)
    })
  }

  return (
    <Input
      value={keyField.value}
      onChange={(event) => keyField.set(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          keyField.reset()
          setEditing(false)
        }
      }}
      aria-label={t('variables.config.addKeyLabel')}
      spellCheck={false}
      className="h-6 px-1.5 font-mono text-xs"
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      data-testid={`variable-key-input-${variable.key}`}
    />
  )
}

/** 键值列表行：变量名（点击编辑）＋值列＋Secret 开关＋删除（动作悬浮显形）。
 *  mutation 通道由页级持有下发（此前每行自挂整套 mutation 组——导入大表
 *  时数百行的重复开销）；行组件 memo，配合引用稳定的 mutate 通道使无关
 *  渲染（对话框开关 / 他行编辑）不再触达未变行。 */
const VariableRow = React.memo(function VariableRow({
  variable,
  style,
  onRename,
  onUpdate,
  onDelete,
}: {
  variable: VariableDto
  /** 虚拟化行的定位样式（非虚拟化渲染不传） */
  style?: React.CSSProperties
  onRename: (key: string, newKey: string) => void
  onUpdate: (key: string, value: string, secret: boolean) => void
  onDelete: (variable: VariableDto) => void
}) {
  const { t } = useI18n()

  return (
    <li
      className="group/row grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto_auto] items-center gap-3 border-t border-border px-4 py-2 first:border-t-0"
      style={style}
      data-testid="variable-row"
      data-variable-key={variable.key}
    >
      <VariableKeyCell variable={variable} onRename={onRename} />
      <SecretValueInput
        value={variable.value}
        secret={variable.secret}
        testId={`variable-value-${variable.key}`}
        onCommit={(value) => onUpdate(variable.key, value, variable.secret)}
      />
      {/* Secret 开关＝状态列（常驻）；切换即写（标记变化立即影响掩码口径） */}
      <Switch
        checked={variable.secret}
        onCheckedChange={(checked) => onUpdate(variable.key, variable.value, checked === true)}
        aria-label={t('variables.config.secretColumn')}
        data-testid={`variable-secret-${variable.key}`}
      />
      {/* 行内动作悬浮 / 键盘聚焦显形（与工作空间服务行同款纪律），删除
          hover 染危险色标示破坏性通道 */}
      <div className="flex justify-end opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100">
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={t('variables.config.deleteVariable', { key: variable.key })}
          title={t('variables.config.deleteVariable', { key: variable.key })}
          data-testid={`variable-delete-${variable.key}`}
          onClick={() => onDelete(variable)}
        >
          <Trash2Icon aria-hidden />
        </Button>
      </div>
    </li>
  )
})

/** 批量落库的行级错误（解析错误与写库失败同一列表呈现；line 1 起算） */
interface BulkRowError {
  line: number
  key: string
  message: string
}

/** 导入行级警示 / 失败（掩码跳过行与写库失败同位呈现；JSON 条目无文本行
 *  语义，不带 line——与批量通道的 BulkRowError 是两种形态） */
interface ImportRowNotice {
  key: string
  message: string
}

/** 解析错误原因 → 文案键（显式映射，不走动态拼键） */
const BULK_ERROR_KEYS: Record<
  ReturnType<typeof parseBulkVariableLines>['errors'][number]['reason'],
  DictKey
> = {
  'missing-colon': 'variables.transfer.bulkMissingColon',
  'empty-key': 'variables.transfer.bulkEmptyKey',
  duplicate: 'variables.transfer.bulkDuplicate',
}

/** 新增变量对话框（单条页签＝变量名 / 值 / Secret 标记；批量页签＝
 *  `key: 值` 每行一对，逐条落库、行级错误定位）。批量与导入对话框不走
 *  mutation 组：行级错误收集在对话框内呈现，绕开全局 reportError toast
 *  逐行弹层的噪音；缓存协议仍走 applyVariablesList 单点 */
function AddVariableDialog({
  workspaceId,
  categoryId,
  open,
  onOpenChange,
}: {
  /** effective 失效的归属空间（mutation 组绑定用） */
  workspaceId: string
  categoryId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const { createVariableMutation } = useVariableMutations(workspaceId)
  const [mode, setMode] = React.useState<'single' | 'bulk'>('single')
  const [key, setKey] = React.useState('')
  const [value, setValue] = React.useState('')
  const [secret, setSecret] = React.useState(false)
  const [bulkText, setBulkText] = React.useState('')
  const [bulkErrors, setBulkErrors] = React.useState<BulkRowError[]>([])
  const [bulkRunning, setBulkRunning] = React.useState(false)
  // 连续添加：成功后焦点回 key 输入（Esc 关窗）
  const keyInputRef = React.useRef<HTMLInputElement | null>(null)
  // 关闭即丢弃草稿（重开不带旧值；渲染期调整，条件随置空收敛）
  if (!open && (key !== '' || value !== '' || secret || bulkText !== '' || mode !== 'single')) {
    setKey('')
    setValue('')
    setSecret(false)
    setBulkText('')
    setBulkErrors([])
    setMode('single')
  }

  const submit = () => {
    if (key.trim() === '' || createVariableMutation.isPending) return
    createVariableMutation.mutate(
      { categoryId, key, value, secret },
      {
        // 连续添加：确认后保持打开、清空字段、焦点回 key——连串录入
        // 不必反复开窗；关窗只有 Esc / 取消两个显式通道
        onSuccess: () => {
          setKey('')
          setValue('')
          setSecret(false)
          keyInputRef.current?.focus()
        },
      },
    )
  }

  const submitBulk = async () => {
    if (bulkRunning) return
    const { rows, errors } = parseBulkVariableLines(bulkText)
    const failures: BulkRowError[] = errors.map((error) => ({
      line: error.line,
      key: '',
      message: t(BULK_ERROR_KEYS[error.reason]),
    }))
    if (rows.length > 0) {
      setBulkRunning(true)
      for (const row of rows) {
        try {
          const list = await variableCreateVariable(categoryId, row.key, row.value, false)
          applyVariablesList(queryClient, workspaceId, categoryId, list)
        } catch (raw) {
          failures.push({ line: row.line, key: row.key, message: toIpcError(raw).message })
        }
      }
      setBulkRunning(false)
    }
    if (failures.length === 0) {
      onOpenChange(false)
      return
    }
    setBulkErrors(failures)
  }

  // 关闭收口单点：批量落库运行中锁窗（Esc / 遮罩 / 取消一律不关）——
  //  for 循环逐条创建直写缓存，中途关窗会让结果与失败清单无人可见
  const requestClose = (next: boolean) => {
    if (bulkRunning && !next) return
    onOpenChange(next)
  }

  // 两页签按钮的焦点锚（方向键切换后焦点移到新页签）
  const tabRefs = React.useRef<Record<'single' | 'bulk', HTMLButtonElement | null>>({
    single: null,
    bulk: null,
  })
  // 待跟随焦点的页签（switchMode 记账，渲染提交后 effect 兑现——新面板
  // 挂载的 autoFocus 会抢焦点，晚于其执行才能保住「焦点在页签上」）
  const pendingFocusTabRef = React.useRef<'single' | 'bulk' | null>(null)
  // 页签切换单点：切模式＋清批量错误＋焦点跟随（roving tabindex 键位）
  const switchMode = (next: 'single' | 'bulk') => {
    setMode(next)
    setBulkErrors([])
    pendingFocusTabRef.current = next
  }
  React.useEffect(() => {
    const pending = pendingFocusTabRef.current
    if (pending === null) return
    pendingFocusTabRef.current = null
    tabRefs.current[pending]?.focus()
  }, [mode])

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('variables.config.addDialogTitle')}</DialogTitle>
          <DialogDescription>{t('variables.config.addDialogDescription')}</DialogDescription>
        </DialogHeader>
        {/* 页签（单条 / 批量）：形态对齐设置页分段 pill；tablist 语义全套
            （id / aria-controls / tabpanel 关联＋roving tabindex＋左右方向键，
            两页签循环切换） */}
        <div
          className="flex gap-1"
          role="tablist"
          aria-label={t('variables.config.addDialogTitle')}
          data-testid="variable-add-mode-tabs"
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            switchMode(event.key === 'ArrowRight' ? 'bulk' : 'single')
          }}
        >
          {(['single', 'bulk'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              id={`variable-add-tab-${candidate}`}
              aria-controls={`variable-add-panel-${candidate}`}
              aria-selected={mode === candidate}
              tabIndex={mode === candidate ? 0 : -1}
              ref={(element) => {
                tabRefs.current[candidate] = element
              }}
              className={cn(
                'h-7 rounded-sm px-2.5 text-xs transition-colors duration-150',
                mode === candidate
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
              onClick={() => switchMode(candidate)}
            >
              {t(
                candidate === 'single'
                  ? 'variables.transfer.modeSingle'
                  : 'variables.transfer.modeBulk',
              )}
            </button>
          ))}
        </div>
        {mode === 'single' ? (
          <div
            role="tabpanel"
            id="variable-add-panel-single"
            aria-labelledby="variable-add-tab-single"
            className="flex flex-col gap-3"
          >
            <Input
              ref={keyInputRef}
              value={key}
              onChange={(event) => setKey(event.target.value)}
              aria-label={t('variables.config.addKeyLabel')}
              placeholder={t('variables.config.addKeyPlaceholder')}
              className="h-8 font-mono"
              spellCheck={false}
              data-testid="variable-add-key-input"
              autoFocus
            />
            <Input
              value={value}
              onChange={(event) => setValue(event.target.value)}
              aria-label={t('variables.config.addValueLabel')}
              placeholder={t('variables.config.addValuePlaceholder')}
              className="h-8 font-mono"
              spellCheck={false}
              data-testid="variable-add-value-input"
            />
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={secret} onCheckedChange={(checked) => setSecret(checked === true)} />
              <span>{t('variables.config.addSecretLabel')}</span>
            </label>
            <p className="text-micro text-muted-foreground">
              {t('variables.config.addSecretHint')}
            </p>
          </div>
        ) : (
          <div
            role="tabpanel"
            id="variable-add-panel-bulk"
            aria-labelledby="variable-add-tab-bulk"
            className="flex flex-col gap-2"
          >
            <Textarea
              value={bulkText}
              onChange={(event) => setBulkText(event.target.value)}
              aria-label={t('variables.transfer.bulkLabel')}
              placeholder={t('variables.transfer.bulkPlaceholder')}
              spellCheck={false}
              className="min-h-32 resize-none font-mono text-xs"
              data-testid="variable-add-bulk-input"
              autoFocus
            />
            <p className="text-micro text-muted-foreground">{t('variables.transfer.bulkHint')}</p>
            {bulkErrors.length > 0 && (
              <div
                className="flex max-h-24 flex-col gap-0.5 overflow-y-auto rounded-sm bg-destructive/10 p-2 text-xs text-destructive"
                data-testid="variable-add-bulk-errors"
              >
                {bulkErrors.map((error, index) => (
                  <span key={`${error.line}-${index}`} className="truncate">
                    {t('variables.transfer.bulkRowError', {
                      line: error.line,
                      message: error.message,
                    })}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => requestClose(false)}>
            {t('variables.config.cancel')}
          </Button>
          {mode === 'single' ? (
            <Button
              disabled={key.trim() === '' || createVariableMutation.isPending}
              onClick={submit}
              data-testid="variable-add-confirm"
            >
              {t('variables.config.add')}
            </Button>
          ) : (
            <Button
              disabled={bulkText.trim() === '' || bulkRunning}
              onClick={() => void submitBulk()}
              data-testid="variable-add-bulk-confirm"
            >
              {t('variables.transfer.bulkSubmit')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 导出分类对话框：JSON 文本进剪贴板（文件落盘归用户）。Secret 值默认
 * 掩码导出（`***`，不泄露长度），显式勾选才含真值——剪贴板内容可能被
 * 粘贴到日志 / 工单，放行必须是显式动作。
 */
function ExportCategoryDialog({
  categoryName,
  variables,
  open,
  onOpenChange,
}: {
  categoryName: string
  variables: VariableDto[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  const uiText = useUiText()
  const [includeSecretValues, setIncludeSecretValues] = React.useState(false)
  if (!open && includeSecretValues) setIncludeSecretValues(false)

  const copy = () => {
    void copyTextWithFeedback(
      () => exportCategoryJson(categoryName, variables, includeSecretValues),
      uiText,
    )
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('variables.transfer.exportTitle', { name: categoryName })}</DialogTitle>
          <DialogDescription>{t('variables.transfer.exportDescription')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={includeSecretValues}
              onCheckedChange={(checked) => setIncludeSecretValues(checked === true)}
              data-testid="variable-export-secret-switch"
            />
            <span>{t('variables.transfer.exportSecretLabel')}</span>
          </label>
          <p className="text-micro text-muted-foreground">
            {t('variables.transfer.exportSecretHint')}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('variables.config.cancel')}
          </Button>
          <Button onClick={copy} data-testid="variable-export-copy">
            {t('variables.transfer.exportCopy')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 导入变量对话框：粘贴 JSON（导出形态 `{ variables: [...] }` 或裸数组）
 * 逐条落库到当前分类。同名键冲突二选一：跳过（保留现值，默认）或覆盖
 * （现值被导入值替换，标记随导入行）；逐条收集行级警示 / 失败（key＋原因，
 * 同位呈现），全部成功才关窗，有警示或失败保持窗开显示清单。掩码回灌
 * 防御：secret 值恰为导出掩码 `***` 的行不落库（宁可不导入也不落假值），
 * 出行级警示「值疑似导出掩码，未导入」。
 */
function ImportVariablesDialog({
  workspaceId,
  categoryId,
  existing,
  open,
  onOpenChange,
}: {
  workspaceId: string
  categoryId: string
  /** 现有变量清单（冲突判定基准） */
  existing: VariableDto[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [text, setText] = React.useState('')
  const [strategy, setStrategy] = React.useState<'skip' | 'overwrite'>('skip')
  const [running, setRunning] = React.useState(false)
  // 解析错误（单条，带行级定位）与行级警示 / 失败清单（多条）；重开即清
  const [parseError, setParseError] = React.useState<ImportParseError | null>(null)
  const [failures, setFailures] = React.useState<ImportRowNotice[]>([])
  const [importedCount, setImportedCount] = React.useState(0)
  if (!open && (text !== '' || parseError !== null || failures.length > 0 || importedCount > 0)) {
    setText('')
    setParseError(null)
    setFailures([])
    setImportedCount(0)
  }

  // 关闭收口单点：导入运行中锁窗（Esc / 遮罩 / 取消一律不关）——逐条落库
  // 未完成前关窗会让结果与警示 / 失败清单无人可见
  const requestClose = (next: boolean) => {
    if (running && !next) return
    onOpenChange(next)
  }

  // 解析错误文案：行级定位可得时给出行号 / 条目号变体，否则整单粒度
  const parseErrorText =
    parseError === null
      ? null
      : parseError.error === 'invalid-json'
        ? parseError.line === null
          ? t('variables.transfer.importInvalidJson')
          : t('variables.transfer.importInvalidJsonAt', { line: parseError.line })
        : parseError.index === null
          ? t('variables.transfer.importInvalidShape')
          : t('variables.transfer.importInvalidShapeAt', { index: parseError.index + 1 })

  const submit = async () => {
    if (running) return
    const parsed = parseImportedVariables(text)
    if ('error' in parsed) {
      setParseError(parsed)
      return
    }
    setParseError(null)
    // 掩码跳过行先进清单（警示与写库失败同位呈现）；有警示不自动关窗
    const notices: ImportRowNotice[] = parsed.skipped.map((row) => ({
      key: row.key,
      message: t('variables.transfer.importMaskSkipped'),
    }))
    setRunning(true)
    const byKey = new Map(existing.map((variable) => [variable.key, variable]))
    let imported = 0
    for (const row of parsed.rows) {
      const current = byKey.get(row.key)
      if (current !== undefined && strategy === 'skip') continue
      try {
        const list =
          current === undefined
            ? await variableCreateVariable(categoryId, row.key, row.value, row.secret)
            : await variableUpdateVariable(categoryId, row.key, row.value, row.secret)
        applyVariablesList(queryClient, workspaceId, categoryId, list)
        if (current !== undefined)
          byKey.set(row.key, { key: row.key, value: row.value, secret: row.secret })
        imported += 1
      } catch (raw) {
        notices.push({ key: row.key, message: toIpcError(raw).message })
      }
    }
    setRunning(false)
    setImportedCount(imported)
    if (notices.length === 0) {
      onOpenChange(false)
      return
    }
    setFailures(notices)
  }

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('variables.transfer.importTitle')}</DialogTitle>
          <DialogDescription>{t('variables.transfer.importDescription')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Textarea
            value={text}
            onChange={(event) => {
              setText(event.target.value)
              setParseError(null)
            }}
            aria-label={t('variables.transfer.importPasteLabel')}
            placeholder={t('variables.transfer.importPastePlaceholder')}
            spellCheck={false}
            className="min-h-32 resize-none font-mono text-xs"
            data-testid="variable-import-input"
            autoFocus
          />
          {parseErrorText !== null && (
            <p className="text-xs text-destructive" data-testid="variable-import-parse-error">
              {parseErrorText}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {t('variables.transfer.importStrategyLabel')}
          </p>
          <RadioGroup
            value={strategy}
            onValueChange={(next) => {
              if (next === 'skip' || next === 'overwrite') setStrategy(next)
            }}
            className="grid-cols-1 gap-1.5"
            data-testid="variable-import-strategy"
          >
            {(['skip', 'overwrite'] as const).map((candidate) => (
              <label key={candidate} className="flex items-center gap-2 text-xs">
                <RadioGroupItem
                  value={candidate}
                  id={`variable-import-${candidate}`}
                  data-testid={`variable-import-strategy-${candidate}`}
                />
                <span>
                  {t(
                    candidate === 'skip'
                      ? 'variables.transfer.importStrategySkip'
                      : 'variables.transfer.importStrategyOverwrite',
                  )}
                </span>
              </label>
            ))}
          </RadioGroup>
          {failures.length > 0 && (
            <div
              className="flex max-h-24 flex-col gap-0.5 overflow-y-auto rounded-sm bg-destructive/10 p-2 text-xs text-destructive"
              data-testid="variable-import-failures"
            >
              {failures.map((failure, index) => (
                <span key={`${failure.key}-${index}`} className="truncate">
                  {t('variables.transfer.importRowError', {
                    key: failure.key,
                    message: failure.message,
                  })}
                </span>
              ))}
            </div>
          )}
          {failures.length === 0 && importedCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {t('variables.transfer.importDone', { count: importedCount })}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => requestClose(false)}>
            {t('variables.config.cancel')}
          </Button>
          <Button
            disabled={text.trim() === '' || running}
            onClick={() => void submit()}
            data-testid="variable-import-confirm"
          >
            {t('variables.transfer.importSubmit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 生效集来源徽标（按兜底链层呈现来源） */
function SourceBadge({ source }: { source: EffectiveVariableDto['source'] }) {
  const { t } = useI18n()
  if (source === 'active') {
    return <Badge variant="default">{t('variables.effective.sourceActive')}</Badge>
  }
  if (source === 'global') {
    return <Badge variant="secondary">{t('variables.effective.sourceGlobal')}</Badge>
  }
  return <Badge variant="outline">{t('variables.effective.sourceBuiltin')}</Badge>
}

/**
 * 生效变量集面板（生效预览 Popover 的内容体）：优先级链在上、最终生效清单
 * 在下（恒掩码）。顶部搜索框纯前端过滤（key / value 大小写不敏感包含；
 * 过滤态空＝提示无匹配，与「生效集为空」区分）。高度封顶在视口六成，超
 * 出滚动。
 */
function EffectiveVariablesPanel({
  workspaceId,
  activeCategoryName,
}: {
  workspaceId: string
  /** 当前激活分类名（null＝全不激活） */
  activeCategoryName: string | null
}) {
  const { t } = useI18n()
  const [search, setSearch] = React.useState('')
  const effectiveQuery = useIpcQuery({
    queryKey: variableKeys.effective(workspaceId),
    queryFn: () => variableEffective(workspaceId),
    staleTime: 30_000,
  })
  const items = effectiveQuery.data?.items ?? []
  const needle = search.trim().toLowerCase()
  const visible =
    needle === ''
      ? items
      : items.filter(
          (item) =>
            item.key.toLowerCase().includes(needle) || item.value.toLowerCase().includes(needle),
        )
  const bySource = (source: EffectiveVariableDto['source']) =>
    visible.filter((item) => item.source === source)

  return (
    <div
      className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto p-4"
      data-testid="effective-variables-panel"
    >
      <div className="flex flex-col gap-1.5">
        {/* 优先级链：chip 分节＋箭头串联，兜底链方向一眼可读 */}
        <div
          className="flex flex-wrap items-center gap-1 text-micro text-muted-foreground"
          data-testid="effective-priority-chain"
        >
          <span className="shrink-0">{t('variables.effective.priorityLabel')}：</span>
          <span className="rounded-sm bg-muted px-1.5 py-0.5">
            {activeCategoryName ?? t('variables.effective.noActive')}
          </span>
          <ChevronRightIcon aria-hidden className="size-3 shrink-0" />
          <span className="rounded-sm bg-muted px-1.5 py-0.5">
            {t('variables.effective.sourceGlobal')}
          </span>
          <ChevronRightIcon aria-hidden className="size-3 shrink-0" />
          <span className="rounded-sm bg-muted px-1.5 py-0.5">
            {t('variables.effective.sourceBuiltin')}
          </span>
        </div>
        {items.length > 0 && (
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('variables.effective.searchPlaceholder')}
            aria-label={t('variables.effective.searchPlaceholder')}
            className="h-7 text-xs"
            spellCheck={false}
            data-testid="effective-search"
          />
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-micro font-medium text-muted-foreground">
          {t('variables.effective.finalLabel')}
        </p>
        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('variables.effective.empty')}</p>
        ) : visible.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="effective-search-empty">
            {t('variables.effective.searchEmpty')}
          </p>
        ) : (
          <div className="flex flex-col">
            {(['active', 'global', 'builtin'] as const).map((source) =>
              bySource(source).map((item) => (
                <div
                  key={`${source}:${item.key}`}
                  className="flex items-center gap-2 py-1 text-xs"
                  data-testid="effective-variable-row"
                  data-source={item.source}
                >
                  <span className="w-24 shrink-0 truncate font-mono" title={item.key}>
                    {item.key}
                  </span>
                  {/* 恒掩码：不提供明文切换，不放复制 */}
                  <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                    {item.secret ? SECRET_MASK : item.value}
                  </span>
                  <SourceBadge source={item.source} />
                </div>
              )),
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 生效预览 Popover：锚定卡头按钮下方（右对齐），承载生效变量集面板——
 * 预览是按需查看的次要信息，不与键值表分栏抢宽度。恒掩码纪律：面板不提
 * 供明文切换、不放复制入口。
 */
function EffectivePreviewPopover({
  workspaceId,
  activeCategoryName,
}: {
  workspaceId: string
  /** 当前激活分类名（null＝全不激活） */
  activeCategoryName: string | null
}) {
  const { t } = useI18n()
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            data-testid="variable-effective-preview-button"
          >
            <EyeIcon aria-hidden data-icon="inline-start" />
            {t('variables.config.effectivePreview')}
          </Button>
        }
      />
      <PopoverContent
        align="end"
        className="w-80 gap-0 p-0"
        data-testid="effective-preview-popover"
      >
        <EffectiveVariablesPanel
          workspaceId={workspaceId}
          activeCategoryName={activeCategoryName}
        />
      </PopoverContent>
    </Popover>
  )
}

export function VariableConfigPage({ categoryId }: { categoryId: string }) {
  const { t } = useI18n()
  const { data: workspaces } = useWorkspacesQuery()
  const workspaceId = workspaces?.currentId ?? null

  const categoriesQuery = useIpcQuery({
    queryKey: variableKeys.categories(workspaceId ?? ''),
    queryFn: () => variableListCategories(workspaceId!),
    enabled: workspaceId !== null,
    staleTime: 30_000,
  })
  const category = categoriesQuery.data?.items.find((c) => c.id === categoryId) ?? null
  const activeCategoryId = categoriesQuery.data?.activeCategoryId ?? null

  const variablesQuery = useIpcQuery({
    queryKey: variableKeys.variables(categoryId),
    queryFn: () => variableListVariables(categoryId),
    staleTime: 30_000,
  })

  // —— 分类级 mutation（缓存后处理收口在 hook；此处只带 UI 副作用） ——
  // —— 变量行 mutation 通道（页级单点持有：行组件 memo 后不自挂组） ——
  const {
    activateCategoryMutation,
    deleteCategoryMutation,
    createVariableMutation,
    updateVariableMutation,
    renameVariableMutation,
    deleteVariableMutation,
  } = useVariableMutations(workspaceId ?? '')
  // mutate 引用稳定（TanStack 单实例回调），解构后作为 useCallback 依赖
  const { mutate: createVariable } = createVariableMutation
  const { mutate: updateVariable } = updateVariableMutation
  const { mutate: renameVariable } = renameVariableMutation
  const { mutate: deleteVariable } = deleteVariableMutation

  const handleRenameVariable = React.useCallback(
    (key: string, newKey: string) => renameVariable({ categoryId, key, newKey }),
    [renameVariable, categoryId],
  )
  const handleUpdateVariable = React.useCallback(
    (key: string, value: string, secret: boolean) =>
      updateVariable({ categoryId, key, value, secret }),
    [updateVariable, categoryId],
  )
  /** 删除保持轻量无确认（对照分类删除的确认弹窗——变量可重建）：toast
   *  ＋「撤销」短窗口原值重建（key 仍空闲即恢复；被占说明用户已重建，
   *  报错收敛——重建走 mutation 组，错误统一上抛） */
  const handleDeleteVariable = React.useCallback(
    (variable: VariableDto) => {
      deleteVariable(
        { categoryId, key: variable.key },
        {
          onSuccess: () => {
            toast.info(t('variables.config.deletedToast', { key: variable.key }), {
              action: {
                label: t('variables.config.undoDelete'),
                onClick: () =>
                  createVariable({
                    categoryId,
                    key: variable.key,
                    value: variable.value,
                    secret: variable.secret,
                  }),
              },
            })
          },
        },
      )
    },
    [deleteVariable, createVariable, categoryId, t],
  )

  // —— 变量清单与虚拟化（hook 须在提前返回前：行数超阈值切换虚拟渲染，
  //     虚拟化设施与左栏树同源 @tanstack/react-virtual） ——
  const variables = variablesQuery.data?.items ?? []
  const virtualized = variables.length > VIRTUALIZE_ROW_THRESHOLD
  const variableListRef = React.useRef<HTMLUListElement | null>(null)
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual 的返回值不可安全 memo（库固有限制），React Compiler 跳过本组件属有意取舍：虚拟行的定位由 getVirtualItems 快照直读，页面其余状态不受影响
  const rowVirtualizer = useVirtualizer({
    count: variables.length,
    getScrollElement: () => (virtualized ? variableListRef.current : null),
    estimateSize: () => VARIABLE_ROW_HEIGHT,
    overscan: 8,
  })

  // —— 分类改名走弹窗（与左栏树 F2 同一对话框；Tab 标题同步在对话框内
  //     随清单视图一并处理），横幅标题恒为只读大标题、跟随清单真值 ——
  const [renameOpen, setRenameOpen] = React.useState(false)
  const closeTab = useTabsStore((s) => s.close)

  // —— 激活切换（全局分类不可激活；再点取消＝全不激活可达成） ——
  const activated = category !== null && !category.isGlobal && activeCategoryId === categoryId

  // —— 删除分类（级联删全部变量；确认弹窗；成功后关闭本 Tab） ——
  const [deleteOpen, setDeleteOpen] = React.useState(false)

  const [addOpen, setAddOpen] = React.useState(false)
  // 导入导出（分类维度；导出＝JSON 进剪贴板，导入＝粘贴逐条落库）
  const [exportOpen, setExportOpen] = React.useState(false)
  const [importOpen, setImportOpen] = React.useState(false)

  if (!workspaceId || !category) {
    return (
      <div
        className="flex flex-1 items-center justify-center text-sm text-muted-foreground"
        data-testid="variable-config-missing"
      >
        {t('variables.config.categoryMissing')}
      </div>
    )
  }

  const activeCategoryName = activated ? category.name : null
  // meta 摘要行参与态：全局分类恒兜底参与生效集；普通分类激活＝最高
  // 优先级参与，未激活＝不参与
  const chainText = category.isGlobal
    ? t('variables.config.metaGlobalChain')
    : activated
      ? t('variables.config.metaActiveChain')
      : t('variables.config.metaNotInChain')

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="variable-config-page">
      {/* 横幅：分类图标块＋只读大标题（改名走弹窗，与工作空间详情同形）＋
          激活 / 全局徽章＋meta 摘要行＋动作组 */}
      <DetailBanner
        data-testid="variable-config-header"
        icon={<SEMANTIC_ICONS.variables aria-hidden className="size-6" />}
        title={category.name}
        badges={
          category.isGlobal ? (
            <Badge variant="outline">{t('variables.config.globalBadge')}</Badge>
          ) : (
            activated && (
              // 激活徽章＝工作空间「当前」同款（selection 浅底＋主题色字）
              <span
                data-testid="variable-active-badge"
                className="inline-flex shrink-0 items-center rounded-sm bg-selection px-1.5 py-0.5 text-micro font-medium text-primary"
              >
                {t('variables.config.activeBadge')}
              </span>
            )
          )
        }
        meta={
          <>
            {!variablesQuery.isPending && (
              <>
                <span className="tabular-nums">
                  {t('variables.config.metaVariableCount', { count: variables.length })}
                </span>
                <span aria-hidden>·</span>
              </>
            )}
            <span>{chainText}</span>
          </>
        }
        actions={
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground"
              aria-label={t('variables.config.renameCategory')}
              title={t('variables.config.renameCategory')}
              data-testid="variable-rename-category"
              onClick={() => setRenameOpen(true)}
            >
              <SquarePenIcon aria-hidden />
            </Button>
            {!category.isGlobal && (
              <Button
                variant={activated ? 'outline' : 'default'}
                size="xs"
                data-testid="variable-activate-button"
                onClick={() => activateCategoryMutation.mutate(activated ? null : categoryId)}
              >
                {activated ? t('variables.config.deactivate') : t('variables.config.activate')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground"
              aria-label={t('variables.transfer.exportButton')}
              title={t('variables.transfer.exportButton')}
              data-testid="variable-export-button"
              onClick={() => setExportOpen(true)}
            >
              <UploadIcon aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground"
              aria-label={t('variables.transfer.importButton')}
              title={t('variables.transfer.importButton')}
              data-testid="variable-import-button"
              onClick={() => setImportOpen(true)}
            >
              <DownloadIcon aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground hover:text-destructive"
              aria-label={t('variables.config.deleteCategory')}
              title={t('variables.config.deleteCategory')}
              data-testid="variable-delete-category"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2Icon aria-hidden />
            </Button>
          </>
        }
      />

      {/* 身体：居中限宽一张「变量」卡——卡头（计数＋生效预览＋新增）＋
          卡体键值列表行；生效预览悬浮面板锚在卡头按钮下方、不占文档流 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DetailContentColumn>
          <DetailSectionCard
            icon={<SEMANTIC_ICONS.variables aria-hidden className="size-4 text-muted-foreground" />}
            title={
              <>
                {t('variables.config.keyColumn')}
                {!variablesQuery.isPending && (
                  <span
                    className="ml-1.5 font-mono text-xs text-muted-foreground tabular-nums"
                    data-testid="variable-count"
                  >
                    {variables.length}
                  </span>
                )}
              </>
            }
            actions={
              <>
                <EffectivePreviewPopover
                  workspaceId={workspaceId}
                  activeCategoryName={activeCategoryName}
                />
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => setAddOpen(true)}
                  data-testid="variable-add-button"
                >
                  <PlusIcon aria-hidden data-icon="inline-start" />
                  {t('variables.config.addVariable')}
                </Button>
              </>
            }
          >
            {/* 卡体：加载中＝形状匹配的骨架行（不整块突跳）；空＝引导态；
                有数据＝键值列表行（边框分隔由行 border-t 承担） */}
            {variablesQuery.isPending ? (
              <div aria-hidden data-testid="variable-table-skeleton">
                {TABLE_SKELETON_WIDTHS.map((width, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-6 border-t border-border px-4 py-2.5 first:border-t-0"
                  >
                    <div className="h-3 animate-pulse rounded-sm bg-muted" style={{ width }} />
                    <div className="ml-auto h-3 w-16 animate-pulse rounded-sm bg-muted" />
                  </div>
                ))}
              </div>
            ) : variables.length === 0 ? (
              <Empty className="justify-center py-10">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <SEMANTIC_ICONS.variables />
                  </EmptyMedia>
                  <EmptyTitle>{t('variables.config.emptyVariables')}</EmptyTitle>
                </EmptyHeader>
                <EmptyContent>
                  <p className="text-xs text-muted-foreground">
                    {t('variables.config.emptyVariablesHint')}
                  </p>
                </EmptyContent>
              </Empty>
            ) : (
              /* 阈值以上整表虚拟化：ul 自身成为滚动元素（高度封顶视口六成，
                 同生效预览面板惯例），行绝对定位只渲染可视窗口＋overscan；
                 阈值以下保持全量渲染（常态小表零行为差异） */
              <ul
                data-testid="variable-table"
                ref={variableListRef}
                className={cn(virtualized && 'relative max-h-[60vh] overflow-y-auto')}
                style={virtualized ? { height: rowVirtualizer.getTotalSize() } : undefined}
              >
                {virtualized
                  ? rowVirtualizer.getVirtualItems().map((virtualRow) => {
                      const variable = variables[virtualRow.index]
                      if (!variable) return null
                      return (
                        <VariableRow
                          key={variable.key}
                          variable={variable}
                          style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            height: virtualRow.size,
                            transform: `translateY(${virtualRow.start}px)`,
                          }}
                          onRename={handleRenameVariable}
                          onUpdate={handleUpdateVariable}
                          onDelete={handleDeleteVariable}
                        />
                      )
                    })
                  : variables.map((variable) => (
                      <VariableRow
                        key={variable.key}
                        variable={variable}
                        onRename={handleRenameVariable}
                        onUpdate={handleUpdateVariable}
                        onDelete={handleDeleteVariable}
                      />
                    ))}
              </ul>
            )}
          </DetailSectionCard>
        </DetailContentColumn>
      </div>

      {/* 改名弹窗（与左栏树 F2 同一对话框；成功后 Tab 标题随之同步） */}
      {renameOpen && (
        <RenameCategoryDialog
          workspaceId={workspaceId}
          target={{ id: categoryId, name: category.name }}
          onOpenChange={() => setRenameOpen(false)}
        />
      )}

      {/* 新增变量对话框 */}
      <AddVariableDialog
        workspaceId={workspaceId}
        categoryId={categoryId}
        open={addOpen}
        onOpenChange={setAddOpen}
      />

      {/* 导入导出（分类维度）：导出＝JSON 进剪贴板（Secret 默认掩码）；
          导入＝粘贴逐条落库（同名键跳过 / 覆盖） */}
      <ExportCategoryDialog
        categoryName={category.name}
        variables={variables}
        open={exportOpen}
        onOpenChange={setExportOpen}
      />
      <ImportVariablesDialog
        workspaceId={workspaceId}
        categoryId={categoryId}
        existing={variables}
        open={importOpen}
        onOpenChange={setImportOpen}
      />

      {/* 删除分类确认（级联范围明示；进行中禁确认钮防连点重复 mutate，
          失败保持弹窗在场可重试——对齐工作空间域删除确认口径） */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('variables.config.deleteConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('variables.config.deleteConfirmDescription', { name: category.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('variables.config.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteCategoryMutation.isPending}
              data-testid="variable-delete-category-confirm"
              onClick={() =>
                deleteCategoryMutation.mutate(categoryId, {
                  onSuccess: () => {
                    // 关闭本 Tab（Tab 身份＝variables:{categoryId}；tabs 收缩信号连带清理）
                    closeTab(`${VARIABLES_TAB_ID_PREFIX}${categoryId}`)
                    setDeleteOpen(false)
                  },
                })
              }
            >
              {deleteCategoryMutation.isPending
                ? t('variables.config.deleteConfirmPending')
                : t('variables.config.deleteConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
