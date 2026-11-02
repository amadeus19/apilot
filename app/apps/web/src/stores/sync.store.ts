import { create } from 'zustand'
import type { QueryClient } from '@tanstack/react-query'

import {
  syncApply,
  syncDiff,
  syncFetch,
  syncFetchCancel,
  syncKeys,
  type ApplyOutcomeDto,
} from '@/features/sync/sync-api'
import { workbenchKeys } from '@/services/workbench-api'
import type { DiffOutcome } from '@/features/sync/diff-contract'

/**
 * 同步向导状态机（四段：服务选择 → 拉取运行 → 对比确认 → 完成）。
 *
 * 编排口径：
 * - 同步以**服务选择子集**为输入，**串联**逐服务拉取（前一服务落定后才发起
 *   下一个；一服务失败不影响后续，不可达 / 异常服务本次跳过、不产生任何
 *   写入）；运行中关闭＝放弃即停：剩余排队服务不再发起；
 * - 拉取只写待应用暂存、不推进快照代（快照随全量应用转正）——关闭向导
 *   ＝放弃：进行中拉取走 `sync.fetch_cancel`（CancellationToken，快照与
 *   用户数据零变化），未应用的变更保持待应用（下次同步仍在清单），本地
 *   态全量重置；
 * - 应用段逐服务 `sync.apply`（参数与请求体由应用事务静默对齐），
 *   未确认零落盘副作用。
 */

/** 向导段位 */
export type SyncWizardPhase = 'select' | 'running' | 'compare' | 'done'

/** 单服务的拉取运行态（skipped＝拉取或对比失败，本次跳过） */
export interface ServiceRunState {
  status: 'queued' | 'fetching' | 'diffing' | 'ok' | 'skipped'
  errorMessage?: string
  /** 拉取被用户取消的落定标记（CANCELLED 转 skipped 时置位；中性呈现，可重试） */
  cancelled?: boolean
  /** 本次运行起点（ms 纪元；fetching 置位时写入——运行段活动面板读秒） */
  startedAt?: number
  /** 运行总耗时（ms；落定态写入，完成行「完成 · Ns」呈现） */
  durationMs?: number
  diff?: DiffOutcome
}

/** 向导输入的服务元数据（勾选面，来自当前工作空间服务清单） */
export interface SyncServiceMeta {
  id: string
  name: string
  /** 无文档地址的服务不可参与同步（选择面禁用） */
  docUrl: string | null
}

/** 应用段汇总（完成段呈现：跨服务计数相加） */
export interface AppliedSummary {
  added: number
  changed: number
  removed: number
  unchanged: number
}

interface SyncWizardState {
  open: boolean
  phase: SyncWizardPhase
  /** 勾选的服务 id（选择段；保持勾选序） */
  selectedServiceIds: string[]
  /** serviceId → 拉取运行态（running / compare 段消费） */
  runs: Record<string, ServiceRunState>
  /** 应用段进行中（确认按钮禁用面） */
  applying: boolean
  /** serviceId → 应用结果（完成段呈现） */
  applyOutcomes: Record<string, ApplyOutcomeDto>
  /** 最近一次应用汇总（完成段呈现；phase=done 时必有值） */
  lastSummary: AppliedSummary | null
  /** 运行代次（关闭 / 重新开始自增）：在途拉取与旧串联编排据此判失效——
   *  关闭后立即重开时，旧会话的结果不得写进新会话 */
  runToken: number
  openWizard: () => void
  /** 单服务直达（接口树服务行右键）：打开向导并预勾选该服务——保留选择段
   *  （四段流程完整、未确认零副作用），用户可在选择段增删后开始 */
  openWizardFor: (serviceId: string) => void
  /** 关闭＝放弃：取消进行中拉取（fire-and-forget）＋全量重置本地态 */
  closeWizard: () => void
  toggleService: (serviceId: string) => void
  setSelected: (serviceIds: string[]) => void
  /** 拉取 → 对比编排：全服务 settle 后进 compare（应用前零落盘副作用） */
  startSync: (services: SyncServiceMeta[]) => Promise<void>
  /** 单服务重试（确认段 skipped 行）：重走拉取→对比编排，成功转 ok 带
   *  diff、失败回 skipped；确认面随 runs 即时收敛（部分成功→清单呈现，
   *  仍全跳过→失败明细原地刷新）。进行中（fetching/diffing）重入忽略 */
  retryService: (serviceId: string) => Promise<void>
  /** 行内取消单个服务的进行中拉取（不关向导）：fire-and-forget 发取消信号，
   *  终态由 runServiceFetch 的 catch 落地（CANCELLED → skipped＋中性
   *  「已取消」，可重试）；diffing 是只读短任务，不提供取消 */
  cancelService: (serviceId: string) => void
  /** 应用段：按确认段勾选集逐服务 apply（serviceId → 勾选稳定键集；空集
   *  服务跳过＝不写），完成后进 done。queryClient 由调用组件注入，每服务
   *  apply 成功即失效其用户数据与接口文档查询前缀（对齐结果回流到已打开
   *  的接口 Tab——Tab 按身份单实例复用，不失效则重开前恒旧值；文档抽屉
   *  同理，失效回流让打开中的抽屉即时刷新） */
  applyAll: (
    selections: Record<string, string[]>,
    queryClient?: QueryClient,
  ) => Promise<AppliedSummary>
}

