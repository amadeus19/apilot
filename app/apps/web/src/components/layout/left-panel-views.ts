import type { ComponentType } from 'react'

import type { LucideIcon } from 'lucide-react'

import { SEMANTIC_ICONS } from '@/features/icons/semantic-icons'
import { TreeExpandToggle } from '@/features/api-tree/tree-expand-toggle'
import type { DictKey } from '@/i18n'
import type { LeftPanelView } from '@/stores/app.store'

/**
 * 左栏视图的单一映射源：图标栏与左栏面板共用，
 * 图标、标签与搜索占位在此一处维护，防止两处映射漂移。
 * 图标取语义常量源（SEMANTIC_ICONS），本文件不直接引用图标库——
 * 「一个语义一个图标」的事实源只有那一处。
 * 五视图均为实装视图（接口树 / 请求历史 / 变量树 / 工作空间清单 / 工作流清单），
 * 空态由各业务面板自行呈现，不经此处分发文案键。
 */
export interface LeftPanelViewMeta {
  key: LeftPanelView
  /** 图标栏标签与无障碍名 */
  labelKey: DictKey
  /** 搜索框占位 */
  placeholderKey: DictKey
  icon: LucideIcon
  /** 搜索行尾部动作（视图专属，如接口树的一键展开 / 收起）；无则不渲染 */
  SearchAction?: ComponentType
}

export const LEFT_PANEL_VIEWS: LeftPanelViewMeta[] = [
  {
    key: 'apis',
    labelKey: 'shell.viewApis',
    placeholderKey: 'shell.searchApisPlaceholder',
    icon: SEMANTIC_ICONS.apiTree,
    SearchAction: TreeExpandToggle,
  },
  {
    key: 'history',
    labelKey: 'shell.viewHistory',
    placeholderKey: 'shell.searchHistoryPlaceholder',
    icon: SEMANTIC_ICONS.requestHistory,
  },
  {
    key: 'variables',
    labelKey: 'shell.viewVariables',
    placeholderKey: 'shell.searchVariablesPlaceholder',
    icon: SEMANTIC_ICONS.variables,
  },
  {
    key: 'workspaces',
    labelKey: 'shell.viewWorkspaces',
    placeholderKey: 'shell.searchWorkspacesPlaceholder',
    icon: SEMANTIC_ICONS.workspace,
  },
  {
    key: 'workflows',
    labelKey: 'shell.viewWorkflows',
    placeholderKey: 'shell.searchWorkflowsPlaceholder',
    icon: SEMANTIC_ICONS.workflow,
  },
]
