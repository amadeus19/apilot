/**
 * 变量域 mutation 组与缓存后处理单点（失效契约一处可查）。
 *
 * 协议：Rust 侧 mutation 一律返回刷新后的视图，前端直写不重拉——
 * - 分类 mutation（激活 / 新建 / 改名 / 删除）返回清单视图 →
 *   categories(workspaceId) 键 setQueryData 直写＋effective(workspaceId)
 *   失效（激活指针与全局分类集合都在兜底链上，合成结果随之重算）；
 * - 变量 mutation（增 / 改 / 改名 / 删）返回分类内清单 →
 *   variables(categoryId) 键 setQueryData 直写＋effective(workspaceId)
 *   失效（合成结果随变量集合变化重算）。
 *
 * 错误统一 reportError（调用方不再各自接线）；UI 副作用（关对话框 /
 * Tab 标题同步 / 关 Tab / 清树选中）不属缓存协议，经 mutate 的
 * per-call 回调由调用方自带。
 *
 * 生效集的另一半输入来自 workspaces.base_url（内置 {{baseUrl}} 条目），
 * 该路径的失效在 workspaces 域的 rename mutation 补齐（跨域引用本模块
 * 的 variableKeys，不自拼键）。
 */

import { useQueryClient, type QueryClient } from '@tanstack/react-query'

import { reportError } from '@/services/error-center'
import { useIpcMutation } from '@/services/ipc-query'

import {
  variableCreateCategory,
  variableCreateVariable,
  variableDeleteCategory,
  variableDeleteVariable,
  variableKeys,
  variableMoveCategory,
  variableRenameCategory,
  variableRenameVariable,
  variableSetActiveCategory,
  variableUpdateVariable,
  type VariableCategoriesDto,
  type VariableListDto,
} from './variable-api'

/** 变量清单落库后处理（非组件上下文与 hook 共用同一协议：直写分类内清单＋失效生效集） */
export function applyVariablesList(
  queryClient: QueryClient,
  workspaceId: string,
  categoryId: string,
  list: VariableListDto,
): void {
  queryClient.setQueryData(variableKeys.variables(categoryId), list)
  void queryClient.invalidateQueries({ queryKey: variableKeys.effective(workspaceId) })
}

/** 分类清单视图落库后处理（hook 与非组件上下文共用：直写分类视图＋失效生效集） */
export function applyCategoriesView(
  queryClient: QueryClient,
  workspaceId: string,
  view: VariableCategoriesDto,
): void {
  queryClient.setQueryData(variableKeys.categories(workspaceId), view)
  void queryClient.invalidateQueries({ queryKey: variableKeys.effective(workspaceId) })
}

/**
 * 非组件上下文的激活切换（命令面板 / 快捷键分发用）：同一 IPC 与缓存协议，
 * 错误走统一 reportError。组件上下文请用 useVariableMutations 的
 * activateCategoryMutation（同一协议的 hook 形态）。
 */
export async function activateCategoryBy(
  queryClient: QueryClient,
  workspaceId: string,
  categoryId: string | null,
): Promise<void> {
  try {
    const view = await variableSetActiveCategory(workspaceId, categoryId)
    applyCategoriesView(queryClient, workspaceId, view)
  } catch (error) {
    reportError(error)
  }
}

/** 变量 CRUD 入参的公共骨架（categoryId 供失效侧定位 effective 归属空间） */
interface VariableInput {
  categoryId: string
  key: string
}

/**
 * 变量域 mutation 组（分类 5＋变量 CRUD 4）：绑定 workspaceId（effective
 * 失效的归属空间）。子组件（树行 / 对话框 / 键值行）各自调用即可，
 * 后处理已在组内收口，消费方只带自己的 UI 副作用。
 */
