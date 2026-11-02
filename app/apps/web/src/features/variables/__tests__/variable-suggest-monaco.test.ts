import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as monacoNs from 'monaco-editor'

import type { EffectiveVariableDto } from '../variable-api'
import {
  acquireMonacoVariableSuggest,
  buildVariableSuggestions,
  releaseMonacoVariableSuggest,
  setMonacoVariableContext,
  variableHoverAt,
  type SuggestLabels,
} from '../variable-suggest-monaco'

const items: EffectiveVariableDto[] = [
  { key: 'baseUrl', value: 'http://api.test', secret: false, source: 'builtin' },
  { key: 'token', value: 'sk-live', secret: true, source: 'active' },
  { key: 'pageSize', value: '20', secret: false, source: 'active' },
  { key: 'siteName', value: '示例站', secret: false, source: 'global' },
]

const labels: SuggestLabels = {
  sourceActive: '激活分类',
  sourceGlobal: '全局分类',
  sourceBuiltin: '内置',
  secretBadge: 'Secret 变量',
  undefinedBadge: '未定义',
}

// —— provider 调用面（acquire 注册出的 Monaco 胶水）——
// monaco 命名空间桩：注册面用普通数组捕获 provider 实现（不经 mock 状态
// 系统，hook 与用例间稳定共享）；CompletionItemKind 用自洽假值（断言与桩
// 值互证，不依赖真实枚举序）。纯函数测试不触 monaco 运行时，无需 mock 模块
const monacoStub = vi.hoisted(() => {
  const captured: {
    completion: Array<{ language: string; provider: unknown }>
    hover: Array<{ language: string; provider: unknown }>
  } = { completion: [], hover: [] }
  const registration = { dispose: () => {} }
  return {
    captured,
    languages: {
      registerCompletionItemProvider: (language: string, provider: unknown) => {
        captured.completion.push({ language, provider })
        return registration
      },
      registerHoverProvider: (language: string, provider: unknown) => {
        captured.hover.push({ language, provider })
        return registration
      },
      CompletionItemKind: { Variable: 'kind-variable' },
    },
  }
})

/** 捕获的建议项（窄化到断言用到的面；kind 用桩值互证取 unknown） */
interface CapturedSuggestion {
  label: string
  kind: unknown
  insertText: string
  filterText?: string
  detail: string
  sortText: string
  range: monacoNs.IRange
}

/** 捕获的 completion provider 签名（model 只用到行内 getValueInRange 切片） */
interface CapturedCompletionProvider {
  provideCompletionItems: (
    model: { getValueInRange: (range: monacoNs.IRange) => string },
    position: { lineNumber: number; column: number },
  ) => { suggestions: CapturedSuggestion[] }
}

/** 捕获的 hover provider 签名（model 只用到 getLineContent） */
interface CapturedHoverProvider {
  provideHover: (
    model: { getLineContent: (lineNumber: number) => string },
    position: { lineNumber: number; column: number },
  ) => { contents: Array<{ value: string }> } | null
}

/** 最近一次注册的 completion provider（三语言实现同体，取首个） */
function capturedCompletionProvider(): CapturedCompletionProvider {
  return monacoStub.captured.completion[0]!.provider as CapturedCompletionProvider
}

/** 最近一次注册的 hover provider（三语言实现同体，取首个） */
function capturedHoverProvider(): CapturedHoverProvider {
  return monacoStub.captured.hover[0]!.provider as CapturedHoverProvider
}

/** 单行假 model：getValueInRange 按列切片、getLineContent 整行（与真实
 *  model 的行内语义一致，provider 只做单行读取） */
function fakeModel(line: string) {
  return {
    getValueInRange: (range: monacoNs.IRange) =>
      line.slice(range.startColumn - 1, range.endColumn - 1),
    getLineContent: () => line,
  }
}

describe('buildVariableSuggestions（补全候选构造）', () => {
  it('插入文本为完整 `{{键}}`，detail 为值预览＋来源层', () => {
    const [first] = buildVariableSuggestions('page', items, labels)
    expect(first).toMatchObject({
      label: 'pageSize',
      insertText: '{{pageSize}}',
      detail: '20 · 激活分类',
    })
  })

  it('键名大小写不敏感包含过滤；无匹配返回空数组', () => {
    expect(buildVariableSuggestions('TOKEN', items, labels).map((s) => s.label)).toEqual(['token'])
    expect(buildVariableSuggestions('', items, labels)).toHaveLength(4)
    expect(buildVariableSuggestions('zzz', items, labels)).toEqual([])
  })

  it('Secret 行值恒掩码；来源层排序 active → global → builtin', () => {
    const all = buildVariableSuggestions('', items, labels)
    expect(all.find((s) => s.label === 'token')?.detail).toBe('*** · 激活分类')
    expect(all.find((s) => s.label === 'siteName')?.detail).toBe('示例站 · 全局分类')
    expect(all.map((s) => s.label)).toEqual(['pageSize', 'token', 'siteName', 'baseUrl'])
  })
})

