import { useQueryClient } from '@tanstack/react-query'

import {
  categoryCreate,
  categoryDelete,
  categoryMove,
  categoryMoveTo,
  categoryRename,
  endpointCreateManual,
  endpointDelete,
  endpointMove,
  endpointSetPinned,
  endpointUpdateManual,
  serviceCreate,
  serviceDelete,
  serviceMove,
  serviceMoveTo,
  serviceUpdate,
  workbenchKeys,
  type ManualEndpointInput,
} from '@/services/workbench-api'
import { useIpcMutation } from '@/services/ipc-query'

/**
 * 接口树 IPC 变更层：服务 / 分类 / 接口 / 置顶的全部写操作。
 * 失效策略（单一约定）：mutation 失效树所展示空间的树键（显式
 * workspaceId——切换空间的瞬间 in-flight mutation 仍作用于旧空间，
 * 不得失效成新当前空间）；DTO（新建实体身份）随 onSuccess 回传调用方。
 */
export function useTreeMutations(workspaceId: string) {
  const queryClient = useQueryClient()
  const treeKey = workbenchKeys.tree(workspaceId)

  const invalidateTree = () => {
    void queryClient.invalidateQueries({ queryKey: treeKey })
  }

  // —— 服务 ——
  const serviceCreateMutation = useIpcMutation({
    mutationFn: ({ name, docUrl }: { name: string; docUrl: string | null }) =>
      serviceCreate(workspaceId, name, docUrl),
    onSuccess: invalidateTree,
  })
  const serviceUpdateMutation = useIpcMutation({
    mutationFn: ({ id, name, docUrl }: { id: string; name: string; docUrl: string | null }) =>
      serviceUpdate(id, name, docUrl),
    onSuccess: invalidateTree,
  })
  const serviceDeleteMutation = useIpcMutation({
    mutationFn: (id: string) => serviceDelete(id),
    onSuccess: invalidateTree,
  })
  const serviceMoveMutation = useIpcMutation({
    mutationFn: ({ id, direction }: { id: string; direction: 'up' | 'down' }) =>
      serviceMove(id, direction),
    onSuccess: invalidateTree,
  })
  const serviceMoveToMutation = useIpcMutation({
    mutationFn: ({ id, index }: { id: string; index: number }) => serviceMoveTo(id, index),
    onSuccess: invalidateTree,
  })

  // —— 分类 ——
  const categoryCreateMutation = useIpcMutation({
    mutationFn: ({ serviceId, name }: { serviceId: string; name: string }) =>
      categoryCreate(serviceId, name),
    onSuccess: invalidateTree,
  })
  const categoryRenameMutation = useIpcMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => categoryRename(id, name),
    onSuccess: invalidateTree,
  })
  const categoryDeleteMutation = useIpcMutation({
    mutationFn: (id: string) => categoryDelete(id),
    onSuccess: invalidateTree,
  })
  const categoryMoveMutation = useIpcMutation({
    mutationFn: ({ id, direction }: { id: string; direction: 'up' | 'down' }) =>
      categoryMove(id, direction),
    onSuccess: invalidateTree,
  })
  const categoryMoveToMutation = useIpcMutation({
    mutationFn: ({
      id,
      targetServiceId,
      index,
    }: {
      id: string
      targetServiceId: string
      index: number
    }) => categoryMoveTo(id, targetServiceId, index),
    onSuccess: invalidateTree,
  })

  // —— 接口与置顶 ——
  const endpointCreateMutation = useIpcMutation({
    mutationFn: (input: ManualEndpointInput) => endpointCreateManual(input),
    onSuccess: invalidateTree,
  })
  const endpointUpdateMutation = useIpcMutation({
    mutationFn: (input: ManualEndpointInput & { key: string }) => endpointUpdateManual(input),
    onSuccess: invalidateTree,
  })
  const endpointDeleteMutation = useIpcMutation({
    mutationFn: ({ serviceId, key }: { serviceId: string; key: string }) =>
      endpointDelete(serviceId, key),
    onSuccess: invalidateTree,
  })
  const endpointSetPinnedMutation = useIpcMutation({
    mutationFn: ({ serviceId, key, pinned }: { serviceId: string; key: string; pinned: boolean }) =>
      endpointSetPinned(serviceId, key, pinned),
    onSuccess: invalidateTree,
  })
  const endpointMoveMutation = useIpcMutation({
    mutationFn: ({
      serviceId,
      key,
      categoryId,
      index,
    }: {
      serviceId: string
      key: string
      categoryId: string | null
      index: number
    }) => endpointMove(serviceId, key, categoryId, index),
    onSuccess: invalidateTree,
  })

  return {
    serviceCreateMutation,
    serviceUpdateMutation,
    serviceDeleteMutation,
    serviceMoveMutation,
    serviceMoveToMutation,
    categoryCreateMutation,
    categoryRenameMutation,
    categoryDeleteMutation,
    categoryMoveMutation,
    categoryMoveToMutation,
    endpointCreateMutation,
    endpointUpdateMutation,
    endpointDeleteMutation,
    endpointSetPinnedMutation,
    endpointMoveMutation,
  }
}

export type TreeMutations = ReturnType<typeof useTreeMutations>
