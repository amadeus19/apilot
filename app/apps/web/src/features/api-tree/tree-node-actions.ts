import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { workbenchKeys, type TreeDto } from '@/services/workbench-api'
import { makeEndpointNodeId } from '@/lib/tree-identity'
import { useSyncWizardStore } from '@/stores/sync.store'
import { useTabsStore } from '@/stores/tabs.store'

import {
  parseCategoryNodeId,
  parseServiceNodeId,
  type ApiTreeIndex,
  type ApiTreeNode,
} from './selector'
import type { TreeDialogState } from './tree-dialogs'
import type { TreeMutations } from './use-tree-mutations'

/**
 * 分类删除的联动范围：该分类下全部接口的 Tab 身份集（id＝单实例契约键，
 * 全等命中即关，不区分来源）。树全量 DTO 直扫（不经过滤子图），须在删除
 * 落库前调用——删除成功后接口已随级联消失，无从收集。
 */
export function collectCategoryEndpointTabIds(
  tree: TreeDto | null,
  categoryId: string,
): Set<string> {
  const ids = new Set<string>()
  if (!tree) return ids
  for (const service of tree.services) {
    for (const endpoint of service.endpoints) {
      if (endpoint.categoryId === categoryId) {
        ids.add(makeEndpointNodeId(endpoint.serviceId, endpoint.key))
      }
    }
  }
  return ids
}

/**
 * 树节点动作分发：对话框状态机 +「节点 id → 实体 id → mutation」的全部
 * 路由（新建 / 重命名 / 删除 / 置顶 / 上移下移）收敛一处。菜单与快捷键
 * （F2 / Ctrl+T）只是入口，动作语义只此一份：
 * - 重命名成功：打开中的同身份 Tab 同步新标题（TabBar 单一事实源在 tabs store）；
 * - 新建接口成功：直接进入编辑（常驻 Tab，标题＝接口标题）；
 * - 删除成功：联动关闭右侧对应 Tab（接口删单 Tab、服务删全服务、
 *   分类删该分类——受影响接口身份在删除落库前从树查询数据收集）；
 * - 上移 / 下移＝同分组内相邻移动（拖拽排序的键盘替代通道；index 为
 *   摘除自身后的插入位，越界由 Rust 侧钳制）。
 */
