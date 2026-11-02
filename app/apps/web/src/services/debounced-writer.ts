import * as React from 'react'

import { registerExitFlusher } from '@/services/exit-flush'

/**
 * 草稿防抖写（DebouncedWriter）：编辑实时防抖落库的通用核心。
 *
 * 语义（工作台草稿模型）：
 * - 编辑到达（schedule）＝记录最新值并重置防抖窗口，窗口内多次编辑合并为一次写；
 * - 关 Tab / 切 Tab（组件卸载 → dispose）＝立即写出剩余值；
 * - 应用退出（退出收尾注册表 → flushNow）＝立即写出并等待完成；
 * - 在途写未完成时到达的新值排队补写，保证最终值落库（最后一次写恒为最新值）；
 * - 单次写失败只上报不重试（下一条编辑或下次 flush 自然重写整包）。
 *
 * 资源四问：拥有者＝挂载的编辑组件；创建＝组件挂载；释放＝卸载 dispose
 * （清定时器 + 剩余值落库，写闭包独立于组件生命周期）；泄漏防护＝
 * 定时器单槽覆盖 + 在途写排队收敛，无悬挂回调。
 */

/** 默认防抖窗口（草稿模型约定的合并写窗口） */
export const DEFAULT_DEBOUNCE_MS = 500

export interface DebouncedWriterOptions<T> {
  /** 整包写动作（调用方闭包持 IPC 封装与身份参数） */
  write: (payload: T) => Promise<void>
  /** 单次写失败上报（统一错误协议由调用方注入） */
  onError: (error: unknown) => void
  /** 防抖窗口毫秒数（默认 500；测试可注入更小值） */
  debounceMs?: number
}

export class DebouncedWriter<T> {
  private readonly options: DebouncedWriterOptions<T>
  private timer: number | null = null
  private latest: T | null = null
  private writing = false
  private pendingWrite: Promise<void> | null = null
  private disposed = false

  constructor(options: DebouncedWriterOptions<T>) {
    this.options = options
  }

  private get debounceMs(): number {
    return this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  } /** 编辑到达：记录最新值并重置防抖窗口 */
  schedule(payload: T): void {
    if (this.disposed) return
    this.latest = payload
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.flushNow()
    }, this.debounceMs)
  }

  /**
   * 立即落库（关/切 Tab 收尾与退出收尾共用通道）。
   * 返回「本次及排队补写」全部完成的信号——退出放行需等待写完成；
   * 无未写值时立即兑现。
   */
  flushNow(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.timer !== null) {
      window.clearTimeout(this.timer)
      this.timer = null
    }
    if (this.writing) {
      // 在途写进行中：排队补写（完成后按剩余最新值续写）
      const current = this.pendingWrite ?? Promise.resolve()
      return current.then(() => this.flushNow())
    }
    if (this.latest === null) return Promise.resolve()
    return this.doWrite()
  }

  /** 是否有未落库的编辑（诊断与测试观察用） */
  hasPending(): boolean {
    return this.latest !== null
  }

  /** 卸载收尾：清除防抖定时器；剩余未写值立即写出（不等待完成） */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== null) {
      window.clearTimeout(this.timer)
      this.timer = null
    }
    if (this.latest === null) return
    if (this.writing) {
      // 在途写完成后补写剩余值；写闭包独立存活，卸载不等待
      void (this.pendingWrite ?? Promise.resolve()).then(() => {
        if (this.latest !== null) void this.doWrite()
      })
      return
    }
    void this.doWrite()
  }

  /** 取快照发起一次整包写；失败上报后丢弃（不重试，等下一次编辑或 flush） */
  private doWrite(): Promise<void> {
    const payload = this.latest
    this.latest = null
    this.writing = true
    const write = Promise.resolve(this.options.write(payload!))
      .catch((error: unknown) => {
        this.options.onError(error)
      })
      .finally(() => {
        this.writing = false
        this.pendingWrite = null
      })
    this.pendingWrite = write
    return write
  }
}

export interface UseDebouncedWriterOptions<T> {
  /** 退出收尾注册名（exit-flush 注册表键，幂等覆盖；多 writer 不得重名） */
  flusherId: string
  write: (payload: T) => Promise<void>
  onError: (error: unknown) => void
  debounceMs?: number
}

/**
 * 防抖写 hook 包装：注册退出收尾（应用退出的 flush 通道），writer 生命周期
 * 与挂载 effect 对齐——挂载创建、清理 dispose（关/切 Tab 的 flush 通道）。
 * dispose 是终态（清定时器 + 剩余值落库，实例不可复用），故 effect 重挂
 * （StrictMode 的挂载-清理-重挂模拟）必须新建实例，否则同一 ref 上的
 * 已 dispose 实例会让后续编辑静默丢弃。write / onError 闭包经 ref 透传，
 * 重渲染不重置防抖状态。
 */
export function useDebouncedWriter<T>(options: UseDebouncedWriterOptions<T>): {
  schedule: (payload: T) => void
  flushNow: () => Promise<void>
} {
  const optionsRef = React.useRef(options)
  // 最新 options 同步：渲染后写入（渲染期写 ref 对 React Compiler 不友好）；
  // 消费方是 writer 的写闭包，由防抖定时器 / flush 通道触发，均在 effect 之后
  React.useEffect(() => {
    optionsRef.current = options
  })

  const writerRef = React.useRef<DebouncedWriter<T> | null>(null)
  const { flusherId, debounceMs } = options

  React.useEffect(() => {
    const writer = new DebouncedWriter<T>({
      write: (payload) => optionsRef.current.write(payload),
      onError: (error) => optionsRef.current.onError(error),
      debounceMs,
    })
    writerRef.current = writer
    const unregister = registerExitFlusher(flusherId, () => writer.flushNow())
    return () => {
      unregister()
      writer.dispose()
      if (writerRef.current === writer) writerRef.current = null
    }
  }, [flusherId, debounceMs])

  return React.useMemo(
    () => ({
      // 用户事件回调只会发生在挂载 effect 之后（React 事件时序保证）
      schedule: (payload: T) => writerRef.current?.schedule(payload),
      flushNow: () => writerRef.current?.flushNow() ?? Promise.resolve(),
    }),
    [],
  )
}
