import { fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

import { ExtractEditor } from '../canvas/data-editor'
import { NodeUpdateContext } from '../canvas/node-editing-context'
import { WorkflowIdContext } from '../canvas/workflow-id-context'
import { useWorkflowEditorStore } from '../workflow-editor.store'
import type { ExtractNodeConfig } from '../workflow-model'

// 测试环境无 IPC：写回分支挂的查询 hook（空间清单 / 分类 / 最近执行）统一拒绝
vi.mock('@/services/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ipc')>()
  return {
    ...actual,
    invoke: vi.fn().mockRejectedValue(new Error('no IPC in component tests')),
  }
})

/**
 * 参数提取编辑器（单来源多规则）：来源节点级选一次、规则块逐条编辑与增删
 * （可删空）、路径→产物名尾键联动逐规则生效（用户改过名不覆盖）、写回分支
 * 开关的缺省填充（写回值＝首个产物名、键＝值尾段）与写回值下拉列出全部产物
 * （产物集为空显空态提示）。
 */

function extractConfig(overrides?: Partial<ExtractNodeConfig>): ExtractNodeConfig {
  return {
    type: 'extract',
    source: 'jsonPath',
    rules: [{ path: '', name: '' }],
    writeback: {
      enabled: false,
      productPath: '',
      key: '',
      categoryName: null,
      secret: true,
    },
    ...overrides,
  }
}

function renderEditor(config: ExtractNodeConfig, onUpdate?: (next: ExtractNodeConfig) => void) {
  // 空编辑会话＝无上游图（实测下拉只显顶层产物；实测字段的拼装属查询
  // 数据面，由 extract-observed 纯函数测试覆盖）
  useWorkflowEditorStore.setState({ sessions: {} })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <WorkflowIdContext.Provider value="wf1">
        <NodeUpdateContext.Provider value={onUpdate ? () => onUpdate : () => {}}>
          <ExtractEditor nodeId="n1" config={config} onChange={onUpdate ?? (() => {})} />
        </NodeUpdateContext.Provider>
      </WorkflowIdContext.Provider>
    </QueryClientProvider>,
  )
}

describe('data-editor：单来源多规则', () => {
  it('来源字段＋规则块＋添加钮齐备：新建播种一条空规则', () => {
    renderEditor(extractConfig())
    expect(screen.getByTestId('workflow-extract-editor')).toBeInTheDocument()
    expect(screen.getByLabelText('来源')).toBeInTheDocument()
    expect(screen.getAllByTestId('workflow-extract-rule')).toHaveLength(1)
    expect(screen.getByLabelText('取值路径')).toBeInTheDocument()
    expect(screen.getByLabelText('产物名')).toBeInTheDocument()
    expect(screen.getByTestId('workflow-extract-rule-add')).toBeInTheDocument()
    expect(screen.getByTestId('workflow-extract-rule-remove')).toBeInTheDocument()
  })

  it('路径输入联动产物名缺省建议（空名同步尾键）', () => {
    const onUpdate = vi.fn()
    renderEditor(extractConfig(), onUpdate)
    fireEvent.change(screen.getByLabelText('取值路径'), { target: { value: '$.data.token' } })
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'jsonPath',
        rules: [{ path: '$.data.token', name: 'token' }],
      }),
    )
  })

  it('用户改过产物名后改路径不覆盖（非尾键名保留）', () => {
    const onUpdate = vi.fn()
    renderEditor(extractConfig({ rules: [{ path: '', name: 'custom' }] }), onUpdate)
    fireEvent.change(screen.getByLabelText('取值路径'), { target: { value: '$.data.token' } })
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        rules: [{ path: '$.data.token', name: 'custom' }],
      }),
    )
  })

  it('状态码源路径输入禁用', () => {
    renderEditor(extractConfig({ source: 'statusCode' }))
    expect(screen.getByLabelText('取值路径')).toBeDisabled()
  })

  it('添加规则：新空规则缀尾（既有规则原样）', () => {
    const onUpdate = vi.fn()
    renderEditor(extractConfig({ rules: [{ path: '$.token', name: 'token' }] }), onUpdate)
    fireEvent.click(screen.getByTestId('workflow-extract-rule-add'))
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        rules: [
          { path: '$.token', name: 'token' },
          { path: '', name: '' },
        ],
      }),
    )
  })

  it('删除规则可删空（rules 空数组，校验面板兜底）', () => {
    const onUpdate = vi.fn()
    renderEditor(extractConfig({ rules: [{ path: '$.token', name: 'token' }] }), onUpdate)
    fireEvent.click(screen.getByTestId('workflow-extract-rule-remove'))
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ rules: [] }))
  })

  it('路径尾键联动逐规则生效（改第二条不动第一条）', () => {
    const onUpdate = vi.fn()
    renderEditor(
      extractConfig({
        rules: [
          { path: '$.token', name: 'token' },
          { path: '$.data', name: 'data' },
        ],
      }),
      onUpdate,
    )
    const secondRule = screen.getAllByTestId('workflow-extract-rule')[1]
    fireEvent.change(within(secondRule!).getByLabelText('取值路径'), {
      target: { value: '$.data.token2' },
    })
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        rules: [
          { path: '$.token', name: 'token' },
          { path: '$.data.token2', name: 'token2' },
        ],
      }),
    )
  })
})

