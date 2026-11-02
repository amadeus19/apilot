import * as React from 'react'

import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryWrapper } from '@/test/render-providers'

import { VariableSuggestInput } from '../variable-suggest'
import { matchVariableFragment } from '../variable-suggest-match'
import type { EffectiveSetDto } from '../variable-api'

// —— IPC invoke 替换：生效集走桩 ——
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

// hover 解析的量宽桩（jsdom 无 canvas 2d）：每字符 10px、内边距 0，
// 命中区间手工可算；命中几何（pickReferenceAtX / clampTooltipLeft）走真实现。
// 桩可计数——量宽缓存断言「同区间微动零重复量宽」的观测量
const measureMock = vi.hoisted(() => vi.fn((text: string) => text.length * 10))
vi.mock('../variable-hover', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createInputTextMeasurer: () => ({
    measure: measureMock,
    paddingLeft: 0,
  }),
}))

let stubEffective: EffectiveSetDto

beforeEach(() => {
  vi.clearAllMocks()
  stubEffective = {
    items: [
      { key: 'token', value: 'abc123', secret: false, source: 'active' },
      { key: 'host', value: 'https://api.example.com', secret: false, source: 'global' },
      { key: 'password', value: '明文绝不上屏', secret: true, source: 'active' },
      { key: 'baseUrl', value: 'https://x.test', secret: false, source: 'builtin' },
    ],
  }
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === 'variable.effective') return Promise.resolve(stubEffective)
    return Promise.resolve(undefined)
  })
})

/** 受控包装：宿主受控回环（编辑器值单元格 / URL 框的使用形态） */
function ControlledInput(props: {
  workspaceId: string | null
  initial?: string
  onKeyDown?: React.ComponentProps<'input'>['onKeyDown']
}) {
  const [value, setValue] = React.useState(props.initial ?? '')
  return (
    <VariableSuggestInput
      value={value}
      onChange={setValue}
      workspaceId={props.workspaceId}
      onKeyDown={props.onKeyDown}
      aria-label="目标输入"
      data-testid="suggest-host-input"
    />
  )
}

describe('matchVariableFragment（{{ 片段检测）', () => {
  it('未闭合片段命中：返回起点与已输查询词', () => {
    expect(matchVariableFragment('https://x/{{to')).toEqual({ start: 10, query: 'to' })
    expect(matchVariableFragment('{{')).toEqual({ start: 0, query: '' })
  })

  it('闭合后与 {{{ 连击不命中', () => {
    expect(matchVariableFragment('{{token}}')).toBeNull()
    expect(matchVariableFragment('{{token}}tail')).toBeNull()
    expect(matchVariableFragment('{{{')).toBeNull()
    expect(matchVariableFragment('plain')).toBeNull()
  })
})

