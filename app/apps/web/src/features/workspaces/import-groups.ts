import type { ImportGroupDto } from '@/services/workbench-api'

/**
 * 批量导入分组纯函数：查重标注、默认勾选与表头全选三态计算。
 * 查重口径＝与当前工作空间现有服务比对（名称精确匹配、文档地址精确匹配）；
 * 默认勾选只剔除名称撞车的分组（用户可强行勾选，落库时后端追加序号消歧），
 * 地址撞车仅标注提示。
 */

/** 发现分组 + 查重标注（勾选列表的渲染模型） */
export interface ImportGroupCheck {
  name: string
  docUrl: string
  /** 与现有服务重名（默认不勾选，可强行勾选） */
  nameExists: boolean
  /** 文档地址与现有服务相同（仅标注） */
  urlExists: boolean
}

/** 现有服务的查重比对面（树 DTO 的服务节点即够） */
export interface ExistingServiceLike {
  name: string
  docUrl: string | null
}

/** 标注发现分组：与现有服务逐项比对（名称 / 文档地址精确匹配） */
export function annotateImportGroups(
  groups: readonly ImportGroupDto[],
  existing: readonly ExistingServiceLike[],
): ImportGroupCheck[] {
  const names = new Set(existing.map((service) => service.name))
  const urls = new Set(
    existing.filter((service) => service.docUrl !== null).map((service) => service.docUrl),
  )
  return groups.map((group) => ({
    name: group.name,
    docUrl: group.docUrl,
    nameExists: names.has(group.name),
    urlExists: urls.has(group.docUrl),
  }))
}

/** 默认勾选索引集：名称撞车的不勾，其余全勾 */
export function defaultCheckedIndexes(groups: readonly ImportGroupCheck[]): number[] {
  return groups
    .map((group, index) => ({ group, index }))
    .filter(({ group }) => !group.nameExists)
    .map(({ index }) => index)
}

/** 表头全选三态：all＝可勾行全勾，none＝可勾行全未勾，partial＝介于两者 */
export type ImportSelectAllState = 'all' | 'none' | 'partial'

/**
 * 全选三态推导（只读，不写状态）：全集＝可勾行（名称撞车行恒排除，与默认
 * 勾选同口径），用户强行勾选的撞车行不参与三态判定；空列表或全部禁选时
 * 无可勾集，恒为 none。
 */
export function importSelectAllState(
  groups: readonly ImportGroupCheck[],
  checked: readonly number[],
): ImportSelectAllState {
  const selectableCount = defaultCheckedIndexes(groups).length
  if (selectableCount === 0) return 'none'
  let selectedCount = 0
  for (const index of checked) {
    const group = groups[index]
    if (group !== undefined && !group.nameExists) selectedCount += 1
  }
  if (selectedCount === 0) return 'none'
  return selectedCount === selectableCount ? 'all' : 'partial'
}
