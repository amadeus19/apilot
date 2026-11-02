import {
  BookOpenIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  CloudIcon,
  CloudOffIcon,
  FolderIcon,
  FolderOpenIcon,
  Layers2Icon,
  PinIcon,
  RefreshCwIcon,
  RouteIcon,
  ServerIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  SquarePenIcon,
  VariableIcon,
} from 'lucide-react'
import { describe, expect, it } from 'vitest'

import { SEMANTIC_ICONS } from '../semantic-icons'

/**
 * 语义图标常量源：锁定首批映射的选型结果，防止「同一语义两处各自取图」回潮。
 * 断言的是选型契约（一语义一图标），不是图标库自身行为。
 */
describe('语义图标常量源', () => {
  it('首批映射与规范一致', () => {
    expect(SEMANTIC_ICONS.workspace).toBe(Layers2Icon)
    expect(SEMANTIC_ICONS.apiTree).toBe(ServerIcon)
    expect(SEMANTIC_ICONS.variables).toBe(VariableIcon)
    expect(SEMANTIC_ICONS.service).toBe(ServerIcon)
    expect(SEMANTIC_ICONS.category).toBe(FolderIcon)
    expect(SEMANTIC_ICONS.categoryExpanded).toBe(FolderOpenIcon)
    expect(SEMANTIC_ICONS.pinnedGroup).toBe(PinIcon)
    expect(SEMANTIC_ICONS.manualEndpoint).toBe(SquarePenIcon)
    expect(SEMANTIC_ICONS.docSource).toBe(BookOpenIcon)
    expect(SEMANTIC_ICONS.settings).toBe(SettingsIcon)
    expect(SEMANTIC_ICONS.workspaceSettings).toBe(SlidersHorizontalIcon)
    expect(SEMANTIC_ICONS.sync).toBe(CloudIcon)
    expect(SEMANTIC_ICONS.syncUnavailable).toBe(CloudOffIcon)
    expect(SEMANTIC_ICONS.refresh).toBe(RefreshCwIcon)
    expect(SEMANTIC_ICONS.treeExpandAll).toBe(ChevronsUpDownIcon)
    expect(SEMANTIC_ICONS.treeCollapseAll).toBe(ChevronsDownUpIcon)
    expect(SEMANTIC_ICONS.workflow).toBe(RouteIcon)
  })

  it('不同语义不复用同一图标', () => {
    // 同步与「刷新 / 重发请求」是两件事：共用图标会让后落地的一方无图可用
    expect(SEMANTIC_ICONS.sync).not.toBe(SEMANTIC_ICONS.refresh)
    expect(SEMANTIC_ICONS.syncUnavailable).not.toBe(SEMANTIC_ICONS.refresh)
    // 应用设置与工作空间级配置是两处入口，不得共用一个齿轮
    expect(SEMANTIC_ICONS.settings).not.toBe(SEMANTIC_ICONS.workspaceSettings)
    // 变量与接口树是两个视图语义（斜 x vs 服务机架），不共用图标
    expect(SEMANTIC_ICONS.variables).not.toBe(SEMANTIC_ICONS.apiTree)
    // 例外：接口树入口刻意复用「服务」图标（树以服务为一级组织，入口与内容同图）
    expect(SEMANTIC_ICONS.apiTree).toBe(SEMANTIC_ICONS.service)
  })
})
