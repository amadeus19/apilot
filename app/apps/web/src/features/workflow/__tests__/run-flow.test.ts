import { vi, describe, beforeEach, it, expect } from 'vitest'

import { toastStore, toast } from '@workspace/ui/components'

import { executeWorkflowGuarded } from '../run-flow'
import { workflowExecute, workflowValidate, type WorkflowExecutionDto } from '../workflow-api'

// workflow-api 换替身（保留 workflowKeys / issuesFromRejection 真实形状——
// 失效匹配依赖键一致）；被测对象是终态 toast 分发
vi.mock('../workflow-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workflow-api')>()
  return {
    ...actual,
    workflowValidate: vi.fn(),
    workflowExecute: vi.fn(),
  }
})

/** 终态执行记录桩（toast 分发只消费 status） */
function record(status: WorkflowExecutionDto['status']): WorkflowExecutionDto {
  return {
    id: 'wexec_1',
    workflowId: 'wf1',
    status,
    startedAt: 't0',
    completedAt: 't1',
    durationMs: 12,
    errorCode: null,
    errorMessage: null,
    nodes: [],
  }
}

/** 清空 toast 缓冲（有界缓冲单例，用例间互不串扰） */
function drainToasts(): void {
  for (const item of toastStore.getSnapshot()) toast.dismiss(item.id)
}

describe('run-flow：执行终态 toast（清单行不设历史结果徽标的完成反馈出口）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    drainToasts()
    vi.mocked(workflowValidate).mockResolvedValue([])
  })

  it('passed：右下角 success toast 携带工作流名', async () => {
    vi.mocked(workflowExecute).mockResolvedValue(record('passed'))
    executeWorkflowGuarded({ workflowId: 'wf1', name: '登录链', onIssues: vi.fn() })
    await vi.waitFor(() => {
      expect(toastStore.getSnapshot().some((item) => item.kind === 'success')).toBe(true)
    })
    expect(
      toastStore.getSnapshot().some((item) => item.message === '工作流「登录链」执行通过'),
    ).toBe(true)
  })

  it('failed：error toast 携带工作流名（断言失败等业务失败非调用异常）', async () => {
    vi.mocked(workflowExecute).mockResolvedValue(record('failed'))
    executeWorkflowGuarded({ workflowId: 'wf1', name: '断言链', onIssues: vi.fn() })
    await vi.waitFor(() => {
      expect(
        toastStore
          .getSnapshot()
          .some((item) => item.kind === 'error' && item.message === '工作流「断言链」执行失败'),
      ).toBe(true)
    })
  })

  it('cancelled：不弹提示（用户主动停止，无需完成反馈）', async () => {
    vi.mocked(workflowExecute).mockResolvedValue(record('cancelled'))
    executeWorkflowGuarded({ workflowId: 'wf1', name: '慢链', onIssues: vi.fn() })
    await vi.waitFor(() => {
      expect(workflowExecute).toHaveBeenCalledWith('wf1')
    })
    // 微任务链走完（记录对齐已执行）后仍无 toast
    await Promise.resolve()
    await Promise.resolve()
    expect(toastStore.getSnapshot()).toHaveLength(0)
  })

  it('校验问题非空：不启动执行、无 toast', async () => {
    vi.mocked(workflowValidate).mockResolvedValue([
      { code: 'missingStart', message: '缺少开始节点' },
    ])
    const onIssues = vi.fn()
    executeWorkflowGuarded({ workflowId: 'wf1', name: '登录链', onIssues })
    await Promise.resolve()
    expect(onIssues).toHaveBeenCalled()
    expect(workflowExecute).not.toHaveBeenCalled()
    expect(toastStore.getSnapshot()).toHaveLength(0)
  })
})
