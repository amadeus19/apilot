import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@/stores/app.store'
import { createQueryWrapper } from '@/test/render-providers'

import { HeaderVariableButton } from '../header-variable-button'

// —— IPC invoke 替换：分类 / 变量清单走桩存储，创建 / 更新记录调用 ——
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

let stubActiveCategoryId: string | null
let stubVariables: { key: string; value: string; secret: boolean }[]
const createdCalls: { categoryId: string; key: string; value: string; secret: boolean }[] = []
const updatedCalls: { categoryId: string; key: string; value: string; secret: boolean }[] = []

function stubInvokes() {
  invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'variable.list_categories')
      return Promise.resolve({
        items: [
          { id: 'c1', name: '开发', isGlobal: false, sortOrder: 0 },
          { id: 'g1', name: '全局', isGlobal: true, sortOrder: 1 },
        ],
        activeCategoryId: stubActiveCategoryId,
      })
    if (cmd === 'variable.list_variables') return Promise.resolve({ items: stubVariables })
    if (cmd === 'variable.create_variable') {
      createdCalls.push({
        categoryId: args?.categoryId as string,
        key: args?.key as string,
        value: args?.value as string,
        secret: args?.secret as boolean,
      })
      return Promise.resolve({ items: stubVariables })
    }
    if (cmd === 'variable.update_variable') {
      updatedCalls.push({
        categoryId: args?.categoryId as string,
        key: args?.key as string,
        value: args?.value as string,
        secret: args?.secret as boolean,
      })
      return Promise.resolve({ items: stubVariables })
    }
    return Promise.resolve(undefined)
  })
}

function renderButton(defaultSecret = false) {
  return render(
    <HeaderVariableButton
      workspaceId="w1"
      headerName="X-Request-Id"
      headerValue="abc-123"
      defaultSecret={defaultSecret}
    />,
    { wrapper: createQueryWrapper() },
  )
}

/** 打开浮层并等到首个内容控件出现（分类视图异步加载，表单随后填充） */
async function openPopover(contentTestId: string) {
  fireEvent.click(screen.getByTestId('header-save-variable-trigger'))
  await waitFor(() => expect(screen.getByTestId(contentTestId)).toBeInTheDocument())
}

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.getState().setLeftView('apis')
  stubActiveCategoryId = 'c1'
  stubVariables = [{ key: 'X-Token', value: 'old', secret: true }]
  createdCalls.length = 0
  updatedCalls.length = 0
  stubInvokes()
})

describe('响应头「存为变量」浮层', () => {
  it('key 名即触发器：悬浮高亮主题色（可点击无图标形态）', async () => {
    renderButton(false)
    const trigger = screen.getByTestId('header-save-variable-trigger')
    expect(trigger).toHaveTextContent('X-Request-Id')
    expect(trigger.className).toContain('hover:text-primary')
    expect(trigger.querySelector('svg')).toBeNull()
  })

  it('变量名预填 header 名；敏感头默认勾 Secret', async () => {
    renderButton(true)
    await openPopover('header-save-variable-key')
    expect(screen.getByTestId('header-save-variable-key')).toHaveValue('X-Request-Id')
    expect(screen.getByTestId('header-save-variable-secret')).toHaveAttribute('data-checked')
    cleanup()
  })

  it('非敏感头默认不勾 Secret', async () => {
    renderButton(false)
    await openPopover('header-save-variable-secret')
    expect(screen.getByTestId('header-save-variable-secret')).not.toHaveAttribute('data-checked')
  })

  it('新名保存走 create_variable（分类＝激活分类，值＝响应头明文）', async () => {
    renderButton(false)
    await openPopover('header-save-variable-submit')
    fireEvent.click(screen.getByTestId('header-save-variable-submit'))
    await waitFor(() => expect(createdCalls).toHaveLength(1))
    expect(createdCalls[0]).toEqual({
      categoryId: 'c1',
      key: 'X-Request-Id',
      value: 'abc-123',
      secret: false,
    })
    expect(updatedCalls).toHaveLength(0)
  })

  it('同名保存走 update_variable 并呈现更新提示', async () => {
    stubVariables = [
      { key: 'X-Request-Id', value: 'old', secret: false },
      { key: 'X-Token', value: 't', secret: true },
    ]
    renderButton(false)
    await openPopover('header-save-variable-submit')
    // 分类内清单在激活分类解析后异步到达，更新提示随之出现
    await waitFor(() =>
      expect(screen.getByText('同名变量已存在，保存将更新其值')).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByTestId('header-save-variable-submit'))
    await waitFor(() => expect(updatedCalls).toHaveLength(1))
    expect(updatedCalls[0]).toEqual({
      categoryId: 'c1',
      key: 'X-Request-Id',
      value: 'abc-123',
      secret: false,
    })
    expect(createdCalls).toHaveLength(0)
  })

  it('无激活分类：不出表单，提示并引导切左栏变量视图', async () => {
    stubActiveCategoryId = null
    renderButton(false)
    await openPopover('header-save-variable-open-variables')
    expect(screen.queryByTestId('header-save-variable-submit')).not.toBeInTheDocument()
    expect(screen.getByText('当前无激活分类，请先激活一个分类再保存')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('header-save-variable-open-variables'))
    expect(useAppStore.getState().leftView).toBe('variables')
  })
})
