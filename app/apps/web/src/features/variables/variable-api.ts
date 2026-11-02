/**
 * 变量域 IPC 薄封装：variable.* 命令的参数与 DTO 类型镜像（与 Rust
 * commands/variable.rs 签名一一对应，camelCase，沿 workbench-api.ts 惯例）。
 *
 * query key 约定（单一事实源，组件不自拼键）：
 * - ['variable', 'categories', workspaceId]：分类清单＋激活指针
 * - ['variable', 'variables', categoryId]：分类内变量清单
 * - ['variable', 'effective', workspaceId]：生效变量集（兜底链合成）
 * - ['variable', 'baseUrls', workspaceId]：BaseUrl 候选清单
 *
 * 缓存协议（后处理单点在 variable-mutations，此处只述事实）：分类
 * mutation 返回刷新后的清单视图（categories 键 setQueryData 直写＋
 * effective 键失效）；变量 mutation 返回分类内清单（variables 键
 * setQueryData 直写＋effective 键失效）；BaseUrl 候选 mutation 只写
 * baseUrls 键（纯 GUI 备选，不触碰 workspaces.base_url 生效值）。
 */

import { invoke } from '@/services/ipc'

// —— DTO 类型（Rust 序列化形态镜像，camelCase） ——

export interface VariableCategoryDto {
  id: string
  name: string
  /** 全局行（workspace_id NULL）：跨工作空间共享、不可激活 */
  isGlobal: boolean
  sortOrder: number
}

export interface VariableCategoriesDto {
  /** 本空间分类在前、全局分类在后（后端排序） */
  items: VariableCategoryDto[]
  /** 激活分类指针（null＝全不激活；全局分类不可激活） */
  activeCategoryId: string | null
}

export interface VariableDto {
  key: string
  /** 值恒明文（Secret 只是敏感标记；掩码由展示端负责） */
  value: string
  secret: boolean
}

export interface VariableListDto {
  items: VariableDto[]
}

/** 生效变量来源层：激活分类 / 全局分类 / 内置 baseUrl */
export type VariableSource = 'active' | 'global' | 'builtin'

export interface EffectiveVariableDto {
  key: string
  value: string
  secret: boolean
  source: VariableSource
}

export interface EffectiveSetDto {
  items: EffectiveVariableDto[]
}

export interface BaseUrlCandidateDto {
  id: string
  url: string
}

export interface BaseUrlListDto {
  items: BaseUrlCandidateDto[]
}

// —— query key 工厂（单一事实源，组件不自拼键） ——

export const variableKeys = {
  /** 域根（域级失效入口：工作流写回这类引擎侧落库、无对应 mutation 的变更） */
  root: ['variable'] as const,
  categories: (workspaceId: string) => [...variableKeys.root, 'categories', workspaceId] as const,
  variables: (categoryId: string) => [...variableKeys.root, 'variables', categoryId] as const,
  effective: (workspaceId: string) => [...variableKeys.root, 'effective', workspaceId] as const,
  baseUrls: (workspaceId: string) => [...variableKeys.root, 'baseUrls', workspaceId] as const,
}

// —— variable.*（14） ——

export function variableListCategories(workspaceId: string): Promise<VariableCategoriesDto> {
  return invoke<VariableCategoriesDto>('variable.list_categories', { workspaceId })
}

export function variableCreateCategory(
  workspaceId: string,
  global: boolean,
  name: string,
): Promise<VariableCategoriesDto> {
  return invoke<VariableCategoriesDto>('variable.create_category', {
    workspaceId,
    global,
    name,
  })
}

export function variableRenameCategory(
  workspaceId: string,
  id: string,
  name: string,
): Promise<VariableCategoriesDto> {
  return invoke<VariableCategoriesDto>('variable.rename_category', { workspaceId, id, name })
}

export function variableDeleteCategory(
  workspaceId: string,
  id: string,
): Promise<VariableCategoriesDto> {
  return invoke<VariableCategoriesDto>('variable.delete_category', { workspaceId, id })
}

/** categoryId null＝取消激活（全不激活可达成） */
export function variableSetActiveCategory(
  workspaceId: string,
  categoryId: string | null,
): Promise<VariableCategoriesDto> {
  return invoke<VariableCategoriesDto>('variable.set_active_category', {
    workspaceId,
    categoryId,
  })
}

/** 移动分类到同层 index 位（全局组与本空间组各自成层；越界钳制到末尾） */
export function variableMoveCategory(
  workspaceId: string,
  categoryId: string,
  index: number,
): Promise<VariableCategoriesDto> {
  return invoke<VariableCategoriesDto>('variable.move_category', {
    workspaceId,
    categoryId,
    index,
  })
}

export function variableListVariables(categoryId: string): Promise<VariableListDto> {
  return invoke<VariableListDto>('variable.list_variables', { categoryId })
}

export function variableCreateVariable(
  categoryId: string,
  key: string,
  value: string,
  secret: boolean,
): Promise<VariableListDto> {
  return invoke<VariableListDto>('variable.create_variable', {
    categoryId,
    key,
    value,
    secret,
  })
}

export function variableUpdateVariable(
  categoryId: string,
  key: string,
  value: string,
  secret: boolean,
): Promise<VariableListDto> {
  return invoke<VariableListDto>('variable.update_variable', {
    categoryId,
    key,
    value,
    secret,
  })
}

/** 变量改名（key 是身份组成，后端原子改主键列；新 key 撞车稳定报错） */
export function variableRenameVariable(
  categoryId: string,
  key: string,
  newKey: string,
): Promise<VariableListDto> {
  return invoke<VariableListDto>('variable.rename_variable', { categoryId, key, newKey })
}

export function variableDeleteVariable(categoryId: string, key: string): Promise<VariableListDto> {
  return invoke<VariableListDto>('variable.delete_variable', { categoryId, key })
}

export function variableEffective(workspaceId: string): Promise<EffectiveSetDto> {
  return invoke<EffectiveSetDto>('variable.effective', { workspaceId })
}

export function variableListBaseUrls(workspaceId: string): Promise<BaseUrlListDto> {
  return invoke<BaseUrlListDto>('variable.list_base_urls', { workspaceId })
}

export function variableAddBaseUrl(workspaceId: string, url: string): Promise<BaseUrlListDto> {
  return invoke<BaseUrlListDto>('variable.add_base_url', { workspaceId, url })
}

export function variableDeleteBaseUrl(workspaceId: string, id: string): Promise<BaseUrlListDto> {
  return invoke<BaseUrlListDto>('variable.delete_base_url', { workspaceId, id })
}