export function useTreeNodeActions(options: {
  workspaceId: string
  activeIndex: ApiTreeIndex | null
  mutations: TreeMutations
  onError: (error: unknown) => void
}): {
  dialog: TreeDialogState | null
  closeDialog: () => void
  /** 空态「新建服务」入口 */
  openNewServiceDialog: () => void
  /** 外部新建接口信号（Ctrl+T 等）：serviceId null＝无服务，引导先建服务 */
  openNewEndpointRequest: (serviceId: string | null) => void
  canRename: (node: ApiTreeNode) => boolean
  openRenameDialog: (node: ApiTreeNode) => void
  openNewCategory: (node: ApiTreeNode) => void
  openNewEndpoint: (node: ApiTreeNode) => void
  openDeleteDialog: (node: ApiTreeNode) => void
  togglePin: (node: ApiTreeNode) => void
  moveByDirection: (node: ApiTreeNode, direction: 'up' | 'down') => void
  /** 单服务同步直达（服务行菜单；无文档地址服务调用方置灰，双保险拒绝） */
  syncService: (node: ApiTreeNode) => void
  submitService: (name: string, docUrl: string | null, node: ApiTreeNode | null) => void
  submitCategory: (name: string, node: ApiTreeNode | null) => void
  submitEndpoint: (form: { title: string; method: string; pathTemplate: string }) => void
  confirmDelete: (node: ApiTreeNode) => void
} {
  const { activeIndex, mutations, onError, workspaceId } = options
  const queryClient = useQueryClient()
  const [dialog, setDialog] = React.useState<TreeDialogState | null>(null)
  const closeDialog = () => setDialog(null)

  // —— 重命名可用性（接口仅手工；分类 / 服务恒可） ——
  const canRename = (node: ApiTreeNode): boolean =>
    node.kind === 'service' || node.kind === 'category' || node.isManual === true

  const openRenameDialog = (node: ApiTreeNode) => {
    if (node.kind === 'service') setDialog({ type: 'service-edit', node })
    else if (node.kind === 'category') setDialog({ type: 'category-rename', node })
    else if (node.kind === 'endpoint' && node.isManual) setDialog({ type: 'endpoint-rename', node })
  }

  // —— 新建入口：分类 / 服务行开对话框；分类行的新建接口挂到该分类 ——
  const openNewCategory = (node: ApiTreeNode) => {
    // 分类行的新建分类挂到其所属服务（分类直属服务、不嵌套）
    const serviceId =
      node.kind === 'category'
        ? parseServiceNodeId(node.parentIds[0] ?? '')
        : parseServiceNodeId(node.id)
    if (serviceId) setDialog({ type: 'category-new', serviceId })
  }

  const openNewEndpoint = (node: ApiTreeNode) => {
    if (node.kind === 'category') {
      const serviceId = parseServiceNodeId(node.parentIds[0] ?? '')
      const categoryId = parseCategoryNodeId(node.id)
      if (serviceId && categoryId) setDialog({ type: 'endpoint-new', serviceId, categoryId })
      return
    }
    const serviceId = parseServiceNodeId(node.id)
    if (serviceId) setDialog({ type: 'endpoint-new', serviceId, categoryId: null })
  }

  const openDeleteDialog = (node: ApiTreeNode) => {
    if (node.kind === 'service') setDialog({ type: 'delete-service', node })
    else if (node.kind === 'category') setDialog({ type: 'delete-category', node })
    else setDialog({ type: 'delete-endpoint', node })
  }

  const togglePin = (node: ApiTreeNode) => {
    if (node.kind !== 'endpoint' || !node.serviceId || !node.key) return
    mutations.endpointSetPinnedMutation.mutate(
      { serviceId: node.serviceId, key: node.key, pinned: !node.pinned },
      { onError },
    )
  }

  const moveByDirection = (node: ApiTreeNode, direction: 'up' | 'down') => {
    if (node.kind === 'service') {
      const serviceId = parseServiceNodeId(node.id)
      if (serviceId) mutations.serviceMoveMutation.mutate({ id: serviceId, direction }, { onError })
      return
    }
    if (node.kind === 'category') {
      const categoryId = parseCategoryNodeId(node.id)
      if (categoryId)
        mutations.categoryMoveMutation.mutate({ id: categoryId, direction }, { onError })
      return
    }
    // 接口：置顶行的树内位置由置顶组决定，不参与排序
    if (node.kind !== 'endpoint' || node.pinned || !node.serviceId || !node.key) return
    const groupNodeId = node.parentIds[0] ?? ''
    const groupSiblings = activeIndex?.childrenOf.get(groupNodeId) ?? []
    const current = groupSiblings.indexOf(node.id)
    if (current < 0) return
    mutations.endpointMoveMutation.mutate(
      {
        serviceId: node.serviceId,
        key: node.key,
        categoryId: node.categoryId ?? null,
        index: direction === 'up' ? current - 1 : current + 1,
      },
      { onError },
    )
  }

  const syncService = (node: ApiTreeNode) => {
    if (node.kind !== 'service' || node.docUrl == null) return
    const serviceId = parseServiceNodeId(node.id)
    if (serviceId) useSyncWizardStore.getState().openWizardFor(serviceId)
  }

  // —— 表单提交（mutation 全在此闭包；错误经统一错误协议 toast） ——
  const submitService = (name: string, docUrl: string | null, node: ApiTreeNode | null) => {
    const serviceId = node ? parseServiceNodeId(node.id) : null
    if (node && !serviceId) return
    if (node) {
      mutations.serviceUpdateMutation.mutate(
        { id: serviceId!, name, docUrl },
        { onSuccess: closeDialog, onError },
      )
    } else {
      mutations.serviceCreateMutation.mutate({ name, docUrl }, { onSuccess: closeDialog, onError })
    }
  }

  const submitCategory = (name: string, node: ApiTreeNode | null) => {
    if (node) {
      const categoryId = parseCategoryNodeId(node.id)
      if (!categoryId) return
      mutations.categoryRenameMutation.mutate(
        { id: categoryId, name },
        { onSuccess: closeDialog, onError },
      )
      return
    }
    if (dialog?.type !== 'category-new') return
    mutations.categoryCreateMutation.mutate(
      { serviceId: dialog.serviceId, name },
      { onSuccess: closeDialog, onError },
    )
  }

  const submitEndpoint = (form: { title: string; method: string; pathTemplate: string }) => {
    if (dialog?.type === 'endpoint-new') {
      mutations.endpointCreateMutation.mutate(
        {
          serviceId: dialog.serviceId,
          method: form.method,
          pathTemplate: form.pathTemplate,
          title: form.title,
          categoryId: dialog.categoryId,
        },
        {
          onSuccess: (created) => {
            closeDialog()
            // 新建后直接进入编辑（常驻 Tab；标题＝接口标题）
            useTabsStore
              .getState()
              .openEndpoint(
                { serviceId: created.serviceId, key: created.key, title: created.title },
                'persistent',
              )
          },
          onError,
        },
      )
      return
    }
    if (dialog?.type === 'endpoint-rename') {
      const node = dialog.node
      if (!node.serviceId || !node.key) return
      mutations.endpointUpdateMutation.mutate(
        {
          serviceId: node.serviceId,
          key: node.key,
          title: form.title,
          method: node.method ?? 'GET',
          pathTemplate: node.pathTemplate ?? '/',
          categoryId: node.categoryId ?? null,
        },
        {
          onSuccess: (updated) => {
            closeDialog()
            // 打开中的同身份 Tab 同步新标题
            useTabsStore
              .getState()
              .setTabTitle(makeEndpointNodeId(node.serviceId!, node.key!), updated.title)
          },
          onError,
        },
      )
    }
  }

  const confirmDelete = (node: ApiTreeNode) => {
    if (node.kind === 'service') {
      const serviceId = parseServiceNodeId(node.id)
      if (!serviceId) return
      mutations.serviceDeleteMutation.mutate(serviceId, {
        onSuccess: () => {
          closeDialog()
          // 服务级联删除其全部分类与接口：打开中的该服务接口 Tab 一并关闭
          useTabsStore
            .getState()
            .closeWhere((tab) => tab.kind === 'endpoint' && tab.serviceId === serviceId)
        },
        onError,
      })
    } else if (node.kind === 'category') {
      const categoryId = parseCategoryNodeId(node.id)
      if (!categoryId) return
      // 受影响接口 Tab 身份在删除落库前从树查询数据收集（删除成功后无从收集）
      const tree = queryClient.getQueryData<TreeDto>(workbenchKeys.tree(workspaceId)) ?? null
      const affectedTabIds = collectCategoryEndpointTabIds(tree, categoryId)
      mutations.categoryDeleteMutation.mutate(categoryId, {
        onSuccess: () => {
          closeDialog()
          useTabsStore.getState().closeWhere((tab) => affectedTabIds.has(tab.id))
        },
        onError,
      })
    } else if (node.kind === 'endpoint' && node.serviceId && node.key) {
      const tabId = makeEndpointNodeId(node.serviceId, node.key)
      mutations.endpointDeleteMutation.mutate(
        { serviceId: node.serviceId, key: node.key },
        {
          onSuccess: () => {
            closeDialog()
            useTabsStore.getState().close(tabId)
          },
          onError,
        },
      )
    }
  }

  return {
    dialog,
    closeDialog,
    openNewServiceDialog: () => setDialog({ type: 'service-new' }),
    openNewEndpointRequest: (serviceId: string | null) =>
      setDialog(
        serviceId === null
          ? { type: 'service-new' }
          : { type: 'endpoint-new', serviceId, categoryId: null },
      ),
    canRename,
    openRenameDialog,
    openNewCategory,
    openNewEndpoint,
    openDeleteDialog,
    togglePin,
    moveByDirection,
    syncService,
    submitService,
    submitCategory,
    submitEndpoint,
    confirmDelete,
  }
}

/** 动作对象类型（菜单等消费方整体注入，不逐个转发回调） */
export type TreeNodeActions = ReturnType<typeof useTreeNodeActions>
