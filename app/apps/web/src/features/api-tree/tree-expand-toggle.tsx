import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components'

import { SEMANTIC_ICONS } from '@/features/icons/semantic-icons'
import { useCurrentWorkspaceTreeQuery } from '@/features/workspaces/api'
import { useI18n } from '@/i18n'

import { allContainerIds } from './selector'
import { useTreeExpandedStore } from './tree-state.store'

/**
 * 接口树「一键展开 / 收起全部」（左栏搜索行尾部动作）：有任一展开项时
 * 收起全部（清空展开集），否则展开全部容器（服务 + 分类 + 置顶组）。
 * 目标集从树查询直推——与树面板共享同一条查询缓存，不产生额外请求。
 */
export function TreeExpandToggle() {
  const { t } = useI18n()
  const { data: tree } = useCurrentWorkspaceTreeQuery()
  const expandedIds = useTreeExpandedStore((s) => s.expandedIds)
  const setExpanded = useTreeExpandedStore((s) => s.setExpanded)
  const anyExpanded = expandedIds.length > 0
  const label = anyExpanded ? t('apiTree.collapseAll') : t('apiTree.expandAll')
  const Icon = anyExpanded ? SEMANTIC_ICONS.treeCollapseAll : SEMANTIC_ICONS.treeExpandAll
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            data-testid="api-tree-expand-toggle"
            disabled={!tree}
            className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors duration-150 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[2px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
            onClick={() => setExpanded(anyExpanded ? [] : tree ? allContainerIds(tree) : [])}
          />
        }
      >
        <Icon aria-hidden className="size-3.5 shrink-0" />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