describe('`{{` 变量联想下拉', () => {
  it('输入 {{ 弹浮层：键名＋值预览＋来源；Secret 行恒掩码', async () => {
    render(<ControlledInput workspaceId="w1" />, { wrapper: createQueryWrapper() })
    const input = screen.getByTestId('suggest-host-input')
    fireEvent.change(input, { target: { value: '{{' } })
    const rows = await screen.findAllByTestId('var-suggest-row')
    expect(rows).toHaveLength(4)
    expect(screen.getByTestId('var-suggest-list').textContent).toContain('token')
    expect(screen.getByTestId('var-suggest-list').textContent).toContain('激活分类')
    expect(screen.getByTestId('var-suggest-list').textContent).toContain('全局变量')
    expect(screen.getByTestId('var-suggest-list').textContent).toContain('内置')
    // Secret 值不上屏
    expect(screen.getByTestId('var-suggest-list').textContent).not.toContain('明文绝不上屏')
    expect(screen.getByTestId('var-suggest-list').textContent).toContain('***')
  })

  it('继续输入按 key 大小写不敏感过滤', async () => {
    render(<ControlledInput workspaceId="w1" />, { wrapper: createQueryWrapper() })
    const input = screen.getByTestId('suggest-host-input')
    fireEvent.change(input, { target: { value: '{{TO' } })
    const rows = await screen.findAllByTestId('var-suggest-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent).toContain('token')
  })

  it('方向键移动高亮后 Enter 取高亮项插入：光标落 }} 之后、浮层关闭', async () => {
    const user = userEvent.setup()
    render(<ControlledInput workspaceId="w1" />, {
      wrapper: createQueryWrapper(),
    })
    const input = screen.getByTestId('suggest-host-input') as HTMLInputElement
    input.focus()
    await user.keyboard('/api/{{{{')
    await screen.findByTestId('var-suggest-list')
    expect(screen.getAllByTestId('var-suggest-row')[0]).toHaveAttribute('data-highlight')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getAllByTestId('var-suggest-row')[1]).toHaveAttribute('data-highlight')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveValue('/api/{{host}}')
    expect(screen.queryByTestId('var-suggest-list')).not.toBeInTheDocument()
    await vi.waitFor(() => {
      expect(input.selectionStart).toBe('/api/{{host}}'.length)
    })
  })

  it('点击浮层行插入（鼠标通道），焦点不离开输入框', async () => {
    const user = userEvent.setup()
    render(<ControlledInput workspaceId="w1" />, { wrapper: createQueryWrapper() })
    const input = screen.getByTestId('suggest-host-input') as HTMLInputElement
    input.focus()
    await user.keyboard('{{{{')
    const row = (await screen.findAllByTestId('var-suggest-row'))[0]!
    fireEvent.click(row)
    expect(input).toHaveValue('{{token}}')
    await vi.waitFor(() => {
      expect(input.selectionStart).toBe('{{token}}'.length)
    })
    expect(input).toHaveFocus()
  })

  it('Esc 关闭不残留', async () => {
    const user = userEvent.setup()
    render(<ControlledInput workspaceId="w1" />, { wrapper: createQueryWrapper() })
    const input = screen.getByTestId('suggest-host-input')
    input.focus()
    await user.keyboard('{{{{')
    await screen.findByTestId('var-suggest-list')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByTestId('var-suggest-list')).not.toBeInTheDocument()
  })

  it('无匹配显示空态文案', async () => {
    const user = userEvent.setup()
    render(<ControlledInput workspaceId="w1" />, { wrapper: createQueryWrapper() })
    const input = screen.getByTestId('suggest-host-input')
    input.focus()
    await user.keyboard('{{{{nomatch')
    expect(await screen.findByTestId('var-suggest-empty')).toBeInTheDocument()
  })

  it('输入法组合态 Enter 不拦截（不插入，浮层保持）', async () => {
    const user = userEvent.setup()
    render(<ControlledInput workspaceId="w1" />, { wrapper: createQueryWrapper() })
    const input = screen.getByTestId('suggest-host-input')
    input.focus()
    await user.keyboard('{{{{')
    await screen.findByTestId('var-suggest-list')
    // React 合成事件读 nativeEvent.isComposing——在原生事件上标注组合态
    const composingEnter = createEvent.keyDown(input, { key: 'Enter' })
    Object.defineProperty(composingEnter, 'isComposing', { value: true })
    fireEvent(input, composingEnter)
    expect(input).toHaveValue('{{')
    expect(screen.getByTestId('var-suggest-list')).toBeInTheDocument()
  })

  it('浮层自身列表滚动不关层，其他元素滚动才关', async () => {
    const user = userEvent.setup()
    render(<ControlledInput workspaceId="w1" />, { wrapper: createQueryWrapper() })
    const input = screen.getByTestId('suggest-host-input')
    input.focus()
    await user.keyboard('{{{{')
    const list = await screen.findByTestId('var-suggest-list')
    // 浮层 overflow 容器自己的滚动不算错位信号（长列表要能滚）
    fireEvent.scroll(list)
    expect(screen.getByTestId('var-suggest-list')).toBeInTheDocument()
    // 宿主侧滚动（目标行离开视线）才关闭
    fireEvent.scroll(input)
    expect(screen.queryByTestId('var-suggest-list')).not.toBeInTheDocument()
  })

  it('粘贴以未闭合 {{ 结尾的文本不冲突：值完整保留、联想按片段弹出', async () => {
    render(<ControlledInput workspaceId="w1" />, { wrapper: createQueryWrapper() })
    const input = screen.getByTestId('suggest-host-input')
    // jsdom 不实现粘贴默认行为：直接落到粘贴后的受控值终态
    fireEvent.change(input, { target: { value: 'prefix {{to' } })
    expect(input).toHaveValue('prefix {{to')
    const rows = await screen.findAllByTestId('var-suggest-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent).toContain('token')
  })

  it('workspaceId 缺省不启用联想（退化为普通输入）', async () => {
    render(<ControlledInput workspaceId={null} />, { wrapper: createQueryWrapper() })
    const input = screen.getByTestId('suggest-host-input')
    fireEvent.change(input, { target: { value: '{{' } })
    await Promise.resolve()
    expect(screen.queryByTestId('var-suggest-list')).not.toBeInTheDocument()
  })

  it('combobox 语义全套：aria-controls 指向 listbox，activedescendant 随高亮行移动', async () => {
    render(<ControlledInput workspaceId="w1" />, { wrapper: createQueryWrapper() })
    const input = screen.getByTestId('suggest-host-input')
    fireEvent.change(input, { target: { value: '{{' } })
    await screen.findAllByTestId('var-suggest-row')
    const combobox = screen.getByRole('combobox')
    expect(combobox).toHaveAttribute('aria-autocomplete', 'list')
    expect(combobox).toHaveAttribute('aria-expanded', 'true')
    const listbox = screen.getByRole('listbox')
    expect(combobox.getAttribute('aria-controls')).toBe(listbox.id)
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(4)
    // 初始高亮第 0 行：activedescendant 指向该行 id，aria-selected 通报选中
    expect(combobox.getAttribute('aria-activedescendant')).toBe(options[0]!.id)
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(options[1]).toHaveAttribute('aria-selected', 'false')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(combobox.getAttribute('aria-activedescendant')).toBe(options[1]!.id)
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(options[0]).toHaveAttribute('aria-selected', 'false')
  })

  it('浮层关闭时无悬空引用：aria-controls / activedescendant 不出现', () => {
    render(<ControlledInput workspaceId="w1" />, { wrapper: createQueryWrapper() })
    const combobox = screen.getByRole('combobox')
    expect(combobox).not.toHaveAttribute('aria-expanded')
    expect(combobox).not.toHaveAttribute('aria-controls')
    expect(combobox).not.toHaveAttribute('aria-activedescendant')
  })

  it('无匹配空列表时 Enter 关浮层且拦截（不穿透触发宿主默认行为）', async () => {
    render(<ControlledInput workspaceId="w1" />, { wrapper: createQueryWrapper() })
    const input = screen.getByTestId('suggest-host-input')
    fireEvent.change(input, { target: { value: '{{nomatch' } })
    expect(await screen.findByTestId('var-suggest-empty')).toBeInTheDocument()
    const enterEvent = createEvent.keyDown(input, { key: 'Enter' })
    fireEvent(input, enterEvent)
    // keydown 默认行为（含表单隐式提交）被取消；浮层关闭、值不动
    expect(enterEvent.defaultPrevented).toBe(true)
    expect(screen.queryByTestId('var-suggest-empty')).not.toBeInTheDocument()
    expect(input).toHaveValue('{{nomatch')
  })

  it('浮层打开期 Escape 就地关闭且不再冒泡（宿主 Dialog 不连坐关）', async () => {
    const outerKeyDown = vi.fn()
    render(
      <div onKeyDown={outerKeyDown}>
        <ControlledInput workspaceId="w1" />
      </div>,
      { wrapper: createQueryWrapper() },
    )
    const input = screen.getByTestId('suggest-host-input')
    fireEvent.change(input, { target: { value: '{{' } })
    await screen.findByTestId('var-suggest-list')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByTestId('var-suggest-list')).not.toBeInTheDocument()
    expect(outerKeyDown).not.toHaveBeenCalled()
  })

  it('有匹配时 Tab 采纳高亮项（IDE 惯例）；无匹配时放行不劫持', async () => {
    render(<ControlledInput workspaceId="w1" />, { wrapper: createQueryWrapper() })
    const input = screen.getByTestId('suggest-host-input')
    fireEvent.change(input, { target: { value: '{{' } })
    await screen.findAllByTestId('var-suggest-row')
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input).toHaveValue('{{token}}')
    // 续输无匹配片段：Tab 不 preventDefault、不插入（正常 tab 导航放行）
    fireEvent.change(input, { target: { value: '{{token}}{{nomatch' } })
    expect(await screen.findByTestId('var-suggest-empty')).toBeInTheDocument()
    const tabEvent = createEvent.keyDown(input, { key: 'Tab' })
    fireEvent(input, tabEvent)
    expect(tabEvent.defaultPrevented).toBe(false)
    expect(input).toHaveValue('{{token}}{{nomatch')
  })

  it('输入框贴视口右缘时浮层左缘钳制防溢出', async () => {
    render(<ControlledInput workspaceId="w1" />, { wrapper: createQueryWrapper() })
    const input = screen.getByTestId('suggest-host-input')
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({
      x: 1000,
      y: 8,
      top: 8,
      bottom: 36,
      left: 1000,
      right: 1200,
      width: 200,
      height: 28,
      toJSON: () => ({}),
    } as DOMRect)
    fireEvent.change(input, { target: { value: '{{' } })
    const list = await screen.findByTestId('var-suggest-list')
    // jsdom 视口宽 1024：left 1000 + 最小宽 200 溢出右缘 → 钳到 1024-200-8
    expect(list.style.left).toBe('816px')
    expect(list.style.minWidth).toBe('200px')
  })
})

