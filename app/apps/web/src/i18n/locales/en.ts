import type { Dict } from './zh-CN'

import { apiTree } from './en/api-tree'
import { commandPalette } from './en/command-palette'
import { common } from './en/common'
import { contextmenu } from './en/contextmenu'
import { editor } from './en/editor'
import { errors } from './en/errors'
import { history } from './en/history'
import { historyDetail } from './en/history-detail'
import { keybindings } from './en/keybindings'
import { response } from './en/response'
import { settings } from './en/settings'
import { shell } from './en/shell'
import { statusBar } from './en/status-bar'
import { sync } from './en/sync'
import { tabs } from './en/tabs'
import { variables } from './en/variables'
import { workspace } from './en/workspace'
import { workspaceSettings } from './en/workspace-settings'
import { workflows } from './en/workflows'

/**
 * 英文字典聚合 barrel：`satisfies Dict`（= DictShape<typeof zhCN>）结构同构约束——
 * 缺译（少键）/ 多译（多键）/ 结构漂移（string 处写对象、复数节点变普通串）均编译失败，
 * 键结构随 zh-CN 基准单点演进。复数节点可写 one 形态（英文 count===1 分支）。
 * 字典按域拆分存放于 en/ 目录（一域一文件，与 zh-CN/ 目录成对）；
 * 新增域时在此与 zh-CN.ts 两侧同步挂载。
 */
export const en = {
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
} as const satisfies Dict
