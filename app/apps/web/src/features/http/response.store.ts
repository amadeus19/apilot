import { create } from 'zustand'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { useTabsStore } from '@/stores/tabs.store'
import { toIpcError } from '@/services/ipc'
import { httpCancel, httpTabClosed, invalidateHistory, sseStart } from './http-api'
import { SSE_BUFFER_MAX_CHARS } from './constants'
import { finishSendPhase, type RunOutcome, type SendPhase } from './send-state'
import type { RunResultDto, SendArgs, SseEventDto, SseMetaDto, SseUpgradeDto } from './http-api'

/**
 * 响应面板 store：按 tabId 记最近一次发送（phase＋可展示结果）与 SSE 流
 * 的渐进缓冲。渲染层（ResponsePane、编辑器发送按钮）从这里读，发起与
 * 终态写入也收口在这里。
 *
 * 资源四问（SSE 监听器）：
 * - 谁拥有：本模块（监听句柄表 sseListeners）；不归组件——响应面板折叠会
 *   卸载内容组件，归组件会让折叠等于杀流，违背折叠语义；store 层持有则
 *   折叠 / 切 Tab 期间流继续接收，回面板即见。
 * - 何时创建：sse.start 返回流 id 后 listen 注册（句柄进表）；普通发送的
 *   事件流升级（sse-upgrade 告知）落地时同表挂 sse:// 增量句柄。
 * - 何时释放：终态事件（done / cancelled / error）到达即 unlisten；同 Tab
 *   新流启动先摘旧句柄；Tab 关闭（tabs 集合收缩）同步摘除并触发关 Tab 清理。
 * - 异常兜底：后端保证任务链结束必发终态事件；Tab 关闭路径不依赖事件
 *   到达（订阅清理直接 unlisten＋http.tab_closed：取消在途＋删临时文件）。
 *
 * 资源四问（SSE 升级预登记监听，upgradeListeners）：
 * - 谁拥有：本模块（与 sseListeners 同纪律的两张表）。
 * - 何时创建：普通发送编排（runSend）在 http.send invoke 发起前注册
 *   `sse-upgrade://<tabId>`（时序前提：监听先于响应头到达）。
 * - 何时释放：发送落定（finishSend / failSend）即摘；新发送清场（beginSend）
 *   与关 Tab 收缩同步摘除；代际标记（upgradeEpoch）使清场后迟到的注册
 *   句柄与回调失效。
 * - 异常兜底：注册失败静默降级（升级是尽力增强，不阻断发送）；后端告知
 *   事件至多一次，摘除后到达即无回调可触发。
 *
 * 「面板不被取消清空」：cancelled 与 invoke 层失败均保留上一个可展示
 * result（响应面板保留上次内容不清空）；只有 passed /
 * failed 的新结果才覆盖。
 */

export type SsePhase = 'streaming' | 'done' | 'cancelled' | 'error'

/** Body 视图模式（Pretty / Raw / Preview；恒英文原样展示，此处只作判别值） */
export type BodyViewMode = 'pretty' | 'raw' | 'preview'

export interface SseStreamState {
  /** 空串＝sse.start 尚未返回（事件不可能到达的占位态） */
  streamId: string
  phase: SsePhase
  /** 尾部缓冲文本（上限 SSE_BUFFER_MAX_CHARS 字符，超出丢弃头部） */
  text: string
  /** 累计已收字符数（不受缓冲裁剪影响；展示已接收量） */
  receivedChars: number
  meta: SseMetaDto | null
  error: { code: string; message: string } | null
}

export interface ResponseEntry {
  phase: SendPhase
  /** 最近可展示结果：passed / failed 覆盖；cancelled 与 invoke 失败保留旧值 */
  result: RunResultDto | null
  /** invoke 层失败信息（请求未发出：SHUTDOWN_IN_PROGRESS 等；渲染优先走错误卡） */
  error: { code: string; message: string } | null
  /** sending 起点（状态行实时累计耗时用；也是跨挂载恢复的计时基准——
   *  切 Tab 卸载编辑器 / 响应区后重挂，从此时间戳续算，不重新计时） */
  startedAt: number | null
}