describe('hover 变量解析提示', () => {
  /** 挂载→生效集就绪→置闭合引用值→指针移到指定横坐标（量宽桩下 origin=0） */
  async function renderAndHover(value: string, clientX: number) {
    render(<ControlledInput workspaceId="w1" />, { wrapper: createQueryWrapper() })
    const input = screen.getByTestId('suggest-host-input')
    fireEvent.change(input, { target: { value: '{{' } })
    await screen.findAllByTestId('var-suggest-row') // 生效集已加载
    fireEvent.change(input, { target: { value } })
    fireEvent.mouseMove(input, { clientX })
    return input
  }

  it('指针落在引用片段上出提示：键名＋当前解析值', async () => {
    await renderAndHover('{{host}}', 40) // 片段宽 80，x=40 居中命中
    const tip = screen.getByTestId('var-hover-tip')
    expect(tip.textContent).toContain('{{host}}')
    expect(tip.textContent).toContain('https://api.example.com')
    expect(tip.textContent).not.toContain('Secret 变量')
  })

  it('Secret 引用恒掩码并标注「Secret 变量」', async () => {
    await renderAndHover('{{password}}', 60)
    const tip = screen.getByTestId('var-hover-tip')
    expect(tip.textContent).toContain('***')
    expect(tip.textContent).toContain('Secret 变量')
    expect(tip.textContent).not.toContain('明文绝不上屏')
  })

  it('生效集未含的键标「未定义」', async () => {
    await renderAndHover('{{nope}}', 20)
    const tip = screen.getByTestId('var-hover-tip')
    expect(tip.textContent).toContain('{{nope}}')
    expect(tip.textContent).toContain('未定义')
  })

  it('指针不在任何片段上不出提示', async () => {
    await renderAndHover('{{host}}', 999)
    expect(screen.queryByTestId('var-hover-tip')).not.toBeInTheDocument()
  })

  it('值无引用不出提示', async () => {
    await renderAndHover('plain-value', 10)
    expect(screen.queryByTestId('var-hover-tip')).not.toBeInTheDocument()
  })

  it('编辑值即收提示', async () => {
    const input = await renderAndHover('{{host}}', 40)
    expect(screen.getByTestId('var-hover-tip')).toBeInTheDocument()
    fireEvent.change(input, { target: { value: '{{host}}x' } })
    expect(screen.queryByTestId('var-hover-tip')).not.toBeInTheDocument()
  })

  it('指针离开输入框即收提示', async () => {
    const input = await renderAndHover('{{host}}', 40)
    expect(screen.getByTestId('var-hover-tip')).toBeInTheDocument()
    fireEvent.mouseLeave(input)
    expect(screen.queryByTestId('var-hover-tip')).not.toBeInTheDocument()
  })

  it('联想浮层打开期间不出 hover 提示', async () => {
    render(<ControlledInput workspaceId="w1" />, { wrapper: createQueryWrapper() })
    const input = screen.getByTestId('suggest-host-input')
    fireEvent.change(input, { target: { value: '{{host' } })
    await screen.findAllByTestId('var-suggest-row')
    fireEvent.mouseMove(input, { clientX: 20 })
    expect(screen.getByTestId('var-suggest-list')).toBeInTheDocument()
    expect(screen.queryByTestId('var-hover-tip')).not.toBeInTheDocument()
  })

  it('生效集未加载不出提示', () => {
    invokeMock.mockImplementationOnce(() => Promise.resolve(undefined))
    render(<ControlledInput workspaceId="w1" />, { wrapper: createQueryWrapper() })
    const input = screen.getByTestId('suggest-host-input')
    fireEvent.change(input, { target: { value: '{{host}}' } })
    fireEvent.mouseMove(input, { clientX: 40 })
    expect(screen.queryByTestId('var-hover-tip')).not.toBeInTheDocument()
  })

  it('同一引用区间内指针微动零重复量宽、提示子树保持（浅比较＋值内缓存去重）', async () => {
    render(<ControlledInput workspaceId="w1" />, { wrapper: createQueryWrapper() })
    const input = screen.getByTestId('suggest-host-input')
    fireEvent.change(input, { target: { value: '{{' } })
    await screen.findAllByTestId('var-suggest-row') // 生效集已加载
    fireEvent.change(input, { target: { value: '{{host}}' } })
    measureMock.mockClear()
    // 量宽桩下 {{host}} 宽 80：x=40 命中 → 首次量宽并建缓存，提示出现
    fireEvent.mouseMove(input, { clientX: 40 })
    const tip = screen.getByTestId('var-hover-tip')
    const firstCount = measureMock.mock.calls.length
    expect(firstCount).toBeGreaterThan(0)
    // 同区间微动（x=60）：命中片段未变 → 缓存全命中（零重复量宽），
    // hover 状态引用保持 → 提示不关不重建
    fireEvent.mouseMove(input, { clientX: 60 })
    expect(measureMock).toHaveBeenCalledTimes(firstCount)
    expect(screen.getByTestId('var-hover-tip')).toBe(tip)
    // 指针移出片段：命中消失 → 关提示（去重不吞掉真实状态迁移）
    fireEvent.mouseMove(input, { clientX: 200 })
    expect(screen.queryByTestId('var-hover-tip')).not.toBeInTheDocument()
    // 值变化后缓存随值失效：再次 hover 恢复量宽调用
    fireEvent.change(input, { target: { value: '{{host}}x' } })
    fireEvent.mouseMove(input, { clientX: 40 })
    expect(measureMock.mock.calls.length).toBeGreaterThan(firstCount)
    expect(screen.getByTestId('var-hover-tip')).toBeInTheDocument()
  })

  it('提示容器带 role=tooltip（悬浮提示语义）', async () => {
    await renderAndHover('{{host}}', 40)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
  })
})
