import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

import { useSyncWizardStore, type SyncServiceMeta } from '../sync.store'
import type { DiffOutcome } from '@/features/sync/diff-contract'

// sync-api 模块桩：IPC 不可直连（测试环境），编排逻辑是本测试对象
const syncFetch = vi.fn()
const syncFetchCancel = vi.fn()
const syncDiff = vi.fn()
const syncApply = vi.fn()
vi.mock('@/features/sync/sync-api', () => ({
  syncFetch: (...args: unknown[]) => syncFetch(...args),
  syncFetchCancel: (...args: unknown[]) => syncFetchCancel(...args),
  syncDiff: (...args: unknown[]) => syncDiff(...args),
  syncApply: (...args: unknown[]) => syncApply(...args),
  syncKeys: {
    lastSynced: (workspaceId: string) => ['sync.last_synced', workspaceId],
    lastSyncedPrefix: ['sync.last_synced'],
  },
}))

function diffOf(serviceId: string, added: number, changed: number, removed: number): DiffOutcome {
  return {
    serviceId,
    generation: 2,
    summary: { added, changed, removed, unchanged: 1 },
    diffs: [],
  }
}

const SERVICES: SyncServiceMeta[] = [
  { id: 's1', name: '服务一', docUrl: 'http://a' },
  { id: 's2', name: '服务二', docUrl: 'http://b' },
]

function reset() {
  useSyncWizardStore.getState().closeWizard()
  vi.clearAllMocks()
}

