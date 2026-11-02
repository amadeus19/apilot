/** 异步工具：给 Promise 加超时上限（boot 载荷读取等关键路径防挂起） */

/** 超时即以 TimeoutError 拒绝；原 Promise 继续运行但结果被丢弃（调用方须自行保证资源安全） */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (reason) => {
        clearTimeout(timer)
        reject(reason)
      },
    )
  })
}
