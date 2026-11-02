import * as React from 'react'
import { DiffEditor } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'

import type { ResolvedTheme } from '@/lib/settings-schema'

import '@/features/http/monaco-env'

interface MonacoDiffEditorProps {
  /** 旧侧文本（契约行重建，键序锚定稳定） */
  original: string
  /** 新侧文本 */
  modified: string
  /** Monaco 语言标识（同步明细恒 'json'） */
  language: string
  /** resolved 主题：light → vs、dark → vs-dark */
  theme: ResolvedTheme
}

/**
 * Monaco 双栏 diff 只读底座：同步向导明细页签（参数 / 响应 / 请求体 Schema）
 * 的唯一 DiffEditor 装配，经调用方 React.lazy 懒加载（未展开明细不进任何
 * chunk；装配与主题 / 本地化引导沿 MonacoTextEditor 共享底座模式）。
 *
 * 呈现口径：双栏对照、行级高亮承载全列出语义
 * （未变行无高亮＝原「置灰」）；大 schema 的折叠与虚拟化由 Monaco 内建承担。
 * 纯呈现面恒只读——两侧文本均来自契约行重建，无任何编辑通道。
 */
export function MonacoDiffEditor({ original, modified, language, theme }: MonacoDiffEditorProps) {
  const monacoTheme = theme === 'dark' ? 'vs-dark' : 'vs'

  const options = React.useMemo<monaco.editor.IDiffEditorConstructionOptions>(
    () => ({
      readOnly: true,
      domReadOnly: true,
      renderSideBySide: true,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      folding: true,
      lineNumbers: 'on',
      // 差异上下文行数：紧凑呈现（默认 5 行上下足够定位）
      renderIndicators: true,
      fontFamily: "Consolas, 'Courier New', monospace",
      fontSize: 14,
      lineHeight: 19,
    }),
    [],
  )

  return (
    <DiffEditor
      original={original}
      modified={modified}
      language={language}
      theme={monacoTheme}
      options={options}
    />
  )
}
