import * as React from 'react'

import { useCommandsStore } from './commands.store'
import type { CommandDef } from './types'

/**
 * 命令注册 hook：挂载注册、卸载清理（资源四问闭环）。
 * 命令定义经 ref 透传——重渲染更新定义内容（run 闭包等）不重置注册表，
 * 依赖数组变化（feature 生命周期事件）才执行注册/清理对。
 */
export function useRegisterCommands(defs: CommandDef[], deps: React.DependencyList): void {
  const defsRef = React.useRef(defs)
  defsRef.current = defs

  React.useEffect(() => {
    const current = defsRef.current
    useCommandsStore.getState().registerCommands(current)
    return () => {
      useCommandsStore.getState().unregisterCommands(current.map((def) => def.id))
    }
    // 依赖由调用方声明（命令定义通常静态；随 feature 状态变化的命令显式给 deps）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
