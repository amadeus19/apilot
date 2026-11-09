import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'

import {
  treeGet,
  workbenchKeys,
  workspaceCreate,
  workspaceDelete,
  workspaceList,
  workspaceRename,
  workspaceReorder,
  workspaceSetCurrent,
  serviceCreate,
  serviceDelete,
  serviceImportCreate,
  serviceImportDiscover,
  serviceListByWorkspace,
  serviceMove,
  serviceMoveTo,
  serviceUpdate,
  type TreeDto,
  type WorkspaceDto,
  type WorkspaceListDto,
} from '@/services/workbench-api'
import { useIpcMutation, useIpcQuery } from '@/services/ipc-query'
import type { IpcError } from '@/services/ipc'
import { variableKeys } from '@/features/variables/variable-api'

import type { ImportGroupCheck } from './import-groups'

/**
 * 工作空间域前端数据层：清单 + current 走 ['workspaces'] 单键；
 * 切换＝写 settings 键（Rust 侧校验存在性）→ 失效 ['workspaces']，
 * 新工作空间的 tree 键随 api-tree 挂载自动拉取（visited 过的缓存一并失效防旧值）。
 */

/** 工作空间清单 + current（标题栏切换器与会话恢复接线共用） */
export function useWorkspacesQuery(): ReturnType<
  typeof useQuery<WorkspaceListDto, IpcError, WorkspaceListDto, unknown[]>
> {
  return useIpcQuery({
    queryKey: workbenchKeys.workspaces(),
    queryFn: workspaceList,
    staleTime: 30_000,
  })
}

/**
 * 当前工作空间的树全量（复合查询：清单 → currentId → tree）。
 * 树数据的默认消费形态——接口树 / 标签栏方法徽章 / 接口编辑器共用，
 * staleTime 与 enabled 约定在此单点定约，消费方不自拼接线。
 */
export function useCurrentWorkspaceTreeQuery(): ReturnType<
  typeof useQuery<TreeDto, IpcError, TreeDto, unknown[]>
> & { workspaceId: string | null } {
  const { data: workspaces } = useWorkspacesQuery()
  const workspaceId = workspaces?.currentId ?? null
  const query = useIpcQuery({
    queryKey: workbenchKeys.tree(workspaceId ?? ''),
    queryFn: () => treeGet(workspaceId!),
    enabled: workspaceId !== null,
    staleTime: 30_000,
  })
  return { ...query, workspaceId }
}

/**
 * 失效当前工作空间的树（mutation 后的刷新单点）：currentId 经
 * workspaces 缓存直读，消费方不必为失效反查清单。
 */
export function invalidateCurrentTree(queryClient: QueryClient): void {
  const current = queryClient.getQueryData<WorkspaceListDto>(workbenchKeys.workspaces())
  const workspaceId = current?.currentId
  if (workspaceId) {
    void queryClient.invalidateQueries({ queryKey: workbenchKeys.tree(workspaceId) })
  }
}

/** 切换当前工作空间（只切不建不删不名；管理视图随工作空间管理域交付） */
export function useSetCurrentWorkspaceMutation() {
  const queryClient = useQueryClient()
  return useIpcMutation({
    mutationFn: (workspaceId: string) => workspaceSetCurrent(workspaceId),
    onSuccess: (_data, workspaceId) => {
      void queryClient.invalidateQueries({ queryKey: workbenchKeys.workspaces() })
      // 新空间的树键一并失效：曾访问过的工作空间不得回放旧树
      void queryClient.invalidateQueries({ queryKey: workbenchKeys.tree(workspaceId) })
    },
  })
}

/**
 * 新建工作空间的产品预置默认值（2026-10-21 用户裁定）：BaseUrl 指向本地
 * Flask 型开发服务、认证预置 bearer 令牌变量——多数新空间开箱即可发请求；
 * 建后详情页随时可改。auth 为认证配置 JSON，与 workspace.set_auth 写路径
 * 同口径（serializeAuthDraft 的产物形态）。
 */
const CREATE_DEFAULT_BASE_URL = 'http://127.0.0.1:5000'
const CREATE_DEFAULT_AUTH = JSON.stringify({ type: 'bearer', token: '{{access-token}}' })

/**
 * 工作空间管理 mutation 组（新建 / 重命名整行 / 删除）：
 * Rust 侧返回刷新后的清单；失效走 ['workspaces'] 前缀——树键
 * （['workspaces', id, 'tree']）是它的子键，删除连带切换的树重建
 * 由同一次前缀失效覆盖。重命名（名称与 BaseUrl 同写）额外失效目标
 * 空间的生效变量集（内置 {{baseUrl}} 条目取自 base_url）。
 */
export function useWorkspaceMutations() {
  const queryClient = useQueryClient()
  const invalidateWorkspaces = () => {
    void queryClient.invalidateQueries({ queryKey: workbenchKeys.workspaces() })
  }

  const createMutation = useIpcMutation({
    mutationFn: (name: string) =>
      workspaceCreate(name, CREATE_DEFAULT_BASE_URL, CREATE_DEFAULT_AUTH),
    onSuccess: invalidateWorkspaces,
  })
  const renameMutation = useIpcMutation({
    mutationFn: (input: { id: string; name: string; baseUrl: string | null }) =>
      workspaceRename(input.id, input.name, input.baseUrl),
    onSuccess: (_data, input) => {
      invalidateWorkspaces()
      // 生效变量集的内置 {{baseUrl}} 条目取自 workspaces.base_url：改名
      // （含 BaseUrl 变更）后该空间的生效集随之失效重算
      void queryClient.invalidateQueries({ queryKey: variableKeys.effective(input.id) })
    },
  })
  const deleteMutation = useIpcMutation({
    mutationFn: (id: string) => workspaceDelete(id),
    onSuccess: invalidateWorkspaces,
  })
  return { createMutation, renameMutation, deleteMutation }
}

