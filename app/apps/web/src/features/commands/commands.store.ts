import { create } from 'zustand'

import type { CommandDef } from './types'

/**
 * 命令注册表（Zustand 单 slice）＝键位与命令面板的单一事实源：
 * 各 feature 挂载注册、卸载清理；注册键幂等覆盖（同 id 旧定义被替换，
 * 重注册不增长）。面板开关状态同域持有（面板本体与 toggle 命令共用）。
 *
 * 资源四问：拥有者＝注册 feature；创建＝挂载；释放＝卸载（unregister）；
 * 泄漏防护＝卸载必删 + 幂等覆盖，注册表不随挂载循环增长。
 */

interface CommandsState {
  commands: CommandDef[]
  /** 命令面板开关（Ctrl+Shift+P 命令与面板本体共用） */
  paletteOpen: boolean
  registerCommands: (defs: CommandDef[]) => void
  unregisterCommands: (ids: string[]) => void
  setPaletteOpen: (open: boolean) => void
}

export const useCommandsStore = create<CommandsState>((set) => ({
  commands: [],
  paletteOpen: false,

  registerCommands: (defs) =>
    set((state) => {
      const others = state.commands.filter((cmd) => !defs.some((def) => def.id === cmd.id))
      return { commands: [...others, ...defs] }
    }),

  unregisterCommands: (ids) =>
    set((state) => ({
      commands: state.commands.filter((cmd) => !ids.includes(cmd.id)),
    })),

  setPaletteOpen: (open) => set({ paletteOpen: open }),
}))
