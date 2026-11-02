import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Toaster, toast, toastStore } from '@workspace/ui/components'

import { SETTINGS_DEFAULTS } from '@/lib/settings-schema'
import { createQueryWrapper } from '@/test/render-providers'
import { useResponseStore } from '../response.store'
import { useSettingsStore } from '@/stores/settings.store'
import { useTabsStore } from '@/stores/tabs.store'

import type { RunResultDto } from '../http-api'
import type * as monacoNs from 'monaco-editor'
import { HTTP_BODY_EDITOR_MAX_CHARS } from '../constants'
import { ResponseBodyPane } from '../response-body-pane'

// —— Monaco 三模块替换（jsdom 不真渲染编辑器）——
// monaco-editor：editor.create / editor.setTheme 桩，create 返回可断言的
// 假实例（setValue / updateOptions / dispose 均 spy）——生命周期断言锚点
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
vi.mock('monaco-editor', () => ({ editor: monacoState }))

// monaco-env：本地 worker / loader 引导的副作用模块，测试下置空
vi.mock('../monaco-env', () => ({}))

// @monaco-editor/react：假 Editor 组件，模拟真实生命周期——mount 创建
// 实例、value / options 变化走 setValue / updateOptions、unmount dispose；
// language 以 data-language 输出供高亮语言断言
vi.mock('@monaco-editor/react', async () => {
  const React = await import('react')
  const monaco = await import('monaco-editor')

  interface FakeEditorProps {
    value?: string
    language?: string
    theme?: string
    options?: Record<string, unknown>
  }

  function Editor(props: FakeEditorProps) {
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
    return <div data-testid="monaco-editor-host" data-language={props.language ?? ''} />
  }

  return { default: Editor, loader: { config: vi.fn() } }
})

// monaco-text-editor 模块本体可挂起（gate）——供懒加载 fallback 断言：武装后
// 首个进 Pretty 态的用例先见 spinner，release 后真实模块顶替（默认立即返回
// 真实实现，既有用例行为不变）。vi.mock 工厂只执行一次，gate 用例须先于其它
// 触发 lazy 的用例运行（故置于文件首个 describe）
const monacoGate = vi.hoisted(() => ({
  armed: false,
  opened: null as (() => void) | null,
  release: (): void => {},
}))
vi.mock('../monaco-text-editor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../monaco-text-editor')>()
  if (monacoGate.armed) {
    // 工厂经异步 transform 后才执行：挂起前经 opened 通知测试，测试等到
    // 通知后再调 release（此时才被覆盖为真 resolver）
    monacoGate.opened?.()
    await new Promise<void>((resolve) => {
      monacoGate.release = resolve
    })
  }
  return actual
})

// Blob URL 桩（jsdom 无 createObjectURL）：句柄按调用序编号，供 revoke 断言
const blobUrl = vi.hoisted(() => ({ create: vi.fn(), revoke: vi.fn() }))

// 剪贴板 spy 持有器（jsdom 无 navigator.clipboard，Proxy 全局 stub、其余透传）
const clipboardState = vi.hoisted(() => ({
  current: { writeText: vi.fn() },
}))

// 全量读取桩（超限回落用例经它灌入受控全文）
const readRangeMock = vi.hoisted(() => vi.fn())
vi.mock('../http-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../http-api')>()
  return { ...actual, httpReadRange: readRangeMock }
})

const TAB_ID = 'endpoint:s1:e1'

// 模块级 toast store 的用例间隔离（TTL 5s 内残留会与后续同名 toast 叠加）
function clearAllToasts(): void {
  for (const item of toastStore.getSnapshot()) toast.dismiss(item.id)
}