describe('data-editor：规则区形态与批量编辑', () => {
  it('规则区限高滚动容器在位（多条规则同容器）', () => {
    renderEditor(
      extractConfig({
        rules: [
          { path: '$.token', name: 'token' },
          { path: '$.data', name: 'data' },
        ],
      }),
    )
    const container = screen.getByTestId('workflow-extract-rules')
    expect(within(container).getAllByTestId('workflow-extract-rule')).toHaveLength(2)
  })

  it('批量编辑进入：textarea 以「产物名: 取值路径」播种（空名规则不进种子）', () => {
    renderEditor(
      extractConfig({
        rules: [
          { path: '$.token', name: 'token' },
          { path: '', name: '' },
        ],
      }),
    )
    fireEvent.click(screen.getByTestId('workflow-extract-bulk-edit'))
    const textarea = screen.getByTestId('workflow-extract-bulk-textarea')
    expect(textarea).toHaveValue('token: $.token')
    // 规则块与添加钮被文本模式替换
    expect(screen.queryByTestId('workflow-extract-rule')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workflow-extract-rule-add')).not.toBeInTheDocument()
  })

  it('批量编辑应用：同名产物仅更新路径、新行缀尾、未提及行保留（空名行不进基线）', () => {
    const onUpdate = vi.fn()
    renderEditor(
      extractConfig({
        rules: [
          { path: '$.token', name: 'token' },
          { path: '$.stale', name: 'stale' },
        ],
      }),
      onUpdate,
    )
    fireEvent.click(screen.getByTestId('workflow-extract-bulk-edit'))
    fireEvent.change(screen.getByTestId('workflow-extract-bulk-textarea'), {
      target: { value: 'token: $.data.token\ntokenType: $.tokenType' },
    })
    fireEvent.click(screen.getByTestId('workflow-extract-bulk-apply'))
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        rules: [
          { path: '$.data.token', name: 'token' },
          { path: '$.stale', name: 'stale' },
          { path: '$.tokenType', name: 'tokenType' },
        ],
      }),
    )
  })

  it('批量编辑取消：数据不动，回到规则块模式', () => {
    const onUpdate = vi.fn()
    renderEditor(extractConfig({ rules: [{ path: '$.token', name: 'token' }] }), onUpdate)
    fireEvent.click(screen.getByTestId('workflow-extract-bulk-edit'))
    fireEvent.change(screen.getByTestId('workflow-extract-bulk-textarea'), {
      target: { value: 'token: $.changed' },
    })
    fireEvent.click(screen.getByTestId('workflow-extract-bulk-cancel'))
    expect(onUpdate).not.toHaveBeenCalled()
    expect(screen.getByTestId('workflow-extract-rule')).toBeInTheDocument()
  })

  it('路径无语义来源（状态码）不出批量编辑入口', () => {
    renderEditor(extractConfig({ source: 'statusCode' }))
    expect(screen.queryByTestId('workflow-extract-bulk-edit')).not.toBeInTheDocument()
  })
})

