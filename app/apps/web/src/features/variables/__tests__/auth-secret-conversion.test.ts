import { beforeEach, describe, expect, it, vi } from 'vitest'

import { toast } from '@workspace/ui/components'

import {
  convertLiteralToSecret,
  isVariableReference,
  pickTargetCategory,
} from '../auth-secret-conversion'

// —— IPC invoke 替换：分类清单与建变量走桩 ——
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@workspace/ui/components', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(toast.error).mockClear()
  vi.mocked(toast.success).mockClear()
})

describe('pickTargetCategory：目标分类兜底序', () => {
  it('有激活分类时激活分类优先（即使排在清单后面）', () => {
    const view = {
      items: [
        { id: 'vc1', name: '开发', isGlobal: false, sortOrder: 0 },
        { id: 'vc2', name: '预发', isGlobal: false, sortOrder: 1 },
        { id: 'g1', name: '公共', isGlobal: true, sortOrder: 2 },
      ],
      activeCategoryId: 'vc2',
    }
    expect(pickTargetCategory(view)?.id).toBe('vc2')
  })

  it('无激活时回落第一个本空间分类', () => {
    const view = {
      items: [
        { id: 'vc1', name: '开发', isGlobal: false, sortOrder: 0 },
        { id: 'g1', name: '公共', isGlobal: true, sortOrder: 1 },
      ],
      activeCategoryId: null,
    }
    expect(pickTargetCategory(view)?.id).toBe('vc1')
  })

  it('只有全局分类时回落全局；空清单＝null', () => {
    const onlyGlobal = {
      items: [{ id: 'g1', name: '公共', isGlobal: true, sortOrder: 0 }],
      activeCategoryId: null,
    }
    expect(pickTargetCategory(onlyGlobal)?.id).toBe('g1')
    expect(pickTargetCategory({ items: [], activeCategoryId: null })).toBeNull()
  })
})

describe('isVariableReference：字面量判定', () => {
  it('{{ 开头＝引用形态（含前导空白），其余为字面量', () => {
    expect(isVariableReference('{{token}}')).toBe(true)
    expect(isVariableReference('  {{token}}')).toBe(true)
    expect(isVariableReference('abc123')).toBe(false)
    expect(isVariableReference('')).toBe(false)
  })
})

describe('convertLiteralToSecret：转换动作', () => {
  it('目标分类建同名 Secret 变量，返回引用串', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'variable.list_categories') {
        return Promise.resolve({
          items: [
            { id: 'vc1', name: '开发', isGlobal: false, sortOrder: 0 },
            { id: 'g1', name: '公共', isGlobal: true, sortOrder: 1 },
          ],
          activeCategoryId: 'vc1',
        })
      }
      if (cmd === 'variable.create_variable') return Promise.resolve({ items: [] })
      return Promise.resolve(undefined)
    })
    const reference = await convertLiteralToSecret('w1', 'token', 'raw-credential')
    expect(reference).toBe('{{token}}')
    const createCall = invokeMock.mock.calls.find(([cmd]) => cmd === 'variable.create_variable')
    expect(createCall![1]).toEqual({
      categoryId: 'vc1',
      key: 'token',
      value: 'raw-credential',
      secret: true,
    })
    expect(vi.mocked(toast.success)).toHaveBeenCalledExactlyOnceWith('已转为 Secret 变量 token')
  })

  it('无可用分类＝toast 错误并返回 null（不建变量）', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'variable.list_categories') {
        return Promise.resolve({ items: [], activeCategoryId: null })
      }
      return Promise.resolve(undefined)
    })
    const reference = await convertLiteralToSecret('w1', 'token', 'raw')
    expect(reference).toBeNull()
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'variable.create_variable')).toBe(false)
    expect(vi.mocked(toast.error)).toHaveBeenCalledExactlyOnceWith('没有可用的变量分类')
  })

  it('建变量失败（如键重复）＝错误呈现并返回 null', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'variable.list_categories') {
        return Promise.resolve({
          items: [{ id: 'vc1', name: '开发', isGlobal: false, sortOrder: 0 }],
          activeCategoryId: 'vc1',
        })
      }
      if (cmd === 'variable.create_variable') {
        return Promise.reject({
          kind: 'apilot_error',
          code: 'VARIABLE_KEY_DUPLICATE',
          message: 'duplicate',
        })
      }
      return Promise.resolve(undefined)
    })
    const reference = await convertLiteralToSecret('w1', 'token', 'raw')
    expect(reference).toBeNull()
  })
})
