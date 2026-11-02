import * as React from 'react'

import { CheckIcon } from 'lucide-react'

import { cn } from 'cn'
import { Button, Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components'

import { useI18n } from '@/i18n'
import { useIpcQuery } from '@/services/ipc-query'
import { SEMANTIC_ICONS } from '@/features/icons/semantic-icons'

import { useVariableMutations } from './variable-mutations'
import { variableKeys, variableListCategories } from './variable-api'

/** 骨架占位行宽度（错落近似分类行长短；与加载完成后的行高形状匹配） */
const SKELETON_ROW_WIDTHS = ['62%', '84%', '48%']

/** 弹层选择行（分类行与「全部不激活」共用呈现；勾选位＝当前激活态）。
 *  读屏语义＝listbox/option（比 menuitemradio 更贴合：容器非 menu，且行
 *  不真实聚焦——焦点留在触发器，aria-selected 在浏览模式下可播报） */
function EnvSwitchRow({
  label,
  checked,
  testId,
  onPick,
}: {
  label: string
  checked: boolean
  testId: string
  onPick: () => void
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={checked}
      className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-xs outline-none hover:bg-accent focus-visible:bg-accent"
      data-testid={testId}
      onClick={onPick}
    >
      {checked ? (
        <CheckIcon aria-hidden className="size-3 shrink-0 text-primary" />
      ) : (
        <span aria-hidden className="size-3 shrink-0" />
      )}
      <span className="truncate">{label}</span>
    </button>
  )
}

/**
 * 环境快捷切换（地址栏环境块）：显示当前激活分类名，点开列出本工作空间
 * 全部分类＋「全部不激活」，点选即切。与左栏变量树、配置页按钮共用
 * activateCategoryMutation（seam 收口：分类视图直写＋生效集失效，切换后
 * 生效变量集右栏即时刷新）。全局分类跨空间兜底、不可激活，不进清单。
 */
export function EnvQuickSwitchControl({ workspaceId }: { workspaceId: string }) {
  const { t } = useI18n()
  const [open, setOpen] = React.useState(false)
  const categoriesQuery = useIpcQuery({
    queryKey: variableKeys.categories(workspaceId),
    queryFn: () => variableListCategories(workspaceId),
    staleTime: 30_000,
  })
  const { activateCategoryMutation } = useVariableMutations(workspaceId)

  // 本空间分类才可激活（全局分类跨空间兜底）；激活指针指向已删分类时视为未激活
  const items = categoriesQuery.data?.items.filter((category) => !category.isGlobal) ?? []
  const activeId = categoriesQuery.data?.activeCategoryId ?? null
  const activeName = items.find((category) => category.id === activeId)?.name ?? null

  const pick = (categoryId: string | null) => {
    setOpen(false)
    if (categoryId !== activeId) activateCategoryMutation.mutate(categoryId)
  }

  const label = activeName
    ? t('variables.quickSwitch.triggerActiveLabel', { name: activeName })
    : t('variables.quickSwitch.triggerLabel')

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'h-7 max-w-40 shrink-0 gap-1 rounded-md px-2 text-xs whitespace-nowrap text-muted-foreground hover:bg-muted',
              activeName && 'text-foreground',
            )}
            aria-label={label}
            title={label}
            data-testid="env-quick-switch-trigger"
            data-active={activeName ? true : undefined}
          >
            <SEMANTIC_ICONS.variables aria-hidden className="size-3 shrink-0" />
            <span className="min-w-0 truncate">
              {activeName ?? t('variables.quickSwitch.noActive')}
            </span>
          </Button>
        }
      />
      <PopoverContent align="end" className="w-64">
        <p className="text-xs font-medium text-muted-foreground">
          {t('variables.quickSwitch.title')}
        </p>
        {categoriesQuery.isPending ? (
          // 加载中渲染骨架占位，不渲染空态（防「暂无本空间分类」闪烁）
          <div
            aria-hidden
            data-testid="env-quick-switch-skeleton"
            className="mt-1 flex flex-col gap-1 py-1"
          >
            {SKELETON_ROW_WIDTHS.map((width, index) => (
              <div
                key={index}
                className="h-4 animate-pulse rounded-sm bg-muted"
                style={{ width }}
              />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            {t('variables.quickSwitch.empty')}
          </p>
        ) : (
          // 单选清单语义：外层 listbox 收纳分类行与「全部不激活」（视觉两段，
          // 语义一份——同组互斥的单选集）；分隔段 role=presentation，不冒充选项
          <div
            role="listbox"
            aria-label={t('variables.quickSwitch.title')}
            data-testid="env-quick-switch-list"
          >
            <div role="presentation" className="mt-1 flex max-h-56 flex-col overflow-y-auto">
              {items.map((category) => (
                <EnvSwitchRow
                  key={category.id}
                  label={category.name}
                  checked={category.id === activeId}
                  testId="env-quick-switch-row"
                  onPick={() => pick(category.id)}
                />
              ))}
            </div>
            <div role="presentation" className="mt-1 border-t border-border pt-1">
              <EnvSwitchRow
                label={t('variables.quickSwitch.deactivateAll')}
                checked={activeId === null}
                testId="env-quick-switch-deactivate"
                onPick={() => pick(null)}
              />
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