/**
 * 全部工作空间的服务清单（聚合单查询，左栏工作空间树第二级供数）。
 * 键挂 ['workspaces'] 前缀——空间集合变化或任一服务变更（新建 / 编辑 /
 * 删除 / 导入）经前缀失效整批重拉，同前缀的接口树键一并失效；轻查询
 * 批量重拉的开销在个位数空间量级下可忽略，换取失效口径单点。
 */
export function useAllWorkspaceServicesQuery(items: WorkspaceDto[]) {
  const idsKey = items.map((item) => item.id).join(',')
  return useIpcQuery({
    queryKey: workbenchKeys.workspaceServicesBatch(idsKey),
    queryFn: () => Promise.all(items.map((item) => serviceListByWorkspace(item.id))),
    staleTime: 30_000,
    enabled: items.length > 0,
  })
}

/**
 * 单工作空间服务清单（工作空间详情页服务列表供数）。键与 tree 键同构
 * 挂 ['workspaces'] 前缀——服务变更经前缀失效自动覆盖，本处不自维护
 * 失效面；workspaceId null（详情未指向具体空间）时不拉取。
 */
export function useWorkspaceServicesQuery(workspaceId: string | null) {
  return useIpcQuery({
    queryKey: workbenchKeys.workspaceServices(workspaceId ?? ''),
    queryFn: () => serviceListByWorkspace(workspaceId!),
    staleTime: 30_000,
    enabled: workspaceId !== null,
  })
}

/**
 * 树视图服务 mutation 组（新建 / 编辑 / 删除，作用对象可为任意工作空间）：
 * 失效走 ['workspaces'] 前缀——服务批查询、清单与受影响空间的接口树
 * 一次覆盖，不必逐空间判定失效面。
 */
export function useWorkspaceServiceMutations() {
  const queryClient = useQueryClient()
  const invalidateWorkspaces = () => {
    void queryClient.invalidateQueries({ queryKey: workbenchKeys.workspaces() })
  }
  const createMutation = useIpcMutation({
    mutationFn: (input: { workspaceId: string; name: string; docUrl: string | null }) =>
      serviceCreate(input.workspaceId, input.name, input.docUrl),
    onSuccess: invalidateWorkspaces,
  })
  const updateMutation = useIpcMutation({
    mutationFn: (input: { id: string; name: string; docUrl: string | null }) =>
      serviceUpdate(input.id, input.name, input.docUrl),
    onSuccess: invalidateWorkspaces,
  })
  const deleteMutation = useIpcMutation({
    mutationFn: (id: string) => serviceDelete(id),
    onSuccess: invalidateWorkspaces,
  })
  return { createMutation, updateMutation, deleteMutation }
}

/**
 * 排序 mutation 组（左栏两级树与工作空间详情服务列表共用）：
 * - reorderMutation：工作空间整批重排（workspace.reorder，有序 id 表一次到位）
 * - serviceMoveMutation：服务相邻交换（service.move，上移 / 下移键盘替代通道）
 * - serviceMoveToMutation：服务拖拽到位（service.move_to，摘除自身后的插入位）
 * 失效统一走 ['workspaces'] 前缀——清单、服务批查询与单空间清单一次覆盖；
 * 落库失败不写回滚，靠失效重拉回真值。
 */
export function useWorkspaceSortMutations() {
  const queryClient = useQueryClient()
  const invalidateWorkspaces = () => {
    void queryClient.invalidateQueries({ queryKey: workbenchKeys.workspaces() })
  }

  const reorderMutation = useIpcMutation({
    mutationFn: (orderedIds: string[]) => workspaceReorder(orderedIds),
    onSuccess: invalidateWorkspaces,
  })
  const serviceMoveMutation = useIpcMutation({
    mutationFn: ({ id, direction }: { id: string; direction: 'up' | 'down' }) =>
      serviceMove(id, direction),
    onSuccess: invalidateWorkspaces,
  })
  const serviceMoveToMutation = useIpcMutation({
    mutationFn: ({ id, index }: { id: string; index: number }) => serviceMoveTo(id, index),
    onSuccess: invalidateWorkspaces,
  })
  return { reorderMutation, serviceMoveMutation, serviceMoveToMutation }
}

/**
 * 批量导入 mutation 组（Swashbuckle 入口页发现 → 勾选建服务）：
 * 目标工作空间随入参携带（树上可对任意空间导入）；发现只读不失效，
 * 建服务后失效 ['workspaces'] 前缀（服务批查询与目标空间接口树一并重拉）。
 */
export function useServiceImportMutations() {
  const queryClient = useQueryClient()
  const discoverMutation = useIpcMutation({
    mutationFn: (input: { workspaceId: string; entryUrl: string }) =>
      serviceImportDiscover(input.workspaceId, input.entryUrl),
  })
  const createMutation = useIpcMutation({
    mutationFn: (input: { workspaceId: string; groups: readonly ImportGroupCheck[] }) =>
      serviceImportCreate(
        input.workspaceId,
        input.groups.map((group) => ({ name: group.name, docUrl: group.docUrl })),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workbenchKeys.workspaces() })
    },
  })
  return { discoverMutation, createMutation }
}
