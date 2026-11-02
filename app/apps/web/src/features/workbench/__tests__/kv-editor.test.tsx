import * as React from 'react'

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { createQueryWrapper } from '@/test/render-providers'

import { type KvRowType } from '../kv-rows'
import { KvEditor } from '../kv-editor'

// —— IPC invoke 替换（`{{` 联想集成用例的生效集桩；其余用例不触 IPC） ——
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

// —— 系统文件选择器替换（file 行值格用例；返回值形态＝plugin-dialog open） ——
const openMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: openMock }))

/** 键值编辑器表格形态的 UI 约束：类型集由宿主面经 allowedTypes 收敛——
 *  Params（query/path）与 x-www-form-urlencoded 无 file，form-data 含 file，
 *  Headers 恒 string 不出选择器；说明列随行持久化进草稿 JSON；表格单行制
 *  （列头行＋数据行＋尾部占位行），行启停 / path 芯片 / 拖拽排序 / 批量编辑 /
 *  占位行转正在此钉住 */

/** 与宿主 endpoint-editor 同一口径：参数行类型集（不承载文件） */
const PARAM_ROW_TYPES: readonly KvRowType[] = [
  'string',
  'integer',
  'boolean',
  'number',
  'array',
  'object',
]
/** 与宿主 endpoint-editor 同一口径：form-data 行类型集（参数行全集加 file） */
const FORM_DATA_ROW_TYPES: readonly KvRowType[] = [...PARAM_ROW_TYPES, 'file']

/** 打开指定行的类型选择器（触发器点击即开，弹层经 Portal 挂载） */
async function openTypeSelect(ariaLabel: string) {
  fireEvent.click(screen.getByRole('combobox', { name: ariaLabel }))
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

/** 受控包装：onChange 回写 json——宿主防抖写链路最终也以受控回环呈现；
 *  传 onChange 时同帧转发（断言用，不改变受控行为） */
function ControlledKvEditor({
  initialJson,
  allowedTypes,
  pathParamNames,
  maskValueOf,
  revealValues,
  onChange,
}: {
  initialJson: string
  allowedTypes?: readonly KvRowType[]
  pathParamNames?: readonly string[]
  maskValueOf?: (name: string) => boolean
  revealValues?: boolean
  onChange?: (json: string) => void
}) {
  const [json, setJson] = React.useState(initialJson)
  return (
    <KvEditor
      json={json}
      onChange={(next) => {
        setJson(next)
        onChange?.(next)
      }}
      allowedTypes={allowedTypes}
      pathParamNames={pathParamNames}
      maskValueOf={maskValueOf}
      revealValues={revealValues}
    />
  )
}

/** 行首拖拽把手（行序即行 JSON 序＝发送序） */
const grip = (index: number) => screen.getAllByTestId('kv-row-grip')[index] as HTMLElement
/** 数据行容器（按视觉序） */
const rowAt = (index: number) => screen.getAllByTestId('kv-row')[index] as HTMLElement

describe('Headers 形态（不传 allowedTypes）', () => {
  it('不出类型选择器与类型列头，说明列照常渲染', () => {
    render(<KvEditor json='[{"name":"token","value":"abc"}]' onChange={vi.fn()} />)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByLabelText('说明 1')).toBeInTheDocument()
    // 列头按宿主面收敛：Headers 无类型列
    expect(screen.getByTestId('kv-header-row')).toHaveTextContent('参数名')
    expect(screen.getByTestId('kv-header-row')).not.toHaveTextContent('类型')
  })

  it('说明输入随行序列化进草稿 JSON（防抖写链路的入参载体）', () => {
    const onChange = vi.fn()
    render(<KvEditor json='[{"name":"token","value":"abc"}]' onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('说明 1'), { target: { value: '鉴权令牌' } })
    expect(onChange).toHaveBeenLastCalledWith(
      '[{"name":"token","value":"abc","description":"鉴权令牌"}]',
    )
  })

  it('缺 type 字段的旧行编辑值后仍不携带 type（存在性携带，零回归）', () => {
    const onChange = vi.fn()
    render(<KvEditor json='[{"name":"token","value":"abc"}]' onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('参数值 1'), { target: { value: 'xyz' } })
    expect(onChange).toHaveBeenLastCalledWith('[{"name":"token","value":"xyz"}]')
  })

  it('说明超长由单行 input 截断承载：title 悬停全文、聚焦可完整编辑', () => {
    render(
      <KvEditor
        json='[{"name":"a","value":"1","description":"很长的说明文本"}]'
        onChange={vi.fn()}
      />,
    )
    const input = screen.getByLabelText('说明 1')
    expect(input).toHaveAttribute('title', '很长的说明文本')
    input.focus()
    expect(input).toHaveFocus()
  })
})

