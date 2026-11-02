import { describe, expect, it } from 'vitest'

import { formatSyncClock } from '../wizard-data'

describe('formatSyncClock（头部「上次同步」时钟文本）', () => {
  it('ISO 时刻输出本地 MM-DD HH:mm（两位补零）', () => {
    expect(formatSyncClock('2026-10-18T14:02:00.000Z')).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('非法输入原样返回（不抛错，不呈现 Invalid Date）', () => {
    expect(formatSyncClock('not-a-date')).toBe('not-a-date')
  })
})