beforeEach(() => {
  clearAllToasts()
  monacoState.created.length = 0
  monacoState.create.mockClear()
  monacoState.setTheme.mockClear()
  readRangeMock.mockReset()
  blobUrl.create
    .mockReset()
    .mockImplementation(() => `blob:mock-${blobUrl.create.mock.calls.length}`)
  blobUrl.revoke.mockReset()
  Object.defineProperty(URL, 'createObjectURL', {
    value: blobUrl.create,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: blobUrl.revoke,
    configurable: true,
    writable: true,
  })
  clipboardState.current = { writeText: vi.fn().mockResolvedValue(undefined) }
  vi.stubGlobal(
    'navigator',
    new Proxy(navigator, {
      get: (target, key) =>
        key === 'clipboard' ? clipboardState.current : Reflect.get(target, key),
    }),
  )
  // setBodyMode 有活 Tab 守卫，渲染期切 mode 需要 Tab 在册
  useTabsStore.setState({
    tabs: [
      { id: TAB_ID, kind: 'endpoint', title: '接口', serviceId: 's1', key: 'e1', preview: false },
    ],
    activeTabId: TAB_ID,
    editorTabs: {},
  })
  useResponseStore.setState({ bodyModes: {} })
  // 主题回浅色基准（setTheme 断言从 vs 起步）
  useSettingsStore.setState({ theme: { ...SETTINGS_DEFAULTS.theme, preference: 'light' } })
})

function makeResult(excerpt: string, overrides?: Partial<RunResultDto>): RunResultDto {
  return {
    runId: 'run-1',
    state: 'passed',
    statusCode: 200,
    durationMs: 5,
    errorCode: null,
    errorMessage: null,
    request: {
      method: 'GET',
      url: 'http://localhost/orders',
      headers: [],
      body: null,
      redactions: { headerNames: [], queryKeys: [], secretValues: [] },
    },
    response: {
      status: 200,
      headers: [],
      contentType: 'application/json',
      body: { excerpt, truncated: false, totalSize: excerpt.length },
    },
    responseId: null,
    resolved: { url: 'http://localhost/orders', hits: [], secretValues: [] },
    ...overrides,
  }
}

function renderPane(excerpt: string, result?: RunResultDto) {
  // Pretty 态挂真实 MonacoTextEditor（底座带 IPC 查询），统一包 QueryClient
  return render(
    <>
      <ResponseBodyPane result={result ?? makeResult(excerpt)} tabId={TAB_ID} />
      <Toaster />
    </>,
    { wrapper: createQueryWrapper() },
  )
}

describe('Monaco 懒加载 fallback（Pretty 态）', () => {
  it('chunk 在途显示居中 spinner（status＋aria-label＋高度链），就绪后编辑器顶替', async () => {
    // 武装 gate 后本用例是工厂首执行点：lazy 挂起直至 release
    monacoGate.armed = true
    const opened = new Promise<void>((resolve) => {
      monacoGate.opened = resolve
    })
    renderPane('{"ok":true}')
    // 等 vi.mock 工厂真正挂起（工厂经异步 transform 后才执行）
    await opened
    const loading = screen.getByTestId('monaco-loading')
    expect(loading).toHaveAttribute('role', 'status')
    expect(loading).toHaveAttribute('aria-label', '编辑器加载中')
    // 高度链：absolute inset-0 内居中，与编辑器装配层同构（无布局跳动）
    expect(loading).toHaveClass('absolute', 'inset-0')
    const spinner = loading.querySelector('svg')
    expect(spinner).not.toBeNull()
    expect(spinner).toHaveClass('animate-spin')
    // chunk 就绪：spinner 消失、Monaco 层内编辑器顶替
    await act(async () => {
      monacoGate.release()
    })
    expect(await screen.findByTestId('monaco-editor-host')).toBeInTheDocument()
    expect(screen.queryByTestId('monaco-loading')).not.toBeInTheDocument()
  })
})