describe('Params 形态（allowedTypes 无 file）', () => {
  it('类型选择器值域为六类，无 file；类型列头出现', async () => {
    render(
      <KvEditor
        json='[{"name":"page","value":"1"}]'
        onChange={vi.fn()}
        allowedTypes={PARAM_ROW_TYPES}
      />,
    )
    await openTypeSelect('类型 1')
    const labels = screen
      .getAllByRole('option')
      .map((option) => option.textContent)
      .filter((text): text is string => text !== null)
    expect(labels).toEqual(['string', 'integer', 'boolean', 'number', 'array', 'object'])
    expect(screen.queryByRole('option', { name: 'file' })).not.toBeInTheDocument()
    expect(screen.getByTestId('kv-header-row')).toHaveTextContent('类型')
  })

  it('选择类型后随行序列化进草稿 JSON；缺省显示 string', async () => {
    const onChange = vi.fn()
    render(
      <KvEditor
        json='[{"name":"page","value":"1"}]'
        onChange={onChange}
        allowedTypes={PARAM_ROW_TYPES}
      />,
    )
    expect(screen.getByRole('combobox', { name: '类型 1' })).toHaveTextContent('string')
    await openTypeSelect('类型 1')
    await pickOption('integer')
    expect(onChange).toHaveBeenLastCalledWith('[{"name":"page","value":"1","type":"integer"}]')
  })
})

describe('form-data 形态（allowedTypes 含 file）', () => {
  it('类型值域含 file；选中 file 后值格变为「选择文件」入口（无文本值输入）', async () => {
    render(
      <ControlledKvEditor
        initialJson='[{"name":"attach","value":""}]'
        allowedTypes={FORM_DATA_ROW_TYPES}
      />,
    )
    await openTypeSelect('类型 1')
    expect(screen.getByRole('option', { name: 'file' })).toBeInTheDocument()
    await pickOption('file')
    // 受控回环：选择已随行持久化进草稿 JSON（触发器回读显示选中类型）
    expect(screen.getByRole('combobox', { name: '类型 1' })).toHaveTextContent('file')
    // file 行值格：选择文件入口出现、文本值输入退场、占位提示不出现
    expect(screen.getByTestId('kv-pick-file')).toBeInTheDocument()
    expect(screen.queryByLabelText('参数值 1')).not.toBeInTheDocument()
    expect(screen.queryByText('文件字段将在后续版本提供')).not.toBeInTheDocument()
  })

  it('file 行选择文件：完整路径入行 value，显示 basename、title 悬停全路径', async () => {
    const onChange = vi.fn()
    render(
      <ControlledKvEditor
        initialJson='[{"name":"attach","value":"","type":"file"}]'
        allowedTypes={FORM_DATA_ROW_TYPES}
        onChange={onChange}
      />,
    )
    openMock.mockResolvedValueOnce('C:\\用户数据\\avatar.png')
    fireEvent.click(screen.getByTestId('kv-pick-file'))
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(
        '[{"name":"attach","value":"C:\\\\用户数据\\\\avatar.png","type":"file"}]',
      )
    })
    // 受控回环：显示 basename，title 悬停可看完整路径
    expect(screen.getByTestId('kv-file-name')).toHaveTextContent('avatar.png')
    expect(screen.getByTestId('kv-file-name')).toHaveAttribute('title', 'C:\\用户数据\\avatar.png')
  })

  it('用户取消选择（返回 null）不改行数据；POSIX 路径 basename 同样生效', async () => {
    const onChange = vi.fn()
    render(
      <ControlledKvEditor
        initialJson='[{"name":"attach","value":"/tmp/old.bin","type":"file"}]'
        allowedTypes={FORM_DATA_ROW_TYPES}
        onChange={onChange}
      />,
    )
    expect(screen.getByTestId('kv-file-name')).toHaveTextContent('old.bin')
    openMock.mockResolvedValueOnce(null)
    fireEvent.click(screen.getByTestId('kv-pick-file'))
    await vi.waitFor(() => {
      expect(openMock).toHaveBeenCalledWith({ multiple: false })
    })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('行启停（禁用行置灰、不发送由双端契约钉住）', () => {
  it('取消勾选携带 enabled: false，行置灰；再勾选移除字段（回缺省启用）', () => {
    render(<ControlledKvEditor initialJson='[{"name":"a","value":"1"}]' />)
    expect(rowAt(0)).not.toHaveAttribute('data-disabled')
    fireEvent.click(screen.getByRole('checkbox', { name: '启用该行 1' }))
    expect(rowAt(0)).toHaveAttribute('data-disabled', 'true')
    expect(screen.getByLabelText('参数值 1')).toHaveValue('1')
    fireEvent.click(screen.getByRole('checkbox', { name: '启用该行 1' }))
    expect(rowAt(0)).not.toHaveAttribute('data-disabled')
    // 受控回环后的草稿 JSON：禁用携带 false，恢复启用不携带字段
    fireEvent.change(screen.getByLabelText('参数值 1'), { target: { value: '2' } })
    expect(screen.getByLabelText('参数值 1')).toHaveValue('2')
  })

  it('禁用行的启停序列化：enabled: false 携带进草稿 JSON', () => {
    const onChange = vi.fn()
    render(<KvEditor json='[{"name":"a","value":"1","type":"integer"}]' onChange={onChange} />)
    fireEvent.click(screen.getByRole('checkbox', { name: '启用该行 1' }))
    expect(onChange).toHaveBeenLastCalledWith(
      '[{"name":"a","value":"1","type":"integer","enabled":false}]',
    )
  })

  it('已有 enabled 的行编辑其他字段时保留（存在性携带）', () => {
    const onChange = vi.fn()
    render(<KvEditor json='[{"name":"a","value":"1","enabled":false}]' onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('参数值 1'), { target: { value: '9' } })
    expect(onChange).toHaveBeenLastCalledWith('[{"name":"a","value":"9","enabled":false}]')
  })
})

describe('路径参数标识（pathParamNames 命中行）', () => {
  it('命中行渲染 path 只读芯片且不出启停勾选；未命中行照常勾选', () => {
    render(
      <KvEditor
        json='[{"name":"id","value":"1"},{"name":"q","value":"v"}]'
        onChange={vi.fn()}
        allowedTypes={PARAM_ROW_TYPES}
        pathParamNames={['id']}
      />,
    )
    expect(screen.getByTestId('kv-path-chip')).toHaveTextContent('path')
    expect(screen.queryByRole('checkbox', { name: '启用该行 1' })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '启用该行 2' })).toBeInTheDocument()
  })
})

