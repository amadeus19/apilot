import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { useAppStore } from '@/stores/app.store'
import { useSettingsStore } from '@/stores/settings.store'
import { useTabsStore } from '@/stores/tabs.store'
import { resolveTheme } from '@/lib/settings-schema'
import { useUpdateFlow } from '@/features/update/use-update-flow'
import { toggleLeftPanelGeometry } from '@/components/layout/panel-bridge'
import { openNewEndpointDialog } from '@/features/api-tree/new-endpoint-action'
import { invokeSendAction } from '@/features/workbench/send-action-bridge'
import { workbenchKeys, type WorkspaceListDto } from '@/services/workbench-api'
import { activateCategoryBy } from '@/features/variables/variable-mutations'
import { variableKeys, type VariableCategoriesDto } from '@/features/variables/variable-api'

import { useCommandsStore } from './commands.store'
import { useRegisterCommands } from './use-register-commands'
import { PARAMETERIZED_FAMILY, type CommandDef } from './types'

/**
 * 全局命令（发送 + 面板开关 + 标签页 + 新建接口 + 左栏收展等）：AppShell 挂载
 * 单点注册。动作全部转发既有 store / 流程（命令零业务）；run 经 getState
 * 直读，闭包无陈旧态。面板不显示 palette.toggle 与参数化族（后者由动态段
 * 代替），但注册进注册表——统一分发器与快捷键自定义都消费它。
 * 一切命令键位（含 Ctrl+B / Ctrl+T / Ctrl+Enter）只经统一分发器生效，业务
 * 不得自挂命令键位监听。
 */
export function useGlobalCommands(): void {
  const queryClient = useQueryClient()
  const defs = React.useMemo<CommandDef[]>(
    () => [
      {
        id: 'workbench.send',
        labelKey: 'commandPalette.cmdSendRequest',
        group: 'workbench',
        defaultShortcut: 'Ctrl+Enter',
        // 仅接口 Tab 激活时可用：非接口 Tab 不吞 Ctrl+Enter（默认行为放行）
        when: () => {
          const { tabs, activeTabId } = useTabsStore.getState()
          return tabs.some((tab) => tab.id === activeTabId && tab.kind === 'endpoint')
        },
        // 经 workbench store 取激活 tabId 路由到该 Tab 编辑器登记的发送动作
        // （发送语义——草稿取用、sending 态取消——单一活在编辑器，命令不复制）
        run: () => {
          const { activeTabId } = useTabsStore.getState()
          if (activeTabId) invokeSendAction(activeTabId)
        },
      },
      {
        id: 'palette.toggle',
        labelKey: 'commandPalette.cmdTogglePalette',
        group: 'settings',
        defaultShortcut: 'Ctrl+Shift+P',
        run: () => {
          const store = useCommandsStore.getState()
          store.setPaletteOpen(!store.paletteOpen)
        },
      },
      {
        id: 'view.switchToApis',
        labelKey: 'commandPalette.cmdSwitchToApis',
        group: 'view',
        run: () => useAppStore.getState().setLeftView('apis'),
      },
      {
        id: 'view.toggleLeftPanel',
        labelKey: 'commandPalette.cmdToggleLeftPanel',
        group: 'view',
        defaultShortcut: 'Ctrl+B',
        run: () => toggleLeftPanelGeometry(),
      },
      {
        id: 'tree.newEndpoint',
        labelKey: 'commandPalette.cmdNewEndpoint',
        group: 'view',
        defaultShortcut: 'Ctrl+T',
        run: () => openNewEndpointDialog(queryClient),
      },
      {
        id: 'tab.switchByIndex',
        labelKey: 'commandPalette.tabSwitchByIndexLabel',
        group: 'tabs',
        defaultShortcut: PARAMETERIZED_FAMILY,
        run: (arg) => {
          if (!arg) return
          const { tabs, setActive } = useTabsStore.getState()
          const target = tabs[arg - 1]
          if (target) setActive(target.id)
        },
      },
      {
        id: 'tab.close',
        labelKey: 'commandPalette.cmdCloseTab',
        group: 'tabs',
        defaultShortcut: 'Ctrl+W',
        run: () => {
          const { activeTabId, close } = useTabsStore.getState()
          if (activeTabId) close(activeTabId)
        },
      },
      {
        id: 'tab.closeAll',
        labelKey: 'commandPalette.cmdCloseAllTabs',
        group: 'tabs',
        run: () => useTabsStore.getState().closeAll(),
      },
      {
        id: 'variables.activateCategory',
        labelKey: 'commandPalette.cmdActivateCategory',
        group: 'variables',
        // 参数化命令（面板由环境动态段代替，对齐 tab.switchByIndex 先例）：
        // run(n)＝切到分类清单第 n 个本空间分类（1 基序号，清单序＝
        // categories 查询返回序）；null＝取消激活不做序号化（面板行直达）。
        // 数据经缓存现取（面板打开即预热；缓存未热则静默跳过）
        run: (arg) => {
          if (!arg) return
          const current = queryClient.getQueryData<WorkspaceListDto>(workbenchKeys.workspaces())
          const workspaceId = current?.currentId
          if (!workspaceId) return
          const view = queryClient.getQueryData<VariableCategoriesDto>(
            variableKeys.categories(workspaceId),
          )
          const target = (view?.items ?? []).filter((item) => !item.isGlobal)[arg - 1]
          if (target) void activateCategoryBy(queryClient, workspaceId, target.id)
        },
      },
      {
        id: 'settings.open',
        labelKey: 'commandPalette.cmdOpenSettings',
        group: 'settings',
        defaultShortcut: 'Ctrl+,',
        run: () => useAppStore.getState().setSettingsOpen(true),
      },
      {
        id: 'settings.checkUpdate',
        labelKey: 'commandPalette.cmdCheckUpdates',
        group: 'settings',
        run: () => void useUpdateFlow.getState().checkUpdates(),
      },
      {
        id: 'appearance.toggleTheme',
        labelKey: 'commandPalette.cmdToggleTheme',
        group: 'appearance',
        run: () => {
          const settings = useSettingsStore.getState()
          const resolved = resolveTheme(settings.theme.preference, settings.systemTheme)
          settings.setThemePreference(resolved === 'dark' ? 'light' : 'dark')
        },
      },
      {
        id: 'focus.search',
        labelKey: 'commandPalette.cmdFocusSearch',
        group: 'focus',
        defaultShortcut: 'Ctrl+K',
        // 只聚焦当前视图的搜索框，不切换视图——各视图搜索框都挂着 Ctrl+K
        // 提示，命令承诺与提示一致（历史视图的输入框由 HistoryPanel 持有，
        // 消费同一 nonce 信号）
        run: () => {
          useAppStore.getState().focusSearch()
        },
      },
    ],
    [queryClient],
  )
  useRegisterCommands(defs, [])
}
