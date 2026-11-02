import { create } from 'zustand'

import { queryClient } from '@/app/query-client'
import { reportError } from '@/services/error-center'

import { workflowKeys, workflowSave, type WorkflowDto } from './workflow-api'
import type { WorkflowGraph } from './workflow-model'

/**
 * 工作流编辑会话 store（Zustand，按工作流 id 一槽）：编辑期领域图的内存
 * 真相＋脏态＋Undo/Redo 栈。生命周期（资源四问）：
 * - 何时创建：编辑 Tab 首次加载数据后 seed（幂等——已存在的会话不覆盖，
 *   重挂载保留未保存编辑与撤销历史）；
 * - 何时释放：Tab 关闭（含删除联动）discard；其余泄漏路径（切空间后残留）
 *   由编辑器挂载期的对账清扫兜底（纯内存 JSON，无系统资源）；
 * - 保存：saveSession 经 IPC 落库后失效 load 查询缓存（防重开播种旧图）
 *   并清脏；失败保持脏态并统一报错；
 * - 关闭确认：TabBar 关闭路径读 dirty 决定是否弹确认（保存并关闭 /
 *   不保存关闭 / 取消）。
 * 非激活 Tab 的组件树已卸载，编辑态留在此处——切 Tab 回来不丢。
 *
 * Undo/Redo（有界缓冲纪律）：栈上限 UNDO_MAX_ENTRIES，超限丢最旧；
 * 合并窗（同 label 且间隔 < UNDO_COALESCE_MS）只作用于显式声明的连续
 * 通道——节点内逐键配置编辑（coalesce=true），高频 tick 折算一条；
 * 结构操作（增删 / 连线 / 粘贴 / 自动布局）每次独立成条；拖动收口
 * （commitSnapshot）按快照引用去重——均不吞用户步骤。
 * 跨保存边界：保存不清栈；撤销已保存的编辑重新标脏（回到未保存态），
 * 再保存即落库——保存点不是撤销墙。
 */

/** undo 栈上限（编辑操作条数；超限丢最旧） */
export const UNDO_MAX_ENTRIES = 100

/** 连续配置编辑合并窗（ms；节点内逐键通道在此窗内只算一次编辑） */
export const UNDO_COALESCE_MS = 800

export interface WorkflowEditorSession {
  workflowId: string
  name: string
  graph: WorkflowGraph
  dirty: boolean
  /** 撤销栈（变更前快照；有界） */
  past: WorkflowGraph[]
  /** 重做栈（被撤销的图；undo 之外的一切新编辑清空） */
  future: WorkflowGraph[]
  /** 连续编辑合并窗锚点（null＝下一条编辑必推栈） */
  lastCommit: { label: string; at: number } | null
}

interface WorkflowEditorState {
  sessions: Record<string, WorkflowEditorSession>
  /** 编辑 Tab 数据就绪后播种（幂等：已有会话不覆盖，保留未保存编辑） */
  seed: (dto: WorkflowDto) => void
  /** Tab 关闭 / 删除联动清理（释放内存会话；不碰已保存数据） */
  discard: (workflowId: string) => void
  /**
   * 画布结构变更写回并记一条撤销（标脏、清重做栈）。合并语义显式声明：
   * coalesce=true（节点内配置编辑等逐键高频通道）时同 label 且在
   * 合并窗内的连续调用折算一条；结构操作（增删 / 连线 / 粘贴 / 布局）
   * 传缺省 false，每次独立成条（不吞用户步骤）。
   */
  commitGraph: (workflowId: string, graph: WorkflowGraph, label: string, coalesce?: boolean) => void
  /**
   * 拖动收口：拖动过程已由 applyGraph 落定，结束时把拖动前快照补记为
   * 一条撤销（位置未变不记、不脏）。与 commitGraph 的差异＝图已就位，
   * 只补推栈。去重只认快照引用——一次手势对多节点的重复收口不重复
   * 推栈；两次独立拖动即使紧邻也各成一条（undo 一步只回退一步）。
   */
  commitSnapshot: (workflowId: string, snapshot: WorkflowGraph) => void
  /** 不记撤销的写回（拖动过程、undo/redo 恢复后的视图对齐路径） */
  applyGraph: (workflowId: string, graph: WorkflowGraph) => void
  /** 撤销：返回恢复到的图（栈空返回 null；恢复即标脏） */
  undo: (workflowId: string) => WorkflowGraph | null
  /** 重做：返回恢复到的图（栈空返回 null；恢复即标脏） */
  redo: (workflowId: string) => WorkflowGraph | null
  /** 是否可撤销 / 可重做（工具栏与命令门控） */
  canUndo: (workflowId: string) => boolean
  canRedo: (workflowId: string) => boolean
  /** 重命名同步（改名 mutation 成功后调用；仅影响工具栏显示名） */
  renameSession: (workflowId: string, name: string) => void
  /**
   * 保存（IPC 落库＋失效 load 缓存＋清脏；失败保持脏态，错误统一上报）。
   * 返回是否落库成功（无会话视为无需保存＝true）——调用方以它决定后续
   * 依赖落库态的动作（如运行）是否继续。
   */
  saveSession: (workflowId: string) => Promise<boolean>
  /** 挂载期对账清扫：丢弃不在存活 Tab 清单里的会话 */
  gcSessions: (aliveWorkflowIds: readonly string[]) => void
}

