import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'

import { ValidationPanel } from '../canvas/validation-panel'
import type { WorkflowIssueDto } from '../workflow-api'

/**
 * 校验错误清单面板体：逐条行（节点名插值）、节点行点击定位、图级行纯
 * 展示、未知 code 回落 message 原文、无问题不渲染。标题行与计数徽标归
 * 控制台容器（bottom-console.test.tsx 覆盖）。
 */

const NODE_NAMES = new Map([
  ['n1', '登录'],
  ['n2', '查询'],
])

function renderPanel(issues: readonly WorkflowIssueDto[], onLocate = vi.fn()) {
  render(<ValidationPanel issues={issues} nodeNames={NODE_NAMES} onLocate={onLocate} />)
  return onLocate
}

describe('校验错误清单面板', () => {
  it('无问题不渲染（不占画布空间）', () => {
    renderPanel([])
    expect(screen.queryByTestId('workflow-validation-panel')).not.toBeInTheDocument()
  })

  it('逐条行按词典渲染（节点名插值）', () => {
    renderPanel([
      {
        code: 'requestUnbound',
        nodeId: 'n1',
        message: 'request node is not bound to an endpoint: n1',
      },
      { code: 'missingStart', message: 'workflow has no Start node' },
    ])
    expect(screen.getByText('请求节点「登录」未绑定接口')).toBeInTheDocument()
    expect(screen.getByText('缺少开始节点')).toBeInTheDocument()
  })

  it('节点问题行点击定位对应节点；图级行（无 nodeId）点击不定位', async () => {
    const user = userEvent.setup()
    const onLocate = renderPanel([
      {
        code: 'requestInvalidRef',
        nodeId: 'n2',
        message: 'referenced endpoint not found: GET /gone',
      },
      { code: 'missingStart', message: 'workflow has no Start node' },
    ])
    await user.click(screen.getByText('请求节点「查询」引用的接口不存在'))
    expect(onLocate).toHaveBeenCalledWith('n2')
    onLocate.mockClear()
    await user.click(screen.getByText('缺少开始节点'))
    expect(onLocate).not.toHaveBeenCalled()
  })

  it('未知 code 回落 message 原文（词表演进不冒充已知态）', () => {
    renderPanel([{ code: 'futureIssue', nodeId: 'n1', message: 'something new went wrong' }])
    expect(screen.getByText('something new went wrong')).toBeInTheDocument()
  })
})
