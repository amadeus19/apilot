import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components'
import { useI18n } from '@/i18n'
import { useAppStore } from '@/stores/app.store'

import { expandLeftPanel } from './panel-bridge'
import { LEFT_PANEL_VIEWS } from './left-panel-views'

/**
 * 常驻图标栏：w-12，左栏视图切换；
 * 图标栏永不折叠（底座调整定案），收展只作用于右侧面板区域（AppShell 接线）。
 * 收起态下点击视图＝明确要查看该视图：面板随之展开（展开动作幂等，
 * 已展开时不动）——视图入口不应指向一块不可见区域。
 */

export function IconRail() {
  const { t } = useI18n()
  const leftView = useAppStore((s) => s.leftView)
  const setLeftView = useAppStore((s) => s.setLeftView)

  return (
    <nav
      aria-label={t('shell.leftNavLabel')}
      className="flex h-full w-12 shrink-0 flex-col items-center gap-1 border-r bg-sidebar py-2"
    >
      {LEFT_PANEL_VIEWS.map((view) => {
        const active = leftView === view.key
        const label = t(view.labelKey)
        return (
          <Tooltip key={view.key}>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className={
                    active
                      ? 'bg-selection text-sidebar-accent-foreground hover:bg-selection'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  }
                  aria-label={label}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => {
                    setLeftView(view.key)
                    expandLeftPanel()
                  }}
                />
              }
            >
              <view.icon />
            </TooltipTrigger>
            <TooltipContent side="right">{label}</TooltipContent>
          </Tooltip>
        )
      })}
    </nav>
  )
}
