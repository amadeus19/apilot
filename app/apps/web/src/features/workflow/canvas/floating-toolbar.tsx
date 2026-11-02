import * as React from 'react'

import { useReactFlow } from '@xyflow/react'
import {
  CopyIcon,
  CrosshairIcon,
  MapIcon,
  PlayIcon,
  PlusIcon,
  Redo2Icon,
  SaveIcon,
  SquareIcon,
  Undo2Icon,
  WandSparklesIcon,
} from 'lucide-react'

import { cn } from 'cn'

import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components'

import { useI18n } from '@/i18n'

import { useWorkflowEditorStore } from '../workflow-editor.store'

/**
 * 悬浮工具栏（画布底部居中，Postman Flow 式）：运行/停止是唯一实心按钮，
 * 其余动作收成图标钮＋Tooltip；「添加节点」带可见文字，承担左栏节点面板
 * 消失后的可发现性。工具栏是画布上的浮件（与缩放控件 / 小地图同类），
 * 边界内允许投影——不改变面板「边框优先」的分工。
 */

export function FloatingToolbar({
  workflowId,
  dirty,
  running,
  canUndo,
  canRedo,
  onRun,
  onStop,
  onUndo,
  onRedo,
  onCopy,
  onAutoLayout,
  minimapOpen,
  onToggleMinimap,
  onAddNode,
}: {
  workflowId: string
  dirty: boolean
  running: boolean
  canUndo: boolean
  canRedo: boolean
  onRun: () => void
  onStop: () => void
  onUndo: () => void
  onRedo: () => void
  onCopy: () => void
  onAutoLayout: () => void
  minimapOpen: boolean
  onToggleMinimap: () => void
  onAddNode: () => void
}) {
  const { t } = useI18n()
  const saveSession = useWorkflowEditorStore((s) => s.saveSession)
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3">
      <div
        className="pointer-events-auto flex items-center gap-0.5 rounded-lg border bg-card/95 p-1 shadow-lg backdrop-blur"
        data-testid="workflow-editor-toolbar"
      >
        <ToolbarIconButton
          label={t('workflows.toolbarUndo')}
          hint={canUndo ? t('workflows.toolbarUndoHint') : null}
          disabled={!canUndo}
          onClick={onUndo}
          testId="workflow-undo"
        >
          <Undo2Icon aria-hidden className="size-3.5" />
        </ToolbarIconButton>
        <ToolbarIconButton
          label={t('workflows.toolbarRedo')}
          hint={canRedo ? t('workflows.toolbarRedoHint') : null}
          disabled={!canRedo}
          onClick={onRedo}
          testId="workflow-redo"
        >
          <Redo2Icon aria-hidden className="size-3.5" />
        </ToolbarIconButton>
        <ToolbarIconButton
          label={t('workflows.toolbarSave')}
          hint={dirty ? t('workflows.toolbarSaveDirtyLabel') : null}
          disabled={!dirty}
          primary={dirty}
          onClick={() => void saveSession(workflowId)}
          testId="workflow-save"
        >
          <SaveIcon aria-hidden className="size-3.5" />
        </ToolbarIconButton>
        <ToolbarIconButton
          label={t('workflows.toolbarCopy')}
          hint={t('workflows.toolbarCopyHint')}
          onClick={onCopy}
          testId="workflow-copy-workflow"
        >
          <CopyIcon aria-hidden className="size-3.5" />
        </ToolbarIconButton>
        <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
        <ToolbarIconButton
          label={t('workflows.toolbarAutoLayout')}
          hint={t('workflows.toolbarAutoLayoutHint')}
          onClick={onAutoLayout}
          testId="workflow-auto-layout"
        >
          <WandSparklesIcon aria-hidden className="size-3.5" />
        </ToolbarIconButton>
        <ToolbarIconButton
          label={t('workflows.toolbarMinimap')}
          hint={minimapOpen ? t('workflows.toolbarMinimapOn') : t('workflows.toolbarMinimapOff')}
          pressed={minimapOpen}
          primary={minimapOpen}
          onClick={onToggleMinimap}
          testId="workflow-minimap-toggle"
        >
          <MapIcon aria-hidden className="size-3.5" />
        </ToolbarIconButton>
        <FitViewButton />
        <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                onClick={onAddNode}
                aria-label={t('workflows.toolbarAddNode')}
                data-testid="workflow-add-node"
                className="h-8 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <PlusIcon aria-hidden className="size-3.5" />
                {t('workflows.toolbarAddNode')}
              </Button>
            }
          />
          <TooltipContent>{t('workflows.toolbarAddNodeHint')}</TooltipContent>
        </Tooltip>
        {running ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="destructive"
                  size="sm"
                  className="ml-0.5 h-8 gap-1.5 px-3.5"
                  onClick={onStop}
                  aria-label={t('workflows.toolbarStop')}
                  data-testid="workflow-stop"
                >
                  <SquareIcon aria-hidden className="size-3.5" />
                  {t('workflows.toolbarStop')}
                </Button>
              }
            />
            <TooltipContent>{t('workflows.toolbarStopHint')}</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  className="ml-0.5 h-8 gap-1.5 px-3.5"
                  onClick={onRun}
                  aria-label={t('workflows.toolbarRun')}
                  data-testid="workflow-run"
                >
                  <PlayIcon aria-hidden className="size-3.5" />
                  {t('workflows.toolbarRun')}
                </Button>
              }
            />
            <TooltipContent>{t('workflows.toolbarRunHint')}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
}

/** 工具栏图标钮：语义全走 aria-label 与 Tooltip（图标钮没有可见文字，
 * 可访问名必须有）；hint 为空时只回显标签。 */
function ToolbarIconButton({
  label,
  hint,
  disabled,
  pressed,
  primary,
  onClick,
  testId,
  children,
}: {
  label: string
  /** Tooltip 正文（动作说明 / 快捷键）；null＝只显标签 */
  hint?: string | null
  disabled?: boolean
  pressed?: boolean
  /** 常开态（小地图开、保存脏态）用主色图标，不做填充 */
  primary?: boolean
  onClick: () => void
  testId: string
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            aria-label={label}
            aria-pressed={pressed}
            onClick={onClick}
            data-testid={testId}
            className={cn('text-muted-foreground hover:text-foreground', primary && 'text-primary')}
          >
            {children}
          </Button>
        }
      />
      <TooltipContent>{hint || label}</TooltipContent>
    </Tooltip>
  )
}

/** 适配视图（React Flow 命令须在 Provider 内） */
function FitViewButton() {
  const { t } = useI18n()
  const { fitView } = useReactFlow()
  return (
    <ToolbarIconButton
      label={t('workflows.toolbarFitView')}
      onClick={() => void fitView({ padding: 0.2, duration: 200 })}
      testId="workflow-fit-view"
    >
      <CrosshairIcon aria-hidden className="size-3.5" />
    </ToolbarIconButton>
  )
}
