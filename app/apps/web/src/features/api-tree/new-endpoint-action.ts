import type { QueryClient } from '@tanstack/react-query'

import { workbenchKeys, type TreeDto, type WorkspaceListDto } from '@/services/workbench-api'

import { ensureApiTreeVisible } from './tree-locate'
import { parseCategoryNodeId, parseEndpointNodeId, parseServiceNodeId } from './selector'
import { useTreeExpandedStore } from './tree-state.store'

/**
 * 新建接口动作（Ctrl+T 命令消费，与树右键菜单共享同一对话框）：
 * 目标服务＝当前选中行所属（服务行取自身 / 分类行取所属服务 / 接口行取
 * 所属服务）→ 无选中取第一个服务 → 无服务＝引导先建服务（服务新建对话框）。
 * 树上下文可见的前置（切视图＋展开面板）与树定位同源，经 tree-locate
 * 接缝统一保证；对话框宿主随面板挂载，经信号开对话框。
 */

/** 解析目标服务：选中行所属优先，回落第一个；null＝无服务可归属 */
export function resolveNewEndpointTarget(
  tree: TreeDto | undefined,
  selectedNodeId: string | null,
): string | null {
  if (!tree || tree.services.length === 0) return null
  const firstService = tree.services[0]?.id ?? null
  if (!selectedNodeId) return firstService
  if (selectedNodeId.startsWith('service:')) {
    const serviceId = parseServiceNodeId(selectedNodeId)
    if (serviceId && tree.services.some((service) => service.id === serviceId)) return serviceId
    return firstService
  }
  if (selectedNodeId.startsWith('category:')) {
    const categoryId = parseCategoryNodeId(selectedNodeId)
    const owner = categoryId
      ? tree.services.find((service) => service.categories.some((c) => c.id === categoryId))
      : undefined
    return owner?.id ?? firstService
  }
  if (selectedNodeId.startsWith('endpoint:')) {
    const identity = parseEndpointNodeId(selectedNodeId)
    if (identity && tree.services.some((service) => service.id === identity.serviceId)) {
      return identity.serviceId
    }
    return firstService
  }
  // 置顶组等虚拟分组行不携带服务归属：回落第一个
  return firstService
}

/** 新建接口动作体：保证树上下文可见后，经信号请求面板开对话框 */
export function openNewEndpointDialog(queryClient: QueryClient): void {
  // 对话框宿主与树上下文可见：切接口树视图 + 展开左栏（与树定位同源的接缝保证）
  ensureApiTreeVisible()

  const workspaces = queryClient.getQueryData<WorkspaceListDto>(workbenchKeys.workspaces())
  const workspaceId = workspaces?.currentId ?? null
  const tree = workspaceId
    ? queryClient.getQueryData<TreeDto>(workbenchKeys.tree(workspaceId))
    : undefined
  const selectedNodeId = useTreeExpandedStore.getState().activeNodeId
  useTreeExpandedStore.getState().requestNewEndpoint(resolveNewEndpointTarget(tree, selectedNodeId))
}
