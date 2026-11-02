import * as React from 'react'
import Editor from '@monaco-editor/react'
import * as monaco from 'monaco-editor'

import { variableEffective, variableKeys } from '@/features/variables/variable-api'
import {
  acquireMonacoVariableSuggest,
  releaseMonacoVariableSuggest,
  setMonacoVariableContext,
  type SuggestLabels,
} from '@/features/variables/variable-suggest-monaco'
import { useI18n } from '@/i18n'
import type { ResolvedTheme } from '@/lib/settings-schema'
import { useIpcQuery } from '@/services/ipc-query'

import './monaco-env'

interface MonacoTextEditorProps {
  /** 受控文本：事实源在调用方，内容变化经 model 同步（不换实例） */
  value: string
  /** Monaco 语言标识（如 'json'）；同挂载期切换仅换 model 语言，不重建实例 */
  language: string
  /** resolved 主题：light → vs、dark → vs-dark */
  theme: ResolvedTheme
  /** 换行开关：true → on、false → off */
  wordWrap: boolean
  /** 受控编辑回调：内容变化回传最新全文（undefined 并合为空串）；缺省即只读形态 */
  onChange?: (value: string) => void
  /** 显式强制只读：onChange 在线时临时禁编；onChange 缺省时恒为只读 */
  readOnly?: boolean
  /** 变量联想上下文：非 null 时启用 `{{` 补全与 hover 解析（生效变量集
   *  数据由底座拉取，与发送侧解析、输入框联想同源；只读面与无工作空间
   *  上下文的宿主不传——不启用零开销） */
  variableSuggest?: { workspaceId: string } | null
}

/**
 * Monaco 文本编辑器共享底座：请求体编辑与响应 Pretty 同源的唯一 Editor
 * 装配，经调用方 React.lazy 懒加载（首屏与未进入编辑视图时不进任何 chunk）。
 *
 * 生命周期纪律：
 * - 实例跨内容复用：同一挂载期切 value / language / wordWrap 不重建实例——
 *   value 走 model 同步、language 走 setModelLanguage、wordWrap 走
 *   updateOptions（options 按派生值 memo，无关重渲染不下发）；
 * - 卸载即 dispose：组件树卸载（关 Tab / 折叠面板 / 切走视图）时
 *   @monaco-editor/react 的清理链路销毁 editor 与 model；
 * - 主题跟随：resolved 主题变化时 monaco.editor.setTheme 切换 vs / vs-dark
 *   （theme prop 亦传入，保证 create 初始主题正确）；
 * - automaticLayout：容器尺寸变化（含 hidden 切换恢复）自动 relayout；
 * - 大文本回落是消费面策略：底座不做阈值判定，由调用方决定什么内容进编辑器。
 */
export function MonacoTextEditor({
  value,
  language,
  theme,
  wordWrap,
  onChange,
  readOnly,
  variableSuggest,
}: MonacoTextEditorProps) {
  const monacoTheme = theme === 'dark' ? 'vs-dark' : 'vs'
  // onChange 缺省即只读形态；readOnly 供 onChange 在线时显式禁编
  const resolvedReadOnly = onChange === undefined || readOnly === true

  React.useEffect(() => {
    monaco.editor.setTheme(monacoTheme)
  }, [monacoTheme])

  // —— 变量联想（可选启用）：provider 注册按 language id 全局单例＋引用
  //    计数（多编辑器同屏共享一组注册，全数卸载即 dispose）；生效变量集
  //    与展示文案经 effect 同步进 provider 上下文（调用面读最新值）——
  const suggestOn = variableSuggest !== undefined && variableSuggest !== null
  const effectiveQuery = useIpcQuery({
    queryKey: variableKeys.effective(variableSuggest?.workspaceId ?? ''),
    queryFn: () => variableEffective(variableSuggest?.workspaceId ?? ''),
    enabled: suggestOn,
    staleTime: 30_000,
  })
  React.useEffect(() => {
    if (!suggestOn) return
    acquireMonacoVariableSuggest(monaco)
    return () => releaseMonacoVariableSuggest()
  }, [suggestOn])
  const { t } = useI18n()
  const suggestLabels = React.useMemo<SuggestLabels>(
    () => ({
      sourceActive: t('variables.effective.sourceActive'),
      sourceGlobal: t('variables.effective.sourceGlobal'),
      sourceBuiltin: t('variables.effective.sourceBuiltin'),
      secretBadge: t('variables.hover.secretBadge'),
      undefinedBadge: t('variables.hover.undefinedBadge'),
    }),
    [t],
  )
  React.useEffect(() => {
    if (!suggestOn) return
    setMonacoVariableContext(effectiveQuery.data?.items ?? [], suggestLabels)
  }, [suggestOn, effectiveQuery.data, suggestLabels])

  // 收敛为纯 string 契约：调用方持 string 状态即可直接接线
  const handleEditorChange = React.useCallback(
    (next: string | undefined) => {
      onChange?.(next ?? '')
    },
    [onChange],
  )

  const editorOptions = React.useMemo<monaco.editor.IStandaloneEditorConstructionOptions>(
    () => ({
      readOnly: resolvedReadOnly,
      domReadOnly: resolvedReadOnly,
      wordWrap: wordWrap ? 'on' : 'off',
      automaticLayout: true,
      // 正文视图不需要缩略图与末尾留白，减掉这两块渲染开销
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      // 折叠与行号是正文阅读的基础能力，显式声明（与默认一致）
      folding: true,
      lineNumbers: 'on',
      // 顶部留白对齐 pre 态的 p-3 视觉基线
      padding: { top: 10 },
      // 字号 / 行高 / 字体显式钉住 Monaco 在 Windows 的默认渲染值
      // （fontSize 14、行高 round(1.35×14)=19、Consolas 栈）：两区与等宽
      // pre 态共用同一口径，不再随平台 / 编辑器版本浮动
      fontFamily: "Consolas, 'Courier New', monospace",
      fontSize: 14,
      lineHeight: 19,
      // 软换行悬挂缩进：换行行与首行同列缩进（缩进对齐），与默认一致——
      // 显式声明是两区换行形态的代码级锚点
      wrappingIndent: 'same',
    }),
    [resolvedReadOnly, wordWrap],
  )

  return (
    <Editor
      value={value}
      language={language}
      theme={monacoTheme}
      options={editorOptions}
      onChange={handleEditorChange}
    />
  )
}