const EMPTY_RUNS: Record<string, ServiceRunState> = {}

/** 单调运行代次：关闭 / 重新开始都推进，旧代次的异步结果一律丢弃 */
let runEpoch = 0

function initial(): Pick<
  SyncWizardState,
  | 'open'
  | 'phase'
  | 'selectedServiceIds'
  | 'runs'
  | 'applying'
  | 'applyOutcomes'
  | 'lastSummary'
  | 'runToken'
> {
  return {
    open: false,
    phase: 'select',
    selectedServiceIds: [],
    runs: EMPTY_RUNS,
    applying: false,
    applyOutcomes: {},
    lastSummary: null,
    runToken: 0,
  }
}

export const useSyncWizardStore = create<SyncWizardState>((set, get) => ({
  ...initial(),

  openWizard: () => set({ open: true, phase: 'select' }),

  openWizardFor: (serviceId) =>
    set({ open: true, phase: 'select', selectedServiceIds: [serviceId] }),

  closeWizard: () => {
    // 进行中的拉取按 CancellationToken 收敛（幂等取消；结果无人等待，
    // oneshot 发送端 drop 由 Rust 侧自然清理登记）
    for (const [serviceId, run] of Object.entries(get().runs)) {
      if (run.status === 'fetching') {
        void Promise.resolve(syncFetchCancel(serviceId)).catch(() => {})
      }
    }
    // 代次推进：关闭前发出的在途拉取 / 旧编排即使此刻落定也一律丢弃
    set({ ...initial(), runToken: ++runEpoch })
  },

  toggleService: (serviceId) =>
    set((state) => ({
      selectedServiceIds: state.selectedServiceIds.includes(serviceId)
        ? state.selectedServiceIds.filter((id) => id !== serviceId)
        : [...state.selectedServiceIds, serviceId],
    })),

  setSelected: (serviceIds) => set({ selectedServiceIds: serviceIds }),

  startSync: async (services) => {
    const selected = services.filter((s) => get().selectedServiceIds.includes(s.id))
    if (selected.length === 0) return
    const runToken = ++runEpoch
    const runs: Record<string, ServiceRunState> = {}
    for (const s of selected) runs[s.id] = { status: 'queued' }
    set({ runToken, phase: 'running', runs, applyOutcomes: {} })

    // 串联拉取：逐个发起、前一服务落定（ok / skipped）后再启动下一个。
    // phase / runToken 是续跑断点——closeWizard 重置并推进代次，编排据此
    // 终止：剩余排队服务不再发起（放弃即停），关闭后立即重开的新会话也
    // 不会被旧编排续跑
    for (const s of selected) {
      if (get().phase !== 'running' || get().runToken !== runToken) return
      await runServiceFetch(s.id, runToken)
    }
    // 全部 settle（含跳过）才进确认段：半态不呈现清单；关闭后不切段
    if (
      get().phase === 'running' &&
      get().runToken === runToken &&
      Object.values(get().runs).every((r) => r.status === 'ok' || r.status === 'skipped')
    ) {
      set({ phase: 'compare' })
    }
  },

  retryService: async (serviceId) => {
    const run = get().runs[serviceId]
    // 无运行态或进行中（并发重入）不重试
    if (!run || run.status === 'fetching' || run.status === 'diffing') return
    await runServiceFetch(serviceId, get().runToken)
  },

  cancelService: (serviceId) => {
    const run = get().runs[serviceId]
    if (run?.status !== 'fetching') return
    void Promise.resolve(syncFetchCancel(serviceId)).catch(() => {})
  },

  applyAll: async (selections, queryClient) => {
    if (get().applying) throw new Error('apply already in progress')
    set({ applying: true })
    const summary: AppliedSummary = {
      added: 0,
      changed: 0,
      removed: 0,
      unchanged: 0,
    }
    const outcomes: Record<string, ApplyOutcomeDto> = {}
    try {
      for (const [serviceId, keys] of Object.entries(selections)) {
        // 只应用拉取成功的服务（跳过者本轮无输入面）；勾选集空＝该服务
        // 无勾选行，不落任何数据，直接跳过
        if (get().runs[serviceId]?.status !== 'ok') continue
        if (keys.length === 0) continue
        const outcome = await syncApply(serviceId, keys)
        // 该服务用户数据与接口文档查询前缀即时失效（fire-and-forget
        // refetch）：已打开 Tab 的编辑器据此重播种未编辑草稿，文档抽屉
        // 回流新 definition；部分服务失败时已成功者不陪绑
        queryClient?.invalidateQueries({ queryKey: workbenchKeys.userDataService(serviceId) })
        queryClient?.invalidateQueries({ queryKey: workbenchKeys.endpointDocService(serviceId) })
        outcomes[serviceId] = outcome
        summary.added += outcome.added
        summary.changed += outcome.changed
        summary.removed += outcome.removed
        summary.unchanged += outcome.unchanged
      }
    } finally {
      set({ applying: false })
    }
    set({ applyOutcomes: outcomes, phase: 'done', lastSummary: summary })
    if (Object.keys(outcomes).length > 0) {
      // 树面（新增 / 删除行与徽标）即刻失效重取：不依赖「完成」按钮的
      // 关闭路径——X / Esc 关闭同样要看到刷新后的树。头部「上次同步」
      // 随全量应用推进（部分应用不滚代，值不变；前缀失效幂等）。
      void queryClient?.invalidateQueries({ queryKey: workbenchKeys.workspaces() })
      void queryClient?.invalidateQueries({ queryKey: syncKeys.lastSyncedPrefix })
    }
    return summary
  },
}))

