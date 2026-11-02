/**
 * 工作台域 IPC 薄封装：点分命令的参数 / DTO 类型镜像（与 Rust command
 * 签名一一对应），query key 约定（单一事实源）：
 * - ['workspaces']：清单 + current
 * - ['workspaces', workspaceId, 'tree']：树全量
 * - ['user-data', serviceId, key]：草稿单键（mutation 不失效任何 key；
 *   同步应用按 ['user-data', serviceId] 前缀失效回流）
 * - ['endpoint-doc', serviceId, key]：接口文档抽屉取数（同步应用按
 *   ['endpoint-doc', serviceId] 前缀失效回流）
 * 失效策略：workspace mutation → ['workspaces']（切换另失效新空间 tree）；
 * service / category / endpoint / pin mutation → ['workspaces', id, 'tree']。
 */

import { invoke } from './ipc'

// —— DTO 类型（Rust 序列化形态镜像，camelCase） ——

export interface WorkspaceDto {
  id: string
  name: string
  baseUrl: string | null
  /** 工作空间级认证配置 JSON（认证继承链根；null＝未配置） */
  auth: string | null
  isCurrent: boolean
}

export interface WorkspaceListDto {
  items: WorkspaceDto[]
  currentId: string | null
}

export interface CategoryNodeDto {
  id: string
  name: string
  sortOrder: number
}

export interface EndpointNodeDto {
  serviceId: string
  key: string
  title: string
  categoryId: string | null
  definition: { method: string; pathTemplate: string }
  isManual: boolean
  pinned: boolean
  /** 同步徽标（'new' / 'changed'）；未参与同步的行 null */
  badge?: string | null
}

export interface ServiceNodeDto {
  id: string
  name: string
  docUrl: string | null
  docType: string
  sortOrder: number
  categories: CategoryNodeDto[]
  endpoints: EndpointNodeDto[]
}

export interface TreeDto {
  workspaceId: string
  services: ServiceNodeDto[]
}

export interface ServiceDto {
  id: string
  workspaceId: string
  name: string
  docUrl: string | null
  docType: string
  sortOrder: number
}

export interface CategoryDto {
  id: string
  serviceId: string
  name: string
  sortOrder: number
}

export interface EndpointDto {
  serviceId: string
  key: string
  title: string
  categoryId: string | null
  definition: { method: string; pathTemplate: string }
  isManual: boolean
}

export interface UserDataDto {
  serviceId: string
  key: string
  body: string | null
  params: string
  headers: string
  /** 接口级超时覆写（null 继承全局 / 0 不限制 / >0 秒） */
  timeoutSeconds: number | null
  /** 请求级认证配置 JSON（前端组装；null＝继承工作空间级） */
  auth: string | null
  /** 路径覆写（null＝跟随接口定义；发送时覆写优先） */
  pathOverride: string | null
  /** 方法覆写（null＝跟随接口定义；发送时覆写优先） */
  methodOverride: string | null
  updatedAt: string
}

export interface SessionDto {
  tabs: string
  treeExpanded: string
}

// —— query key 工厂（单一事实源，组件不自拼键） ——

export const workbenchKeys = {
  workspaces: () => ['workspaces'] as const,
  tree: (workspaceId: string) => ['workspaces', workspaceId, 'tree'] as const,
  /** 单空间服务清单（工作空间详情页服务列表供数；与 tree 键同构挂前缀） */
  workspaceServices: (workspaceId: string) => ['workspaces', workspaceId, 'services'] as const,
  /** 全空间服务批查询（左栏工作空间树第二级供数；idsKey＝空间 id 序列） */
  workspaceServicesBatch: (idsKey: string) => ['workspaces', 'services-batch', idsKey] as const,
  userData: (serviceId: string, key: string) => ['user-data', serviceId, key] as const,
  /** 服务级前缀：整服务的用户数据查询批量失效（同步应用后回流对齐结果） */
  userDataService: (serviceId: string) => ['user-data', serviceId] as const,
  endpointDoc: (serviceId: string, key: string) => ['endpoint-doc', serviceId, key] as const,
  /** 服务级前缀：整服务的接口文档查询批量失效（同步应用后打开中的抽屉即时回流） */
  endpointDocService: (serviceId: string) => ['endpoint-doc', serviceId] as const,
}

