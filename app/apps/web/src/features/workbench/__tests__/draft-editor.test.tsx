import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryWrapper } from '@/test/render-providers'
import { makeEndpointNodeId } from '@/lib/tree-identity'
import { useTabsStore, type TabMeta } from '@/stores/tabs.store'
import { useDraftStore, type EndpointDraftData } from '../draft.store'
import { DraftEditor } from '../draft-editor'

// —— IPC invoke 替换：按命令名分派 ——
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

// Monaco 底座替换（jsdom 不真渲染编辑器）：textarea 承载 value/onChange
vi.mock('@/features/http/monaco-text-editor', async () => {
  const React = await import('react')
  function Editor(props: {
    value?: string
    onChange?: (value: string) => void
    variableSuggest?: { workspaceId: string } | null
  }) {
    return React.createElement('textarea', {
      'data-testid': 'editor-body-input',
      'data-suggest-workspace': props.variableSuggest?.workspaceId ?? '',
      value: props.value ?? '',
      onChange: (event: { target: { value: string } }) => props.onChange?.(event.target.value),
    })
  }
  return { MonacoTextEditor: Editor }
})

const TREE = {
  workspaceId: 'w1',
  services: [
    {
      id: 's1',
      name: '用户服务',
      docUrl: null,
      docType: 'openapi',
      sortOrder: 0,
      categories: [],
      endpoints: [] as unknown[],
    },
  ],
}

/** 新建草稿（endpoint.create_manual 桩身份自增） */
let createdCount = 0
/** user_data.upsert 捕获的整包 */
let upserted: Record<string, unknown> | null = null

function stubInvokes() {
  invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'workspace.list') {
      return Promise.resolve({
        items: [{ id: 'w1', name: '默认工作空间', baseUrl: null, auth: null, isCurrent: true }],
        currentId: 'w1',
      })
    }
    if (cmd === 'tree.get') return Promise.resolve(TREE)
    if (cmd === 'endpoint.create_manual') {
      createdCount += 1
      const input = args?.args as { serviceId: string; title: string }
      return Promise.resolve({
        serviceId: input.serviceId,
        key: `new-key-${createdCount}`,
        title: input.title,
        categoryId: null,
        definition: { method: 'POST', pathTemplate: '/orders' },
        isManual: true,
      })
    }
    if (cmd === 'user_data.upsert') {
      upserted = { ...(args?.args as Record<string, unknown>) }
      return Promise.resolve({ serviceId: 's1', key: 'new-key-1' })
    }
    return Promise.resolve(undefined)
  })
}

function makeData(overrides?: Partial<EndpointDraftData>): EndpointDraftData {
  return {
    method: 'GET',
    pathTemplate: 'https://other.test/v1/orders',
    paramsJson: '[{"name":"verbose","value":"true"}]',
    headersJson:
      '[{"name":"accept","value":"*/*"},{"name":"authorization","value":"Bearer t"},{"name":"x-custom-key","value":"my-api-key"}]',
    body: '{"kind":"json","text":"{\\"a\\":1}"}',
    bodyTruncated: false,
    sensitiveHeaderNames: ['x-custom-key'],
    sourceServiceId: 's1',
    ...overrides,
  }
}

/** 全链路播种：openDraft → seed → 返回 TabMeta */
function seedDraftTab(data: EndpointDraftData): TabMeta {
  const id = useTabsStore.getState().openDraft(`${data.method} ${data.pathTemplate}`)
  useDraftStore.getState().seedDraft(id, data)
  return useTabsStore.getState().tabs.find((tab) => tab.id === id)!
}

beforeEach(() => {
  invokeMock.mockReset()
  stubInvokes()
  createdCount = 0
  upserted = null
  useTabsStore.setState({ tabs: [], activeTabId: null, editorTabs: {} })
  useDraftStore.setState({ drafts: {} })
})

/** 等转正落点判定所依赖的树查询链就绪（workspaces → tree 两段） */
async function waitForTreeReady(): Promise<void> {
  await waitFor(() => {
    const cmds = invokeMock.mock.calls.map(([cmd]) => cmd)
    expect(cmds).toContain('workspace.list')
    expect(cmds).toContain('tree.get')
  })
}

