import * as React from 'react'

import { MoreHorizontalIcon } from 'lucide-react'

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@workspace/ui/components'
import { cn } from 'cn'

import { useI18n } from '@/i18n'
import { SettingRow, SettingRows } from '@/components/common/SettingRow'
import { useSettingsStore } from '@/stores/settings.store'
import { useCommandsStore } from '@/features/commands/commands.store'
import { COMMAND_GROUP_HEADING_KEYS } from '@/features/commands/types'
import {
  COMMAND_GROUPS,
  effectiveShortcut,
  eventToAccelerator,
  shortcutsConflict,
  type CommandDef,
} from '@/features/commands/types'

/**
 * 设置「快捷键」分区：按命令分组（与命令面板分组一致），行＝命令名 +
 * 生效键位芯片（芯片即修改入口，点击进入按键捕获）+ 行尾「···」菜单
 * （清空 / 恢复默认）；组头「恢复全部默认」。冲突检测：同键位已绑其他
 * 命令时提示并阻止保存；允许清空（命令仍面板可达）。组件交互原语
 * （树导航 / Esc 分级等）是固定语义，不进自定义面。
 */

export function KeybindingsSection() {
  const { t } = useI18n()
  const commands = useCommandsStore((s) => s.commands)
  const overrides = useSettingsStore((s) => s.keybindings)
  const [capturingId, setCapturingId] = React.useState<string | null>(null)
  const [conflictOwner, setConflictOwner] = React.useState<string | null>(null)

  // 按键捕获录入：capture 阶段拦在统一分发器与其他全局监听之前；
  // Esc 取消、可绑定键命中即保存（冲突阻止并提示归属命令）
  React.useEffect(() => {
    if (!capturingId) return
    const onKeyDown = (event: KeyboardEvent): void => {
      event.stopPropagation()
      event.preventDefault()
      if (event.key === 'Escape') {
        setCapturingId(null)
        setConflictOwner(null)
        return
      }
      const accelerator = eventToAccelerator(event)
      if (accelerator === null) return
      const settings = useSettingsStore.getState()
      const owner = commands.find(
        (cmd) =>
          cmd.id !== capturingId &&
          shortcutsConflict(effectiveShortcut(cmd, settings.keybindings), accelerator),
      )
      if (owner) {
        setConflictOwner(t(owner.labelKey))
        return
      }
      settings.setKeybinding(capturingId, accelerator)
      setCapturingId(null)
      setConflictOwner(null)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [capturingId, commands, t])

  const groups = COMMAND_GROUPS.filter((group) => commands.some((cmd) => cmd.group === group))

  return (
    <div className="flex flex-col gap-5 p-6" data-testid="keybindings-section">
      <p className="text-xs text-muted-foreground">{t('keybindings.sectionHint')}</p>
      {groups.map((group) => {
        const items = commands.filter((cmd) => cmd.group === group)
        return (
          <section key={group} className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">{t(COMMAND_GROUP_HEADING_KEYS[group])}</h3>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground"
                onClick={() =>
                  useSettingsStore.getState().resetKeybindings(items.map((cmd) => cmd.id))
                }
              >
                {t('keybindings.restoreAllDefaults')}
              </Button>
            </div>
            <SettingRows>
              {items.map((cmd) => (
                <KeybindingRow
                  key={cmd.id}
                  cmd={cmd}
                  overrides={overrides}
                  capturing={capturingId === cmd.id}
                  conflict={capturingId === cmd.id ? conflictOwner : null}
                  onCapture={() => {
                    setCapturingId(cmd.id)
                    setConflictOwner(null)
                  }}
                  onClear={() => useSettingsStore.getState().setKeybinding(cmd.id, null)}
                  onReset={() => useSettingsStore.getState().resetKeybindings([cmd.id])}
                />
              ))}
            </SettingRows>
          </section>
        )
      })}
    </div>
  )
}

function KeybindingRow({
  cmd,
  overrides,
  capturing,
  conflict,
  onCapture,
  onClear,
  onReset,
}: {
  cmd: CommandDef
  overrides: Record<string, string | null>
  capturing: boolean
  conflict: string | null
  onCapture: () => void
  onClear: () => void
  onReset: () => void
}) {
  const { t } = useI18n()
  const effective = effectiveShortcut(cmd, overrides)
  const hasOverride = overrides[cmd.id] !== undefined
  return (
    <div data-testid={`keybinding-row-${cmd.id}`}>
      <SettingRow
        label={t(cmd.labelKey)}
        control={
          <div className="flex items-center gap-1.5">
            {/* 键位芯片即修改入口：点击 / Enter 进入按键捕获（Esc 取消） */}
            <button
              type="button"
              aria-label={t('keybindings.modify')}
              title={t('keybindings.modifyHint')}
              disabled={capturing}
              onClick={onCapture}
              className={cn(
                'rounded border px-1.5 py-0.5 transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50',
                capturing
                  ? 'border-ring bg-background text-foreground'
                  : effective
                    ? 'border-border bg-muted text-foreground hover:border-ring/60'
                    : 'border-dashed text-muted-foreground hover:border-ring/60',
              )}
            >
              <kbd className="font-mono text-xs whitespace-nowrap">
                {capturing
                  ? t('keybindings.capturingHint')
                  : (effective ?? t('keybindings.unbound'))}
              </kbd>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={t('keybindings.moreActions')}
                    disabled={capturing}
                  />
                }
              >
                <MoreHorizontalIcon aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={effective === null} onClick={onClear}>
                  {t('keybindings.clear')}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!hasOverride} onClick={onReset}>
                  {t('keybindings.restoreDefault')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />
      {conflict && (
        <p className="-mt-1 px-4 pb-3 text-xs text-destructive">
          {t('keybindings.conflictWith', { name: conflict })}
        </p>
      )}
    </div>
  )
}
