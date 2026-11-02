import { beforeEach, describe, expect, it, vi } from 'vitest'

import { blockingErrorStore, reportError, setErrorLocaleSource } from '../error-center'
import { setDevMode } from '../ipc'

// Toast 呈现替换为 spy：断言路由结果，不渲染真实浮层
vi.mock('@workspace/ui/components', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

import { toast } from '@workspace/ui/components'

beforeEach(() => {
  vi.mocked(toast.error).mockClear()
  setDevMode(false)
  setErrorLocaleSource(() => 'zh-CN')
  blockingErrorStore.dismiss()
})

describe('reportError', () => {
  it('瞬态错误按 errors.<code> 映射本地化文案，devMode 关闭时不附 code', () => {
    reportError({ kind: 'apilot_error', code: 'SETTINGS_UNKNOWN_KEY', message: 'unknown key' })
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('未知的设置项', { description: undefined })
  })

  it('details 作插值参数展示（限额类错误的 limit/actual）', () => {
    reportError({
      kind: 'apilot_error',
      code: 'SETTINGS_VALUE_TOO_LARGE',
      message: 'too large',
      details: { limit: 4096, actual: 5000 },
    })
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      '设置值超出大小上限（上限 4096 字节，实际 5000 字节）',
      { description: undefined },
    )
  })

  it('code 无映射时兜底显示原英文 message', () => {
    reportError({ kind: 'apilot_error', code: 'FUTURE_CODE', message: 'not yet mapped' })
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('not yet mapped', {
      description: undefined,
    })
  })

  it('devMode 开启时 Toast 附带稳定 code', () => {
    setDevMode(true)
    reportError({ kind: 'apilot_error', code: 'DB_QUERY_FAILED', message: 'query failed' })
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('数据库查询失败', {
      description: 'DB_QUERY_FAILED',
    })
  })

  it('语言源切换后按新生效语言映射（切换即时生效）', () => {
    setErrorLocaleSource(() => 'en')
    reportError({ kind: 'apilot_error', code: 'DB_QUERY_FAILED', message: 'query failed' })
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Database query failed', {
      description: undefined,
    })
  })

  it('阻断性错误进入对话框 store，dismiss 后清空', () => {
    reportError({ kind: 'apilot_error', code: 'DB_CORRUPTED', message: 'corrupted' })
    expect(blockingErrorStore.getSnapshot()?.error.code).toBe('DB_CORRUPTED')
    expect(toast.error).not.toHaveBeenCalled()

    blockingErrorStore.dismiss()
    expect(blockingErrorStore.getSnapshot()).toBeNull()
  })

  it('未知异常同样归一路由（瞬态 → Toast，message 原样直出）', () => {
    reportError(new Error('unexpected'))
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('unexpected', { description: undefined })
  })
})