interface ResponseState {
  entries: Record<string, ResponseEntry>
  streams: Record<string, SseStreamState>
  /** Body 视图 Pretty / Raw 偏好（per-tab）：跨请求保留（新 runId 不重置），
   *  随 Tab 关闭清理——用户对「怎么看响应体」的期望不随每次发送改变 */
  bodyModes: Record<string, BodyViewMode>
  /** 写入 Body 视图偏好（渲染层 Tabs 切换时调用；写入即持久到 Tab 生命周期尾） */
  setBodyMode: (tabId: string, mode: BodyViewMode) => void
  /** 进入 sending（保留旧 result；同时在途流缓冲清场——新发送替换流视图） */
  beginSend: (tabId: string) => void
  /** http.send 落定：passed / failed 覆盖 result，cancelled 保留旧 result */
  finishSend: (tabId: string, result: RunResultDto) => void
  /** invoke 层失败（请求未发出）：phase=failed＋错误信息，保留旧 result */
  failSend: (tabId: string, error: { code: string; message: string }) => void
  /** 普通发送的 SSE 升级预登记：注册 `sse-upgrade://<tabId>` 监听（须在
   *  http.send invoke 发起前完成——响应头到达早于任何前端轮询的时序前提） */
  armSseUpgrade: (tabId: string) => Promise<void>
  /** 「流式」重放：sse.start＋监听注册（同 Tab 旧流先摘除） */
  startStream: (tabId: string, args: SendArgs) => Promise<void>
  /** 停止流＝http.cancel（终态经 cancelled 事件回写） */
  stopStream: (tabId: string) => void
}

/** Tab 是否仍打开（终态写入守卫：关 Tab 后到达的结果不再入表） */
function isTabAlive(tabId: string): boolean {
  return useTabsStore.getState().tabs.some((tab) => tab.id === tabId)
}

// —— SSE 监听句柄表（模块级，非序列化资源不入 store state） ——

const sseListeners = new Map<string, UnlistenFn>()

/** 摘除监听句柄（幂等；不动条目数据——终态展示要留） */
function disposeListener(tabId: string): void {
  const unlisten = sseListeners.get(tabId)
  if (unlisten) {
    unlisten()
    sseListeners.delete(tabId)
  }
}

// —— SSE 升级预登记句柄表（普通发送的事件流升级监听） ——

const upgradeListeners = new Map<string, UnlistenFn>()
/** 升级预登记代际（同 Tab 新发送 / 清场使旧代迟到句柄与回调失效） */
const upgradeEpoch = new Map<string, unknown>()

/** 摘除升级预登记（幂等；随监听句柄一并作废代际标记） */
function disposeUpgradeListener(tabId: string): void {
  const unlisten = upgradeListeners.get(tabId)
  if (unlisten) {
    unlisten()
    upgradeListeners.delete(tabId)
  }
  upgradeEpoch.delete(tabId)
}

/**
 * SSE 升级落地：普通发送（http.send）命中事件流响应时后端推
 * `sse-upgrade://<tabId>`，据此建立流条目（meta 即时展示状态码）并挂
 * `sse://<streamId>` 增量监听——sse-panel 发送中即以 streaming 相渲染。
 * 终态事件经 applySseEvent 落地（与重放路径同链路）；http.send 返回后
 * 由 finishSend / failSend 收场（条目摘除，终态展示回三分区）。
 */
async function settleSseUpgrade(tabId: string, payload: SseUpgradeDto): Promise<void> {
  if (!isTabAlive(tabId)) return
  disposeListener(tabId) // 防御：升级前该 Tab 不应有流（重放与普通发送同键互斥）
  useResponseStore.setState((prev) => ({
    streams: {
      ...prev.streams,
      [tabId]: {
        streamId: payload.streamId,
        phase: 'streaming',
        text: '',
        receivedChars: 0,
        meta: payload.meta,
        error: null,
      },
    },
  }))
  try {
    const unlisten = await listen<SseEventDto>(`sse://${payload.streamId}`, (event) => {
      applySseEvent(tabId, payload.streamId, event.payload)
    })
    // 竞速守卫：listen 等待期间被清场 / 新流接管（条目被重置或移除），
    // 迟到的旧句柄立即摘除，不进句柄表
    const current = useResponseStore.getState().streams[tabId]
    if (!current || current.streamId !== payload.streamId) {
      unlisten()
      return
    }
    const prevListener = sseListeners.get(tabId)
    if (prevListener) prevListener()
    sseListeners.set(tabId, unlisten)
  } catch {
    // 增量监听注册失败：保留流条目（终态经 http.send 落定收场），退化为无实时增量
  }
}