describe('data-editor：写回分支', () => {
  it('存变量与敏感值开关同行：写回关闭时敏感开关禁用，开启后可用', () => {
    const { unmount } = renderEditor(extractConfig({ rules: [{ path: '$.token', name: 'token' }] }))
    // Base UI Switch 的禁用面＝aria-disabled / data-disabled（非原生 disabled 属性）
    const secret = screen.getByTestId('workflow-extract-writeback-secret')
    expect(secret).toHaveAttribute('aria-disabled', 'true')
    // 两开关同处一行容器
    const row = screen.getByTestId('workflow-extract-writeback-switch').closest('div')
    expect(within(row!).getByTestId('workflow-extract-writeback-secret')).toBe(secret)
    unmount()
    renderEditor(
      extractConfig({
        rules: [{ path: '$.token', name: 'token' }],
        writeback: {
          enabled: true,
          productPath: 'token',
          key: 'token',
          categoryName: null,
          secret: true,
        },
      }),
    )
    expect(screen.getByTestId('workflow-extract-writeback-secret')).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('存变量开关开启：写回值缺省取首个产物、键缺省取值尾段（secret 默认开）', () => {
    const onUpdate = vi.fn()
    renderEditor(
      extractConfig({
        rules: [
          { path: '$.token', name: 'token' },
          { path: '$.tokenType', name: 'tokenType' },
        ],
      }),
      onUpdate,
    )
    fireEvent.click(screen.getByTestId('workflow-extract-writeback-switch'))
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        writeback: expect.objectContaining({
          enabled: true,
          productPath: 'token',
          key: 'token',
          secret: true,
        }),
      }),
    )
  })

  it('写回分支展开：写回值下拉 / 目标分类下拉在位，变量键字段退场', () => {
    renderEditor(
      extractConfig({
        rules: [{ path: '$.data', name: 'data' }],
        writeback: {
          enabled: true,
          productPath: 'data',
          key: 'data',
          categoryName: null,
          secret: true,
        },
      }),
    )
    // 分支展开（enabled=true）：写回值下拉与目标分类下拉在位（实测字段选项
    // 的拼装属查询数据面，由 extract-observed 纯函数测试覆盖）
    expect(screen.getByTestId('workflow-extract-writeback-product')).toBeInTheDocument()
    expect(screen.getByTestId('workflow-extract-writeback-category')).toBeInTheDocument()
    expect(screen.queryByTestId('workflow-extract-writeback-key')).not.toBeInTheDocument()
    // 「执行到本节点即写回…」提示段已删除
    expect(screen.queryByText(/执行到本节点即写回/)).not.toBeInTheDocument()
  })

  it('写回值下拉顶层选项列出全部产物（多规则逐项）', async () => {
    renderEditor(
      extractConfig({
        rules: [
          { path: '$.token', name: 'token' },
          { path: '$.tokenType', name: 'tokenType' },
        ],
        writeback: {
          enabled: true,
          productPath: 'token',
          key: 'token',
          categoryName: null,
          secret: true,
        },
      }),
    )
    // Base UI Select：纯 click 开弹层（与 request-editor 测试同款交互）
    fireEvent.click(screen.getByTestId('workflow-extract-writeback-product'))
    await vi.waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())
    await vi.waitFor(() => {
      // getByRole 的字符串名按全串匹配：token 不会命中 tokenType
      expect(screen.getByRole('option', { name: 'token' })).toBeInTheDocument()
      expect(screen.getByRole('option', { name: 'tokenType' })).toBeInTheDocument()
    })
  })

  it('产物集为空（规则全空名）＝写回值无可选产物：显空态提示（Select 不渲染）', () => {
    renderEditor(extractConfig({ writeback: { ...extractConfig().writeback, enabled: true } }))
    expect(screen.getByTestId('workflow-extract-writeback-product-empty')).toHaveTextContent(
      '先填写产物名',
    )
    expect(screen.queryByTestId('workflow-extract-writeback-product')).not.toBeInTheDocument()
  })
})
