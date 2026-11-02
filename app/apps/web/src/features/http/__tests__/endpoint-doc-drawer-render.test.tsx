import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchKeys } from '@/services/workbench-api'

import { EndpointDocDrawer } from '../endpoint-doc-drawer'
import type { EndpointDoc } from '../endpoint-doc-logic'

/**
 * 文档抽屉失效回流呈现：查询键走 workbenchKeys 单一事实源，同步应用按
 * 服务级前缀（endpointDocService）失效后，打开中的抽屉即时重取新
 * definition、关闭期间失效的重开也不食旧缓存（回归＝同步后抽屉仍呈旧
 * 数据）。抽屉分区装配与形态细节不入本测（见 endpoint-doc-drawer.test）。
 */

// —— IPC invoke 替换：endpoint.doc 命令回包按同步前 / 后切换 ——
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

/** 同步前定义：无请求体（抽屉呈「无请求体」占位） */
const OLD_DOC: EndpointDoc = {
  title: '创建订单',
  parameters: [],
  responses: [],
}

/** 同步后定义：补齐请求体骨架（body 字段区呈现） */
const NEW_DOC: EndpointDoc = {
  title: '创建订单',
  parameters: [],
  requestBody: {
    contentType: 'application/json',
    required: true,
    schema: {
      schemaType: 'object',
      truncated: false,
      required: ['name'],
      enumValues: [],
      properties: [
        [
          'name',
          { schemaType: 'string', truncated: false, required: [], enumValues: [], properties: [] },
        ],
      ],
    },
  },
  responses: [],
}

const PROPS = {
  onOpenChange: vi.fn(),
  focusReturnRef: { current: null },
  serviceId: 's1',
  key_: 'POST /orders',
  method: 'POST',
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
}

function draw(client: QueryClient, open: boolean) {
  return (
    <QueryClientProvider client={client}>
      <EndpointDocDrawer {...PROPS} open={open} />
    </QueryClientProvider>
  )
}

describe('接口文档抽屉失效回流', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('打开期间失效回流：抽屉即时呈现新 definition', async () => {
    invokeMock.mockResolvedValue(OLD_DOC)
    const queryClient = makeQueryClient()
    const view = render(draw(queryClient, true))

    // 同步前：旧缓存呈现「无请求体」
    await screen.findByText('无请求体')

    // 同步应用：endpoint.doc 换新 definition，按服务前缀失效（与 applyAll 同键）
    invokeMock.mockResolvedValue(NEW_DOC)
    await queryClient.invalidateQueries({ queryKey: workbenchKeys.endpointDocService('s1') })

    expect(await screen.findByTestId('endpoint-doc-body-fields')).toBeTruthy()
    expect(screen.getByText('name')).toBeTruthy()
    expect(screen.queryByText('无请求体')).toBeNull()
    view.unmount()
  })

  it('关闭期间失效：重开抽屉呈现新 definition（不食旧缓存）', async () => {
    invokeMock.mockResolvedValue(OLD_DOC)
    const queryClient = makeQueryClient()
    const view = render(draw(queryClient, true))
    await screen.findByText('无请求体')

    view.rerender(draw(queryClient, false))
    invokeMock.mockResolvedValue(NEW_DOC)
    await queryClient.invalidateQueries({ queryKey: workbenchKeys.endpointDocService('s1') })

    view.rerender(draw(queryClient, true))

    expect(await screen.findByTestId('endpoint-doc-body-fields')).toBeTruthy()
    expect(screen.queryByText('无请求体')).toBeNull()
    view.unmount()
  })

  it('请求体无文档 example 时按 schema 生成示例（响应侧同一回退先例）', async () => {
    invokeMock.mockResolvedValue(NEW_DOC)
    const queryClient = makeQueryClient()
    const view = render(draw(queryClient, true))

    expect(await screen.findByText('请求体示例')).toBeTruthy()
    // 生成示例含骨架字段（string 类型 → "string"）
    expect(screen.getAllByText('"string"').length).toBeGreaterThan(0)
    view.unmount()
  })
})