describe('响应体复制链路（Pretty / Raw 口径）', () => {
  it('响应体区域可选中（CopySurface＋select-text）并带悬浮复制按钮', async () => {
    renderPane('{"ok":true}')
    const surface = await screen.findByTestId('response-body-surface')
    expect(surface).toHaveClass('select-text')
    expect(within(surface).getByRole('button', { name: '复制' })).toBeInTheDocument()
  })

  it('Pretty 态复制格式化文本（JSON 两空格缩进）', async () => {
    const user = userEvent.setup()
    renderPane('{"ok":true,"n":1}')
    await screen.findByTestId('response-body-monaco')
    await user.click(
      within(screen.getByTestId('response-body-surface')).getByRole('button', { name: '复制' }),
    )
    expect(await screen.findByText('已复制')).toBeInTheDocument()
    expect(clipboardState.current.writeText).toHaveBeenCalledWith('{\n  "ok": true,\n  "n": 1\n}')
  })

  it('切到 Raw 后复制原文（不格式化）', async () => {
    const user = userEvent.setup()
    renderPane('{"ok":true,"n":1}')
    await screen.findByTestId('response-body-monaco')
    await user.click(screen.getByRole('tab', { name: 'Raw' }))
    await user.click(
      within(screen.getByTestId('response-body-surface')).getByRole('button', { name: '复制' }),
    )
    expect(await screen.findByText('已复制')).toBeInTheDocument()
    expect(clipboardState.current.writeText).toHaveBeenCalledWith('{"ok":true,"n":1}')
  })

  it('非 JSON 响应：Pretty 回落原文复制', async () => {
    const user = userEvent.setup()
    renderPane('plain text body')
    await user.click(
      within(screen.getByTestId('response-body-surface')).getByRole('button', { name: '复制' }),
    )
    expect(await screen.findByText('已复制')).toBeInTheDocument()
    expect(clipboardState.current.writeText).toHaveBeenCalledWith('plain text body')
  })
})

describe('Monaco 编辑器（Pretty 态承载）', () => {
  it('Pretty(JSON) 挂载只读 Monaco：value＝格式化文本、readOnly 选项下发', async () => {
    renderPane('{"a":1}')
    await screen.findByTestId('response-body-monaco')
    expect(monacoState.create).toHaveBeenCalledTimes(1)
    const editor = monacoState.created[0]
    expect(editor.setValue).toHaveBeenCalledWith('{\n  "a": 1\n}')
    expect(editor.updateOptions).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }))
    // Pretty 态 pre 不渲染（编辑器顶替）
    expect(screen.queryByTestId('response-body-pre')).not.toBeInTheDocument()
  })

  it('切 Raw 不重建实例（Monaco 层 hidden、pre 顶替），切回恢复', async () => {
    const user = userEvent.setup()
    renderPane('{"a":1}')
    const layer = await screen.findByTestId('response-body-monaco')
    await user.click(screen.getByRole('tab', { name: 'Raw' }))
    // 实例不重建：create 仍一次，Monaco 层转入 hidden，pre 呈现原文
    expect(monacoState.create).toHaveBeenCalledTimes(1)
    expect(layer).toHaveClass('hidden')
    expect(screen.getByTestId('response-body-pre')).toHaveTextContent('{"a":1}')
    await user.click(screen.getByRole('tab', { name: 'Pretty' }))
    expect(monacoState.create).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('response-body-pre')).not.toBeInTheDocument()
  })

  it('卸载（关 Tab / 切走视图）即 dispose 编辑器实例', async () => {
    const { unmount } = renderPane('{"a":1}')
    await screen.findByTestId('response-body-monaco')
    unmount()
    expect(monacoState.created[0]?.dispose).toHaveBeenCalled()
  })

  it('主题跟随：resolved 主题切换 setTheme vs / vs-dark', async () => {
    renderPane('{"a":1}')
    await screen.findByTestId('response-body-monaco')
    expect(monacoState.setTheme).toHaveBeenCalledWith('vs')
    act(() => {
      useSettingsStore.setState({ theme: { ...SETTINGS_DEFAULTS.theme, preference: 'dark' } })
    })
    expect(monacoState.setTheme).toHaveBeenLastCalledWith('vs-dark')
  })

  it('新请求内容经 setValue 更新（实例跨请求复用）', async () => {
    const { rerender } = renderPane('{"a":1}')
    await screen.findByTestId('response-body-monaco')
    rerender(
      <>
        <ResponseBodyPane result={makeResult('{"b":2}', { runId: 'run-2' })} tabId={TAB_ID} />
        <Toaster />
      </>,
    )
    expect(monacoState.create).toHaveBeenCalledTimes(1)
    expect(monacoState.created[0]?.setValue).toHaveBeenLastCalledWith('{\n  "b": 2\n}')
  })

  it('Pretty / Raw 偏好跨请求保留（新 runId 不重置，per-tab 存于 store）', async () => {
    const user = userEvent.setup()
    const { rerender } = renderPane('{"a":1}')
    await screen.findByTestId('response-body-monaco')
    await user.click(screen.getByRole('tab', { name: 'Raw' }))
    expect(useResponseStore.getState().bodyModes[TAB_ID]).toBe('raw')
    rerender(
      <>
        <ResponseBodyPane result={makeResult('{"b":2}', { runId: 'run-2' })} tabId={TAB_ID} />
        <Toaster />
      </>,
    )
    // 新响应仍停在 Raw：pre 直出原文（未格式化）
    expect(screen.getByTestId('response-body-pre')).toHaveTextContent('{"b":2}')
    expect(useResponseStore.getState().bodyModes[TAB_ID]).toBe('raw')
  })
})