/** 单服务运行态的就地更新（其余段位不动）。代次不匹配＝结果属于已关闭 /
 *  已被新会话取代的旧会话——原样返回，不写回任何状态 */
function patchRun(serviceId: string, patch: Partial<ServiceRunState>, runToken: number): void {
  useSyncWizardStore.setState((state) => {
    if (state.runToken !== runToken) return state
    const current = state.runs[serviceId]
    if (!current) return state
    return { runs: { ...state.runs, [serviceId]: { ...current, ...patch } } }
  })
}

/** 单服务拉取→对比编排（startSync 串联面与 retryService 共用的编排单点）：
 *  拉取失败或对比失败即转 skipped（行内呈现错误；用户取消的 CANCELLED
 *  转中性「已取消」态），成功转 ok 带 diff；进入即清上一轮错误与取消
 *  标记（重试成功后行内不残留旧失败原因）。startedAt / durationMs 记录
 *  本次运行起止（运行段读秒与完成耗时呈现） */
async function runServiceFetch(serviceId: string, runToken: number): Promise<void> {
  const startedAt = Date.now()
  patchRun(
    serviceId,
    { status: 'fetching', startedAt, errorMessage: undefined, cancelled: false },
    runToken,
  )
  try {
    await syncFetch(serviceId)
  } catch (err) {
    patchRun(
      serviceId,
      errorCodeOf(err) === 'CANCELLED'
        ? { status: 'skipped', cancelled: true, durationMs: Date.now() - startedAt }
        : {
            status: 'skipped',
            errorMessage: errorMessageOf(err),
            durationMs: Date.now() - startedAt,
          },
      runToken,
    )
    return
  }
  // 拉取落定时会话已被关闭 / 取代：不再发起对比（结果无处安放）
  if (useSyncWizardStore.getState().runToken !== runToken) return
  patchRun(serviceId, { status: 'diffing' }, runToken)
  try {
    const diff = await syncDiff(serviceId)
    patchRun(serviceId, { status: 'ok', diff, durationMs: Date.now() - startedAt }, runToken)
  } catch (err) {
    patchRun(
      serviceId,
      {
        status: 'skipped',
        errorMessage: errorMessageOf(err),
        durationMs: Date.now() - startedAt,
      },
      runToken,
    )
  }
}

/** AppError message 提取（IPC 错误对象形态归一） */
function errorMessageOf(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(err)
}

/** AppError code 提取（IPC 错误对象形态归一；无 code 形态返回 null） */
function errorCodeOf(err: unknown): string | null {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return null
}
