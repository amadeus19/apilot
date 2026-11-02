import {
  Button,
  Separator,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@workspace/ui/components'
import * as React from 'react'
import {
  CopyIcon,
  MinusIcon,
  MoonIcon,
  PanelLeftIcon,
  SquareIcon,
  SunIcon,
  XIcon,
} from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'

import { cn } from 'cn'

import { AppLogo } from '@/components/common/AppLogo'
import { toggleLeftPanelGeometry } from '@/components/layout/panel-bridge'
import { SEMANTIC_ICONS } from '@/features/icons/semantic-icons'
import { WorkspaceSwitcher } from '@/features/workspaces/workspace-switcher'
import { useI18n } from '@/i18n'
import { selectResolvedTheme, useSettingsStore } from '@/stores/settings.store'
import { useAppStore } from '@/stores/app.store'
import { useSyncWizardStore } from '@/stores/sync.store'

/**
 * 自绘标题栏：h-10，`data-tauri-drag-region="deep"`
 * 全子树拖拽（可交互元素自动豁免），双击最大化由 Tauri core drag.js 原生处理，
 * 前端不重复实现。左＝logo＋面板收展钮＋工作空间切换器占位；
 * 右＝同步入口（向导）、明暗快捷钮（写偏好落库）、设置、窗口控制。
 */

/** 窗口控制三键：Windows 惯例的全高扁平按钮，关闭键 hover 反色 */
function WindowControls() {
  const { t } = useI18n()
  const [maximized, setMaximized] = React.useState(false)
  const win = React.useMemo(() => getCurrentWindow(), [])

  // 最大化状态跟随窗口尺寸变化；unlisten 归组件清理（资源所有权四问）
  React.useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null
    void win.isMaximized().then((value) => {
      if (!disposed) setMaximized(value)
    })
    void win
      .onResized(() => {
        void win.isMaximized().then((value) => {
          if (!disposed) setMaximized(value)
        })
      })
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [win])

  const controlClass =
    'grid h-full w-11 place-items-center text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset'
  return (
    <div className="flex items-stretch self-stretch" data-tauri-drag-region="false">
      <button
        type="button"
        aria-label={t('shell.minimize')}
        className={controlClass}
        onClick={() => void win.minimize()}
      >
        <MinusIcon className="size-4" />
      </button>
      <button
        type="button"
        aria-label={maximized ? t('shell.restore') : t('shell.maximize')}
        className={controlClass}
        onClick={() => void win.toggleMaximize()}
      >
        {maximized ? <CopyIcon className="size-4" /> : <SquareIcon className="size-4" />}
      </button>
      <button
        type="button"
        aria-label={t('shell.close')}
        className={cn(controlClass, 'hover:bg-destructive hover:text-destructive-foreground')}
        onClick={() => void win.close()}
      >
        <XIcon className="size-4" />
      </button>
    </div>
  )
}

/** 同步入口：打开同步向导（四段流程承载在 SyncWizard，挂 AppShell 层） */
function SyncButton() {
  const { t } = useI18n()
  const openWizard = useSyncWizardStore((s) => s.openWizard)
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('shell.syncButton')}
            onClick={openWizard}
          />
        }
      >
        <SEMANTIC_ICONS.sync />
      </TooltipTrigger>
      <TooltipContent>{t('shell.syncButton')}</TooltipContent>
    </Tooltip>
  )
}

export function TitleBar() {
  const { t } = useI18n()
  const resolvedTheme = useSettingsStore(selectResolvedTheme)
  const setThemePreference = useSettingsStore((s) => s.setThemePreference)
  const leftPanelVisible = useAppStore((s) => s.leftPanelVisible)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)

  // 明暗快捷钮：单击在 light ↔ dark 间切换（写偏好落库，
  // 写失败不回滚由 store 协议保证）；以 resolved 为基准——system 态下点击落「与当前
  // 呈现相反」的显式偏好，首击即达意；「跟随系统」只在设置面板选
  const toggleQuickTheme = () => setThemePreference(resolvedTheme === 'dark' ? 'light' : 'dark')

  return (
    <header
      data-tauri-drag-region="deep"
      className="flex h-10 shrink-0 items-stretch border-b border-border bg-card"
    >
      {/* 左：应用图标＋面板收展钮＋工作空间切换器占位。
          收展钮常显（不再悬停替换 logo）：悬停才出现的控件不构成可发现的操作
          入口，Ctrl+B 的键盘通道也替代不了它对鼠标用户的可见性 */}
      <div className="flex items-center gap-1 pl-2">
        <span className="flex size-7 items-center justify-center text-muted-foreground">
          <AppLogo />
        </span>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('shell.panelToggle')}
                // 收起是「非默认态」：按钮以按下态（aria-pressed＋激活底色）提示
                // 左栏处于收起——常态（展开）不亮，与 ghost 基类的 aria-expanded
                // 激活样式无关（本钮不用 aria-expanded，避免「常态常亮」的反直觉）
                aria-pressed={!leftPanelVisible}
                className="aria-pressed:bg-accent aria-pressed:text-foreground"
                onClick={toggleLeftPanelGeometry}
              />
            }
          >
            <PanelLeftIcon />
          </TooltipTrigger>
          <TooltipContent>{t('shell.panelToggle')}</TooltipContent>
        </Tooltip>

        {/* 工作空间切换器（只列、只切换；管理视图归 Phase 5） */}
        <WorkspaceSwitcher />
      </div>

      <div className="flex-1" />

      {/* 右：同步（向导入口）＋明暗快捷钮＋设置（已接通）＋窗口控制 */}
      <div className="flex items-center gap-1 pr-1">
        <SyncButton />

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={
                  resolvedTheme === 'dark'
                    ? t('shell.themeToggleToLight')
                    : t('shell.themeToggleToDark')
                }
                onClick={toggleQuickTheme}
              />
            }
          >
            {resolvedTheme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </TooltipTrigger>
          <TooltipContent>{t('shell.themeToggleHint')}</TooltipContent>
        </Tooltip>

        {/* 设置面板入口：Ctrl+, 同效 */}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('shell.settingsButton')}
                onClick={() => setSettingsOpen(true)}
              />
            }
          >
            <SEMANTIC_ICONS.settings />
          </TooltipTrigger>
          <TooltipContent>{t('shell.settingsButton')}</TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="mx-1.5 h-5 self-center" />
        <WindowControls />
      </div>
    </header>
  )
}
