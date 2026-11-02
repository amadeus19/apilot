import * as React from 'react'

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  toast,
  usePointContextMenu,
} from '@workspace/ui/components'

import { useI18n } from '@/i18n'

/**
 * 全局文本右键菜单：拦截 WebView2 原生右键（返回 / 刷新 / 打印等浏览器项
 * 不符合桌面工具语境，且 wry 不暴露按项过滤能力），只在「文本语境」弹
 * 自绘文本编辑菜单——可编辑元素（输入框 / 文本域 / contenteditable）或
 * 页面存在文本选区时。树行等业务自绘菜单已 preventDefault 的让位，不重复弹。
 *
 * 项目可用性对齐浏览器原生：打开时快照「是否可编辑 / 是否有选区 /
 * 撤销栈是否可用」，据此禁用或隐藏——可编辑无选区禁用剪切与复制，
 * 非可编辑语境只保留复制与全选（撤销 / 剪切 / 粘贴隐藏）。
 *
 * 动作经 document.execCommand（WebView2 在用户手势内支持撤销 / 剪切 /
 * 复制 / 文本插入；编辑面皆纯文本，粘贴即纯文本插入）；菜单打开不转移
 * 输入焦点，但菜单项点击会使焦点落到浮层——执行前先归还记录的目标元素
 * 焦点。粘贴经剪贴板异步读文本后插入（权限被拒时 toast 提示一次）。
 */

/** 打开时的语境快照：菜单开着的期间 DOM 可能变化，可用性以打开时为准 */
interface TextMenuContext {
  /** 焦点宿主（可编辑元素；非可编辑语境为 null），动作执行前归还焦点 */
  target: HTMLElement | null
  editable: boolean
  hasSelection: boolean
  /** 撤销栈有内容（焦点仍在目标元素上时查询才有效，故随打开快照） */
  canUndo: boolean
}

const EDITABLE_SELECTOR = 'input, textarea, [contenteditable="true"], [contenteditable=""]'

/** 可编辑元素的选区判定（input/textarea 走选区端点，contenteditable 走文档选区） */
function hasEditableSelection(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.selectionStart !== el.selectionEnd
  }
  return (window.getSelection()?.toString() ?? '').length > 0
}

/** 焦点归还后执行（execCommand 只作用于焦点元素） */
function runWithFocus(target: HTMLElement | null, action: () => void): void {
  target?.focus()
  action()
}

export function TextContextMenuHost() {
  const { t } = useI18n()
  const menu = usePointContextMenu()
  const [context, setContext] = React.useState<TextMenuContext | null>(null)

  // 全局右键拦截：原生菜单一律不出现；文本语境弹自绘菜单，其余语境无菜单
  React.useEffect(() => {
    const onContextMenu = (event: MouseEvent): void => {
      // 业务自绘菜单（树行等）已处理的事件让位
      if (event.defaultPrevented) return
      event.preventDefault()
      const target = event.target as HTMLElement | null
      const editable = target?.closest<HTMLElement>(EDITABLE_SELECTOR) ?? null
      const hasSelection = editable
        ? hasEditableSelection(editable)
        : (window.getSelection()?.toString() ?? '').length > 0
      if (!editable && !hasSelection) return
      setContext({
        target: editable,
        editable: editable !== null,
        hasSelection,
        // 焦点尚在目标上（打开不转移焦点），此刻查询反映目标的撤销栈
        canUndo: editable !== null && document.queryCommandEnabled('undo'),
      })
      menu.openAt(event.clientX, event.clientY)
    }
    document.addEventListener('contextmenu', onContextMenu)
    return () => document.removeEventListener('contextmenu', onContextMenu)
  }, [menu])

  const pasteFromClipboard = async (): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText()
      runWithFocus(context?.target ?? null, () => {
        document.execCommand('insertText', false, text)
      })
    } catch {
      // 剪贴板读取被拒（权限 / 非文本内容）：明确提示，不静默无效
      toast.error(t('contextmenu.clipboardUnavailable'))
    }
  }

  const target = context?.target ?? null
  const editable = context?.editable ?? false

  const selectAll = (): void => {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.focus()
      target.select()
      return
    }
    // contenteditable 选自身；非可编辑语境全选页面内容（与浏览器原生一致）
    window.getSelection()?.selectAllChildren(target ?? document.body)
  }

  return (
    <ContextMenu open={menu.open} onOpenChange={(open) => !open && menu.close()}>
      <ContextMenuContent anchor={menu.anchor}>
        {editable ? (
          <>
            <ContextMenuItem
              disabled={!context?.canUndo}
              onClick={() => runWithFocus(target, () => document.execCommand('undo'))}
            >
              {t('contextmenu.undo')}
              <ContextMenuShortcut>Ctrl+Z</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              disabled={!context?.hasSelection}
              onClick={() => runWithFocus(target, () => document.execCommand('cut'))}
            >
              {t('contextmenu.cut')}
              <ContextMenuShortcut>Ctrl+X</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!context?.hasSelection}
              onClick={() => runWithFocus(target, () => document.execCommand('copy'))}
            >
              {t('contextmenu.copy')}
              <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => void pasteFromClipboard()}>
              {t('contextmenu.paste')}
              <ContextMenuShortcut>Ctrl+V</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={selectAll}>
              {t('contextmenu.selectAll')}
              <ContextMenuShortcut>Ctrl+A</ContextMenuShortcut>
            </ContextMenuItem>
          </>
        ) : (
          <>
            <ContextMenuItem onClick={() => runWithFocus(null, () => document.execCommand('copy'))}>
              {t('contextmenu.copy')}
              <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={selectAll}>
              {t('contextmenu.selectAll')}
              <ContextMenuShortcut>Ctrl+A</ContextMenuShortcut>
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
