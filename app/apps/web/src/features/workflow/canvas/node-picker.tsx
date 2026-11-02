import * as React from 'react'

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@workspace/ui/components'

import { cn } from 'cn'

import { useI18n } from '@/i18n'

import type { WorkflowNodeKind } from '../workflow-model'
import { filterConnectableKinds, type ConnectionDirection } from './connection-picker'
import type { PickerPanelPosition } from './node-picker-anchor'
import { NODE_DESC_KEYS, NODE_ICONS, NODE_LABEL_KEYS, PALETTE_GROUPS } from './node-meta'

/**
 * 画布节点选择面板：Postman Flow 式浮动块菜单——顶部搜索、按组列节点
 * （图标＋名称＋一句话说明）。两个场景变体：
 * - 画布场景（variant 缺省，右键空白面 / 悬浮工具栏「添加节点」）：底部
 *   保留空白面动作（粘贴 / 全选 / 自动布局）。替代常驻左栏节点面板——
 *   画布独占编辑区，节点清单只在需要时出现。
 * - 连线场景（variant "connect"）：拉线松手在画布空白处弹出，画布级动作
 *   行不出现；候选按拉线方向过滤（顺向排除开始、反向排除结束），组内
 *   过滤后为空的组整组隐藏。Esc / 点外关闭由编辑器收口（不建任何东西）。
 *
 * 面板坐标由编辑器换算成画布容器的本地坐标（含边界收口），本组件只负责
 * 渲染与关闭语义（Esc / 点外）。maxHeight 是底缘让位线兜底：真实高度
 * 超出时列表经内部滚动吸收，搜索框与底部动作行恒可见。搜索与键盘选择
 * 由 Command 原语承担。
 */

/** 面板锚点：left / top / maxHeight 是画布容器本地坐标下的摆放（已收口），
 * clientX / clientY 是建节点的落点（右键坐标或视口中心） */
export interface NodePickerAnchor extends PickerPanelPosition {
  clientX: number
  clientY: number
}

/** 画布场景 props：空白面打开，带动作行 */
interface CanvasPickerProps {
  variant?: 'canvas'
  anchor: NodePickerAnchor
  /** 画布剪贴板是否有载荷（粘贴项置灰） */
  canPaste: boolean
  onClose: () => void
  onAddNode: (kind: WorkflowNodeKind) => void
  onPaste: () => void
  onSelectAll: () => void
  onAutoLayout: () => void
}

/** 连线场景 props：拉线松手打开，无动作行、候选按方向过滤 */
interface ConnectPickerProps {
  variant: 'connect'
  anchor: NodePickerAnchor
  /** 拉线方向（顺向找下游、反向找上游），决定候选过滤 */
  direction: ConnectionDirection
  onClose: () => void
  onAddNode: (kind: WorkflowNodeKind) => void
}

export type NodePickerProps = CanvasPickerProps | ConnectPickerProps

export function NodePicker(props: NodePickerProps) {
  const { anchor, onClose, onAddNode } = props
  const { t } = useI18n()
  const panelRef = React.useRef<HTMLDivElement | null>(null)
  // 连线场景候选：组内按方向过滤、过滤后为空的组整组隐藏（流程组在顺向
  // 只剩结束、反向只剩开始；元数据增删 kind 时候选自然跟随）
  const paletteGroups =
    props.variant === 'connect'
      ? PALETTE_GROUPS.map((group) => ({
          ...group,
          kinds: filterConnectableKinds(group.kinds, props.direction),
        })).filter((group) => group.kinds.length > 0)
      : PALETTE_GROUPS

  // 点外关闭：捕获阶段监听，画布内的点按（选中 / 拖拽）先于画布处理
  React.useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (panelRef.current?.contains(event.target as Node)) return
      onClose()
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [onClose])

  const handleEscape = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    onClose()
  }

  return (
    <div
      ref={panelRef}
      className="absolute z-20 flex w-72 flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-xl"
      style={{ left: anchor.left, top: anchor.top, maxHeight: anchor.maxHeight }}
      onKeyDown={handleEscape}
      data-testid="workflow-node-picker"
    >
      <Command className="min-h-0 flex-1 rounded-none! bg-transparent p-0">
        <CommandInput
          autoFocus
          placeholder={t('workflows.pickerSearchPlaceholder')}
          data-testid="workflow-picker-search"
          onKeyDown={handleEscape}
        />
        <CommandList className="max-h-[26rem] min-h-0">
          <CommandEmpty className="py-4 text-xs">{t('workflows.pickerEmpty')}</CommandEmpty>
          {paletteGroups.map((group) => (
            <CommandGroup key={group.id} heading={t(group.labelKey)}>
              {group.kinds.map((kind) => {
                const Icon = NODE_ICONS[kind]
                const label = t(NODE_LABEL_KEYS[kind])
                return (
                  <CommandItem
                    key={kind}
                    value={`${label} ${t(NODE_DESC_KEYS[kind])}`}
                    onSelect={() => onAddNode(kind)}
                    className="items-start gap-2.5 rounded-md px-1.5 py-1.5 data-selected:bg-accent"
                    data-testid={`workflow-picker-${kind}`}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-card">
                      <Icon aria-hidden className="size-3.5 text-muted-foreground" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{label}</span>
                      <span className="block truncate text-micro text-muted-foreground">
                        {t(NODE_DESC_KEYS[kind])}
                      </span>
                    </span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
      {/* 连线场景无底部动作行：粘贴 / 全选 / 自动布局是画布级动作，与
          连线选型无关，画布场景变体独占 */}
      {props.variant !== 'connect' && (
        <div className="flex shrink-0 items-center gap-1 border-t bg-muted/30 px-2 py-1.5">
          <PickerAction
            label={t('workflows.canvasMenuPaste')}
            disabled={!props.canPaste}
            onClick={() => {
              onClose()
              props.onPaste()
            }}
          />
          <PickerAction
            label={t('workflows.canvasMenuSelectAll')}
            onClick={() => {
              onClose()
              props.onSelectAll()
            }}
          />
          <PickerAction
            label={t('workflows.canvasMenuAutoLayout')}
            onClick={() => {
              onClose()
              props.onAutoLayout()
            }}
          />
        </div>
      )}
    </div>
  )
}

/** 面板底部动作：字号与弹层内节点条目一致（text-xs），弱色弱权重拉开
 * 与条目的视觉层级 */
function PickerAction({
  label,
  disabled,
  onClick,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'h-6 rounded-sm px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40',
      )}
    >
      {label}
    </button>
  )
}