describe('草稿编辑器：无实体草稿装载', () => {
  it('URL 行呈现方法与模板；另存为新接口按钮可用', async () => {
    const tab = seedDraftTab(makeData())
    render(<DraftEditor tab={tab} />, { wrapper: createQueryWrapper() })
    expect(await screen.findByTestId('draft-save-as-endpoint')).toBeEnabled()
    expect(screen.getByDisplayValue('https://other.test/v1/orders')).toBeInTheDocument()
    // 顶部说明（无面包屑定位——草稿无实体）
    expect(screen.getByTestId('draft-editor-header')).toHaveTextContent('从历史恢复的草稿')
  })

  it('模板形态非法（含空白 / 查询串）：另存按钮禁用（明显非法值不发起写）', async () => {
    const tab = seedDraftTab(makeData({ pathTemplate: 'https://x.test/a b' }))
    render(<DraftEditor tab={tab} />, { wrapper: createQueryWrapper() })
    expect(await screen.findByTestId('draft-save-as-endpoint')).toBeDisabled()

    fireEvent.change(screen.getByLabelText('路径模板'), { target: { value: '/a?x=1' } })
    expect(screen.getByTestId('draft-save-as-endpoint')).toBeDisabled()

    fireEvent.change(screen.getByLabelText('路径模板'), { target: { value: '/a/b' } })
    expect(screen.getByTestId('draft-save-as-endpoint')).toBeEnabled()
  })

  it('敏感头按名单掩码显示（值保留）：揭示后显示真值可编辑', async () => {
    const tab = seedDraftTab(makeData())
    render(<DraftEditor tab={tab} />, { wrapper: createQueryWrapper() })
    await screen.findByTestId('draft-editor-form')
    fireEvent.click(screen.getByRole('tab', { name: 'Headers' }))

    // 标准名单（authorization）＋快照 redactions 提示（x-custom-key）掩码；
    // 普通头原样；掩码值只读
    const masked = screen.getAllByDisplayValue('***')
    expect(masked).toHaveLength(2)
    expect(masked.every((input) => input.hasAttribute('readonly'))).toBe(true)
    expect(screen.getByDisplayValue('*/*')).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: '显示敏感值' }))
    expect(screen.getByDisplayValue('Bearer t')).toBeEnabled()
    expect(screen.getByDisplayValue('my-api-key')).toBeEnabled()
  })

  it('body 超出快照保留范围：Body 页签顶部截断提示', async () => {
    const tab = seedDraftTab(makeData({ bodyTruncated: true }))
    render(<DraftEditor tab={tab} />, { wrapper: createQueryWrapper() })
    await screen.findByTestId('draft-editor-form')
    fireEvent.click(screen.getByRole('tab', { name: 'Body' }))
    expect(screen.getByTestId('draft-body-truncated')).toHaveTextContent('请求体超出快照保留范围')
  })

  it('body 编辑器启用变量联想：variableSuggest 传当前工作空间 id', async () => {
    const tab = seedDraftTab(makeData())
    render(<DraftEditor tab={tab} />, { wrapper: createQueryWrapper() })
    await screen.findByTestId('draft-editor-form')
    fireEvent.click(screen.getByRole('tab', { name: 'Body' }))
    expect(await screen.findByTestId('editor-body-input')).toHaveAttribute(
      'data-suggest-workspace',
      'w1',
    )
  })
})

describe('草稿编辑器：另存为新接口（转正原语）', () => {
  it('点击另存：建实体（绝对模板未分类）→ 写用户数据整包 → Tab 换装为常驻接口', async () => {
    const tab = seedDraftTab(makeData())
    render(<DraftEditor tab={tab} />, { wrapper: createQueryWrapper() })
    await waitForTreeReady()
    fireEvent.click(await screen.findByTestId('draft-save-as-endpoint'))

    await waitFor(() => {
      // Tab 换装：草稿 Tab 消失，新接口 Tab 常驻激活
      const state = useTabsStore.getState()
      expect(state.tabs.map((meta) => meta.kind)).toEqual(['endpoint'])
      expect(state.activeTabId).toBe(makeEndpointNodeId('s1', 'new-key-1'))
    })
    // 草稿条目随收缩信号清理
    expect(useDraftStore.getState().drafts).toEqual({})

    // 实体落库参数：当前服务（来源服务命中）下未分类，绝对模板与标题原样
    const createArgs = invokeMock.mock.calls.find(
      ([cmd]) => cmd === 'endpoint.create_manual',
    )?.[1] as { args: Record<string, unknown> }
    expect(createArgs.args).toMatchObject({
      serviceId: 's1',
      method: 'GET',
      pathTemplate: 'https://other.test/v1/orders',
      categoryId: null,
    })
    // 用户数据整包：草稿五列（超时 / 认证不随草稿）
    expect(upserted).toMatchObject({
      serviceId: 's1',
      key: 'new-key-1',
      body: '{"kind":"json","text":"{\\"a\\":1}"}',
      params: '[{"name":"verbose","value":"true"}]',
      timeoutSeconds: null,
      auth: null,
    })
  })

  it('来源服务已删：回落树首个服务落库', async () => {
    const tab = seedDraftTab(makeData({ sourceServiceId: 'gone' }))
    render(<DraftEditor tab={tab} />, { wrapper: createQueryWrapper() })
    await waitForTreeReady()
    fireEvent.click(await screen.findByTestId('draft-save-as-endpoint'))

    await waitFor(() => {
      expect(useTabsStore.getState().tabs.map((meta) => meta.kind)).toEqual(['endpoint'])
    })
    const createArgs = invokeMock.mock.calls.find(
      ([cmd]) => cmd === 'endpoint.create_manual',
    )?.[1] as { args: Record<string, unknown> }
    expect(createArgs.args).toMatchObject({ serviceId: 's1' })
  })
})
