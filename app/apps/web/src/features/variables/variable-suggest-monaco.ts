/**
 * Monaco 变量联想与 hover 解析（body 文本编辑器面）：completion / hover
 * provider 的注册管理与命中纯逻辑分离——纯函数（建议构造、hover 命中）
 * 独立可测，Monaco API 只剩薄胶水。触发与命中复用输入框联想的同一组
 * 纯函数（`variable-suggest-match`），两侧 `{{` 语义恒同源。
 *
 * 数据源＝生效变量集（variable.effective，与发送侧解析、输入框联想同源
 * ——补全列出的键必然可解析）；Secret 行值恒掩码（***）。
 *
 * 注册生命周期：provider 按 language id 全局注册，模块级单例＋引用计数
 * （多编辑器同屏共享一组注册，启用方全数卸载即 dispose 不残留）。上下文
 * （变量列表与展示文案）经 setMonacoVariableContext 由启用方在 effect 中
 * 同步——provider 调用面读到恒为最新值，不经闭包快照。
 */
import type * as monacoNs from 'monaco-editor'

import type { EffectiveVariableDto } from './variable-api'
import { findVariableReferences, matchVariableFragment } from './variable-suggest-match'

/** Secret 行值掩码（与输入框联想、hover 解析同一呈现口径） */
const SECRET_MASK = '***'

/** 来源层排序权重：激活分类 → 全局分类 → 内置 */
const SOURCE_RANK: Record<EffectiveVariableDto['source'], number> = {
  active: 0,
  global: 1,
  builtin: 2,
}

/** Provider 展示文案（启用方经 i18n 注入；provider 非 React 面不持 hook） */
export interface SuggestLabels {
  sourceActive: string
  sourceGlobal: string
  sourceBuiltin: string
  secretBadge: string
  undefinedBadge: string
}

const SOURCE_LABEL_KEY: Record<EffectiveVariableDto['source'], keyof SuggestLabels> = {
  active: 'sourceActive',
  global: 'sourceGlobal',
  builtin: 'sourceBuiltin',
}

/** 建议项（纯逻辑产物；Monaco 胶水层补 range / kind） */
export interface VariableSuggestion {
  /** 候选键名（面板主标签） */
  label: string
  /** 完整插入文本（`{{键}}`） */
  insertText: string
  /** 值预览（Secret 恒掩码）＋来源层文案 */
  detail: string
  /** 排序键：来源层权重前缀＋键名（同层稳定序） */
  sortText: string
}

/** 光标前未闭合 `{{query` 片段 → 候选列表：键名大小写不敏感包含过滤、
 *  来源层排序；无匹配返回 []（Monaco 不弹面板） */
export function buildVariableSuggestions(
  query: string,
  items: readonly EffectiveVariableDto[],
  labels: SuggestLabels,
): VariableSuggestion[] {
  const needle = query.toLowerCase()
  return items
    .filter((item) => item.key.toLowerCase().includes(needle))
    .map((item) => ({
      label: item.key,
      insertText: `{{${item.key}}}`,
      detail: `${item.secret ? SECRET_MASK : item.value} · ${
        labels[SOURCE_LABEL_KEY[item.source]]
      }`,
      sortText: `${SOURCE_RANK[item.source]}:${item.key}`,
    }))
    .sort((a, b) => a.sortText.localeCompare(b.sortText))
}

/** hover 命中信息（闭合 `{{键}}` 引用上的解析值展示） */
export interface VariableHoverInfo {
  key: string
  /** 展示值：Secret 恒掩码；生效集未含的键为 null（调用方给未定义标注） */
  value: string | null
  /** 来源层文案；未定义键为 undefined */
  sourceLabel: string | undefined
  secret: boolean
}

/** 行文本＋光标列（1-based）→ 命中的闭合引用（列偏移落在 `{{…}}` 区间内）；
 *  未命中（无引用 / 列在区间外）返回 null */