describe('variableHoverAt（hover 命中）', () => {
  const line = 'x {{token}} y {{pageSize}}'

  it('光标落在引用区间内命中（含边界），区间外未命中', () => {
    // `{{token}}` 占列 3–11（1-based 列 3 是首 `{`、列 11 是末 `}`）
    expect(variableHoverAt(line, 3, items, labels)?.key).toBe('token')
    expect(variableHoverAt(line, 11, items, labels)?.key).toBe('token')
    expect(variableHoverAt(line, 12, items, labels)).toBeNull()
    expect(variableHoverAt(line, 2, items, labels)).toBeNull()
    expect(variableHoverAt(line, 16, items, labels)?.key).toBe('pageSize')
  })

  it('Secret 命中：值掩码＋secret 标记＋来源层文案', () => {
    const hit = variableHoverAt(line, 5, items, labels)
    expect(hit).toMatchObject({ key: 'token', value: '***', secret: true, sourceLabel: '激活分类' })
  })

  it('普通命中带解析值；未定义键 value 为 null、无来源层', () => {
    expect(variableHoverAt(line, 17, items, labels)).toMatchObject({
      key: 'pageSize',
      value: '20',
      sourceLabel: '激活分类',
    })
    const missing = variableHoverAt('go {{nope}}', 5, items, labels)
    expect(missing).toMatchObject({ key: 'nope', value: null, sourceLabel: undefined })
  })
})

describe('provider 调用面（acquire 注册出的 completion / hover 胶水）', () => {
  beforeAll(() => {
    acquireMonacoVariableSuggest(monacoStub as unknown as typeof monacoNs)
    setMonacoVariableContext(items, labels)
  })
  afterAll(() => {
    releaseMonacoVariableSuggest()
  })

  it('未闭合 `{{`：全集候选，filterText 与整段替换 range 逐项钉住', () => {
    const line = '{"key":"{{'
    const at = { lineNumber: 1, column: line.length + 1 }
    const { suggestions } = capturedCompletionProvider().provideCompletionItems(fakeModel(line), at)
    expect(suggestions.map((s) => s.label)).toEqual(['pageSize', 'token', 'siteName', 'baseUrl'])
    for (const item of suggestions) {
      // filterText＝`{{＋键名：Monaco 以回跨替换的原文 `{{query` 为过滤词按
      // filterText 模糊命中；缺省回退 label（无花括号恒不中）会被整项静默
      // 丢弃——面板不弹，即 `{{` 无联想的根因形态，此处为回归锚点
      expect(item.filterText).toBe(`{{${item.label}`)
      expect(item.insertText).toBe(`{{${item.label}}}`)
      expect(item.kind).toBe(monacoStub.languages.CompletionItemKind.Variable)
      // 替换范围＝未闭合片段整段：光标前 query.length＋2 列（双花括号计入，
      // 少一列会残留连击花括号）
      expect(item.range).toEqual({
        startLineNumber: 1,
        endLineNumber: 1,
        startColumn: at.column - 2,
        endColumn: at.column,
      })
    }
  })

  it('带查询词：键名包含过滤，range 随 query 加宽', () => {
    const line = '{"key":"{{tok'
    const at = { lineNumber: 1, column: line.length + 1 }
    const { suggestions } = capturedCompletionProvider().provideCompletionItems(fakeModel(line), at)
    expect(suggestions.map((s) => s.label)).toEqual(['token'])
    expect(suggestions[0]?.filterText).toBe('{{token')
    expect(suggestions[0]?.range).toEqual({
      startLineNumber: 1,
      endLineNumber: 1,
      startColumn: at.column - ('tok'.length + 2),
      endColumn: at.column,
    })
  })

  it('闭合引用与无片段：空建议（不弹面板）', () => {
    const provider = capturedCompletionProvider()
    const closed = '{"key":"{{token}}"}'
    expect(
      provider.provideCompletionItems(fakeModel(closed), {
        lineNumber: 1,
        column: closed.length + 1,
      }).suggestions,
    ).toEqual([])
    expect(
      provider.provideCompletionItems(fakeModel('plain'), { lineNumber: 1, column: 6 }).suggestions,
    ).toEqual([])
  })

  it('hover：闭合引用上产解析卡片，区间外为 null', () => {
    const line = 'x {{token}} y' // `{{token}}` 占列 3–11（1-based）
    const hit = capturedHoverProvider().provideHover(fakeModel(line), { lineNumber: 1, column: 5 })
    expect(hit?.contents).toEqual([{ value: '`{{token}}` = ***\n\nSecret 变量 · 激活分类' }])
    expect(
      capturedHoverProvider().provideHover(fakeModel(line), { lineNumber: 1, column: 2 }),
    ).toBeNull()
  })
})

describe('provider 上下文生命周期（模块级单例＋引用计数）', () => {
  beforeEach(() => {
    monacoStub.captured.completion.length = 0
  })

  it('引用归零释放后重新启用：上下文清空，未同步前不产建议', () => {
    acquireMonacoVariableSuggest(monacoStub as unknown as typeof monacoNs)
    setMonacoVariableContext(items, labels)
    // 归零释放：dispose 全部注册并清空上下文；重新启用是一组全新注册
    releaseMonacoVariableSuggest()
    acquireMonacoVariableSuggest(monacoStub as unknown as typeof monacoNs)
    const line = '{"key":"{{'
    const result = capturedCompletionProvider().provideCompletionItems(fakeModel(line), {
      lineNumber: 1,
      column: line.length + 1,
    })
    expect(result.suggestions).toEqual([])
    releaseMonacoVariableSuggest()
  })
})
