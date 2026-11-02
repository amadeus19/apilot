import * as React from 'react'

import { ChevronRightIcon, GripVerticalIcon, type LucideIcon } from 'lucide-react'

import { cn } from 'cn'
import { Tooltip, TooltipContent, TooltipTrigger, type TreeRowData } from '@workspace/ui/components'

import { SEMANTIC_ICONS } from '@/features/icons/semantic-icons'
import { useI18n } from '@/i18n'
import { type ApiTreeNode, type ApiTreeNodeKind } from './selector'
import { MethodBadge } from './method-badge'
import { ServiceProbeChip } from './service-probe-chip'
import { SyncBadgeChip } from './sync-badge'

/**
 * 树行渲染：接口行（方法徽章 + 名称 + 行尾元信息）与容器行（折叠指示 +
 * 类型图标 + 名称 + 行尾元信息）共用一个容器（缩进 / 拖拽手柄一份实现）。
 *
 * 激活态视觉：选中的接口行（＝当前打开的接口）方法徽章点亮主题色，其
 * 上级服务的类型图标同步点亮——长树里定位「激活接口属于哪个服务」不必
 * 逐行扫视方法色。
 *
 * 栅格：容器行占「折叠指示 + 类型图标」两格，接口行占「方法徽章」一格
 * （徽章定宽见 method-badge）。同层行的名称起点因此恒定——树是高频扫视
 * 界面，名称列对齐是垂直扫视的锚点，比横向紧凑更值钱。
 *
 * 行尾元信息与操作手柄分位而处：手工标识（仅来源混存的服务）与文档地址
 * 标识贴行尾右缘、恒定呈现（悬停走统一 Tooltip 说明语义）；拖拽手柄在其后
 * hover 才现（ml-auto 由元信息承担，无元信息的行由名称承担）。
 */

const ICON_CLASS = 'size-3.5 shrink-0 text-muted-foreground'

/** 拖拽手柄：仅真实可拖行渲染（置顶组视图行与过滤模式不渲染） */
function DragHandle(): React.ReactNode {
  return (
    <GripVerticalIcon
      data-drag-handle
      aria-hidden
      className="size-3.5 shrink-0 cursor-grab text-muted-foreground/50 opacity-0 transition-opacity group-hover/row:text-muted-foreground group-hover/row:opacity-100"
    />
  )
}

/** 容器行类型图标：服务 / 分类（展开态换开页形状）/ 置顶组；active＝图标点亮主题色 */
function containerIcon(kind: ApiTreeNodeKind, expanded: boolean, active: boolean): React.ReactNode {
  if (kind === 'service') {
    return (
      <SEMANTIC_ICONS.service aria-hidden className={cn(ICON_CLASS, active && 'text-primary')} />
    )
  }
  if (kind === 'category') {
    const Icon = expanded ? SEMANTIC_ICONS.categoryExpanded : SEMANTIC_ICONS.category
    return <Icon aria-hidden className={ICON_CLASS} />
  }
  return <SEMANTIC_ICONS.pinnedGroup aria-hidden className={ICON_CLASS} />
}

/** 行尾语义标识：悬停提示走全应用统一 Tooltip，不用原生 title */
function TrailingMark({ label, icon: Icon }: { label: string; icon: LucideIcon }): React.ReactNode {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <Icon aria-hidden className={ICON_CLASS} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function ApiTreeRow({
  row,
  showDragHandle,
  containsActiveEndpoint = false,
}: {
  row: TreeRowData<ApiTreeNode>
  showDragHandle: boolean
  /** 该容器行子树内含当前激活接口（＝选中行）：上级服务图标点亮主题色 */
  containsActiveEndpoint?: boolean
}) {
  const { t } = useI18n()
  const node = row.data

  // 行尾组：元信息（手工 / 文档标识 / 可达芯片）与拖拽手柄拢在一处；皆无则不渲染
  const trailing =
    node.showManualMark ||
    (node.kind === 'service' && node.docUrl) ||
    (node.kind === 'service' && node.serviceId) ||
    showDragHandle ? (
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {node.showManualMark && (
          <TrailingMark label={t('apiTree.manualEndpoint')} icon={SEMANTIC_ICONS.manualEndpoint} />
        )}
        {node.kind === 'service' && node.serviceId && (
          <ServiceProbeChip serviceId={node.serviceId} />
        )}
        {node.kind === 'service' && node.docUrl && (
          <TrailingMark label={t('apiTree.docService')} icon={SEMANTIC_ICONS.docSource} />
        )}
        {showDragHandle && <DragHandle />}
      </span>
    ) : null

  return (
    <span
      className="group/row flex min-w-0 flex-1 items-center gap-1 rounded-sm"
      style={{ paddingInlineStart: row.indentPx }}
    >
      {node.kind === 'endpoint' ? (
        <>
          <MethodBadge method={node.method ?? ''} active={row.isSelected} />
          <span className="truncate">{node.name}</span>
          {node.syncBadge && <SyncBadgeChip badge={node.syncBadge} />}
          {trailing}
        </>
      ) : (
        <>
          <ChevronRightIcon
            aria-hidden
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform duration-150',
              row.isExpanded && 'rotate-90',
            )}
          />
          {containerIcon(node.kind, row.isExpanded, containsActiveEndpoint)}
          <span className="truncate">{node.name}</span>
          {trailing}
        </>
      )}
    </span>
  )
}