/** SSE 事件落地：累计缓冲＋终态转移（事件只属于当前流；终态后的迟到事件丢弃） */
function applySseEvent(tabId: string, streamId: string, payload: SseEventDto): void {
  const stream = useResponseStore.getState().streams[tabId]
  if (!stream || stream.streamId !== streamId || stream.phase !== 'streaming') return

  let text = stream.text + payload.text
  if (text.length > SSE_BUFFER_MAX_CHARS) text = text.slice(text.length - SSE_BUFFER_MAX_CHARS)
  const phase: SsePhase = payload.done
    ? 'done'
    : payload.cancelled
      ? 'cancelled'
      : payload.error !== null
        ? 'error'
        : 'streaming'

  useResponseStore.setState((prev) => ({
    streams: {
      ...prev.streams,
      [tabId]: {
        ...stream,
        text,
        phase,
        receivedChars: stream.receivedChars + payload.text.length,
        meta: payload.meta ?? stream.meta,
        error: payload.error,
      },
    },
  }))

  if (payload.done || payload.cancelled || payload.error !== null) {
    disposeListener(tabId)
    // 发送状态机终态（SSE 也占 sending 位；cancelled 保留旧可展示 result）
    const outcome: RunOutcome = payload.done ? 'passed' : payload.cancelled ? 'cancelled' : 'failed'
    finishPhase(tabId, outcome)
    invalidateHistory()
  }
}

/** phase 终态写入（SSE 终态无 RunResult DTO 回传：可展示 result 恒保留旧值） */
function finishPhase(tabId: string, outcome: RunOutcome): void {
  if (!isTabAlive(tabId)) return
  useResponseStore.setState((prev) => {
    const prevEntry = prev.entries[tabId]
    return {
      entries: {
        ...prev.entries,
        [tabId]: {
          phase: finishSendPhase(outcome),
          result: prevEntry?.result ?? null,
          error: null,
          startedAt: null,
        },
      },
    }
  })
}

export const useResponseStore = create<ResponseState>((set, get) => ({
  entries: {},
  streams: {},
  bodyModes: {},

  setBodyMode: (tabId, mode) => {
    // 活 Tab 才写（关 Tab 竞速下的迟到切换不复活条目）
    if (!isTabAlive(tabId)) return
    set((state) => ({ bodyModes: { ...state.bodyModes, [tabId]: mode } }))
  },

  beginSend: (tabId) => {
    // 在途流清场：新发送替换流视图（监听摘除＋后端任务由同键新任务取消前笔）；
    // 升级预登记一并作废（旧代回调不再响应迟到的升级告知）
    disposeListener(tabId)
    disposeUpgradeListener(tabId)
    set((state) => {
      const streams = { ...state.streams }
      delete streams[tabId]
      const prev = state.entries[tabId]
      return {
        streams,
        entries: {
          ...state.entries,
          [tabId]: {
            phase: 'sending',
            result: prev?.result ?? null,
            error: null,
            startedAt: Date.now(),
          },
        },
      }
    })
  },

  finishSend: (tabId, result) => {
    if (!isTabAlive(tabId)) return
    invalidateHistory()
    // 普通发送落定＝升级流态收场（若命中过事件流响应）：流条目摘除、终态
    // 展示回三分区（重放态不经此路径，其终态由事件侧 finishPhase 承接）
    disposeUpgradeListener(tabId)
    disposeListener(tabId)
    set((state) => {
      const streams = { ...state.streams }
      delete streams[tabId]
      const prev = state.entries[tabId]
      // cancelled：无新响应体，保留旧可展示结果；passed / failed：新结果覆盖
      const kept = result.state === 'cancelled' ? (prev?.result ?? null) : result
      return {
        streams,
        entries: {
          ...state.entries,
          [tabId]: {
            phase: finishSendPhase(result.state),
            result: kept,
            error: null,
            startedAt: null,
          },
        },
      }
    })
  },

  failSend: (tabId, error) => {
    if (!isTabAlive(tabId)) return
    // 升级流态随 invoke 失败一并收场（startStream 失败路径同样无害：其自身
    // 的流条目清场与本处收敛一致）
    disposeUpgradeListener(tabId)
    disposeListener(tabId)
    set((state) => {
      const streams = { ...state.streams }
      delete streams[tabId]
      const prev = state.entries[tabId]
      return {
        streams,
        entries: {
          ...state.entries,
          [tabId]: { phase: 'failed', result: prev?.result ?? null, error, startedAt: null },
        },
      }
    })
  },

  armSseUpgrade: async (tabId) => {
    disposeUpgradeListener(tabId)
    const token = {}
    upgradeEpoch.set(tabId, token)
    try {
      const unlisten = await listen<SseUpgradeDto>(`sse-upgrade://${tabId}`, (event) => {
        // 代际校验：仅本次预登记有效（清场 / 新发送后的迟到告知不响应）
        if (upgradeEpoch.get(tabId) !== token) return
        void settleSseUpgrade(tabId, event.payload)
      })
      // 竞速守卫：listen 等待期间被清场 / 新预登记抢先，迟到句柄立即摘除
      if (upgradeEpoch.get(tabId) !== token) {
        unlisten()
        return
      }
      upgradeListeners.set(tabId, unlisten)
    } catch {
      // 升级是尽力增强：监听注册失败退化为现状（流结束才见结果），不阻断发送
      if (upgradeEpoch.get(tabId) === token) upgradeEpoch.delete(tabId)
    }
  },

  startStream: async (tabId, args) => {
    // 同 Tab 旧流先摘（监听句柄＋缓冲条目重置；后端由同键新任务取消前笔）
    disposeListener(tabId)
    get().beginSend(tabId)
    set((state) => ({
      streams: {
        ...state.streams,
        [tabId]: {
          streamId: '',
          phase: 'streaming',
          text: '',
          receivedChars: 0,
          meta: null,
          error: null,
        },
      },
    }))
    try {
      const { streamId } = await sseStart(args)
      if (!isTabAlive(tabId)) {
        // 等待期间 Tab 已关：取消远端任务并清条目（写入守卫外的事件永远到不了展示层）
        void httpCancel(tabId).catch(() => undefined)
        set((state) => {
          const streams = { ...state.streams }
          delete streams[tabId]
          return { streams }
        })
        return
      }
      const unlisten = await listen<SseEventDto>(`sse://${streamId}`, (event) => {
        applySseEvent(tabId, streamId, event.payload)
      })
      // 竞速守卫：等待 listen 期间可能有更新的流接管（占位被重置），
      // 迟到的旧句柄立即摘除，不进句柄表
      const placeholder = get().streams[tabId]
      if (!placeholder || placeholder.streamId !== '') {
        unlisten()
        return
      }
      const prevListener = sseListeners.get(tabId)
      if (prevListener) prevListener()
      sseListeners.set(tabId, unlisten)
      set((state) => {
        const current = state.streams[tabId]
        if (!current) return state
        return { streams: { ...state.streams, [tabId]: { ...current, streamId } } }
      })
    } catch (raw) {
      // 启动失败（请求未发出）：终态 failed＋错误信息，流条目清场
      const err = toIpcError(raw)
      get().failSend(tabId, { code: err.code, message: err.message })
      set((state) => {
        const streams = { ...state.streams }
        delete streams[tabId]
        return { streams }
      })
    }
  },

  stopStream: (tabId) => {
    // 终态经后端 cancelled 事件回写（unlisten 与 phase 转移在事件侧完成）
    void httpCancel(tabId).catch(() => undefined)
  },
}))

