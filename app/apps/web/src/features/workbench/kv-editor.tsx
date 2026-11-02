import * as React from 'react'

import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import { GripVerticalIcon, XIcon } from 'lucide-react'

import {
  Button,
  Checkbox,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@workspace/ui/components'
import { cn } from 'cn'

import { useI18n } from '@/i18n'
import { reportError } from '@/services/error-center'

import { VariableSuggestInput } from '@/features/variables/variable-suggest'

import {
  formatBulkKvText,
  mergeBulkIntoRows,
  parseBulkKvText,
  parseKvRows,
  serializeKvRows,
  type KvRow,
  type KvRowType,
} from './kv-rows'

/**
 * 键值编辑器（查询参数 / 请求头 / form 系 Body 行的表单基座）：草稿 JSON 列 ⇄ 键值行。
 *
 * 表格形态：列头行（参数名 / 参数值 / 类型（Headers 无） / 说明）＋单行数据行，
 * 行序即行 JSON 序（发送序）；行首拖拽把手（HTML5 原生拖拽，键盘 Alt+↑/↓ 同效）、
 * 行级启停（path 参数行为结构必需，以只读芯片代替启停勾选）。「批量编辑」纯文字
 * 按钮悬浮表头行右端（脱离 flex 流），悬浮表格区才显形，键盘聚焦同样显形。
 *
 * 行补全：数据行尾常驻一行占位行（数据为空亦有之）——参数名输入即转正为数据行、
 * 底部再续新占位行；占位行不可移除（无移除钮），值 / 类型 / 说明锁定至转正后。
 * 行内输入框常态无边框，悬浮（或聚焦）才显边框，表格呈轻量连续表单观感。
 *
 * 数据保真边界：JSON 解析失败或形态不符（非数组 / 非字符串字段）时退回
 * 原文编辑模式——用户既有内容原样呈现、原样保存，绝不因格式意外改写或
 * 丢弃用户数据；合法数组走键值行编辑（所见即所得，行含全空行一并保存）。
 */

/** 行内容指纹（含可选标注与启停）：身份调和与「编辑中回落同位置旧身份」共用同一键 */
function rowContentKey(row: KvRow): string {
  return `${row.name}\u0000${row.value}\u0000${row.type ?? ''}\u0000${row.description ?? ''}\u0000${row.enabled ?? ''}`
}

/** 行身份调和：内容相同的行沿用旧身份（删除 / 插入兄弟行时 DOM 不错配，
 *  组合态与焦点随行走）；内容已变的行（编辑中）回落同位置旧身份（不重挂载，
 *  输入法组合态不被打断）；都未命中才是新行（新 id）。 */
function reconcileRows(
  prev: { id: number; row: KvRow }[] | null,
  parsed: KvRow[],
  nextId: () => number,
): { id: number; row: KvRow }[] {
  if (!prev) return parsed.map((row) => ({ id: nextId(), row }))
  const used = new Set<number>()
  const byContent = new Map<string, number[]>()
  for (const p of prev) {
    const key = rowContentKey(p.row)
    const list = byContent.get(key) ?? []
    list.push(p.id)
    byContent.set(key, list)
  }
  return parsed.map((row, index) => {
    const contentKey = rowContentKey(row)
    const contentHit = byContent.get(contentKey)?.find((id) => !used.has(id))
    if (contentHit !== undefined) {
      used.add(contentHit)
      return { id: contentHit, row }
    }
    const positional = prev[index]
    if (positional && !used.has(positional.id)) {
      used.add(positional.id)
      return { id: positional.id, row }
    }
    return { id: nextId(), row }
  })
}

/** 行身份机状态：source＝已调和的 parsed 快照；rows＝带身份行；nextId＝下一新身份 */
interface IdRowsState {
  source: KvRow[] | null
  rows: { id: number; row: KvRow }[]
  nextId: number
}

/** 依据上一个身份状态与新的 parsed 快照调和行身份（纯函数；source 为 null＝
 *  原文模式，行身份视作清空，重入合法模式时全量重分身份） */
function reconcileIdRows(prev: IdRowsState, parsed: KvRow[] | null): IdRowsState {
  const counter = { value: prev.nextId }
  const nextId = (): number => {
    counter.value += 1
    return counter.value
  }
  const rows =
    parsed === null ? [] : reconcileRows(prev.source === null ? null : prev.rows, parsed, nextId)
  return { source: parsed, rows, nextId: counter.value }
}

/** 行类型缺省显示值：语义默认 string 只落在显示层（行数据缺失不携带） */
const DEFAULT_ROW_TYPE = 'string'

/** 文件路径的 basename（Windows 反斜杠与 POSIX 正斜杠分隔都容忍；仅显示用，
 *  行 value 恒持完整路径） */
function basenameOf(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path
}

/** 占位行的显示行数据（恒空）：仅服务渲染，输入经 onAdoptName 转正后才落数据 */
const PLACEHOLDER_ROW: KvRow = { name: '', value: '' }

/** 系统文件选择器（tauri-plugin-dialog：单选、不限扩展）：选定即把完整
 *  路径写入行 value；用户取消（null）是正常路径，静默返回；对话框系统
 *  错误不静默（统一错误协议经错误中心呈现） */
async function pickFile(row: KvRow, onChange: (next: KvRow) => void): Promise<void> {
  try {
    const picked = await openFileDialog({ multiple: false })
    if (typeof picked === 'string') onChange({ ...row, value: picked })
  } catch (error) {
    reportError(error)
  }
}

/** 单个键值行（表格单行制）：拖拽把手 + 启停（或 path 芯片）+ 参数名 + 参数值 +
 *  类型选择器（可选）+ 说明 + 移除按钮（等宽字体，行内紧凑密度）。说明列
 *  超长由 input 单行截断承载，title 悬停全文、聚焦可完整编辑；类型为 file
 *  时值格换为「选择文件」入口＋文件名显示（value 持完整路径，显示用
 *  basename，title 悬停全路径）。占位行形态（isPlaceholder）：不可移除
 *  （移除钮位留空壳保列几何），启停 / 值 / 类型 / 说明锁定，参数名输入即
 *  经 onAdoptName 转正为数据行 */
function KvRowLine({
  row,
  index,
  isLast,
  isPlaceholder,
  onAdoptName,
  onChange,
  onRemove,
  onMove,
  removeLabel,
  reorderLabel,
  reorderHint,
  autoFocusName,
  allowedTypes,
  maskValue,
  isPathParam,
  suggestWorkspaceId,
  draggable,
  dropTarget,
  dragging,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onArm,
}: {
  row: KvRow
  index: number
  isLast: boolean
  /** 占位行（尾部待输入行）：不可移除、值 / 类型 / 说明锁定，参数名输入即转正 */
  isPlaceholder?: boolean
  /** 占位行参数名输入转正（上抛含新行的整包 JSON）；非占位行不传 */
  onAdoptName?: (name: string) => void
  onChange: (next: KvRow) => void
  onRemove: () => void
  onMove: (from: number, to: number) => void
  removeLabel: string
  reorderLabel: string
  reorderHint: string
  /** 挂载即聚焦名称输入（「添加行」的键盘流接续；仅 mount 时生效） */
  autoFocusName?: boolean
  /** 类型选择器值域（宿主面收敛子集）；缺省不出类型选择器 */
  allowedTypes?: readonly KvRowType[]
  /** 该行值以掩码显示（敏感头：数据保留、显示脱敏；掩码态只读，揭示后可编辑） */
  maskValue?: boolean
  /** path 参数行（名称命中路径模板占位符）：结构必需，不出启停勾选 */
  isPathParam?: boolean
  /** 值单元格 `{{` 变量联想的归属空间（null＝不启用）；掩码行（只读）不联想 */
  suggestWorkspaceId?: string | null
  /** 拖拽把手按下后行方可拖拽（避免误拖输入框内文本选择） */
  draggable: boolean
  /** 拖拽悬停目标行（放置指示高亮） */
  dropTarget: boolean
  /** 拖拽中的源行（半透明） */
  dragging: boolean
  onDragStart: (index: number) => void
  onDragOver: (index: number) => void
  onDrop: (index: number) => void
  onDragEnd: () => void
  /** 拖拽把手按下 / 松开（激活与复位行 draggable） */
  onArm: (armed: boolean) => void
}) {
  const { t } = useI18n()
  const showTypeSelect = allowedTypes !== undefined && allowedTypes.length > 0
  const isFileRow = row.type === 'file'
  return (
    <div
      data-testid={isPlaceholder ? 'kv-placeholder-row' : 'kv-row'}
      // 启停只改视觉密度提示，不禁输入（禁用行的值仍可编辑）
      data-disabled={row.enabled === false ? 'true' : undefined}
      className={cn(
        'flex items-center gap-1.5 border-b border-border py-0.5',
        row.enabled === false && 'opacity-50',
        dragging && 'opacity-40',
        dropTarget && 'bg-accent',
      )}
      draggable={draggable}
      onDragStart={(event) => {
        onDragStart(index)
        // setData 是部分浏览器启动拖拽的硬要求；jsdom 事件无 dataTransfer
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', String(index))
        }
      }}
      onDragOver={(event) => {
        event.preventDefault()
        onDragOver(index)
      }}
      onDrop={(event) => {
        event.preventDefault()
        onDrop(index)
      }}
      onDragEnd={onDragEnd}
    >
      {/* 拖拽把手：按下武装行拖拽；键盘 Alt+↑/↓ 与拖拽同一移动原语。
          占位行把手禁用（排序语义只对已落数据的行成立） */}
      <button
        type="button"
        aria-label={`${reorderLabel} ${index + 1}`}
        title={reorderHint}
        data-testid="kv-row-grip"
        disabled={isPlaceholder}
        className="flex size-5 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/60 hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-40"
        onMouseDown={() => onArm(true)}
        onMouseUp={() => onArm(false)}
        onKeyDown={(event) => {
          if (!event.altKey) return
          if (event.key === 'ArrowUp' && index > 0) {
            event.preventDefault()
            onMove(index, index - 1)
          } else if (event.key === 'ArrowDown' && !isLast) {
            event.preventDefault()
            onMove(index, index + 1)
          }
        }}
      >
        <GripVerticalIcon aria-hidden className="size-3.5" />
      </button>
      {/* 启停列：path 参数行是结构必需，以只读芯片代替勾选 */}
      <div className="flex w-6 shrink-0 justify-center">
        {isPathParam ? (
          <span
            className="font-mono text-micro text-muted-foreground"
            title={t('editor.kvPathChipHint')}
            data-testid="kv-path-chip"
          >
            path
          </span>
        ) : (
          <Checkbox
            checked={row.enabled !== false}
            disabled={isPlaceholder}
            onCheckedChange={(checked) => {
              const next = { ...row }
              // 启用＝回缺省（不携带字段）；禁用行显式携带 false
              if (checked) delete next.enabled
              else next.enabled = false
              onChange(next)
            }}
            aria-label={`${t('editor.kvRowEnabled')} ${index + 1}`}
            className="size-3.5"
          />
        )}
      </div>
      <Input
        value={row.name}
        onChange={(event) => {
          // 占位行的输入即转正：首字符起整行落为数据行，值随输入携带
          if (isPlaceholder) onAdoptName?.(event.target.value)
          else onChange({ ...row, name: event.target.value })
        }}
        placeholder={t('editor.kvNamePlaceholder')}
        aria-label={`${t('editor.kvNamePlaceholder')} ${index + 1}`}
        // 常态无边框（悬浮 / 聚焦才显边框），表格呈轻量连续表单观感
        className="h-7 w-40 shrink-0 border-transparent font-mono text-xs hover:border-input"
        autoFocus={autoFocusName}
      />
      {isFileRow ? (
        // file 行值格：完整路径只经系统选择器落入（「选择文件」单选、不限
        // 扩展），显示用 basename、title 悬停全路径；无值时仅显示入口
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-2 text-xs"
            aria-label={`${t('editor.kvPickFile')} ${index + 1}`}
            disabled={isPlaceholder}
            onClick={() => {
              void pickFile(row, onChange)
            }}
            data-testid="kv-pick-file"
          >
            {t('editor.kvPickFile')}
          </Button>
          {row.value !== '' && (
            <span
              className="min-w-0 truncate font-mono text-xs text-muted-foreground"
              title={row.value}
              data-testid="kv-file-name"
            >
              {basenameOf(row.value)}
            </span>
          )}
        </div>
      ) : (
        <VariableSuggestInput
          value={maskValue ? '***' : row.value}
          onChange={(next) => onChange({ ...row, value: next })}
          placeholder={t('editor.kvValuePlaceholder')}
          aria-label={`${t('editor.kvValuePlaceholder')} ${index + 1}`}
          // 掩码行只读：值保留在行数据里，先揭示（reveal）再编辑，
          // 防止对掩码占位的误键入覆盖真实值；只读不触发联想。
          // 占位行锁定至转正后（参数名先行的输入轴）
          readOnly={maskValue}
          disabled={isPlaceholder}
          workspaceId={maskValue || isPlaceholder ? null : suggestWorkspaceId}
          className={cn(
            'h-7 min-w-0 flex-1 border-transparent font-mono text-xs hover:border-input',
            maskValue && 'text-muted-foreground',
          )}
        />
      )}
      {showTypeSelect && (
        <Select
          value={row.type ?? DEFAULT_ROW_TYPE}
          disabled={isPlaceholder}
          onValueChange={(value) => {
            const next = allowedTypes?.find((candidate) => candidate === value)
            if (next) onChange({ ...row, type: next })
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label={`${t('editor.kvTypeLabel')} ${index + 1}`}
            className="h-7 w-24 shrink-0 border-transparent font-mono text-xs hover:border-input"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {allowedTypes.map((type) => (
              <SelectItem key={type} value={type}>
                {type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Input
        value={row.description ?? ''}
        onChange={(event) => onChange({ ...row, description: event.target.value })}
        placeholder={t('editor.kvDescriptionPlaceholder')}
        aria-label={`${t('editor.kvDescriptionLabel')} ${index + 1}`}
        disabled={isPlaceholder}
        // 单行截断承载超长省略：title 悬停全文，聚焦后可完整编辑
        title={row.description === '' ? undefined : row.description}
        className="h-7 min-w-0 flex-1 border-transparent font-mono text-xs hover:border-input"
      />
      {isPlaceholder ? (
        // 占位行不可移除：移除钮位留空壳保列几何
        <span className="size-7 shrink-0" />
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={removeLabel}
          className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onRemove}
        >
          <XIcon aria-hidden />
        </Button>
      )}
    </div>
  )
}

/** 表格列头行：列标题按宿主面收敛——类型列仅在 allowedTypes 存在时出现；
 *  列几何与内容行共享同一套固定段宽度（把手 w-5 / 启停 w-6 / 参数名 w-40 /
 *  类型 w-24 / 移除钮位 w-7），值与说明两列 flex-1 的剩余空间分配才逐列一致。
 *  列头文字 pl-2.5 与行内输入框框内左缘对齐（Input / SelectTrigger 框内左
 *  padding 同为 pl-2.5）；操作列头不出文字（移除语义由行尾钮自明），右端
 *  「批量编辑」纯文字按钮 absolute 浮于行尾，不进 flex 流（否则表头固定尾段
 *  宽于内容行，弹性列整体错位），悬浮表格区（group/kv）才显形 */
function KvHeaderRow({
  hasTypeColumn,
  bulkButton,
}: {
  hasTypeColumn: boolean
  bulkButton: React.ReactNode
}) {
  const { t } = useI18n()
  const label = 'shrink-0 pl-2.5 text-sm font-medium text-muted-foreground'
  return (
    <div
      data-testid="kv-header-row"
      className="relative flex h-7 items-center gap-1.5 border-b border-border"
    >
      <span className="w-5 shrink-0" />
      <span className="w-6 shrink-0" />
      <span className={cn(label, 'w-40 text-left')}>{t('editor.kvColumnName')}</span>
      <span className={cn(label, 'min-w-0 flex-1 text-left')}>{t('editor.kvColumnValue')}</span>
      {hasTypeColumn && (
        <span className={cn(label, 'w-24 text-left')}>{t('editor.kvColumnType')}</span>
      )}
      <span className={cn(label, 'min-w-0 flex-1 text-left')}>
        {t('editor.kvColumnDescription')}
      </span>
      {/* 定宽对齐行尾移除钮（size-7）；无列头文字，批量编辑钮悬浮其上 */}
      <span className="w-7 shrink-0" />
      {bulkButton}
    </div>
  )
}

/**
 * 键值编辑器：受控 json 进出。合法数组＝键值行表格（占位行转正加行 / 逐行编辑 /
 * 移除 / 启停 / 拖拽排序 / 批量编辑），非法形态＝原文 Textarea（带模式说明）。
 * 行编辑即时上抛整包 JSON；行以稳定身份渲染（reconcileRows），占位行转正后
 * 焦点接续到新行名称输入。行类型选择器的值域由宿主面经 allowedTypes 传入
 * （如 Headers 不传＝无选择器）；pathParamNames 命中的行渲染 path 芯片
 * （不出启停勾选）。
 */
export function KvEditor({
  json,
  onChange,
  className,
  allowedTypes,
  maskValueOf,
  revealValues,
  pathParamNames,
  suggestWorkspaceId,
}: {
  json: string
  onChange: (json: string) => void
  className?: string
  /** 类型选择器值域（宿主面收敛子集）；缺省不出类型选择器 */
  allowedTypes?: readonly KvRowType[]
  /** 行名 → 是否掩码显示值（敏感名单命中）；缺省不掩码 */
  maskValueOf?: (name: string) => boolean
  /** 掩码揭示开关（true＝显示真实值并恢复可编辑） */
  revealValues?: boolean
  /** 路径模板占位符名集（宿主面传入）：命中行是 path 参数（只读芯片、无启停） */
  pathParamNames?: readonly string[]
  /** 值单元格 `{{` 变量联想的归属空间（缺省不启用） */
  suggestWorkspaceId?: string | null
}) {
  const { t } = useI18n()
  const parsed = React.useMemo(() => parseKvRows(json), [json])
  const rows = parsed
  const hasTypeColumn = allowedTypes !== undefined && allowedTypes.length > 0
  const pathNames = React.useMemo(() => new Set(pathParamNames ?? []), [pathParamNames])

  // 行身份状态（身份只服务 React key，不参与渲染输出）：渲染期调整模式
  // （React 官方「从 props 派生 state」惯用法）——parsed 快照变化即重调和，
  // 语义与 ref 缓存一致且对 React Compiler 友好
  const [idState, setIdState] = React.useState<IdRowsState>(() =>
    reconcileIdRows({ source: null, rows: [], nextId: 1 }, parsed),
  )
  if (idState.source !== parsed) {
    setIdState(reconcileIdRows(idState, parsed))
  }

  // 「转正」标记：占位行输入后新行（尾部）挂载时聚焦其名称输入；只在新行
  // mount 生效（输入焦点跨 DOM 换转无缝接续，键盘流不中断）
  const [addedRowId, setAddedRowId] = React.useState<number | null>(null)

  // 拖拽状态：armed＝把手按下武装行 draggable；from / over＝跨行共享的拖放序号
  const [dragArmedId, setDragArmedId] = React.useState<number | null>(null)
  const [dragFromIndex, setDragFromIndex] = React.useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = React.useState<number | null>(null)

  // 批量编辑态：null＝表格模式；非 null＝批量文本模式（值即 textarea 内容）
  const [bulkText, setBulkText] = React.useState<string | null>(null)

  if (rows === null) {
    return (
      <div className={cn('flex h-full flex-col gap-1.5 p-3', className)}>
        <p className="text-xs text-muted-foreground">{t('editor.kvRawModeHint')}</p>
        <Textarea
          value={json}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none font-mono text-xs"
        />
      </div>
    )
  }

  const updateRow = (index: number, next: KvRow) => {
    const draft = [...rows]
    draft[index] = next
    onChange(serializeKvRows(draft))
  }
  const removeRow = (index: number) => {
    const draft = rows.filter((_, i) => i !== index)
    onChange(serializeKvRows(draft))
  }
  // 占位行转正：输入的参数名即新行（尾部），焦点随 addedRowId 接续到新行；
  // 底部占位行由渲染期判定自动再续（尾行参数名非空即有之）
  const adoptPlaceholder = (name: string) => {
    onChange(serializeKvRows([...rows, { name, value: '' }]))
    // 新行身份在下一帧调和时分配；以「调和后最后一个身份」标记聚焦目标
    setAddedRowId(idState.nextId + 1)
  }
  const moveRow = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return
    const draft = [...rows]
    const [moved] = draft.splice(from, 1)
    if (moved === undefined) return
    draft.splice(to, 0, moved)
    onChange(serializeKvRows(draft))
  }

  // 批量编辑的进出：进入＝当前行集播种文本；应用＝解析合并写回（同名行仅
  // 覆盖值，标注与启停保留；新行缺省追加）；取消＝丢弃文本退出（数据未动）
  const enterBulk = () => setBulkText(formatBulkKvText(rows))
  const applyBulk = () => {
    if (bulkText === null) return
    onChange(serializeKvRows(mergeBulkIntoRows(rows, parseBulkKvText(bulkText))))
    setBulkText(null)
  }
  const cancelBulk = () => setBulkText(null)

  // 掩码行未揭示时批量编辑禁用：批量文本会明文回显全部行值，先揭示再批量
  const bulkMasked =
    maskValueOf !== undefined && rows.some((row) => maskValueOf(row.name)) && revealValues !== true

  const dragEnd = () => {
    setDragFromIndex(null)
    setDragOverIndex(null)
  }

  if (bulkText !== null) {
    return (
      <div className={cn('flex flex-col gap-1.5 p-3', className)}>
        <div className="flex items-center gap-1.5">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t('editor.kvBulkHint')}</p>
          <Button type="button" size="sm" onClick={applyBulk} data-testid="kv-bulk-apply">
            {t('editor.kvBulkApply')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={cancelBulk}
            data-testid="kv-bulk-cancel"
          >
            {t('editor.kvBulkCancel')}
          </Button>
        </div>
        <Textarea
          value={bulkText}
          onChange={(event) => setBulkText(event.target.value)}
          spellCheck={false}
          aria-label={t('editor.kvBulkEdit')}
          className="min-h-40 resize-none font-mono text-xs"
          data-testid="kv-bulk-textarea"
        />
      </div>
    )
  }

  return (
    <div className={cn('group/kv flex flex-col gap-1 p-3', className)}>
      <KvHeaderRow
        hasTypeColumn={hasTypeColumn}
        bulkButton={
          <button
            type="button"
            disabled={bulkMasked}
            title={bulkMasked ? t('editor.kvBulkMaskedHint') : undefined}
            // 纯文字按钮（无 Button 组件的盒模型与按压位移），浮于表头行右端、
            // 移除钮位列之上（列头无文字，right-0 不重叠）；悬浮表格区才显形，
            // 键盘聚焦同样显形（focus-visible 显形保证 Tab 可达）
            className="absolute top-1/2 right-0 -translate-y-1/2 text-xs text-muted-foreground opacity-0 transition-opacity group-hover/kv:opacity-100 hover:text-primary focus-visible:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none"
            onClick={enterBulk}
            data-testid="kv-bulk-edit"
          >
            {t('editor.kvBulkEdit')}
          </button>
        }
      />
      {idState.rows.map(({ id, row }, index) => (
        <KvRowLine
          key={id}
          row={row}
          index={index}
          isLast={index === rows.length - 1}
          allowedTypes={allowedTypes}
          maskValue={maskValueOf !== undefined && maskValueOf(row.name) && revealValues !== true}
          isPathParam={pathNames.has(row.name)}
          suggestWorkspaceId={suggestWorkspaceId}
          onChange={(next) => updateRow(index, next)}
          onRemove={() => removeRow(index)}
          onMove={moveRow}
          removeLabel={t('editor.kvRemoveRow')}
          reorderLabel={t('editor.kvReorderLabel')}
          reorderHint={t('editor.kvReorderHint')}
          autoFocusName={id === addedRowId}
          draggable={dragArmedId === id}
          dragging={dragFromIndex === index}
          dropTarget={dragOverIndex === index && dragFromIndex !== null && dragFromIndex !== index}
          onDragStart={setDragFromIndex}
          onDragOver={(index_) => setDragOverIndex(index_)}
          onDrop={(index_) => {
            if (dragFromIndex !== null) moveRow(dragFromIndex, index_)
            dragEnd()
          }}
          onDragEnd={dragEnd}
          onArm={(armed) => setDragArmedId(armed ? id : null)}
        />
      ))}
      {rows.at(-1)?.name !== '' && (
        <KvRowLine
          key="placeholder"
          row={PLACEHOLDER_ROW}
          index={rows.length}
          isLast
          isPlaceholder
          onAdoptName={adoptPlaceholder}
          allowedTypes={allowedTypes}
          onChange={() => undefined}
          onRemove={() => undefined}
          onMove={moveRow}
          removeLabel={t('editor.kvRemoveRow')}
          reorderLabel={t('editor.kvReorderLabel')}
          reorderHint={t('editor.kvReorderHint')}
          draggable={false}
          dropTarget={false}
          dragging={false}
          onDragStart={() => undefined}
          onDragOver={() => undefined}
          onDrop={() => undefined}
          onDragEnd={() => undefined}
          onArm={() => undefined}
        />
      )}
    </div>
  )
}
