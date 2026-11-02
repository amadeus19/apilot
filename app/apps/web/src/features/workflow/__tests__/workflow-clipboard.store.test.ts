import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkflowClipboardStore } from '../workflow-clipboard.store'
import type { WorkflowGraph } from '../workflow-model'

/** 应用内剪贴板会话态：单槽覆盖、可清空、不持久化（不写 localStorage、
 * 不碰系统剪贴板——重启即失效是「纯内存态」的直接推论）。 */
function graph(tag: string): WorkflowGraph {
  return {
    schemaVersion: 1,
    nodes: [
      { id: 'n1', name: tag, position: { x: 0, y: 0 }, config: { type: 'start' } },
      {
        id: 'n2',
        name: '请求',
        position: { x: 1, y: 0 },
        config: {
          type: 'request',
          endpointKey: 'GET /healthz',
          query: [],
          pathParams: [],
          body: null,
          timeoutMs: null,
        },
      },
    ],
    edges: [{ id: 'e1', source: 'n1', target: 'n2', label: null }],
  }
}

beforeEach(() => {
  useWorkflowClipboardStore.setState({ entry: null })
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('workflow clipboard store：应用内剪贴板会话态', () => {
  it('初始为空；copy 写入后可读，后写覆盖先写（单槽）', () => {
    expect(useWorkflowClipboardStore.getState().entry).toBeNull()

    useWorkflowClipboardStore.getState().copy({ name: '登录链', graph: graph('a') })
    let entry = useWorkflowClipboardStore.getState().entry
    expect(entry?.name).toBe('登录链')
    expect(entry?.graph.nodes[0]?.name).toBe('a')

    useWorkflowClipboardStore.getState().copy({ name: '支付链', graph: graph('b') })
    entry = useWorkflowClipboardStore.getState().entry
    expect(entry?.name).toBe('支付链')
    expect(entry?.graph.nodes[0]?.name).toBe('b')
  })

  it('clear 清空剪贴板（粘贴入口随之置灰）', () => {
    useWorkflowClipboardStore.getState().copy({ name: '链', graph: graph('a') })
    useWorkflowClipboardStore.getState().clear()
    expect(useWorkflowClipboardStore.getState().entry).toBeNull()
  })

  it('copy 不写 localStorage（会话态不入库，重启即失效）', () => {
    useWorkflowClipboardStore.getState().copy({ name: '登录链', graph: graph('a') })
    expect(localStorage.length).toBe(0)
  })

  it('copy 不碰系统剪贴板（不写系统剪贴板是跨空间复制的产品承诺）', () => {
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    useWorkflowClipboardStore.getState().copy({ name: '登录链', graph: graph('a') })
    expect(writeText).not.toHaveBeenCalled()
  })

  it('载荷持图引用且不被后续编辑波及（不可变更新纪律下的浅持有）', () => {
    const source = graph('a')
    useWorkflowClipboardStore.getState().copy({ name: '链', graph: source })
    // 模拟后续编辑：applyGraph 语义＝整图替换，旧引用保持原样
    const edited: WorkflowGraph = {
      ...source,
      nodes: [
        ...source.nodes,
        {
          id: 'n3',
          name: '新节点',
          position: { x: 2, y: 0 },
          config: { type: 'end' },
        },
      ],
    }
    expect(edited.nodes).toHaveLength(3)
    expect(useWorkflowClipboardStore.getState().entry?.graph.nodes).toHaveLength(2)
  })
})