describe('换行开关（默认关——与请求区 Body 编辑同口径）', () => {
  it('Monaco 态：初始 off，切换开关下发 wordWrap on / off', async () => {
    const user = userEvent.setup()
    renderPane('{"a":1}')
    await screen.findByTestId('response-body-monaco')
    const toggle = screen.getByRole('button', { name: '自动换行' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await user.click(toggle)
    expect(monacoState.created[0]?.updateOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ wordWrap: 'on' }),
    )
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await user.click(toggle)
    expect(monacoState.created[0]?.updateOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ wordWrap: 'off' }),
    )
  })

  it('pre 态：初始不换行（overflow-x-auto），开关联动 whitespace-pre-wrap', async () => {
    const user = userEvent.setup()
    renderPane('plain text body')
    const pre = await screen.findByTestId('response-body-pre')
    expect(pre).toHaveClass('whitespace-pre')
    expect(pre).toHaveClass('overflow-x-auto')
    await user.click(screen.getByRole('button', { name: '自动换行' }))
    expect(pre).toHaveClass('whitespace-pre-wrap')
  })

  it('pre 态字号行高与 Monaco 底座同档（14px / 19px 等宽）', async () => {
    renderPane('plain text body')
    const pre = await screen.findByTestId('response-body-pre')
    expect(pre).toHaveClass('font-mono')
    expect(pre).toHaveClass('text-[14px]')
    expect(pre).toHaveClass('leading-[19px]')
  })
})

describe('大文本回落（超过编辑器上限不建 Monaco 内容）', () => {
  it('全量加载后超限：回落等宽 pre 呈现原文（Pretty 偏好也不进编辑器）', async () => {
    const user = userEvent.setup()
    // 合法 JSON 且全文超过 1MB 上限
    const pad = 'x'.repeat(HTTP_BODY_EDITOR_MAX_CHARS - 8)
    const fullText = `{"pad":"${pad}"}`
    const result = makeResult('{"pad":', {
      responseId: `http:tab:${TAB_ID}`,
      response: {
        status: 200,
        headers: [],
        contentType: 'application/json',
        body: { excerpt: '{"pad":', truncated: true, totalSize: fullText.length },
      },
    })
    const bytes = new TextEncoder().encode(fullText)
    readRangeMock.mockImplementation((_responseId: string, offset: number, len: number) =>
      Promise.resolve(bytes.slice(offset, offset + len).buffer),
    )
    renderPane('{"pad":', result)
    await user.click(screen.getByRole('button', { name: '加载全量' }))
    const pre = await screen.findByTestId('response-body-pre')
    expect(pre).toHaveTextContent('"pad"')
    expect(pre.textContent?.length).toBe(fullText.length)
    // 超限回落：编辑器从未挂载，复制口径仍可用
    expect(monacoState.create).not.toHaveBeenCalled()
    expect(screen.queryByTestId('response-body-monaco')).not.toBeInTheDocument()
  })

  it('全量加载后未超限的 JSON：Pretty 态进 Monaco 呈现格式化全文', async () => {
    const user = userEvent.setup()
    const result = makeResult('{"a":', {
      responseId: `http:tab:${TAB_ID}`,
      response: {
        status: 200,
        headers: [],
        contentType: 'application/json',
        body: { excerpt: '{"a":', truncated: true, totalSize: 9 },
      },
    })
    const bytes = new TextEncoder().encode('{"a":1}')
    readRangeMock.mockImplementation((_responseId: string, offset: number, len: number) =>
      Promise.resolve(bytes.slice(offset, offset + len).buffer),
    )
    renderPane('{"a":', result)
    await user.click(screen.getByRole('button', { name: '加载全量' }))
    await screen.findByTestId('response-body-monaco')
    expect(monacoState.created[0]?.setValue).toHaveBeenLastCalledWith('{\n  "a": 1\n}')
    expect(screen.queryByTestId('response-body-pre')).not.toBeInTheDocument()
  })
})

