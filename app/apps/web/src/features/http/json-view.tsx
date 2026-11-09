import * as React from 'react'

import { CopySurface } from '@workspace/ui/components'

import { cn } from 'cn'

import { colorizeJsonTokens, type JsonToken } from './endpoint-doc-logic'

/**
 * 共享 JSON 视图：两空格缩进文本＋轻量着色（分词逻辑 colorizeJsonTokens
 * 收敛在 endpoint-doc-logic，不引 Monaco）；区域级放行划选与悬浮复制
 * （CopySurface 内建，复制口径＝展示文本，「显示什么就复制什么」）。
 *
 * 接受 unknown 值：非字符串先两空格序列化；字符串按已成形的展示文本直用
 * （格式化口径由调用方决定，见 json-format 的 tryFormatJson）。
 */

const TOKEN_CLASS: Record<JsonToken['kind'], string> = {
  key: 'text-sky-600 dark:text-sky-400',
  string: 'text-emerald-700 dark:text-emerald-400',
  number: 'text-amber-700 dark:text-amber-400',
  literal: 'text-purple-700 dark:text-purple-400',
  punct: 'text-muted-foreground',
}

/** 着色护栏：超过此字符数退纯 pre 不着色（低于快照 64KB 摘录上限） */
const JSON_VIEW_COLORIZE_MAX_CHARS = 32 * 1024

interface JsonViewProps {
  /** JSON 值：非字符串两空格序列化；字符串按已成形的展示文本直用 */
  value: unknown
  /** 追加到内部 pre 的类（高度上限等布局约束由调用面传入） */
  className?: string
}

export function JsonView({ value, className }: JsonViewProps) {
  const text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? 'null')
  // 超护栏退纯文本（分词与逐 token span 的渲染开销不再值得）；useMemo
  // 缓存分词结果，重渲染不重复扫描
  const tokens = React.useMemo(
    () => (text.length <= JSON_VIEW_COLORIZE_MAX_CHARS ? colorizeJsonTokens(text) : null),
    [text],
  )
  return (
    <CopySurface getText={() => text} data-testid="json-view">
      <pre
        className={cn(
          'overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs leading-5 whitespace-pre',
          className,
        )}
      >
        {tokens === null
          ? text
          : tokens.map((token, index) => (
              <span key={index} className={TOKEN_CLASS[token.kind]}>
                {token.text}
              </span>
            ))}
      </pre>
    </CopySurface>
  )
}
