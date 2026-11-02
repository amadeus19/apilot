import { describe, expect, it } from 'vitest'

import { relativeTimeParts } from '../relative-time'

/** 注入「现在」＝2026-10-02 15:30:00 本地时间 */
const NOW = new Date(2026, 9, 2, 15, 30, 0)

describe('relativeTimeParts：秒 / 分 / 时 / 天四档', () => {
  it('各档取值与向下取整', () => {
    expect(relativeTimeParts(new Date(2026, 9, 2, 15, 29, 57).toISOString(), NOW)).toEqual({
      key: 'history.relativeSeconds',
      count: 3,
    })
    expect(relativeTimeParts(new Date(2026, 9, 2, 15, 25, 0).toISOString(), NOW)).toEqual({
      key: 'history.relativeMinutes',
      count: 5,
    })
    // 不足一分钟但超过 59 秒：仍在秒档（59 秒）
    expect(relativeTimeParts(new Date(2026, 9, 2, 15, 29, 1).toISOString(), NOW)).toEqual({
      key: 'history.relativeSeconds',
      count: 59,
    })
    expect(relativeTimeParts(new Date(2026, 9, 2, 13, 30, 0).toISOString(), NOW)).toEqual({
      key: 'history.relativeHours',
      count: 2,
    })
    expect(relativeTimeParts(new Date(2026, 8, 29, 15, 30, 0).toISOString(), NOW)).toEqual({
      key: 'history.relativeDays',
      count: 3,
    })
  })

  it('0 秒显示最小档 1 秒（不产生「0 秒前」）；未来时间钳制同样不产生负数', () => {
    expect(relativeTimeParts(NOW.toISOString(), NOW)).toEqual({
      key: 'history.relativeSeconds',
      count: 1,
    })
    // 时钟漂移：createdAt 落在未来（now 参数更早）——钳到 0 后仍是最小档
    const future = new Date(NOW.getTime() + 5_000)
    expect(relativeTimeParts(future.toISOString(), NOW)).toEqual({
      key: 'history.relativeSeconds',
      count: 1,
    })
  })

  it('无效时间返回 null（调用方不渲染相对时间）', () => {
    expect(relativeTimeParts('not-a-date', NOW)).toBeNull()
  })
})
