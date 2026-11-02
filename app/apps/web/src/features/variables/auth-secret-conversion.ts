/**
 * 认证字面量转 Secret 变量（spec 定案：认证字段值为字面量时提供行内
 * 「转为 Secret 变量」入口；目标分类默认激活分类）。
 *
 * 转换＝在目标分类建与字段同名的 Secret 变量＋调用方把原字段改引用
 * `{{变量名}}`（返回引用串，字段改写由调用方接自己的草稿通道）。
 * 目标分类兜底序：激活分类 → 第一个本空间分类 → 第一个全局分类
 * （「默认激活分类」优先；无激活时不阻塞转换，逐级回落）。
 */

import { toast } from '@workspace/ui/components'

import { translate, type DictKey, type TranslateParams } from '@/i18n'
import { queryClient } from '@/app/query-client'
import { reportError } from '@/services/error-center'
import { selectResolvedLocale, useSettingsStore } from '@/stores/settings.store'
import { applyVariablesList } from './variable-mutations'
import {
  variableCreateVariable,
  variableListCategories,
  type VariableCategoriesDto,
  type VariableCategoryDto,
} from './variable-api'

/** 目标分类兜底序（激活分类 → 本空间 → 全局；无可用分类＝null） */
export function pickTargetCategory(view: VariableCategoriesDto): VariableCategoryDto | null {
  if (view.activeCategoryId) {
    const active = view.items.find((category) => category.id === view.activeCategoryId)
    if (active) return active
  }
  return (
    view.items.find((category) => !category.isGlobal) ??
    view.items.find((category) => category.isGlobal) ??
    null
  )
}

/** 值是否已是变量引用形态（`{{...}}` 开头＝非字面量，不提供转换） */
export function isVariableReference(value: string): boolean {
  return value.trimStart().startsWith('{{')
}

/** toast 文案求值（非组件上下文）：当前解析语言直查字典（沿 error-center 取值模式） */
function tOut(key: DictKey, params?: TranslateParams): string {
  return translate(selectResolvedLocale(useSettingsStore.getState()), key, params)
}

/**
 * 执行转换：目标分类建同名 Secret 变量，成功后返回 `{{变量名}}` 引用串
 * （失败不抛出——无分类与 IPC 错误都走统一错误呈现，调用方无需 try/catch）。
 */
export async function convertLiteralToSecret(
  workspaceId: string,
  variableKey: string,
  value: string,
): Promise<string | null> {
  const view = await variableListCategories(workspaceId).catch((error: unknown) => {
    reportError(error)
    return null
  })
  if (!view) return null
  const target = pickTargetCategory(view)
  if (!target) {
    toast.error(tOut('variables.toSecret.noCategoryError'))
    return null
  }
  try {
    const list = await variableCreateVariable(target.id, variableKey, value, true)
    // 变量集合已变：与组件侧同一协议收口（分类内清单直写＋生效集失效）；
    // 分类清单视图不含变量数据，不需失效
    applyVariablesList(queryClient, workspaceId, target.id, list)
  } catch (error) {
    reportError(error)
    return null
  }
  toast.success(tOut('variables.toSecret.converted', { key: variableKey }))
  return `{{${variableKey}}}`
}
