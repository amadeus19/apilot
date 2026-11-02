import { fireEvent, render, screen } from '@testing-library/react'
import { createRef, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EndpointSettingsDrawer } from '../endpoint-settings-drawer'

/**
 * 抽屉纯呈现层测试：超时行三态交互经回调上抛（草稿防抖写归编辑器测试）。
 * 同步接口形态（entityLocked=true）标题 / 分类行置灰锁定。
 */

function renderDrawer(props: Partial<Parameters<typeof EndpointSettingsDrawer>[0]> = {}) {
  return render(
    <EndpointSettingsDrawer
      open
      onOpenChange={vi.fn()}
      focusReturnRef={createRef<HTMLButtonElement | null>()}
      entityLocked={false}
      title="创建订单"
      categoryId={null}
      categories={[]}
      onTitleChange={vi.fn()}
      onCategoryChange={vi.fn()}
      timeoutSeconds={null}
      onTimeoutChange={vi.fn()}
      {...props}
    />,
  )
}

/** 有状态宿主：回调写回本地 state 并作为 prop 回灌（模拟编辑器草稿回路） */
function Harness({
  initial,
  onTimeoutChange,
}: {
  initial: number | null
  onTimeoutChange: (seconds: number | null) => void
}) {
  const [value, setValue] = useState<number | null>(initial)
  return (
    <EndpointSettingsDrawer
      open
      onOpenChange={vi.fn()}
      focusReturnRef={createRef<HTMLButtonElement | null>()}
      entityLocked={false}
      title=""
      categoryId={null}
      categories={[]}
      onTitleChange={vi.fn()}
      onCategoryChange={vi.fn()}
      timeoutSeconds={value}
      onTimeoutChange={(seconds) => {
        setValue(seconds)
        onTimeoutChange(seconds)
      }}
    />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('抽屉行渲染（手工 / 同步两形态）', () => {
  it('手工接口：分类 / 标题 / 超时三块齐备（组名可见，不只读屏）', () => {
    renderDrawer()
    expect(screen.getByLabelText('分类')).toBeInTheDocument()
    expect(screen.getByLabelText('标题')).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: '请求超时' })).toBeInTheDocument()
    // 组名以可见标题呈现（首眼可知这三项单选在设置什么）
    expect(screen.getByText('请求超时')).toBeInTheDocument()
  })

  it('同步接口（entityLocked=true）：分类与标题置灰锁定且带提示', () => {
    renderDrawer({ entityLocked: true })
    expect(screen.getByRole('radiogroup', { name: '请求超时' })).toBeInTheDocument()
    expect(screen.getByLabelText('分类')).toBeDisabled()
    expect(screen.getByLabelText('标题')).toBeDisabled()
    expect(screen.getByLabelText('标题')).toHaveAttribute('title', '标题与分组随同步文档更新')
  })
})

describe('超时行三态', () => {
  it('默认继承全局（无自定义输入框）；生效值 45 秒回显为自定义选中', () => {
    renderDrawer({ timeoutSeconds: null })
    expect(screen.getByRole('radio', { name: '继承全局' })).toBeChecked()
    expect(screen.queryByTestId('endpoint-timeout-input')).not.toBeInTheDocument()

    renderDrawer({ timeoutSeconds: 45 })
    expect(screen.getByRole('radio', { name: '自定义' })).toBeChecked()
    expect(screen.getByTestId('endpoint-timeout-input')).toHaveValue(45)
  })

  it('继承全局 → 不限制 → 自定义三态切换经回调上抛（null / 0 / 秒数）', () => {
    const onTimeoutChange = vi.fn()
    renderDrawer({ onTimeoutChange })

    fireEvent.click(screen.getByRole('radio', { name: '不限制' }))
    expect(onTimeoutChange).toHaveBeenLastCalledWith(0)

    // 切自定义：输入框动态出现，输入有效秒数即时上抛
    fireEvent.click(screen.getByRole('radio', { name: '自定义' }))
    const input = screen.getByTestId('endpoint-timeout-input')
    fireEvent.change(input, { target: { value: '120' } })
    expect(onTimeoutChange).toHaveBeenLastCalledWith(120)

    // 切回继承全局：上抛 null
    fireEvent.click(screen.getByRole('radio', { name: '继承全局' }))
    expect(onTimeoutChange).toHaveBeenLastCalledWith(null)
  })

  it('自定义输入的中间态不上抛：清空与越界（0 / 86401）不回调，blur 回显回落生效值', () => {
    const onTimeoutChange = vi.fn()
    // 经有状态宿主回灌生效值（编辑器草稿回路形态）：初始继承全局
    render(<Harness initial={null} onTimeoutChange={onTimeoutChange} />)
    expect(screen.getByRole('radio', { name: '继承全局' })).toBeChecked()

    // 切自定义时无可用秒数：不写；输入 45 落定上抛一次
    fireEvent.click(screen.getByRole('radio', { name: '自定义' }))
    const input = screen.getByTestId('endpoint-timeout-input')
    expect(onTimeoutChange).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '45' } })
    expect(onTimeoutChange).toHaveBeenCalledTimes(1)
    expect(onTimeoutChange).toHaveBeenLastCalledWith(45)

    // 清空与越界是中间态：不发起回调（强格式字段防误写）
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.change(input, { target: { value: '86401' } })
    expect(onTimeoutChange).toHaveBeenCalledTimes(1)

    // blur 后无效显示回落为生效值（45 已经宿主回灌）
    fireEvent.blur(input)
    expect(input).toHaveValue(45)
  })
})
