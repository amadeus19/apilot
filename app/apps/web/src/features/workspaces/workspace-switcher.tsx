import { ChevronDownIcon } from 'lucide-react'

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@workspace/ui/components'

import { SEMANTIC_ICONS } from '@/features/icons/semantic-icons'
import { useI18n } from '@/i18n'
import { reportError } from '@/services/error-center'
import { useTabsStore } from '@/stores/tabs.store'
import { useSetCurrentWorkspaceMutation, useWorkspacesQuery } from './api'
import { useWorkspacesStore } from './workspaces.store'

/**
 * 标题栏工作空间切换器：清单 + current 标记直出 workspace.list；选中即
 * set_current（失效并重拉新工作空间 tree / user_data 由 mutation 统一处理）。
 * 底部唯一入口：「工作空间设置」打开当前空间详情 Tab（新建与管理归左栏
 * 工作空间树视图，不在切换器重复入口）。
 *
 * 触发器带尾部折叠箭头：无箭头时它读起来是一个静态标签而非下拉入口
 * （无边框、无 hover 底色，仅靠 Globe 无法表达可点）。
 */
export function WorkspaceSwitcher() {
  const { t } = useI18n()
  const workspacesQuery = useWorkspacesQuery()
  const setCurrent = useSetCurrentWorkspaceMutation()
  const openWorkspaceSettings = useTabsStore((s) => s.openWorkspaceSettings)

  const items = workspacesQuery.data?.items ?? []
  const current = items.find((item) => item.isCurrent)
  const label = current?.name ?? t('shell.workspaceSwitcherEmpty')
  const setTreeSelectedWorkspace = useWorkspacesStore((s) => s.setTreeSelectedWorkspace)

  const pick = (workspaceId: string): void => {
    if (current?.id === workspaceId) return
    // 切换成功树选中跟随新当前空间（树选中、详情指针与当前空间三方一致，
    // 会话恢复落地的详情校正以此为权威源）
    setCurrent.mutate(workspaceId, {
      onSuccess: () => setTreeSelectedWorkspace(workspaceId),
      onError: (error) => reportError(error),
    })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="max-w-56 text-muted-foreground"
            aria-label={`${t('shell.workspaceSwitcherLabel')}: ${label}`}
          />
        }
      >
        <SEMANTIC_ICONS.workspace data-icon="inline-start" />
        <span className="truncate">{label}</span>
        <ChevronDownIcon data-icon="inline-end" className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('shell.workspaceSwitcherLabel')}</DropdownMenuLabel>
          {items.length === 0 ? (
            <DropdownMenuItem disabled>{t('shell.workspaceSwitcherEmpty')}</DropdownMenuItem>
          ) : (
            items.map((item) => (
              <DropdownMenuItem
                key={item.id}
                data-checked={item.isCurrent || undefined}
                onClick={() => pick(item.id)}
              >
                <span className="truncate">{item.name}</span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={current === null}
          onClick={() => {
            if (current) {
              openWorkspaceSettings({
                workspaceId: current.id,
                name: current.name,
                mode: 'persistent',
              })
            }
          }}
          data-testid="workspace-settings-entry"
        >
          {t('shell.workspaceSettingsEntry')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
