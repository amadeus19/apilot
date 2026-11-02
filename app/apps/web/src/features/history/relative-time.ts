import type { DictKey } from '@/i18n'

/**
 * 相对时间分档（纯函数）：秒 / 分 / 时 / 天四档，文案键交给消费方 t()
 * （en 侧复数节点按 count 自动分支）。不接语言、不接 t——沿 selector
 * 纯函数惯例，边界用例（本地日界、时钟漂移）可注入 now 直测。
 */

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

export interface RelativeTimeParts {
  key: DictKey
  count: number
}

/** createdAt（ISO）距今（now）的分档；无效时间返回 null（调用方不渲染） */
export function relativeTimeParts(iso: string, now: Date): RelativeTimeParts | null {
  const created = Date.parse(iso)
  if (Number.isNaN(created)) return null
  // 时钟漂移（created 略在未来）钳到 0：不产生负数或「0 秒前」
  const elapsed = Math.max(0, now.getTime() - created)
  if (elapsed < MINUTE_MS) {
    return { key: 'history.relativeSeconds', count: Math.max(1, Math.floor(elapsed / 1000)) }
  }
  if (elapsed < HOUR_MS) {
    return { key: 'history.relativeMinutes', count: Math.floor(elapsed / MINUTE_MS) }
  }
  if (elapsed < DAY_MS) {
    return { key: 'history.relativeHours', count: Math.floor(elapsed / HOUR_MS) }
  }
  return { key: 'history.relativeDays', count: Math.floor(elapsed / DAY_MS) }
}
