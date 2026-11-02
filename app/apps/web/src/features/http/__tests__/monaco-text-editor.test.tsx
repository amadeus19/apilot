import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryWrapper } from '@/test/render-providers'

import type * as monacoNs from 'monaco-editor'
import { MonacoTextEditor } from '../monaco-text-editor'

// —— Monaco 三模块替换（jsdom 不真渲染编辑器）——
// monaco-editor：editor.create / editor.setTheme 桩，create 返回可断言的
// 假实例（setValue / updateOptions / dispose 均 spy）——生命周期断言锚点；
// languages：变量联想 provider 注册桩（返回可断言 dispose 的假注册句柄）
const monacoState = vi.hoisted(() => {
  interface FakeEditor {
    setValue: ReturnType<typeof vi.fn>
    updateOptions: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
  }
  const created: FakeEditor[] = []
  const setTheme = vi.fn()
  const create = vi.fn((): FakeEditor => {
    const editor: FakeEditor = { setValue: vi.fn(), updateOptions: vi.fn(), dispose: vi.fn() }
    created.push(editor)
    return editor
  })
  return { created, setTheme, create }
})
const languagesState = vi.hoisted(() => {
  interface FakeRegistration {
    dispose: ReturnType<typeof vi.fn>
  }
  const registrations: FakeRegistration[] = []
  const registerCompletionItemProvider = vi.fn((): FakeRegistration => {
    const registration: FakeRegistration = { dispose: vi.fn() }
    registrations.push(registration)
    return registration
  })
  const registerHoverProvider = vi.fn((): FakeRegistration => {
    const registration: FakeRegistration = { dispose: vi.fn() }
    registrations.push(registration)
    return registration
  })
  return {
    registrations,
    registerCompletionItemProvider,
    registerHoverProvider,
    CompletionItemKind: { Variable: 12 },
  }
})
vi.mock('monaco-editor', () => ({ editor: monacoState, languages: languagesState }))

// monaco-env：本地 worker / loader 引导的副作用模块，测试下置空
vi.mock('../monaco-env', () => ({}))

// 假 Editor 收到的最近一次 props（onChange 接线断言的抓手）
interface CapturedEditorProps {
  value?: string
  language?: string
  theme?: string
  options?: Record<string, unknown>
  onChange?: (value: string | undefined) => void
}
const capturedProps = vi.hoisted(() => ({ current: null as CapturedEditorProps | null }))

// @monaco-editor/react：假 Editor 组件，模拟真实生命周期——mount 创建
// 实例、value / options 变化走 setValue / updateOptions、unmount dispose
vi.mock('@monaco-editor/react', async () => {
  const React = await import('react')
  const monaco = await import('monaco-editor')

  function Editor(props: CapturedEditorProps) {
    // 每次渲染后捕获最新 props，供接线断言（经 effect 写入，渲染期不碰外部量）
    React.useEffect(() => {
      capturedProps.current = props
    })
    const editorRef = React.useRef<monacoNs.editor.IStandaloneCodeEditor | null>(null)
    React.useEffect(() => {
      // mount：创建实例（与真实库一致：卸载清理销毁实例）
      editorRef.current = monaco.editor.create(document.createElement('div'), {})
      return () => {
        editorRef.current?.dispose()
      }
    }, [])
    React.useEffect(() => {
      editorRef.current?.setValue(props.value ?? '')
    }, [props.value])
    React.useEffect(() => {
      editorRef.current?.updateOptions(props.options ?? {})
    }, [props.options])
    return <div data-testid="monaco-editor-host" />
  }

  return { default: Editor, loader: { config: vi.fn() } }
})

beforeEach(() => {
  monacoState.created.length = 0
  monacoState.create.mockClear()
  monacoState.setTheme.mockClear()
  languagesState.registrations.length = 0
  languagesState.registerCompletionItemProvider.mockClear()
  languagesState.registerHoverProvider.mockClear()
  capturedProps.current = null
})

type BaseProps = Parameters<typeof MonacoTextEditor>[0]

/** 基准 props 渲染（只读形态），覆盖项按用例叠加（底座含 IPC 查询，需
 *  QueryClient 包装；disabled 查询不触发 invoke） */
function renderBase(overrides?: Partial<BaseProps>) {
  const props: BaseProps = {
    value: '{"a":1}',
    language: 'json',
    theme: 'light',
    wordWrap: true,
    ...overrides,
  }
  return render(<MonacoTextEditor {...props} />, { wrapper: createQueryWrapper() })
}