// —— Preview / 格式选择器 / 编码选择器（本批新增能力） ——

/** 内存档原始字节注入：rawBase64（仅内存档 DTO 携带） */
function withRawBytes(result: RunResultDto, bytes: Uint8Array): RunResultDto {
  if (!result.response) return result
  return {
    ...result,
    response: {
      ...result.response,
      body: { ...result.response.body, rawBase64: btoa(String.fromCharCode(...bytes)) },
    },
  }
}

/** GBK 编码的「中文」（0xD6 0xD0 0xCE 0xC4），utf-8 解码为乱码可作对照 */
const GBK_ZHONGWEN = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])

describe('Preview 视图（可渲染类型判定与渲染通道）', () => {
  it('html：iframe 最严格沙箱（sandbox 空串）＋ Blob URL 承载', async () => {
    const user = userEvent.setup()
    const html = '<h1>hi</h1>'
    const result = withRawBytes(
      makeResult(html, {
        response: {
          status: 200,
          headers: [['content-type', 'text/html']],
          contentType: 'text/html',
          body: { excerpt: html, truncated: false, totalSize: html.length },
        },
      }),
      new TextEncoder().encode(html),
    )
    renderPane(html, result)
    await user.click(screen.getByRole('tab', { name: 'Preview' }))
    const frame = (await screen.findByTestId('response-preview-html')) as HTMLIFrameElement
    expect(frame).toHaveAttribute('sandbox', '')
    expect(frame.getAttribute('src')).toBe('blob:mock-1')
  })

  it('图片：img 承载 Blob URL（Content-Type 原样透传）', async () => {
    const user = userEvent.setup()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const result = withRawBytes(
      makeResult('', {
        response: {
          status: 200,
          headers: [['content-type', 'image/png']],
          contentType: 'image/png',
          body: { excerpt: '', truncated: false, totalSize: png.length },
        },
      }),
      png,
    )
    renderPane('', result)
    await user.click(screen.getByRole('tab', { name: 'Preview' }))
    const img = (await screen.findByTestId('response-preview-image')) as HTMLImageElement
    expect(img.getAttribute('src')).toBe('blob:mock-1')
  })

  it('pdf：无沙箱 iframe 承载 Blob URL（沙箱化 frame 会被 WebView2 拦截内置查看器）', async () => {
    const user = userEvent.setup()
    const pdf = Uint8Array.from('%PDF-1.7', (c) => c.charCodeAt(0))
    const result = withRawBytes(
      makeResult('', {
        response: {
          status: 200,
          headers: [['content-type', 'application/pdf']],
          contentType: 'application/pdf',
          body: { excerpt: '', truncated: false, totalSize: pdf.length },
        },
      }),
      pdf,
    )
    renderPane('', result)
    await user.click(screen.getByRole('tab', { name: 'Preview' }))
    const frame = (await screen.findByTestId('response-preview-pdf')) as HTMLIFrameElement
    expect(frame.getAttribute('src')).toBe('blob:mock-1')
    expect(frame.hasAttribute('sandbox')).toBe(false)
  })

  it('pdf 类型但非 PDF 字节（Content-Type 谎报）：不进无沙箱通道，回落提示', async () => {
    const user = userEvent.setup()
    const html = '<h1>not a pdf</h1>'
    const result = withRawBytes(
      makeResult('', {
        response: {
          status: 200,
          headers: [['content-type', 'application/pdf']],
          contentType: 'application/pdf',
          body: { excerpt: html, truncated: false, totalSize: html.length },
        },
      }),
      new TextEncoder().encode(html),
    )
    renderPane(html, result)
    await user.click(screen.getByRole('tab', { name: 'Preview' }))
    expect(await screen.findByText(/当前响应是二进制内容/)).toBeInTheDocument()
    expect(screen.queryByTestId('response-preview-pdf')).not.toBeInTheDocument()
  })

  it('未知类型（json）字节嗅探为二进制：回落提示带当前响应类型，无渲染元素', async () => {
    const user = userEvent.setup()
    // PNG 魔数开头：未知 Content-Type 按字节判定为二进制
    const pngLike = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const result = withRawBytes(
      makeResult('', {
        response: {
          status: 200,
          headers: [],
          contentType: 'application/json',
          body: { excerpt: '', truncated: false, totalSize: pngLike.length },
        },
      }),
      pngLike,
    )
    renderPane('', result)
    await user.click(screen.getByRole('tab', { name: 'Preview' }))
    expect(screen.getByTestId('response-body-preview')).toHaveTextContent('application/json')
    expect(screen.getByTestId('response-body-preview')).toHaveTextContent(
      'Preview 只对可渲染类型（html / 图片 / PDF / 文本）可用',
    )
    expect(screen.queryByTestId('response-preview-html')).not.toBeInTheDocument()
    expect(screen.queryByTestId('response-preview-image')).not.toBeInTheDocument()
    expect(screen.queryByTestId('response-body-preview-text')).not.toBeInTheDocument()
  })

  it('未知类型但字节嗅探为文本：进文本预览（可读排版，无行号无高亮）', async () => {
    const user = userEvent.setup()
    const text = new TextEncoder().encode('log line one\nlog line two')
    const result = withRawBytes(
      makeResult('log line one', {
        response: {
          status: 200,
          headers: [],
          contentType: 'application/octet-stream',
          body: { excerpt: 'log line one', truncated: false, totalSize: text.length },
        },
      }),
      text,
    )
    renderPane('log line one', result)
    await user.click(screen.getByRole('tab', { name: 'Preview' }))
    const pre = await screen.findByTestId('response-body-preview-text')
    // 字节在手＝全文口径（截断 excerpt 被 utf-8 全量解码顶替）
    expect(pre).toHaveTextContent(/log line one\s+log line two/)
    expect(pre).toHaveClass('whitespace-pre-wrap')
    expect(pre).toHaveClass('text-[14px]')
    expect(screen.queryByTestId('response-body-monaco')).not.toBeInTheDocument()
  })

  it('text/plain 直出文本预览（Content-Type 已声明，无需字节嗅探）', async () => {
    const user = userEvent.setup()
    // 无 rawBase64 无 responseId（无字节源）：text 档不等待字节，直接展示
    renderPane(
      'hello plain',
      makeResult('hello plain', {
        response: {
          status: 200,
          headers: [['content-type', 'text/plain']],
          contentType: 'text/plain',
          body: { excerpt: 'hello plain', truncated: false, totalSize: 11 },
        },
      }),
    )
    await user.click(screen.getByRole('tab', { name: 'Preview' }))
    expect(await screen.findByTestId('response-body-preview-text')).toHaveTextContent('hello plain')
  })

  it('编码切换后文本预览跟随重解码（未知类型＋GBK 字节）', async () => {
    const user = userEvent.setup()
    const result = withRawBytes(
      makeResult('', {
        response: {
          status: 200,
          headers: [],
          contentType: 'application/octet-stream',
          body: { excerpt: '', truncated: false, totalSize: GBK_ZHONGWEN.length },
        },
      }),
      GBK_ZHONGWEN,
    )
    renderPane('', result)
    // 编码选择器在 Pretty 态：先切 gbk（Pretty 侧重解码），再切 Preview 验证跟随
    await user.click(screen.getByRole('combobox', { name: '响应体编码' }))
    await user.click(await vi.waitFor(() => screen.getByRole('option', { name: 'gbk' })))
    await user.click(screen.getByRole('tab', { name: 'Preview' }))
    // GBK 高位字节经嗅探按文本放行，预览文本为 gbk 重解码结果
    expect(await screen.findByTestId('response-body-preview-text')).toHaveTextContent('中文')
  })

  it('Blob URL 生命周期：字节替换 revoke 旧句柄、卸载回收当前句柄', async () => {
    const user = userEvent.setup()
    const first = new TextEncoder().encode('<h1>a</h1>')
    const { rerender, unmount } = render(
      <>
        <ResponseBodyPane
          result={withRawBytes(
            makeResult('<h1>a</h1>', {
              response: {
                status: 200,
                headers: [['content-type', 'text/html']],
                contentType: 'text/html',
                body: { excerpt: '<h1>a</h1>', truncated: false, totalSize: first.length },
              },
            }),
            first,
          )}
          tabId={TAB_ID}
        />
        <Toaster />
      </>,
      { wrapper: createQueryWrapper() },
    )
    await user.click(screen.getByRole('tab', { name: 'Preview' }))
    await screen.findByTestId('response-preview-html')
    expect(blobUrl.create).toHaveBeenCalledTimes(1)

    // 新响应到达（新 runId ＋ 新字节）：旧句柄 revoke、新句柄建出
    const second = new TextEncoder().encode('<h1>b</h1>')
    rerender(
      <>
        <ResponseBodyPane
          result={withRawBytes(
            makeResult('<h1>b</h1>', {
              runId: 'run-2',
              response: {
                status: 200,
                headers: [['content-type', 'text/html']],
                contentType: 'text/html',
                body: { excerpt: '<h1>b</h1>', truncated: false, totalSize: second.length },
              },
            }),
            second,
          )}
          tabId={TAB_ID}
        />
        <Toaster />
      </>,
    )
    await screen.findByTestId('response-preview-html')
    expect(blobUrl.create).toHaveBeenCalledTimes(2)
    expect(blobUrl.revoke).toHaveBeenCalledWith('blob:mock-1')

    // 卸载：当前句柄回收
    unmount()
    expect(blobUrl.revoke).toHaveBeenCalledWith('blob:mock-2')
  })

  it('可渲染类型但无字节源（超限内存档）：显示大小限制提示', async () => {
    const user = userEvent.setup()
    renderPane(
      '',
      makeResult('', {
        response: {
          status: 200,
          headers: [['content-type', 'image/png']],
          contentType: 'image/png',
          body: { excerpt: '', truncated: true, totalSize: 60 * 1024 * 1024 },
        },
      }),
    )
    await user.click(screen.getByRole('tab', { name: 'Preview' }))
    expect(screen.getByTestId('response-body-preview')).toHaveTextContent('全量查看受大小限制')
  })
})

