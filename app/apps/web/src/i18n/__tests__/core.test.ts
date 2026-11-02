import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setDevMode } from '@/services/ipc'

import { en } from '../locales/en'
import { zhCN } from '../locales/zh-CN'
import {
  formatBytes,
  formatDateTime,
  formatDuration,
  formatNumber,
  translate,
  translateError,
} from '../core'

beforeEach(() => {
  setDevMode(false)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  setDevMode(false)
})

describe('translate：插值与复数', () => {
  it('{var} 纯替换：details 占位符替换为参数值', () => {
    const text = translate('zh-CN', 'errors.SETTINGS_VALUE_TOO_LARGE', {
      limit: 4096,
      actual: 5000,
    })
    expect(text).toBe('设置值超出大小上限（上限 4096 字节，实际 5000 字节）')
  })

  it('无对应参数的占位符原样保留', () => {
    expect(translate('zh-CN', 'errors.SETTINGS_VALUE_TOO_LARGE', {})).toContain('{limit}')
  })

  it('{{var}} 双花括号是工作流变量引用语法：即使传了同名参数也不得被插值吞掉', () => {
    expect(translate('zh-CN', 'workflows.conditionExpressionPlaceholder', { status: 999 })).toBe(
      '如 {{登录.status}} == 200',
    )
  })

  it('复数：en count=1 走 one，count≠1 走 other', () => {
    expect(translate('en', 'common.nSelected', { count: 1 })).toBe('1 item selected')
    expect(translate('en', 'common.nSelected', { count: 3 })).toBe('3 items selected')
  })

  it('复数：中文无复数变形，count=1 也恒走 other', () => {
    expect(translate('zh-CN', 'common.nSelected', { count: 1 })).toBe('1 项已选中')
  })
})

describe('translate：三级兜底链（当前语言 → zh-CN → 键名）', () => {
  it('两端都缺：返回键名本身，devMode 下 console.warn', () => {
    setDevMode(true)
    expect(translate('en', 'shell.nonexistentKey')).toBe('shell.nonexistentKey')
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(
      expect.stringContaining('shell.nonexistentKey'),
    )
  })

  it('devMode 关闭时兜底静默（生产不产生噪音）', () => {
    expect(translate('en', 'shell.nonexistentKey')).toBe('shell.nonexistentKey')
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('当前语言缺键落 zh-CN（运行时防线；编译期同构使真实缺译不可能）', () => {
    const enShell = en.shell as Record<string, unknown>
    const original = enShell.minimize
    delete enShell.minimize
    try {
      expect(translate('en', 'shell.minimize')).toBe('最小化')
    } finally {
      enShell.minimize = original
    }
  })

  it('zh-CN 也缺该键：落键名（同上运行时模拟）', () => {
    const zhShell = zhCN.shell as Record<string, unknown>
    const enShell = en.shell as Record<string, unknown>
    const zhOriginal = zhShell.close
    const enOriginal = enShell.close
    delete zhShell.close
    delete enShell.close
    try {
      expect(translate('zh-CN', 'shell.close')).toBe('shell.close')
    } finally {
      zhShell.close = zhOriginal
      enShell.close = enOriginal
    }
  })
})

describe('translateError：errors.<code> 映射', () => {
  it('命中映射返回本地化文案', () => {
    expect(translateError('zh-CN', 'DB_QUERY_FAILED')).toBe('数据库查询失败')
    expect(translateError('en', 'DB_QUERY_FAILED')).toBe('Database query failed')
  })

  it('details 展开为插值参数', () => {
    expect(translateError('zh-CN', 'SETTINGS_KEY_LIMIT_EXCEEDED', { limit: 256 })).toBe(
      '设置项数量超出上限（256）',
    )
  })

  it('未登记的 code 返回 undefined，由调用方兜底原 message', () => {
    expect(translateError('zh-CN', 'UNKNOWN_FUTURE_CODE')).toBeUndefined()
  })
})

describe('本地化格式化器', () => {
  it('formatNumber 走 Intl 千分位', () => {
    expect(formatNumber(1234.5, 'en')).toBe('1,234.5')
  })

  it('formatDateTime 按生效语言出形态（en 带月名与上下午，zh 为年月日）', () => {
    const date = new Date(2026, 8, 27, 14, 30, 0)
    const enText = formatDateTime(date, 'en')
    const zhText = formatDateTime(date, 'zh-CN')
    expect(enText).toContain('Sep')
    expect(enText).toMatch(/PM/i)
    expect(zhText).toContain('2026年9月27日')
  })

  it('formatDuration 恒符号：ms / 一位小数 s / min+补零 s', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(340)).toBe('340ms')
    expect(formatDuration(1200)).toBe('1.2s')
    expect(formatDuration(60_000)).toBe('1min 00s')
    expect(formatDuration(125_000)).toBe('2min 05s')
  })

  it('formatBytes 恒符号：B 档整数，KB/MB/GB 一位小数，GB 封顶', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(123)).toBe('123 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB')
    // 超过 GB 的数值继续以 GB 表达（超大响应走文件落盘，不出现 TB 级展示需求）
    expect(formatBytes(2 * 1024 ** 4)).toBe('2048.0 GB')
  })
})