/** 推栈（有界：超限丢最旧）；撤销必清重做，由调用方语义保证 */
function pushPast(past: WorkflowGraph[], snapshot: WorkflowGraph): WorkflowGraph[] {
  const next = [...past, snapshot]
  return next.length > UNDO_MAX_ENTRIES ? next.slice(next.length - UNDO_MAX_ENTRIES) : next
}

/** 连续编辑判定：同 label 且距上次提交未出合并窗（高频通道合并为一条） */
function shouldCoalesce(
  lastCommit: WorkflowEditorSession['lastCommit'],
  label: string,
  now: number,
): boolean {
  return lastCommit !== null && lastCommit.label === label && now - lastCommit.at < UNDO_COALESCE_MS
}

export const useWorkflowEditorStore = create<WorkflowEditorState>((set, get) => ({
  sessions: {},

  seed: (dto) => {
    set((state) => {
      if (state.sessions[dto.id]) return state
      return {
        sessions: {
          ...state.sessions,
          [dto.id]: {
            workflowId: dto.id,
            name: dto.name,
            graph: dto.graph,
            dirty: false,
            past: [],
            future: [],
            lastCommit: null,
          },
        },
      }
    })
  },

  discard: (workflowId) => {
    set((state) => {
      if (!(workflowId in state.sessions)) return state
      const sessions = { ...state.sessions }
      delete sessions[workflowId]
      return { sessions }
    })
  },

  commitGraph: (workflowId, graph, label, coalesce = false) => {
    set((state) => {
      const session = state.sessions[workflowId]
      if (!session) return state
      const now = Date.now()
      const merge = coalesce && shouldCoalesce(session.lastCommit, label, now)
      return {
        sessions: {
          ...state.sessions,
          [workflowId]: {
            ...session,
            graph,
            dirty: true,
            past: merge ? session.past : pushPast(session.past, session.graph),
            future: [],
            lastCommit: { label, at: now },
          },
        },
      }
    })
  },

  commitSnapshot: (workflowId, snapshot) => {
    set((state) => {
      const session = state.sessions[workflowId]
      if (!session) return state
      // 位置未变（点击式拖动 / 回原位）不产生撤销条目、不标脏；同一快照
      // 引用的重复收口（一次手势对多节点各发一次 dragStop）不重复推栈。
      // 独立拖动的快照各不相同，即使紧邻提交也各成一条
      if (session.graph === snapshot) return state
      if (snapshot === session.past[session.past.length - 1]) return state
      return {
        sessions: {
          ...state.sessions,
          [workflowId]: {
            ...session,
            past: pushPast(session.past, snapshot),
            future: [],
          },
        },
      }
    })
  },

  applyGraph: (workflowId, graph) => {
    set((state) => {
      const session = state.sessions[workflowId]
      if (!session) return state
      return {
        sessions: {
          ...state.sessions,
          [workflowId]: { ...session, graph, dirty: true },
        },
      }
    })
  },

  undo: (workflowId) => {
    const session = get().sessions[workflowId]
    if (!session || session.past.length === 0) return null
    const previous = session.past[session.past.length - 1]
    set((state) => ({
      sessions: {
        ...state.sessions,
        [workflowId]: {
          ...session,
          graph: previous,
          dirty: true,
          past: session.past.slice(0, -1),
          future: [...session.future, session.graph],
          lastCommit: null,
        },
      },
    }))
    return previous
  },

  redo: (workflowId) => {
    const session = get().sessions[workflowId]
    if (!session || session.future.length === 0) return null
    const next = session.future[session.future.length - 1]
    set((state) => ({
      sessions: {
        ...state.sessions,
        [workflowId]: {
          ...session,
          graph: next,
          dirty: true,
          past: [...session.past, session.graph],
          future: session.future.slice(0, -1),
          lastCommit: null,
        },
      },
    }))
    return next
  },

  canUndo: (workflowId) => (get().sessions[workflowId]?.past.length ?? 0) > 0,
  canRedo: (workflowId) => (get().sessions[workflowId]?.future.length ?? 0) > 0,

  renameSession: (workflowId, name) => {
    set((state) => {
      const session = state.sessions[workflowId]
      if (!session) return state
      return {
        sessions: {
          ...state.sessions,
          [workflowId]: { ...session, name },
        },
      }
    })
  },

  saveSession: async (workflowId) => {
    const session = get().sessions[workflowId]
    if (!session) return true
    try {
      await workflowSave(workflowId, session.graph)
    } catch (error) {
      reportError(error)
      return false
    }
    // 保存成功即失效 load 查询缓存：重开 Tab 时 seed 必须读到新图，
    // 否则旧缓存先播种（seed 幂等不覆盖）会造成画布回退且脏态丢失
    void queryClient.invalidateQueries({ queryKey: workflowKeys.load(workflowId) })
    // 保存期间可能有新编辑（applyGraph 置脏）——以保存时点的图为准清脏
    // 会吞掉增量；仅在会话仍指向被保存的图时清脏。撤销栈不清（跨保存
    // 边界可继续撤销，撤销已保存编辑会经 applyGraph 语义重新标脏）
    set((state) => {
      const current = state.sessions[workflowId]
      if (!current || current.graph !== session.graph) return state
      return {
        sessions: {
          ...state.sessions,
          [workflowId]: { ...current, dirty: false },
        },
      }
    })
    return true
  },

  gcSessions: (aliveWorkflowIds) => {
    const alive = new Set(aliveWorkflowIds)
    set((state) => {
      const stale = Object.keys(state.sessions).filter((id) => !alive.has(id))
      if (stale.length === 0) return state
      const sessions = { ...state.sessions }
      for (const id of stale) delete sessions[id]
      return { sessions }
    })
  },
}))
