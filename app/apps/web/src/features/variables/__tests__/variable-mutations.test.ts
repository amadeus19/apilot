import * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'

import { useVariableStore } from '@/stores/variable.store'

import { activateCategoryBy, useVariableMutations } from '../variable-mutations'
import type { VariableCategoriesDto } from '../variable-api'

// 只替 IPC 边（命令函数），缓存协议用真实实现直测
const variableSetActiveCategory = vi.fn()
const variableDeleteCategory = vi.fn()
vi.mock('../variable-api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  variableSetActiveCategory: (...args: unknown[]) => variableSetActiveCategory(...args),
  variableDeleteCategory: (...args: unknown[]) => variableDeleteCategory(...args),
}))

function category(id: string) {
  return { id, name: id, isGlobal: false, sortOrder: 0 }
}

function viewOf(items: ReturnType<typeof category>[], activeCategoryId: string | null) {
  return { items, activeCategoryId } satisfies VariableCategoriesDto
}

const WORKSPACE = 'w1'

beforeEach(() => {
  vi.clearAllMocks()
  useVariableStore.setState({ sessionBaseUrl: null })
})

describe('激活切换的缓存协议（非组件通道）', () => {
  it('激活返回视图直写 categories 键，会话档不随激活变化（地址跟随已退役）', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(['variable', 'categories', WORKSPACE], viewOf([], null))
    useVariableStore.getState().setSessionBaseUrl('http://manual:1')
    variableSetActiveCategory.mockResolvedValue(viewOf([category('c1')], 'c1'))

    await activateCategoryBy(queryClient, WORKSPACE, 'c1')
    expect(queryClient.getQueryData(['variable', 'categories', WORKSPACE])).toMatchObject({
      activeCategoryId: 'c1',
    })
    expect(useVariableStore.getState().sessionBaseUrl).toBe('http://manual:1')
  })
})

describe('变量域 mutation 组：删除分类的缓存协议', () => {
  /** 挂 hook（真实缓存协议，只替 IPC 边），返回 mutation 组与所用 QueryClient */
  function renderMutations() {
    const queryClient = new QueryClient()
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children)
    const result = renderHook(() => useVariableMutations(WORKSPACE), { wrapper })
    return { ...result, queryClient }
  }

  it('删除分类：返回视图直写 categories 键，被删分类的 variables 孤儿缓存清除', async () => {
    const { result, queryClient } = renderMutations()
    queryClient.setQueryData(
      ['variable', 'categories', WORKSPACE],
      viewOf([category('c1'), category('c2')], 'c1'),
    )
    queryClient.setQueryData(['variable', 'variables', 'c1'], { items: [] })
    queryClient.setQueryData(['variable', 'variables', 'c2'], { items: [] })
    variableDeleteCategory.mockResolvedValue(viewOf([category('c2')], null))

    await waitFor(() => {
      result.current.deleteCategoryMutation.mutate('c1')
      expect(result.current.deleteCategoryMutation.isSuccess).toBe(true)
    })
    // 新视图直写（后端返回的刷新清单）
    expect(queryClient.getQueryData(['variable', 'categories', WORKSPACE])).toMatchObject({
      items: [{ id: 'c2' }],
    })
    // 孤儿缓存移除；幸存分类的变量缓存保留
    expect(queryClient.getQueryData(['variable', 'variables', 'c1'])).toBeUndefined()
    expect(queryClient.getQueryData(['variable', 'variables', 'c2'])).toBeDefined()
  })
})