describe('MonacoTextEditor 共享底座（双形态 props 面）', () => {
  it('只读形态（onChange 缺省）：readOnly / domReadOnly 下发，value 与 language 透传', () => {
    renderBase()
    expect(monacoState.create).toHaveBeenCalledTimes(1)
    expect(monacoState.created[0]?.setValue).toHaveBeenCalledWith('{"a":1}')
    expect(monacoState.created[0]?.updateOptions).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true, domReadOnly: true }),
    )
    expect(capturedProps.current?.value).toBe('{"a":1}')
    expect(capturedProps.current?.language).toBe('json')
  })

  it('theme 映射：light → vs、dark → vs-dark，且 setTheme 跟随切换', () => {
    const { rerender } = renderBase()
    expect(monacoState.setTheme).toHaveBeenCalledWith('vs')
    expect(capturedProps.current?.theme).toBe('vs')
    rerender(<MonacoTextEditor value={'{"a":1}'} language="json" theme="dark" wordWrap={true} />)
    expect(monacoState.setTheme).toHaveBeenLastCalledWith('vs-dark')
    expect(capturedProps.current?.theme).toBe('vs-dark')
  })

  it('可编辑形态（onChange 在线）：readOnly 解除，内容变化经 onChange 回传', () => {
    const onChange = vi.fn()
    renderBase({ onChange })
    expect(monacoState.created[0]?.updateOptions).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: false, domReadOnly: false }),
    )
    // 接线：假 Editor 收到的 onChange 即底座回传链路（undefined 并合为空串）
    capturedProps.current?.onChange?.('typed')
    expect(onChange).toHaveBeenCalledWith('typed')
    capturedProps.current?.onChange?.(undefined)
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('readOnly 显式强制：onChange 在线时也可禁编', () => {
    renderBase({ onChange: vi.fn(), readOnly: true })
    expect(monacoState.created[0]?.updateOptions).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true, domReadOnly: true }),
    )
  })

  it('wordWrap 透传：true → on、false → off（updateOptions 下发，不重建实例）', () => {
    const { rerender } = renderBase()
    expect(monacoState.created[0]?.updateOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ wordWrap: 'on' }),
    )
    rerender(<MonacoTextEditor value={'{"a":1}'} language="json" theme="light" wordWrap={false} />)
    expect(monacoState.created[0]?.updateOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ wordWrap: 'off' }),
    )
    expect(monacoState.create).toHaveBeenCalledTimes(1)
  })

  it('两区换行形态锚点：字号 / 行高 / 字体 / 悬挂缩进显式钉住（与等宽 pre 态同口径）', () => {
    renderBase()
    expect(monacoState.created[0]?.updateOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        fontSize: 14,
        lineHeight: 19,
        fontFamily: "Consolas, 'Courier New', monospace",
        // 软换行换行行与首行同列缩进（Monaco 默认 same，显式声明防漂移）
        wrappingIndent: 'same',
      }),
    )
  })

  it('同挂载期切 value / language / wordWrap 不重建实例', () => {
    const { rerender } = renderBase()
    rerender(<MonacoTextEditor value="plain" language="plaintext" theme="light" wordWrap={false} />)
    expect(monacoState.create).toHaveBeenCalledTimes(1)
    expect(monacoState.created[0]?.setValue).toHaveBeenLastCalledWith('plain')
    expect(capturedProps.current?.language).toBe('plaintext')
  })

  it('卸载即 dispose 编辑器实例', () => {
    const { unmount } = renderBase()
    unmount()
    expect(monacoState.created[0]?.dispose).toHaveBeenCalled()
  })
})

describe('MonacoTextEditor 变量联想（可选启用）', () => {
  it('不传 variableSuggest：零注册零开销', () => {
    renderBase()
    expect(languagesState.registerCompletionItemProvider).not.toHaveBeenCalled()
    expect(languagesState.registerHoverProvider).not.toHaveBeenCalled()
  })

  it('启用即注册：json / xml / plaintext 三语言 completion＋hover，触发字符 `{`', () => {
    const { unmount } = renderBase({ variableSuggest: { workspaceId: 'w1' } })
    // 零参 vi.fn 的 calls 需窄化回注册签名形态
    const completionCalls = languagesState.registerCompletionItemProvider.mock
      .calls as unknown as Array<[string, { triggerCharacters?: string[] }]>
    expect(completionCalls.map((call) => call[0])).toEqual(['json', 'xml', 'plaintext'])
    for (const call of completionCalls) {
      expect(call[1].triggerCharacters).toEqual(['{'])
    }
    const hoverCalls = languagesState.registerHoverProvider.mock.calls as unknown as Array<
      [string, unknown]
    >
    expect(hoverCalls.map((call) => call[0])).toEqual(['json', 'xml', 'plaintext'])
    unmount()
  })

  it('引用计数：多实例共享一组注册，全数卸载才 dispose', () => {
    const first = renderBase({ variableSuggest: { workspaceId: 'w1' } })
    const second = renderBase({ variableSuggest: { workspaceId: 'w1' } })
    // 单例注册：completion 3 + hover 3，共 6 个句柄
    expect(languagesState.registrations).toHaveLength(6)
    first.unmount()
    for (const registration of languagesState.registrations) {
      expect(registration.dispose).not.toHaveBeenCalled()
    }
    second.unmount()
    for (const registration of languagesState.registrations) {
      expect(registration.dispose).toHaveBeenCalledTimes(1)
    }
  })

  it('禁用切换：挂载期 prop 转 null 即注销，转回再注册', () => {
    const { rerender } = renderBase({ variableSuggest: { workspaceId: 'w1' } })
    expect(languagesState.registrations).toHaveLength(6)
    rerender(
      <MonacoTextEditor
        value="x"
        language="plaintext"
        theme="light"
        wordWrap={true}
        variableSuggest={null}
      />,
    )
    expect(languagesState.registrations.every((r) => r.dispose.mock.calls.length === 1)).toBe(true)
    rerender(
      <MonacoTextEditor
        value="x"
        language="plaintext"
        theme="light"
        wordWrap={true}
        variableSuggest={{ workspaceId: 'w1' }}
      />,
    )
    expect(languagesState.registerCompletionItemProvider).toHaveBeenCalledTimes(6)
  })
})