describe('格式选择器（推导当前项、只影响视图层）', () => {
  it('json 响应推导 JSON：Monaco 以 json 语言高亮格式化文本', async () => {
    renderPane('{"a":1}')
    const host = await screen.findByTestId('monaco-editor-host')
    expect(host).toHaveAttribute('data-language', 'json')
  })

  it('text 响应推导 Text：等宽 pre 直出、不进编辑器', async () => {
    renderPane(
      'plain text body',
      makeResult('plain', {
        response: {
          status: 200,
          headers: [['content-type', 'text/plain']],
          contentType: 'text/plain',
          body: { excerpt: 'plain text body', truncated: false, totalSize: 15 },
        },
      }),
    )
    expect(await screen.findByTestId('response-body-pre')).toHaveTextContent('plain text body')
    expect(screen.queryByTestId('response-body-monaco')).not.toBeInTheDocument()
  })

  it('切 XML：换高亮语言；非 XML 文本格式化原样返回（原文进编辑器）', async () => {
    const user = userEvent.setup()
    renderPane('plain text body')
    await user.click(screen.getByRole('combobox', { name: '响应体格式' }))
    await user.click(await vi.waitFor(() => screen.getByRole('option', { name: 'XML' })))
    const host = await screen.findByTestId('monaco-editor-host')
    expect(host).toHaveAttribute('data-language', 'xml')
    expect(monacoState.created[0]?.setValue).toHaveBeenLastCalledWith('plain text body')
  })

  it('切 XML：合法内容经缩进规整后进编辑器（Pretty 态）', async () => {
    const user = userEvent.setup()
    renderPane('<root><a>1</a><b/></root>')
    await user.click(screen.getByRole('combobox', { name: '响应体格式' }))
    await user.click(await vi.waitFor(() => screen.getByRole('option', { name: 'XML' })))
    const host = await screen.findByTestId('monaco-editor-host')
    expect(host).toHaveAttribute('data-language', 'xml')
    await vi.waitFor(() => {
      expect(monacoState.created[0]?.setValue).toHaveBeenLastCalledWith(
        '<root>\n  <a>1</a>\n  <b/>\n</root>',
      )
    })
  })
})

