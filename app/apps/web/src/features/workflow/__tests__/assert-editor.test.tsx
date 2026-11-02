import * as React from 'react'

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AssertEditor } from '../canvas/assert-editor'
import type { AssertRule } from '../workflow-model'

/**
 * 断言规则类型切换的字段保留：切换只重建形态骨架，同名字段不静默丢弃——
 * expected 跨 statusCode/jsonPath 保留、path 跨 jsonPath/exists/contains
 * 保留；exists 无 expected/value 字段，切入前暂存原形态、切回时还原，
 * 且 exists 上改过的 path 恒以当前值为准。
 */

/** 受控包装：宿主（画布编辑会话）以受控回环呈现，切换结果经 props 回读 */
function ControlledAssertEditor({
  initialRules,
  onChange,
}: {
  initialRules: AssertRule[]
  onChange?: (rules: AssertRule[]) => void
}) {
  const [rules, setRules] = React.useState(initialRules)
  return (
    <AssertEditor
      config={{ type: 'assert', rules }}
      onChange={(next) => {
        setRules(next.rules)
        onChange?.(next.rules)
      }}
    />
  )
}

/** 打开规则行的类型选择器（弹层经 Portal 挂载） */
async function openTypeSelect() {
  fireEvent.click(screen.getByRole('combobox'))
  await vi.waitFor(() => {
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })
}

/** 选中弹层中指定选项（Base UI 对未经指针按下的纯 click 视为无效） */
async function pickOption(name: string) {
  const option = await vi.waitFor(() => screen.getByRole('option', { name }))
  fireEvent.pointerDown(option)
  fireEvent.click(option)
}

/** 一次完整的类型切换（打开＋选中） */
async function switchType(name: string) {
  await openTypeSelect()
  await pickOption(name)
}

describe('断言规则类型切换字段保留', () => {
  it('状态码切 JSONPath：expected 同名保留，不静默丢弃', async () => {
    const onChange = vi.fn()
    render(
      <ControlledAssertEditor
        initialRules={[{ type: 'statusCode', expected: '404' }]}
        onChange={onChange}
      />,
    )
    await switchType('JSONPath 期望值')
    expect(onChange).toHaveBeenLastCalledWith([{ type: 'jsonPath', path: '', expected: '404' }])
    expect(screen.getByPlaceholderText('期望值')).toHaveValue('404')
  })

  it('状态码往返 exists：expected 不丢（切入暂存、切回还原）', async () => {
    render(<ControlledAssertEditor initialRules={[{ type: 'statusCode', expected: '404' }]} />)
    await switchType('存在')
    // exists 形态无期望值输入，仅剩路径输入（path 无同名可带，落空默认）
    expect(screen.queryByPlaceholderText('如 200')).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('如 $.data.token')).toHaveValue('')
    await switchType('状态码等于')
    expect(screen.getByPlaceholderText('如 200')).toHaveValue('404')
  })

  it('JSONPath 往返 exists：path 与 expected 均还原', async () => {
    render(
      <ControlledAssertEditor
        initialRules={[{ type: 'jsonPath', path: '$.data.token', expected: 'abc' }]}
      />,
    )
    await switchType('存在')
    // path 为同名字段，切入 exists 即直带，不依赖暂存
    expect(screen.getByPlaceholderText('如 $.data.token')).toHaveValue('$.data.token')
    await switchType('JSONPath 期望值')
    expect(screen.getByPlaceholderText('如 $.data.token')).toHaveValue('$.data.token')
    expect(screen.getByPlaceholderText('期望值')).toHaveValue('abc')
  })

  it('exists 上改过 path 再切回：当前 path 优先，expected 仍自暂存还原', async () => {
    render(
      <ControlledAssertEditor initialRules={[{ type: 'jsonPath', path: '$.a', expected: 'x' }]} />,
    )
    await switchType('存在')
    fireEvent.change(screen.getByPlaceholderText('如 $.data.token'), {
      target: { value: '$.b' },
    })
    await switchType('JSONPath 期望值')
    expect(screen.getByPlaceholderText('如 $.data.token')).toHaveValue('$.b')
    expect(screen.getByPlaceholderText('期望值')).toHaveValue('x')
  })

  it('包含往返 exists：value 与 path 均还原', async () => {
    render(
      <ControlledAssertEditor initialRules={[{ type: 'contains', path: '$.note', value: 'ok' }]} />,
    )
    await switchType('存在')
    expect(screen.getByPlaceholderText('如 $.data.token')).toHaveValue('$.note')
    await switchType('包含')
    expect(screen.getByPlaceholderText('取值路径（留空查响应体）')).toHaveValue('$.note')
    expect(screen.getByPlaceholderText('包含文本')).toHaveValue('ok')
  })

  it('包含切状态码：无同名 expected 可带，落类型默认 200（与新增行默认一致）', async () => {
    const onChange = vi.fn()
    render(
      <ControlledAssertEditor
        initialRules={[{ type: 'contains', path: null, value: 'ok' }]}
        onChange={onChange}
      />,
    )
    await switchType('状态码等于')
    expect(onChange).toHaveBeenLastCalledWith([{ type: 'statusCode', expected: '200' }])
  })
})