describe('同步向导状态机', () => {
  beforeEach(reset)

  it('open/close：close 全量重置并取消进行中的拉取', async () => {
    const store = useSyncWizardStore.getState()
    store.openWizard()
    expect(useSyncWizardStore.getState().open).toBe(true)
    useSyncWizardStore.setState({
      runs: { s1: { status: 'fetching' }, s2: { status: 'ok' } },
      phase: 'running',
    })
    useSyncWizardStore.getState().closeWizard()
    const state = useSyncWizardStore.getState()
    expect(state.open).toBe(false)
    expect(state.phase).toBe('select')
    expect(state.runs).toEqual({})
    expect(state.lastSummary).toBeNull()
    // 只有进行中（fetching）的服务被取消
    expect(syncFetchCancel).toHaveBeenCalledTimes(1)
    expect(syncFetchCancel).toHaveBeenCalledWith('s1')
  })

  it('startSync：逐服务拉取→对比，失败即跳过不影响其他', async () => {
    syncFetch.mockImplementation((serviceId: string) => {
      if (serviceId === 's1') return Promise.reject(new Error('unreachable'))
      return Promise.resolve({})
    })
    syncDiff.mockResolvedValue(diffOf('s2', 1, 0, 0))

    useSyncWizardStore.getState().openWizard()
    useSyncWizardStore.getState().setSelected(['s1', 's2'])
    await useSyncWizardStore.getState().startSync(SERVICES)

    const state = useSyncWizardStore.getState()
    expect(state.phase).toBe('compare')
    expect(state.runs.s1!.status).toBe('skipped')
    expect(state.runs.s1!.errorMessage).toBe('unreachable')
    expect(state.runs.s2!.status).toBe('ok')
    expect(state.runs.s2!.diff?.summary.added).toBe(1)
    // 运行起止时间戳随行落定（活动面板读秒与「完成 · Ns」的数据面）
    expect(typeof state.runs.s2!.startedAt).toBe('number')
    expect(typeof state.runs.s2!.durationMs).toBe('number')
    // 未勾选服务零调用（服务选择子集输入）
    expect(syncFetch).toHaveBeenCalledTimes(2)
  })

  it('startSync：全不选中直接返回（零 IPC）', async () => {
    await useSyncWizardStore.getState().startSync(SERVICES)
    expect(syncFetch).not.toHaveBeenCalled()
    expect(useSyncWizardStore.getState().phase).toBe('select')
  })

  it('startSync：串联拉取——后一服务在前一落定前不发起', async () => {
    let resolveS1: (value: unknown) => void = () => {}
    syncFetch.mockImplementation((serviceId: string) => {
      if (serviceId === 's1')
        return new Promise((resolve) => {
          resolveS1 = resolve
        })
      return Promise.resolve({})
    })
    syncDiff.mockImplementation((serviceId: string) => Promise.resolve(diffOf(serviceId, 0, 0, 0)))

    useSyncWizardStore.getState().openWizard()
    useSyncWizardStore.getState().setSelected(['s1', 's2'])
    const syncing = useSyncWizardStore.getState().startSync(SERVICES)

    // s1 挂起期间 s2 保持排队（并行编排会立即并发发起）
    await Promise.resolve()
    expect(syncFetch).toHaveBeenCalledTimes(1)
    expect(useSyncWizardStore.getState().runs.s2!.status).toBe('queued')

    resolveS1({})
    await syncing
    expect(syncFetch).toHaveBeenCalledTimes(2)
    expect(useSyncWizardStore.getState().phase).toBe('compare')
  })

  it('startSync：运行中关闭向导——排队服务不再发起、phase 不被切到确认段', async () => {
    let resolveS1: (value: unknown) => void = () => {}
    syncFetch.mockImplementation((serviceId: string) => {
      if (serviceId === 's1')
        return new Promise((resolve) => {
          resolveS1 = resolve
        })
      return Promise.resolve({})
    })
    syncDiff.mockImplementation((serviceId: string) => Promise.resolve(diffOf(serviceId, 0, 0, 0)))

    useSyncWizardStore.getState().openWizard()
    useSyncWizardStore.getState().setSelected(['s1', 's2'])
    const syncing = useSyncWizardStore.getState().startSync(SERVICES)

    // s1 拉取中关闭＝放弃：取消信号发出、本地态全量重置
    useSyncWizardStore.getState().closeWizard()
    expect(syncFetchCancel).toHaveBeenCalledWith('s1')
    expect(useSyncWizardStore.getState().phase).toBe('select')

    resolveS1({})
    await syncing
    // s2 排队未发起（放弃即停）；关闭后不被残留编排切到 compare
    expect(syncFetch).toHaveBeenCalledTimes(1)
    expect(useSyncWizardStore.getState().phase).toBe('select')
    expect(useSyncWizardStore.getState().open).toBe(false)
  })

  it('关闭后立即重开新会话：旧会话在途拉取的结果不写入新会话', async () => {
    let resolveS1: (value: unknown) => void = () => {}
    syncFetch.mockImplementation((serviceId: string) => {
      if (serviceId === 's1')
        return new Promise((resolve) => {
          resolveS1 = resolve
        })
      return Promise.resolve({})
    })
    syncDiff.mockImplementation((serviceId: string) => Promise.resolve(diffOf(serviceId, 1, 0, 0)))

    // 会话一：s1 拉取挂起
    useSyncWizardStore.getState().openWizard()
    useSyncWizardStore.getState().setSelected(['s1'])
    const first = useSyncWizardStore.getState().startSync(SERVICES)
    await Promise.resolve()

    // 关闭并立即重开新会话（只选 s2），新会话正常完成
    useSyncWizardStore.getState().closeWizard()
    useSyncWizardStore.getState().openWizard()
    useSyncWizardStore.getState().setSelected(['s2'])
    await useSyncWizardStore.getState().startSync(SERVICES)

    // 旧会话的在途拉取此刻落定：不得复活其运行态 / 覆盖新会话
    resolveS1({})
    await first
    const state = useSyncWizardStore.getState()
    expect(state.phase).toBe('compare')
    expect(state.runs.s1).toBeUndefined()
    expect(state.runs.s2?.status).toBe('ok')
  })

  it('applyAll：按勾选键集应用拉取成功的服务并聚合摘要', async () => {
    syncApply.mockResolvedValue({
      added: 1,
      changed: 0,
      removed: 0,
      unchanged: 0,
    })
    useSyncWizardStore.setState({
      phase: 'compare',
      runs: {
        s1: { status: 'ok', diff: diffOf('s1', 1, 0, 0) },
        s2: { status: 'skipped', errorMessage: 'x' },
      },
    })

    const summary = await useSyncWizardStore.getState().applyAll({
      s1: ['GET /users', 'GET /orders'],
      s2: ['GET /x'],
    })
    // 键集随行传递（接口粒度勾选），跳过服务不产生应用调用
    expect(syncApply).toHaveBeenCalledTimes(1)
    expect(syncApply).toHaveBeenCalledWith('s1', ['GET /users', 'GET /orders'])
    expect(summary).toEqual({
      added: 1,
      changed: 0,
      removed: 0,
      unchanged: 0,
    })
    const state = useSyncWizardStore.getState()
    expect(state.phase).toBe('done')
    expect(state.lastSummary).toEqual(summary)
  })

  it('applyAll：勾选集为空的服务跳过（无勾选行不写不调用）', async () => {
    syncApply.mockResolvedValue({
      added: 0,
      changed: 0,
      removed: 0,
      unchanged: 0,
    })
    useSyncWizardStore.setState({
      phase: 'compare',
      runs: {
        s1: { status: 'ok', diff: diffOf('s1', 1, 0, 0) },
        s2: { status: 'ok', diff: diffOf('s2', 1, 0, 0) },
      },
    })

    await useSyncWizardStore.getState().applyAll({ s1: [], s2: ['GET /users'] })
    expect(syncApply).toHaveBeenCalledTimes(1)
    expect(syncApply).toHaveBeenCalledWith('s2', ['GET /users'])
  })

  it('applyAll：注入 queryClient 时每服务应用成功即失效其用户数据与文档查询前缀', async () => {
    syncApply.mockResolvedValue({
      added: 1,
      changed: 0,
      removed: 0,
      unchanged: 0,
    })
    useSyncWizardStore.setState({
      phase: 'compare',
      runs: {
        s1: { status: 'ok', diff: diffOf('s1', 1, 0, 0) },
        s2: { status: 'ok', diff: diffOf('s2', 1, 0, 0) },
        s3: { status: 'skipped', errorMessage: 'x' },
      },
    })
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    await useSyncWizardStore
      .getState()
      .applyAll({ s1: ['GET /users'], s2: ['GET /users'], s3: ['GET /x'] }, queryClient)

    // 每个成功应用的服务各失效两个前缀（用户数据 + 接口文档），跳过的服务不失效；
    // 全部应用后统一失效树面（工作空间根前缀）与「上次同步」（头部时间随全量应用推进）
    expect(invalidate).toHaveBeenCalledTimes(6)
    expect(invalidate).toHaveBeenNthCalledWith(1, { queryKey: ['user-data', 's1'] })
    expect(invalidate).toHaveBeenNthCalledWith(2, { queryKey: ['endpoint-doc', 's1'] })
    expect(invalidate).toHaveBeenNthCalledWith(3, { queryKey: ['user-data', 's2'] })
    expect(invalidate).toHaveBeenNthCalledWith(4, { queryKey: ['endpoint-doc', 's2'] })
    expect(invalidate).toHaveBeenNthCalledWith(5, { queryKey: ['workspaces'] })
    expect(invalidate).toHaveBeenNthCalledWith(6, { queryKey: ['sync.last_synced'] })
  })

  it('applyAll：未注入 queryClient 时照常应用（失效面由调用方豁免）', async () => {
    syncApply.mockResolvedValue({
      added: 0,
      changed: 0,
      removed: 0,
      unchanged: 0,
    })
    useSyncWizardStore.setState({
      phase: 'compare',
      runs: { s1: { status: 'ok', diff: diffOf('s1', 0, 0, 0) } },
    })

    const summary = await useSyncWizardStore.getState().applyAll({ s1: ['GET /users'] })
    expect(syncApply).toHaveBeenCalledTimes(1)
    expect(summary.unchanged).toBe(0)
  })

  it('retryService：重走拉取→对比，成功转 ok 带 diff', async () => {
    syncFetch.mockResolvedValue({})
    syncDiff.mockResolvedValue(diffOf('s1', 2, 0, 0))
    useSyncWizardStore.setState({
      phase: 'compare',
      runs: { s1: { status: 'skipped', errorMessage: 'unreachable' } },
    })

    await useSyncWizardStore.getState().retryService('s1')
    const state = useSyncWizardStore.getState()
    expect(state.runs.s1!.status).toBe('ok')
    expect(state.runs.s1!.diff?.summary.added).toBe(2)
    expect(state.runs.s1!.errorMessage).toBeUndefined()
    // 确认段不因单服务重试切换（phase 恒 compare）
    expect(state.phase).toBe('compare')
  })

  it('retryService：失败回 skipped（行内刷新错误）；进行中重入忽略', async () => {
    syncFetch.mockRejectedValue(new Error('timeout'))
    useSyncWizardStore.setState({
      phase: 'compare',
      runs: { s1: { status: 'skipped', errorMessage: 'old' } },
    })

    await useSyncWizardStore.getState().retryService('s1')
    expect(useSyncWizardStore.getState().runs.s1).toMatchObject({
      status: 'skipped',
      errorMessage: 'timeout',
    })

    // fetching / diffing 态的重入直接忽略（零 IPC）
    useSyncWizardStore.setState({
      runs: { s1: { status: 'fetching' } },
    })
    await useSyncWizardStore.getState().retryService('s1')
    expect(syncFetch).toHaveBeenCalledTimes(1)
  })

  it('cancelService：仅对拉取中的服务发取消（幂等门槛，不关向导）', () => {
    useSyncWizardStore.setState({
      phase: 'running',
      runs: {
        s1: { status: 'fetching' },
        s2: { status: 'ok' },
      },
    })
    useSyncWizardStore.getState().cancelService('s1')
    expect(syncFetchCancel).toHaveBeenCalledTimes(1)
    expect(syncFetchCancel).toHaveBeenCalledWith('s1')
    // 非拉取中（ok / queued / diffing）与无运行态的服务不发取消
    useSyncWizardStore.getState().cancelService('s2')
    useSyncWizardStore.getState().cancelService('missing')
    expect(syncFetchCancel).toHaveBeenCalledTimes(1)
    // 取消不重置会话（区别于关闭向导的全量重置）
    expect(useSyncWizardStore.getState().phase).toBe('running')
  })

  it('拉取取消落定：CANCELLED 转中性「已取消」态（可重试，重试清标记）', async () => {
    syncFetch.mockRejectedValueOnce({ code: 'CANCELLED', message: 'fetch cancelled' })
    syncFetch.mockResolvedValueOnce({})
    syncDiff.mockResolvedValue(diffOf('s1', 0, 0, 0))
    useSyncWizardStore.setState({
      phase: 'running',
      runs: { s1: { status: 'skipped', errorMessage: 'old' } },
    })

    await useSyncWizardStore.getState().retryService('s1')
    // CANCELLED 落地＝skipped＋cancelled 标记＋无错误文案（中性呈现）
    expect(useSyncWizardStore.getState().runs.s1).toMatchObject({
      status: 'skipped',
      cancelled: true,
    })
    expect(useSyncWizardStore.getState().runs.s1!.errorMessage).toBeUndefined()

    // 重试成功清取消标记
    await useSyncWizardStore.getState().retryService('s1')
    expect(useSyncWizardStore.getState().runs.s1).toMatchObject({
      status: 'ok',
      cancelled: false,
    })
  })

  it('toggleService 勾选序保持', () => {
    useSyncWizardStore.getState().toggleService('s2')
    useSyncWizardStore.getState().toggleService('s1')
    expect(useSyncWizardStore.getState().selectedServiceIds).toEqual(['s2', 's1'])
    useSyncWizardStore.getState().toggleService('s2')
    expect(useSyncWizardStore.getState().selectedServiceIds).toEqual(['s1'])
  })
})