export function useVariableMutations(workspaceId: string) {
  const queryClient = useQueryClient()

  /** 分类清单视图落库：categories 键直写＋effective 失效 */
  const applyCategoriesViewForSpace = (view: VariableCategoriesDto) => {
    applyCategoriesView(queryClient, workspaceId, view)
  }

  /** 激活分类（null＝取消激活，全不激活可达成） */
  const activateCategoryMutation = useIpcMutation({
    mutationFn: (categoryId: string | null) => variableSetActiveCategory(workspaceId, categoryId),
    onSuccess: applyCategoriesViewForSpace,
    onError: reportError,
  })
  const createCategoryMutation = useIpcMutation({
    mutationFn: (input: { global: boolean; name: string }) =>
      variableCreateCategory(workspaceId, input.global, input.name),
    onSuccess: applyCategoriesViewForSpace,
    onError: reportError,
  })
  const renameCategoryMutation = useIpcMutation({
    mutationFn: (input: { categoryId: string; name: string }) =>
      variableRenameCategory(workspaceId, input.categoryId, input.name),
    onSuccess: applyCategoriesViewForSpace,
    onError: reportError,
  })
  /**
   * 删除分类：直写新视图前对比新旧 items 差集，被删分类的
   * variables(categoryId) 缓存已成孤儿（不再有任何入口消费）——顺手
   * removeQueries 防其滞留并参与未来的误回灌。
   */
  const deleteCategoryMutation = useIpcMutation({
    mutationFn: (categoryId: string) => variableDeleteCategory(workspaceId, categoryId),
    onSuccess: (view, categoryId) => {
      // 差集须在直写前算（applyCategoriesView 之后缓存里就是新视图了）
      const prevItems =
        queryClient.getQueryData<VariableCategoriesDto>(variableKeys.categories(workspaceId))
          ?.items ?? []
      const removed = prevItems.filter((item) => !view.items.some((next) => next.id === item.id))
      for (const item of removed) {
        queryClient.removeQueries({ queryKey: variableKeys.variables(item.id) })
      }
      applyCategoriesViewForSpace(view)
      // 主动删的 categoryId 即使不在差集里（缓存缺失等边缘）也兜底清一次
      queryClient.removeQueries({ queryKey: variableKeys.variables(categoryId) })
    },
    onError: reportError,
  })
  /** 分类排序（树拖拽 / 菜单上移下移共用通道；同层 index，越界钳制到末尾） */
  const moveCategoryMutation = useIpcMutation({
    mutationFn: (input: { categoryId: string; index: number }) =>
      variableMoveCategory(workspaceId, input.categoryId, input.index),
    onSuccess: applyCategoriesViewForSpace,
    onError: reportError,
  })

  const createVariableMutation = useIpcMutation({
    mutationFn: (input: VariableInput & { value: string; secret: boolean }) =>
      variableCreateVariable(input.categoryId, input.key, input.value, input.secret),
    onSuccess: (list, input) =>
      applyVariablesList(queryClient, workspaceId, input.categoryId, list),
    onError: reportError,
  })
  const updateVariableMutation = useIpcMutation({
    mutationFn: (input: VariableInput & { value: string; secret: boolean }) =>
      variableUpdateVariable(input.categoryId, input.key, input.value, input.secret),
    onSuccess: (list, input) =>
      applyVariablesList(queryClient, workspaceId, input.categoryId, list),
    onError: reportError,
  })
  /** 变量改名（key 是身份组成，后端原子改主键列；新 key 撞车稳定报错） */
  const renameVariableMutation = useIpcMutation({
    mutationFn: (input: VariableInput & { newKey: string }) =>
      variableRenameVariable(input.categoryId, input.key, input.newKey),
    onSuccess: (list, input) =>
      applyVariablesList(queryClient, workspaceId, input.categoryId, list),
    onError: reportError,
  })
  const deleteVariableMutation = useIpcMutation({
    mutationFn: (input: VariableInput) => variableDeleteVariable(input.categoryId, input.key),
    onSuccess: (list, input) =>
      applyVariablesList(queryClient, workspaceId, input.categoryId, list),
    onError: reportError,
  })

  return {
    activateCategoryMutation,
    createCategoryMutation,
    renameCategoryMutation,
    deleteCategoryMutation,
    moveCategoryMutation,
    createVariableMutation,
    updateVariableMutation,
    renameVariableMutation,
    deleteVariableMutation,
  }
}
