import type { LucideIcon } from 'lucide-react'

import type { DictKey } from '@/i18n'

/**
 * 命令域类型与加速键纯函数：命令注册表条目、加速键归一化、生效键位解析、
 * 事件匹配与冲突判定。全部为无副作用纯函数，可单测。
 *
 * 键位架构（命令注册表＝单一事实源）：
 * - 生效键位＝用户覆盖（settings `keybindings`，null＝显式清空）＞命令默认值；
 * - 加速键字符串形态＝修饰键固定序 `Ctrl+Alt+Shift+Meta` + 主键（如 `Ctrl+Shift+P`）；
 * - `Ctrl+1..9` 参数化族是单条命令（tab.switchByIndex）的默认键位表示，
 *   匹配时展开为九个具体键，用户覆盖后按覆盖的具体键生效。
 */

/** 命令分组枚举（面板与快捷键设置分区共用同一分组；工作台＝主区编辑动作） */
export const COMMAND_GROUPS = [
  'workbench',
  'view',
  'tabs',
  'variables',
  'settings',
  'appearance',
  'focus',
] as const
export type CommandGroupId = (typeof COMMAND_GROUPS)[number]

/** 分组 → 组头字典键（命令面板与快捷键设置分区共用） */
export const COMMAND_GROUP_HEADING_KEYS: Record<CommandGroupId, DictKey> = {
  workbench: 'commandPalette.groupWorkbench',
  view: 'commandPalette.groupView',
  tabs: 'commandPalette.groupTabs',
  variables: 'commandPalette.groupVariables',
  settings: 'commandPalette.groupSettings',
  appearance: 'commandPalette.groupAppearance',
  focus: 'commandPalette.groupFocus',
}

export interface CommandDef {
  /** 点分命名空间 id（覆盖表与注册表的键） */
  id: string
  /** 命令名（UiText 字典键，面板与设置分区经 t() 呈现） */
  labelKey: DictKey
  icon?: LucideIcon
  group: CommandGroupId
  /** 默认键位（加速键字符串；参数化族＝`Ctrl+1..9`） */
  defaultShortcut?: string
  /**
   * 别名键位（具体键，如重做的 `Ctrl+Y`）：仅在用户未覆盖该命令键位时
   * 参与事件匹配——覆盖表是生效键位的完整定义，覆盖 / 清空后别名一并
   * 失效。不进命令面板与快捷键设置展示（主键位单值口径不变），不参与
   * 冲突判定（别名是注册表的新增占用，挂载前已确保无既有命令争用）。
   */
  aliasShortcuts?: readonly string[]
  /**
   * 输入焦点让键（声明项）：true＝焦点在文本输入控件（input / textarea /
   * contenteditable）时本命令键位让位原生文本编辑，统一分发器跳过不吞键。
   * 由分发器单点执行，when 不必重复声明；复制粘贴 / 撤销重做等与原生文本
   * 编辑争用键位的命令必须声明。
   */
  yieldsToTextInput?: boolean
  /** 可见性与可执行门（false＝面板与分发器都跳过） */
  when?: () => boolean
  /** 执行（参数化族携带序号 1..9；普通命令无参） */
  run: (arg?: number) => void
}

/** 参数化族（tab.switchByIndex 默认键位）的表示形态 */
export const PARAMETERIZED_FAMILY = 'Ctrl+1..9'

/** settings `keybindings` 的覆盖表形态：仅存覆盖项，null＝显式清空 */
export type KeybindingsOverrides = Record<string, string | null>

/** 命名主键白名单（单字符外的可绑定键）；其余命名键不作命令主键 */
const NAMED_KEYS = new Set([
  'Enter',
  'Escape',
  'Backspace',
  'Delete',
  'Insert',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Space',
])

/** 键盘事件 key → 加速键主键部分：字母大写化；F1–F12 与命名键原样 */
function normalizeEventKey(key: string): string | null {
  if (key.length === 1) {
    if (key === ' ') return 'Space'
    return key.toUpperCase()
  }
  if (/^F([1-9]|1[0-2])$/.test(key)) return key
  if (NAMED_KEYS.has(key)) return key
  return null
}

/**
 * 键盘事件 → 加速键字符串；不可绑定的按键返回 null。
 * 纯字符键（无修饰键）＝普通打字，不当命令键位（F 键除外）。
 */
export function eventToAccelerator(event: KeyboardEvent): string | null {
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Meta')
  const key = normalizeEventKey(event.key)
  if (key === null) return null
  parts.push(key)
  if (parts.length === 1 && !/^F([1-9]|1[0-2])$/.test(key)) return null
  return parts.join('+')
}

/** 生效键位＝覆盖（undefined=未覆盖 → 默认值；null=已清空）＞默认值 */
export function effectiveShortcut(
  cmd: Pick<CommandDef, 'id' | 'defaultShortcut'>,
  overrides: KeybindingsOverrides,
): string | null {
  const override = overrides[cmd.id]
  if (override !== undefined) return override
  return cmd.defaultShortcut ?? null
}

/** 事件与命令的键位匹配：参数化族展开匹配 Ctrl+<1..9>，命中携带序号；
 * 未覆盖时别名键位一并参与匹配（覆盖后别名失效，见 CommandDef 注释） */
export function eventMatchesShortcut(
  cmd: CommandDef,
  overrides: KeybindingsOverrides,
  event: KeyboardEvent,
): { matched: boolean; arg?: number } {
  const accelerator = eventToAccelerator(event)
  if (accelerator === null) return { matched: false }
  if (overrides[cmd.id] === undefined) {
    for (const alias of cmd.aliasShortcuts ?? []) {
      if (alias === accelerator) return { matched: true }
    }
  }
  const effective = effectiveShortcut(cmd, overrides)
  if (!effective) return { matched: false }
  if (effective === PARAMETERIZED_FAMILY) {
    const match = /^Ctrl\+([1-9])$/.exec(accelerator)
    return match ? { matched: true, arg: Number(match[1]) } : { matched: false }
  }
  return { matched: accelerator === effective }
}

/** 冲突判定：两键位是否争用同一按键（参数化族与族内具体键视为冲突） */
export function shortcutsConflict(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  if (a === b) return true
  if (a === PARAMETERIZED_FAMILY && /^Ctrl\+[1-9]$/.test(b)) return true
  if (b === PARAMETERIZED_FAMILY && /^Ctrl\+[1-9]$/.test(a)) return true
  return false
}
