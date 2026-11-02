import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  type PointAnchor,
} from '@workspace/ui/components'

import { useI18n } from '@/i18n'

/**
 * 画布右键菜单（节点 / 边）：受控 ContextMenu＋坐标锚点（usePointContextMenu
 * 形态，浮层在右键坐标展开，Esc / 点外关闭与键盘导航由菜单原语承载）。
 * 空白面的右键归节点选择面板（NodePicker）：节点清单与空白面动作在同一个
 * 浮层里，画布不再常驻左栏节点面板。
 *
 * 菜单零业务：项集与作用域由打开时的 target 快照决定，动作经回调交回
 * 编辑器（复制 / 粘贴 / 删除全部复用编辑器既有命令路径）；多选语义按 IDE
 * 惯例在编辑器侧收口——右键命中节点已在选中集内则动作作用于整个选中集，
 * 不在则先单选命中节点再作用于它。
 *
 * 键位提示：复制 / 粘贴 / 删除是画布组件交互原语（不经命令注册表——
 * 注册表键位无输入焦点守卫，会劫持节点内输入框），提示按画布键位字面。
 * 重命名项把命中节点带进名称编辑态（与 F2 同一编辑器动作）。重接项仅在
 * 失效请求节点上出现（rebindNodeId 由编辑器按校验失效集派生），动作为
 * 引导提示——重接本体是接口树拖入（唯一绑定路径），菜单只负责告知。
 */

/** 右键目标快照：菜单打开期间动作与项集的作用对象 */
export type CanvasMenuTarget = { kind: 'node'; nodeId: string } | { kind: 'edge'; edgeId: string }

export interface CanvasContextMenuProps {
  open: boolean
  anchor: PointAnchor | undefined
  target: CanvasMenuTarget | null
  /** 失效请求节点 id（节点右键且命中失效请求节点时非空，控制重接项显隐） */
  rebindNodeId: string | null
  onClose: () => void
  /** 复制当前选中集（节点菜单） */
  onCopy: () => void
  /** 粘贴画布剪贴板（节点菜单） */
  onPaste: () => void
  /** 删除当前 target：节点菜单删选中集，边菜单删命中边 */
  onDelete: () => void
  /** 重命名命中节点：进入名称编辑态（与 F2 同一动作） */
  onRename: () => void
  /** 重接引导提示（失效请求节点菜单） */
  onRebindHint: () => void
}

export function CanvasContextMenu({
  open,
  anchor,
  target,
  rebindNodeId,
  onClose,
  onCopy,
  onPaste,
  onDelete,
  onRename,
  onRebindHint,
}: CanvasContextMenuProps) {
  const { t } = useI18n()
  return (
    <ContextMenu open={open} onOpenChange={(next) => !next && onClose()}>
      <ContextMenuContent anchor={anchor}>
        {target?.kind === 'node' && (
          <>
            <ContextMenuItem onClick={onCopy}>
              {t('workflows.canvasMenuCopy')}
              <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onClick={onPaste}>
              {t('workflows.canvasMenuPaste')}
              <ContextMenuShortcut>Ctrl+V</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onClick={onRename}>
              {t('workflows.canvasMenuRename')}
              <ContextMenuShortcut>F2</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={onDelete}>
              {t('workflows.canvasMenuDelete')}
              <ContextMenuShortcut>Delete</ContextMenuShortcut>
            </ContextMenuItem>
            {rebindNodeId != null && (
              <ContextMenuItem onClick={onRebindHint}>
                {t('workflows.canvasMenuRebind')}
              </ContextMenuItem>
            )}
          </>
        )}
        {target?.kind === 'edge' && (
          <ContextMenuItem variant="destructive" onClick={onDelete}>
            {t('workflows.canvasMenuDelete')}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
