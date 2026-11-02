import { useQueryClient } from '@tanstack/react-query'

import { useI18n, translate } from '@/i18n'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@workspace/ui/components'

import { useSettingsStore } from '@/stores/settings.store'
import { useTabsStore } from '@/stores/tabs.store'
import { useWorkspacesQuery } from '@/features/workspaces/api'
import { useIpcQuery } from '@/services/ipc-query'
import { activateCategoryBy } from '@/features/variables/variable-mutations'
import { variableKeys, variableListCategories } from '@/features/variables/variable-api'

import { useCommandsStore } from './commands.store'
import {
  COMMAND_GROUP_HEADING_KEYS,
  COMMAND_GROUPS,
  effectiveShortcut,
  type CommandDef,
} from './types'

/**
 * 命令面板（Ctrl+Shift+P）：分组渲染稳定命令（注册表现取）+ 标签页动态段
 * （tabs store 即时求值——「切换到标签 N」不进注册表，面板渲染时现取）+
 * 环境动态段（当前工作空间的变量分类即时求值，切换走 seam 非组件协议）。
 * 只做无结果态（首版命令集恒非空，零命令空态是死分支）；
 * 键盘导航（↑↓ / Enter / Esc）由 cmdk 内建承接。
 */

/** 不进面板清单的命令：面板开关自身（已开）与参数化族（动态段代替） */
function isHiddenFromPalette(cmd: CommandDef): boolean {
  return (
    cmd.id === 'palette.toggle' ||
    cmd.id === 'tab.switchByIndex' ||
    cmd.id === 'variables.activateCategory'
  )
}

export function CommandPaletteDialog() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const open = useCommandsStore((s) => s.paletteOpen)
  const setOpen = useCommandsStore((s) => s.setPaletteOpen)
  const commands = useCommandsStore((s) => s.commands)
  const tabs = useTabsStore((s) => s.tabs)
  const setActive = useTabsStore((s) => s.setActive)
  const overrides = useSettingsStore((s) => s.keybindings)

  // 环境动态段数据（当前工作空间的本空间分类）：面板渲染时现取，与
  // 下拉控件共享同一查询缓存
  const { data: workspaces } = useWorkspacesQuery()
  const workspaceId = workspaces?.currentId ?? null
  const categoriesQuery = useIpcQuery({
    queryKey: variableKeys.categories(workspaceId ?? ''),
    queryFn: () => variableListCategories(workspaceId!),
    enabled: workspaceId !== null,
    staleTime: 30_000,
  })
  const envItems = (categoriesQuery.data?.items ?? []).filter((item) => !item.isGlobal)
  const activeCategoryId = categoriesQuery.data?.activeCategoryId ?? null

  const runAndClose = (cmd: CommandDef, arg?: number) => {
    setOpen(false)
    cmd.run(arg)
  }

  /** 环境动态段切换：关面板 → seam 非组件协议（缓存直写＋生效集失效） */
  const switchEnv = (categoryId: string | null) => {
    if (workspaceId === null) return
    setOpen(false)
    void activateCategoryBy(queryClient, workspaceId, categoryId)
  }

  const visible = commands.filter((cmd) => !isHiddenFromPalette(cmd) && (!cmd.when || cmd.when()))

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title={t('common.commandPaletteTitle')}
      description={t('common.commandPaletteDescription')}
    >
      <CommandInput placeholder={t('common.commandPaletteDescription')} />
      <CommandList data-testid="command-palette-list">
        {tabs.length > 0 && (
          <CommandGroup heading={t(COMMAND_GROUP_HEADING_KEYS.tabs)}>
            {tabs.map((tab, index) => {
              const title =
                tab.kind === 'workspaceSettings' ? t('tabs.workspaceSettingsTitle') : tab.title
              const label = t('commandPalette.switchToTab', { index: index + 1 })
              return (
                <CommandItem
                  key={tab.id}
                  value={`${translate('en', 'commandPalette.switchToTab', { index: index + 1 })} ${label} ${title}`}
                  onSelect={() => {
                    setOpen(false)
                    setActive(tab.id)
                  }}
                >
                  <span className="truncate">
                    {label}：{title}
                  </span>
                  {index < 9 && <CommandShortcut>Ctrl+{index + 1}</CommandShortcut>}
                </CommandItem>
              )
            })}
          </CommandGroup>
        )}
        {workspaceId !== null && envItems.length > 0 && (
          <CommandGroup heading={t('commandPalette.groupVariables')}>
            {envItems.map((category) => {
              const label = t('commandPalette.activateCategoryItem', { name: category.name })
              return (
                <CommandItem
                  key={category.id}
                  value={`${label} ${translate('en', 'commandPalette.activateCategoryItem', { name: category.name })} ${category.name}`}
                  data-checked={activeCategoryId === category.id || undefined}
                  onSelect={() => switchEnv(category.id)}
                >
                  <span className="truncate">{label}</span>
                </CommandItem>
              )
            })}
            <CommandItem
              value={`${t('commandPalette.deactivateAllCategories')} ${translate('en', 'commandPalette.deactivateAllCategories')}`}
              data-checked={activeCategoryId === null || undefined}
              onSelect={() => switchEnv(null)}
            >
              <span>{t('commandPalette.deactivateAllCategories')}</span>
            </CommandItem>
          </CommandGroup>
        )}
        {COMMAND_GROUPS.map((group) => {
          const items = visible.filter((cmd) => cmd.group === group)
          if (items.length === 0) return null
          return (
            <CommandGroup key={group} heading={t(COMMAND_GROUP_HEADING_KEYS[group])}>
              {items.map((cmd) => {
                const label = t(cmd.labelKey)
                const Icon = cmd.icon
                const shortcut = effectiveShortcut(cmd, overrides)
                // 检索值拼中英双 label：英文查询（tab / close 等肌肉记忆词）
                // 与中文查询都命中同一命令
                return (
                  <CommandItem
                    key={cmd.id}
                    value={`${label} ${translate('en', cmd.labelKey)}`}
                    onSelect={() => runAndClose(cmd)}
                  >
                    {Icon && <Icon aria-hidden />}
                    <span>{label}</span>
                    {shortcut && shortcut !== 'Ctrl+1..9' && (
                      <CommandShortcut>{shortcut}</CommandShortcut>
                    )}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          )
        })}
        <CommandEmpty className="py-4 text-center text-xs text-muted-foreground">
          {t('commandPalette.noResults')}
        </CommandEmpty>
      </CommandList>
    </CommandDialog>
  )
}