describe('拖拽排序（行序即行 JSON 序＝发送序）', () => {
  it('拖拽把手 dragStart → dragOver → drop 重排行序并上抛 JSON', () => {
    const onChange = vi.fn()
    render(
      <KvEditor json='[{"name":"a","value":"1"},{"name":"b","value":"2"}]' onChange={onChange} />,
    )
    const dataTransfer = { setData: vi.fn(), effectAllowed: '' }
    fireEvent.dragStart(rowAt(0), { dataTransfer })
    fireEvent.dragOver(rowAt(1), { dataTransfer })
    fireEvent.drop(rowAt(1), { dataTransfer })
    expect(onChange).toHaveBeenLastCalledWith('[{"name":"b","value":"2"},{"name":"a","value":"1"}]')
  })

  it('键盘 Alt+↓/↑ 与拖拽同一移动原语；首末行边界不越界', () => {
    const onChange = vi.fn()
    render(
      <KvEditor
        json='[{"name":"a","value":"1"},{"name":"b","value":"2"},{"name":"c","value":"3"}]'
        onChange={onChange}
      />,
    )
    fireEvent.keyDown(grip(0), { key: 'ArrowDown', altKey: true })
    expect(onChange).toHaveBeenLastCalledWith(
      '[{"name":"b","value":"2"},{"name":"a","value":"1"},{"name":"c","value":"3"}]',
    )
    fireEvent.keyDown(grip(0), { key: 'ArrowUp', altKey: true })
    expect(onChange).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(grip(2), { key: 'ArrowDown', altKey: true })
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('无 Alt 修饰的方向键不触发移动（输入框内方向键不受影响）', () => {
    const onChange = vi.fn()
    render(
      <KvEditor json='[{"name":"a","value":"1"},{"name":"b","value":"2"}]' onChange={onChange} />,
    )
    fireEvent.keyDown(grip(0), { key: 'ArrowDown' })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('批量编辑（工具行切换 ⇄ 文本模式）', () => {
  it('进入播种当前行集文本；应用解析写回（同名行保留标注与启停、新行缺省）', () => {
    const onChange = vi.fn()
    render(
      <KvEditor
        json='[{"name":"a","value":"1","type":"integer","description":"页码","enabled":false},{"name":"b","value":"2"}]'
        onChange={onChange}
      />,
    )
    fireEvent.click(screen.getByTestId('kv-bulk-edit'))
    expect(screen.getByTestId('kv-bulk-textarea')).toHaveValue('a: 1\nb: 2')
    fireEvent.change(screen.getByTestId('kv-bulk-textarea'), {
      target: { value: 'a: 9\n\nnew: v' },
    })
    fireEvent.click(screen.getByTestId('kv-bulk-apply'))
    expect(onChange).toHaveBeenLastCalledWith(
      '[{"name":"a","value":"9","type":"integer","description":"页码","enabled":false},{"name":"b","value":"2"},{"name":"new","value":"v"}]',
    )
    // 应用后退出批量模式回到表格
    expect(screen.queryByTestId('kv-bulk-textarea')).not.toBeInTheDocument()
  })

  it('取消还原：不写草稿，退出批量模式', () => {
    const onChange = vi.fn()
    render(<KvEditor json='[{"name":"a","value":"1"}]' onChange={onChange} />)
    fireEvent.click(screen.getByTestId('kv-bulk-edit'))
    fireEvent.change(screen.getByTestId('kv-bulk-textarea'), { target: { value: 'a: 9' } })
    fireEvent.click(screen.getByTestId('kv-bulk-cancel'))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByTestId('kv-bulk-textarea')).not.toBeInTheDocument()
  })

  it('掩码行未揭示时批量编辑禁用（批量文本会明文回显值）；揭示后可用', () => {
    render(
      <KvEditor
        json='[{"name":"Authorization","value":"secret"}]'
        onChange={vi.fn()}
        maskValueOf={(name) => name === 'Authorization'}
      />,
    )
    expect(screen.getByTestId('kv-bulk-edit')).toBeDisabled()
    render(
      <ControlledKvEditor
        initialJson='[{"name":"Authorization","value":"secret"}]'
        maskValueOf={(name) => name === 'Authorization'}
        revealValues
      />,
    )
    expect(screen.getAllByTestId('kv-bulk-edit')[1]).toBeEnabled()
  })
})

describe('表头列几何（与内容行共享同一套固定段宽度）', () => {
  // jsdom 无布局，几何对齐以类名约束钉住：表头固定段逐列与内容行等宽
  // （把手 w-5 / 启停 w-6 / 参数名 w-40 / 类型 w-24 / 移除钮位 w-7），值与
  // 说明两 flex-1 列的剩余空间分配才一致；批量编辑按钮须脱离 flex 流
  function expectAlignedGeometry() {
    expect(screen.getByTestId('kv-header-row')).toHaveClass('relative')
    // 列头文字与行内输入框框内左缘对齐（Input / SelectTrigger 框内左
    // padding 同为 pl-2.5，列头同值即对齐）
    expect(screen.getByText('参数名')).toHaveClass('pl-2.5')
    expect(screen.getByText('参数值')).toHaveClass('pl-2.5')
    // 批量编辑＝纯文字钮浮于表头行右端（无 Button 盒模型的按压位移），
    // 悬浮表格区才显形；悬浮高亮主题色，键盘聚焦同样显形
    expect(screen.getByTestId('kv-bulk-edit')).toHaveClass(
      'absolute',
      'right-0',
      'opacity-0',
      'group-hover/kv:opacity-100',
      'hover:text-primary',
      'focus-visible:opacity-100',
    )
    // 操作列头不出文字（移除语义由行尾钮自明）
    expect(screen.getByTestId('kv-header-row')).not.toHaveTextContent('操作')
    // 行内输入框常态无边框（悬浮 / 聚焦才显边框）
    expect(screen.getByLabelText('参数名 1')).toHaveClass('border-transparent')
    expect(screen.getByLabelText('参数值 1')).toHaveClass('border-transparent')
  }

  it('Headers 形态（无类型列）：列头对齐约束成立、批量编辑钮悬浮右端', () => {
    const { unmount } = render(<KvEditor json='[{"name":"a","value":"1"}]' onChange={vi.fn()} />)
    expectAlignedGeometry()
    unmount()
  })

  it('Params 形态（有类型列）：同一几何约束成立', () => {
    render(
      <KvEditor
        json='[{"name":"a","value":"1"}]'
        onChange={vi.fn()}
        allowedTypes={PARAM_ROW_TYPES}
      />,
    )
    expectAlignedGeometry()
  })
})

describe('占位行（尾部待输入行：转正加行、不可移除）', () => {
  it('数据为空默认渲染一行占位行（替代空态与「添加」钮）；参数名输入即转正', async () => {
    const onChange = vi.fn()
    const view = render(<KvEditor json="[]" onChange={onChange} />)
    expect(screen.getByTestId('kv-placeholder-row')).toBeInTheDocument()
    expect(screen.queryByTestId('kv-row')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('参数名 1'), { target: { value: 'page' } })
    expect(onChange).toHaveBeenLastCalledWith('[{"name":"page","value":""}]')
    // 受控回环：转正行落位并接续焦点（键盘流不中断），底部再续新占位行
    view.rerender(<KvEditor json='[{"name":"page","value":""}]' onChange={onChange} />)
    expect(screen.getByTestId('kv-row')).toBeInTheDocument()
    expect(screen.getByTestId('kv-placeholder-row')).toBeInTheDocument()
    await vi.waitFor(() => {
      expect(screen.getByLabelText('参数名 1')).toHaveFocus()
    })
  })

  it('尾行参数名非空即再续占位行；尾行参数名清空（数据行保留）则不续', () => {
    const { unmount } = render(<KvEditor json='[{"name":"a","value":"1"}]' onChange={vi.fn()} />)
    expect(screen.getByTestId('kv-placeholder-row')).toBeInTheDocument()
    unmount()
    render(<KvEditor json='[{"name":"","value":"1"}]' onChange={vi.fn()} />)
    expect(screen.queryByTestId('kv-placeholder-row')).not.toBeInTheDocument()
  })

  it('占位行不可移除（无移除钮）：值 / 说明 / 类型锁定至转正后', () => {
    render(
      <KvEditor
        json='[{"name":"a","value":"1"}]'
        onChange={vi.fn()}
        allowedTypes={PARAM_ROW_TYPES}
      />,
    )
    expect(screen.getByLabelText('参数值 2')).toBeDisabled()
    expect(screen.getByLabelText('说明 2')).toBeDisabled()
    expect(screen.getByRole('combobox', { name: '类型 2' })).toBeDisabled()
    // 移除钮只在数据行（数量＝数据行数）
    expect(screen.getAllByRole('button', { name: '移除该行' })).toHaveLength(1)
  })
})

describe('键盘可达', () => {
  it('Tab 沿 把手→启停→名称→值→类型→说明→移除 推进（DOM 序即视觉序）', async () => {
    const user = userEvent.setup()
    render(
      <KvEditor
        json='[{"name":"page","value":"1"}]'
        onChange={vi.fn()}
        allowedTypes={PARAM_ROW_TYPES}
      />,
    )
    grip(0).focus()
    await user.tab()
    expect(screen.getByRole('checkbox', { name: '启用该行 1' })).toHaveFocus()
    await user.tab()
    expect(screen.getByLabelText('参数名 1')).toHaveFocus()
    await user.tab()
    expect(screen.getByLabelText('参数值 1')).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('combobox', { name: '类型 1' })).toHaveFocus()
    await user.tab()
    expect(screen.getByLabelText('说明 1')).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: '移除该行' })).toHaveFocus()
  })
})

describe('`{{` 变量联想（suggestWorkspaceId 接线）', () => {
  it('传工作空间时值单元格输入 {{ 弹生效变量浮层', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'variable.effective') {
        return Promise.resolve({
          items: [{ key: 'token', value: 'abc', secret: false, source: 'active' }],
        })
      }
      return Promise.resolve(undefined)
    })
    render(
      <KvEditor json='[{"name":"token","value":""}]' onChange={vi.fn()} suggestWorkspaceId="w1" />,
      { wrapper: createQueryWrapper() },
    )
    fireEvent.change(screen.getByLabelText('参数值 1'), { target: { value: '{{' } })
    const rows = await screen.findAllByTestId('var-suggest-row')
    expect(rows[0]!.textContent).toContain('token')
  })

  it('不传工作空间时不启用联想（退化为普通输入）', async () => {
    render(<KvEditor json='[{"name":"token","value":""}]' onChange={vi.fn()} />, {
      wrapper: createQueryWrapper(),
    })
    fireEvent.change(screen.getByLabelText('参数值 1'), { target: { value: '{{' } })
    await Promise.resolve()
    expect(screen.queryByTestId('var-suggest-list')).not.toBeInTheDocument()
  })
})