export function variableHoverAt(
  lineText: string,
  column: number,
  items: readonly EffectiveVariableDto[],
  labels: SuggestLabels,
): VariableHoverInfo | null {
  const offset = column - 1
  const hit = findVariableReferences(lineText).find(
    (ref) => offset >= ref.start && offset < ref.end,
  )
  if (hit === undefined) return null
  const item = items.find((v) => v.key === hit.key)
  if (item === undefined) {
    return { key: hit.key, value: null, sourceLabel: undefined, secret: false }
  }
  return {
    key: hit.key,
    value: item.secret ? SECRET_MASK : item.value,
    sourceLabel: labels[SOURCE_LABEL_KEY[item.source]],
    secret: item.secret,
  }
}

// —— 模块级上下文（启用方 effect 同步；provider 调用面读最新） ——

let contextItems: readonly EffectiveVariableDto[] = []
let contextLabels: SuggestLabels | null = null

/** 同步变量集与展示文案（启用方数据 / 语言切换时调用） */
export function setMonacoVariableContext(
  items: readonly EffectiveVariableDto[],
  labels: SuggestLabels,
): void {
  contextItems = items
  contextLabels = labels
}

// —— 注册管理（单例＋引用计数；language id 三值覆盖 body 文本系） ——

const SUGGEST_LANGUAGES = ['json', 'xml', 'plaintext'] as const

let registrations: monacoNs.IDisposable[] | null = null
let consumers = 0

/** 启用方挂载时调用（重复调用只记数不重复注册）；monaco 命名空间由启用方
 *  注入（本模块只持类型导入，不把 monaco 拉进消费者 bundle） */
export function acquireMonacoVariableSuggest(monaco: typeof monacoNs): void {
  consumers++
  if (registrations !== null) return
  registrations = [
    ...SUGGEST_LANGUAGES.map((language) =>
      monaco.languages.registerCompletionItemProvider(language, {
        triggerCharacters: ['{'],
        provideCompletionItems: (model, position) => {
          if (contextLabels === null) return { suggestions: [] }
          const before = model.getValueInRange({
            startLineNumber: position.lineNumber,
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          })
          const fragment = matchVariableFragment(before)
          if (fragment === null) return { suggestions: [] }
          // 替换范围＝未闭合 `{{query` 整段（插入 `{{键}}` 一次成型）；
          // 片段占 position.column 前 query.length+2 列（含双花括号）
          const startColumn = position.column - (fragment.query.length + 2)
          const suggestions = buildVariableSuggestions(
            fragment.query,
            contextItems,
            contextLabels,
          ).map((item) => ({
            label: item.label,
            kind: monaco.languages.CompletionItemKind.Variable,
            insertText: item.insertText,
            // filterText 必须与过滤词（被替换的 `{{query` 原文）模糊命中：
            // range 回跨光标前字符的候选，Monaco 以回跨原文为过滤词、
            // 缺省按 label 匹配——label 无花括号恒不中，整项被静默丢弃
            // （面板不弹或零行）。`{{＋键名` 与过滤词同前缀，既保命中，
            // 也让「键名包含查询词」的过滤语义经模糊匹配自然成立
            // （建议项产物无 key 字段，键名取 label）
            filterText: `{{${item.label}`,
            detail: item.detail,
            sortText: item.sortText,
            range: {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn,
              endColumn: position.column,
            },
          }))
          return { suggestions }
        },
      }),
    ),
    ...SUGGEST_LANGUAGES.map((language) =>
      monaco.languages.registerHoverProvider(language, {
        provideHover: (model, position) => {
          if (contextLabels === null) return null
          const lineText = model.getLineContent(position.lineNumber)
          const info = variableHoverAt(lineText, position.column, contextItems, contextLabels)
          if (info === null) return null
          const head = `\`{{${info.key}}}\``
          const value =
            info.value === null
              ? `${head} ${contextLabels.undefinedBadge}`
              : `${head} = ${info.value}`
          const badges =
            info.value === null
              ? ''
              : `\n\n${[info.secret ? contextLabels.secretBadge : null, info.sourceLabel]
                  .filter((part) => part !== null && part !== undefined)
                  .join(' · ')}`
          return { contents: [{ value: `${value}${badges}` }] }
        },
      }),
    ),
  ]
}

/** 启用方卸载时调用；全数卸载（引用归零）即 dispose 全部注册并清空上下文 */
export function releaseMonacoVariableSuggest(): void {
  consumers--
  if (consumers > 0 || registrations === null) return
  for (const registration of registrations) registration.dispose()
  registrations = null
  contextItems = []
  contextLabels = null
}
