/**
 * 基准语言字典（zh-CN）聚合 barrel：全项目 UI 文案的唯一样本，
 * en 字典与其结构同构（en.ts satisfies DictShape，缺译/多译/结构漂移 = 编译错误）。
 *
 * 字典按域拆分存放于 zh-CN/ 目录（一域一文件，en/ 目录成对）；本文件聚合为
 * 完整字典 zhCN，新增域时在此与 en.ts 两侧同步挂载。
 *
 * 键规范：嵌套对象 + 点号路径、功能域前缀、层级 ≤3、键名描述语义恒英文小写。
 * 例外：`errors` 域的键 = AppError 稳定 code 原样（大写下划线，映射协议要求直查）。
 *
 * 恒不翻译内容不进字典：方法/状态码/Header 名、URL、JSON、业务数据、
 * 面板标签 Body/Headers、符号 ms/s/KB/MB、「Workflow」领域名。
 */

import { apiTree } from './zh-CN/api-tree'
import { commandPalette } from './zh-CN/command-palette'
import { common } from './zh-CN/common'
import { contextmenu } from './zh-CN/contextmenu'
import { editor } from './zh-CN/editor'
import { errors } from './zh-CN/errors'
import { history } from './zh-CN/history'
import { historyDetail } from './zh-CN/history-detail'
import { keybindings } from './zh-CN/keybindings'
import { response } from './zh-CN/response'
import { settings } from './zh-CN/settings'
import { shell } from './zh-CN/shell'
import { statusBar } from './zh-CN/status-bar'
import { sync } from './zh-CN/sync'
import { tabs } from './zh-CN/tabs'
import { variables } from './zh-CN/variables'
import { workspace } from './zh-CN/workspace'
import { workspaceSettings } from './zh-CN/workspace-settings'
import { workflows } from './zh-CN/workflows'

/**
 * 基准形状类型：键结构逐层保留，string 字面量值放宽为 string；
 * 复数节点（含 other 键的叶对象）放宽为 `{ one?; other }`——zh-CN 只写 other、
 * en 可补 one 形态而不触发多译报错。Phase 1 字典分组对象不含 other 键，特判安全。
 */
export type DictShape<T> = T extends string
  ? string
  : T extends { other: string }
    ? { one?: string; other: string }
    : { [K in keyof T]: DictShape<T[K]> }

/** 叶子路径元组收集：string 与复数节点为叶子，分组对象继续下钻 */
type LeavesOf<T> = T extends string
  ? readonly []
  : T extends { other: string }
    ? readonly []
    : { [K in keyof T & string]: readonly [K, ...LeavesOf<T[K]>] }[keyof T & string]

type JoinPath<T extends readonly unknown[]> = T extends readonly [infer F extends string]
  ? F
  : T extends readonly [infer F extends string, ...infer R]
    ? R extends readonly unknown[]
      ? `${F}.${JoinPath<R>}`
      : never
    : never

export const zhCN = {
  common,
  shell,
  tabs,
  commandPalette,
  contextmenu,
  keybindings,
  editor,
  response,
  history,
  historyDetail,
  workspaceSettings,
  apiTree,
  statusBar,
  settings,
  errors,
  variables,
  workspace,
  sync,
  workflows,
} as const

/** 全部合法键的点号路径联合（t() 的 key 参数类型，写错键 = 编译错误） */
export type DictKey = JoinPath<LeavesOf<typeof zhCN>>

/** 基准形状实例（zhCN 同文件内做 typeof，en 侧 import type 即得，无需值引用） */
export type Dict = DictShape<typeof zhCN>