describe('编码选择器（按原始字节重解码）', () => {
  it('随响应 charset 推导：gbk 声明的内存档自动重解码为中文', async () => {
    const result = withRawBytes(
      makeResult('', {
        response: {
          status: 200,
          headers: [['content-type', 'text/plain; charset=gbk']],
          contentType: 'text/plain; charset=gbk',
          body: { excerpt: '', truncated: false, totalSize: GBK_ZHONGWEN.length },
        },
      }),
      GBK_ZHONGWEN,
    )
    renderPane('', result)
    // 后端 excerpt 是 utf-8 lossy（乱码）；按声明 charset 重解码后中文正确
    const pre = await screen.findByTestId('response-body-pre')
    expect(pre).toHaveTextContent('中文')
    expect(screen.queryByTestId('response-charset-fallback')).not.toBeInTheDocument()
  })

  it('用户切编码：utf-8 口径文本按 gbk 重解码', async () => {
    const user = userEvent.setup()
    const result = withRawBytes(
      makeResult('', {
        response: {
          status: 200,
          headers: [],
          contentType: 'application/octet-stream',
          body: { excerpt: '', truncated: false, totalSize: GBK_ZHONGWEN.length },
        },
      }),
      GBK_ZHONGWEN,
    )
    renderPane('', result)
    await user.click(screen.getByRole('combobox', { name: '响应体编码' }))
    await user.click(await vi.waitFor(() => screen.getByRole('option', { name: 'gbk' })))
    const pre = await screen.findByTestId('response-body-pre')
    expect(pre).toHaveTextContent('中文')
  })

  it('解码失败回落 utf-8 并提示', async () => {
    const user = userEvent.setup()
    const invalidGbk = new Uint8Array([0x81, 0xff]) // 非法 gbk 双字节序列，fatal 解码必抛
    const result = withRawBytes(
      makeResult('', {
        response: {
          status: 200,
          headers: [],
          contentType: 'application/octet-stream',
          body: { excerpt: '', truncated: false, totalSize: invalidGbk.length },
        },
      }),
      invalidGbk,
    )
    renderPane('', result)
    await user.click(screen.getByRole('combobox', { name: '响应体编码' }))
    await user.click(await vi.waitFor(() => screen.getByRole('option', { name: 'gbk' })))
    // eslint-disable-next-line no-console
    console.log(
      'DEBUG toolbar:',
      document.querySelector('[data-testid=response-body-toolbar]')?.textContent,
      '| pre:',
      document.querySelector('[data-testid=response-body-pre]')?.textContent,
    )
    expect(await screen.findByTestId('response-charset-fallback')).toHaveTextContent('gbk')
  })

  it('文件档：charset 声明触发分段拉取原始字节后重解码', async () => {
    const result = makeResult('', {
      responseId: `http:tab:${TAB_ID}`,
      response: {
        status: 200,
        headers: [['content-type', 'text/plain; charset=gbk']],
        contentType: 'text/plain; charset=gbk',
        body: { excerpt: '', truncated: true, totalSize: GBK_ZHONGWEN.length },
      },
    })
    readRangeMock.mockImplementation((_responseId: string, offset: number, len: number) =>
      Promise.resolve(GBK_ZHONGWEN.slice(offset, offset + len).buffer),
    )
    renderPane('', result)
    const pre = await screen.findByTestId('response-body-pre')
    await waitFor(() => {
      expect(pre).toHaveTextContent('中文')
    })
    expect(readRangeMock).toHaveBeenCalledWith(`http:tab:${TAB_ID}`, 0, GBK_ZHONGWEN.length)
  })
})