// —— workspace.*（7） ——

export function workspaceList(): Promise<WorkspaceListDto> {
  return invoke<WorkspaceListDto>('workspace.list')
}

/** 返回刷新后的清单（含 current 标记），调用方可直接消费。baseUrl / auth
 *  可选携带创建默认值（auth＝认证配置 JSON，同 workspace.set_auth 载荷口径） */
export function workspaceCreate(
  name: string,
  baseUrl: string | null = null,
  auth: string | null = null,
): Promise<WorkspaceListDto> {
  return invoke<WorkspaceListDto>('workspace.create', { name, baseUrl, auth })
}

export function workspaceRename(
  id: string,
  name: string,
  baseUrl: string | null,
): Promise<WorkspaceListDto> {
  return invoke<WorkspaceListDto>('workspace.rename', { args: { id, name, baseUrl } })
}

export function workspaceDelete(id: string): Promise<WorkspaceListDto> {
  return invoke<WorkspaceListDto>('workspace.delete', { id })
}

export function workspaceSetCurrent(id: string): Promise<void> {
  return invoke<void>('workspace.set_current', { id })
}

/**
 * 工作空间整批重排（拖拽放落 / 上移下移共用的一次到位原语）：orderedIds
 * 为完整有序 id 表（须与现有集合完全一致），返回刷新后的清单
 */
export function workspaceReorder(orderedIds: string[]): Promise<WorkspaceListDto> {
  return invoke<WorkspaceListDto>('workspace.reorder', { orderedIds })
}

/** 更新工作空间级认证配置（认证继承链根）；null＝清除配置（等价无认证） */
export function workspaceSetAuth(id: string, auth: string | null): Promise<WorkspaceDto> {
  return invoke<WorkspaceDto>('workspace.set_auth', { id, auth })
}

// —— tree.get（1） ——

export function treeGet(workspaceId: string): Promise<TreeDto> {
  return invoke<TreeDto>('tree.get', { workspaceId })
}

// —— service.*（6） ——

export function serviceListByWorkspace(workspaceId: string): Promise<ServiceDto[]> {
  return invoke<ServiceDto[]>('service.list_by_workspace', { workspaceId })
}

export function serviceCreate(
  workspaceId: string,
  name: string,
  docUrl: string | null,
): Promise<ServiceDto> {
  return invoke<ServiceDto>('service.create', { workspaceId, name, docUrl })
}

export function serviceUpdate(
  id: string,
  name: string,
  docUrl: string | null,
): Promise<ServiceDto> {
  return invoke<ServiceDto>('service.update', { args: { id, name, docUrl } })
}

export function serviceDelete(id: string): Promise<void> {
  return invoke<void>('service.delete', { id })
}

export function serviceMove(id: string, direction: 'up' | 'down'): Promise<void> {
  return invoke<void>('service.move', { id, direction })
}

/** 移动服务到工作空间服务序列的目标位（拖拽排序；index 为摘除自身后的插入位） */
export function serviceMoveTo(id: string, index: number): Promise<void> {
  return invoke<void>('service.move_to', { id, index })
}

// —— service.import_*（2）：批量导入（Swashbuckle 入口页发现） ——

/** 发现分组：Swagger UI 分组名 + 文档绝对地址 */
export interface ImportGroupDto {
  name: string
  docUrl: string
}

/** 发现返回：补全后的入口页绝对地址（回显）+ 分组清单（不建服务） */
export interface ImportDiscoverDto {
  entryUrl: string
  groups: ImportGroupDto[]
}

/** 批量建服务输入项（导入服务必有文档地址） */
export interface ImportServiceInput {
  name: string
  docUrl: string
}