/**
 * 关闭 Tab 的条目清理（有界）：tabs 集合收缩时，死 Tab 的终态条目丢弃、
 * 在途流摘监听、Body 视图偏好（bodyModes）回收；并对每个死 Tab 触发后端
 * 关 Tab 清理（取消在途请求＋单键删除响应临时文件，幂等、fire-and-forget）。
 * 关 Tab / 关闭其他 / 关闭右侧 /
 * 关闭全部 / 切工作空间（restore 整体替换）都经此同一收缩信号——逐 Tab
 * 同语义的唯一链路，覆盖在途普通发送（entries 条目）、在途流（streams
 * 条目）与视图偏好（bodyModes）。与写入守卫（isTabAlive）配合封住
 * 「关 Tab 后到达的结果写回」竞速。
 */
useTabsStore.subscribe((state, prevState) => {
  if (state.tabs === prevState.tabs) return
  const alive = new Set(state.tabs.map((tab) => tab.id))
  const { entries, streams, bodyModes } = useResponseStore.getState()
  const deadEntryIds = Object.keys(entries).filter((id) => !alive.has(id))
  const deadStreamIds = Object.keys(streams).filter((id) => !alive.has(id))
  const deadModeIds = Object.keys(bodyModes).filter((id) => !alive.has(id))
  if (deadEntryIds.length === 0 && deadStreamIds.length === 0 && deadModeIds.length === 0) return
  const deadTabIds = new Set([...deadEntryIds, ...deadStreamIds, ...deadModeIds])
  for (const tabId of deadTabIds) {
    disposeListener(tabId)
    disposeUpgradeListener(tabId)
    // 幂等（无在途任务 / 无文件静默）；invoke 失败静默——清理是尽力而为，
    // 不阻塞关 Tab 动画与后续交互
    void httpTabClosed(tabId).catch(() => undefined)
  }
  useResponseStore.setState((prev) => {
    const nextEntries = { ...prev.entries }
    for (const tabId of deadEntryIds) delete nextEntries[tabId]
    const nextStreams = { ...prev.streams }
    for (const tabId of deadStreamIds) delete nextStreams[tabId]
    const nextBodyModes = { ...prev.bodyModes }
    for (const tabId of deadModeIds) delete nextBodyModes[tabId]
    return { entries: nextEntries, streams: nextStreams, bodyModes: nextBodyModes }
  })
})