/** 拉取入口页并解析 swagger 分组清单（重名消歧在前端只做标注，落库在后端） */
export function serviceImportDiscover(
  workspaceId: string,
  entryUrl: string,
): Promise<ImportDiscoverDto> {
  return invoke<ImportDiscoverDto>('service.import_discover', { workspaceId, entryUrl })
}

/** 勾选分组批量建服务（重名自动追加序号；单事务全成或全败） */
export function serviceImportCreate(
  workspaceId: string,
  services: ImportServiceInput[],
): Promise<ServiceDto[]> {
  return invoke<ServiceDto[]>('service.import_create', { workspaceId, services })
}

// —— category.*（5） ——

export function categoryCreate(serviceId: string, name: string): Promise<CategoryDto> {
  return invoke<CategoryDto>('category.create', { serviceId, name })
}

export function categoryRename(id: string, name: string): Promise<CategoryDto> {
  return invoke<CategoryDto>('category.rename', { id, name })
}

export function categoryDelete(id: string): Promise<void> {
  return invoke<void>('category.delete', { id })
}

export function categoryMove(id: string, direction: 'up' | 'down'): Promise<void> {
  return invoke<void>('category.move', { id, direction })
}

/** 移动分类到目标服务分类序列的目标位（拖拽排序，支持跨服务） */
export function categoryMoveTo(id: string, targetServiceId: string, index: number): Promise<void> {
  return invoke<void>('category.move_to', { id, targetServiceId, index })
}

// —— endpoint.*（5） ——

export interface ManualEndpointInput {
  serviceId: string
  method: string
  pathTemplate: string
  title: string
  categoryId: string | null
}

export function endpointCreateManual(input: ManualEndpointInput): Promise<EndpointDto> {
  return invoke<EndpointDto>('endpoint.create_manual', { args: input })
}

export function endpointUpdateManual(
  input: ManualEndpointInput & { key: string },
): Promise<EndpointDto> {
  return invoke<EndpointDto>('endpoint.update_manual', { args: input })
}

export function endpointDelete(serviceId: string, key: string): Promise<void> {
  return invoke<void>('endpoint.delete', { serviceId, key })
}

export function endpointSetPinned(serviceId: string, key: string, pinned: boolean): Promise<void> {
  return invoke<void>('endpoint.set_pinned', { serviceId, key, pinned })
}

/** 移动接口到目标分组的目标位（拖拽 / 上移下移共用；categoryId 缺省＝服务散层） */
export function endpointMove(
  serviceId: string,
  key: string,
  categoryId: string | null,
  index: number,
): Promise<void> {
  return invoke<void>('endpoint.move', { serviceId, key, categoryId, index })
}

// —— user_data.*（2） ——

export function userDataGet(serviceId: string, key: string): Promise<UserDataDto | null> {
  return invoke<UserDataDto | null>('user_data.get', { serviceId, key })
}

/** 整包写（六列一次）；mutation 不失效任何 query key（本地状态为真相） */
export function userDataUpsert(
  serviceId: string,
  key: string,
  body: string | null,
  params: string,
  headers: string,
  timeoutSeconds: number | null,
  auth: string | null,
  pathOverride: string | null,
  methodOverride: string | null,
): Promise<UserDataDto> {
  return invoke<UserDataDto>('user_data.upsert', {
    args: {
      serviceId,
      key,
      body,
      params,
      headers,
      timeoutSeconds,
      auth,
      pathOverride,
      methodOverride,
    },
  })
}

// —— session.*（2） ——

/** 恢复会话：被删服务的残留 Tab 已由 Rust 侧按存在性过滤 */
export function sessionGet(workspaceId: string): Promise<SessionDto | null> {
  return invoke<SessionDto | null>('session.get', { workspaceId })
}

/** 整包保存（tabs / treeExpanded 均为前端组装的 JSON 字符串） */
export function sessionSave(
  workspaceId: string,
  tabs: string,
  treeExpanded: string,
): Promise<void> {
  return invoke<void>('session.save', { args: { workspaceId, tabs, treeExpanded } })
}
