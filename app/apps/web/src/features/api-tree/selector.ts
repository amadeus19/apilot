import type { TreeDto } from '@/services/workbench-api'
import { makeCategoryNodeId, makeEndpointNodeId, makeServiceNodeId } from '@/lib/tree-identity'

/**
 * 接口树纯函数映射层：Query 的树全量 DTO → 树节点索引（TreePrimitive 数据
 * 加载器消费）→ 过滤可见子图。全部为无副作用纯函数，可单测。
 *
 * 层级＝服务 › 分类 › 接口；分类可选，直挂服务的散接口与分类节点混排
 * （分类在前、散接口在后）；散层与分类内顺序＝sort_order 升序（手动排序，
 * 未定制序时回退创建时间，Rust 侧 DTO 已按此序给出，此处保持数组序不重排）；
 * 置顶接口从原位提升到顶层置顶组（1.0 置顶区语义，跨服务直达，原位不保留）。
 */

/** 顶层置顶组（虚拟分组）的固定节点 id */
export const PINNED_GROUP_ID = 'pinned'

/** 树根 id（TreePrimitive 只作树根，不渲染行） */
export const API_TREE_ROOT_ID = 'root'

export type ApiTreeNodeKind = 'pinnedGroup' | 'service' | 'category' | 'endpoint'

export interface ApiTreeNode {
  id: string
  kind: ApiTreeNodeKind
  /** 行显示名（TreePrimitive getItemName 直接消费） */
  name: string
  /** 祖先链（自父至根）＝树内实际呈现位置（置顶组内接口指向置顶组） */
  parentIds: string[]
  /** 接口行专属身份（打开 Tab 与 IPC 动作的恢复指针） */
  serviceId?: string
  key?: string
  /** 接口行专属：定义与方法徽章 / 过滤匹配用 */
  method?: string
  pathTemplate?: string
  isManual?: boolean
  /**
   * 行尾手工标识是否呈现：仅当所属服务内手工与同步接口并存时该标识才有
   * 信息量（全手工 / 全同步时它恒真或恒假，逐行呈现只是噪音）
   */
  showManualMark?: boolean
  pinned?: boolean
  /** 接口行专属：同步徽标（上次同步应用写入、下次同步清旧；非两值视为无） */
  syncBadge?: 'new' | 'changed'
  /** 接口行所属分类名快照（过滤匹配用；散接口无） */
  categoryName?: string
  /** 接口行所属分类实体 id 快照（更新接口的归属回填用；散层与置顶组内同样保留原归属） */
  categoryId?: string | null
  /** 服务行专属：文档地址（非空渲染 BookOpen 标识） */
  docUrl?: string | null
}

/** 树节点索引：数据加载器（节点表 + 子级表）与过滤可见子图共用形状 */
export interface ApiTreeIndex {
  nodes: Map<string, ApiTreeNode>
  childrenOf: Map<string, string[]>
  rootChildren: string[]
}

/** 节点身份编解码单点在 lib/tree-identity（此处转发，供树域内消费方就近引用） */
export {
  makeEndpointNodeId,
  makeServiceNodeId,
  makeCategoryNodeId,
  parseEndpointNodeId,
  parseServiceNodeId,
  parseCategoryNodeId,
} from '@/lib/tree-identity'

/** 组装树节点索引：节点表 + 子级表（root / 服务 / 分类 / 置顶组全链） */
export function buildApiTreeIndex(tree: TreeDto): ApiTreeIndex {
  const nodes = new Map<string, ApiTreeNode>()
  const childrenOf = new Map<string, string[]>()
  const rootChildren: string[] = []

  const pinnedItems: ApiTreeNode[] = []

  for (const service of tree.services) {
    const serviceNode: ApiTreeNode = {
      id: makeServiceNodeId(service.id),
      kind: 'service',
      name: service.name,
      parentIds: [],
      // 服务行自指原始服务 id（可达性芯片 / 树行动作的消费指针）
      serviceId: service.id,
      docUrl: service.docUrl,
    }
    nodes.set(serviceNode.id, serviceNode)

    const categoryNames = new Map<string, string>()
    for (const category of service.categories) {
      const categoryId = makeCategoryNodeId(category.id)
      categoryNames.set(categoryId, category.name)
      nodes.set(categoryId, {
        id: categoryId,
        kind: 'category',
        name: category.name,
        parentIds: [serviceNode.id],
      })
      childrenOf.set(categoryId, [])
    }

    // 分类内的接口按分类归拢；散接口直挂服务（同 Rust DTO 序＝创建时间升序）；
    // 置顶接口提升到顶层置顶组，原位不保留（1.0 置顶区语义）
    const endpointsByCategory = new Map<string, ApiTreeNode[]>()
    const scatter: ApiTreeNode[] = []
    // 来源是否混存按服务判定（含被提升到置顶组的接口——归属仍是本服务）
    const manualCount = service.endpoints.filter((endpoint) => endpoint.isManual).length
    const serviceHasMixedOrigin = manualCount > 0 && manualCount < service.endpoints.length
    for (const endpoint of service.endpoints) {
      const node: ApiTreeNode = {
        id: makeEndpointNodeId(endpoint.serviceId, endpoint.key),
        kind: 'endpoint',
        name: endpoint.title,
        parentIds: [],
        serviceId: endpoint.serviceId,
        key: endpoint.key,
        method: endpoint.definition.method,
        pathTemplate: endpoint.definition.pathTemplate,
        isManual: endpoint.isManual,
        showManualMark: endpoint.isManual && serviceHasMixedOrigin,
        pinned: endpoint.pinned,
        syncBadge:
          endpoint.badge === 'new' || endpoint.badge === 'changed' ? endpoint.badge : undefined,
      }
      if (endpoint.pinned) {
        // 原归属快照保留（按分类名匹配与行上下文用）；树内父链稍后指向置顶组
        node.categoryId = endpoint.categoryId
        node.categoryName =
          endpoint.categoryId !== null
            ? categoryNames.get(makeCategoryNodeId(endpoint.categoryId))
            : undefined
        pinnedItems.push(node)
        nodes.set(node.id, node)
        continue
      }
      if (endpoint.categoryId !== null) {
        const categoryIdNode = makeCategoryNodeId(endpoint.categoryId)
        if (categoryNames.has(categoryIdNode)) {
          node.parentIds = [categoryIdNode, serviceNode.id]
          node.categoryId = endpoint.categoryId
          node.categoryName = categoryNames.get(categoryIdNode)
          const bucket = endpointsByCategory.get(categoryIdNode)
          if (bucket) bucket.push(node)
          else endpointsByCategory.set(categoryIdNode, [node])
        } else {
          // 分类已删而 DTO 未刷新时接口退回散层（脏 categoryId 不丢行，归属快照保留）
          node.parentIds = [serviceNode.id]
          node.categoryId = endpoint.categoryId
          scatter.push(node)
        }
      } else {
        node.parentIds = [serviceNode.id]
        node.categoryId = endpoint.categoryId
        scatter.push(node)
      }
      nodes.set(node.id, node)
    }

    for (const [categoryId, items] of endpointsByCategory) {
      childrenOf.set(
        categoryId,
        items.map((item) => item.id),
      )
    }

    childrenOf.set(serviceNode.id, [...categoryIds(service), ...scatter.map((item) => item.id)])
    for (const item of scatter) nodes.set(item.id, item)
    rootChildren.push(serviceNode.id)
  }

  // 置顶组：有置顶接口才建组；组内接口的实际父链＝置顶组（提升语义下
  // 树内只有这一处呈现），原位归属仅供匹配与上下文（categoryName 快照）
  if (pinnedItems.length > 0) {
    const groupNode: ApiTreeNode = {
      id: PINNED_GROUP_ID,
      kind: 'pinnedGroup',
      name: PINNED_GROUP_ID,
      parentIds: [],
    }
    nodes.set(groupNode.id, groupNode)
    childrenOf.set(
      groupNode.id,
      pinnedItems.map((item) => item.id),
    )
    for (const item of pinnedItems) item.parentIds = [PINNED_GROUP_ID]
    rootChildren.unshift(groupNode.id)
  }

  return { nodes, childrenOf, rootChildren }
}

/** 服务下分类节点 id 列表（保持 DTO 序＝sort_order 序） */
function categoryIds(service: TreeDto['services'][number]): string[] {
  return service.categories.map((category) => makeCategoryNodeId(category.id))
}

/** 树内全部容器节点 id（服务 + 分类 + 有置顶时的置顶组）：一键展开全部的目标集 */
export function allContainerIds(tree: TreeDto): string[] {
  const ids: string[] = []
  let hasPinned = false
  for (const service of tree.services) {
    ids.push(makeServiceNodeId(service.id))
    for (const category of service.categories) {
      ids.push(makeCategoryNodeId(category.id))
    }
    if (!hasPinned && service.endpoints.some((endpoint) => endpoint.pinned)) hasPinned = true
  }
  if (hasPinned) ids.push(PINNED_GROUP_ID)
  return ids
}

/** 过滤结果：命中接口的可见子图（null＝非过滤模式，用全量索引） */
export interface ApiTreeFilterResult {
  index: ApiTreeIndex
  /** 命中接口的祖先链并集（进入过滤时自动展开，保证命中项可见） */
  ancestorsToExpand: string[]
  hasMatches: boolean
}

/** 四字段匹配（标题 + 路径 + 分类名 + 方法），不区分大小写 */
function matchesEndpoint(node: ApiTreeNode, query: string): boolean {
  if (node.method?.toLowerCase().includes(query)) return true
  if (node.pathTemplate?.toLowerCase().includes(query)) return true
  if (node.name.toLowerCase().includes(query)) return true
  return node.categoryName?.toLowerCase().includes(query) ?? false
}

/** 过滤树：不命中行不显示，命中项祖先自动可见；空查询返回 null（非过滤） */
export function filterApiTree(index: ApiTreeIndex, rawQuery: string): ApiTreeFilterResult | null {
  const query = rawQuery.trim().toLowerCase()
  if (query === '') return null

  const matchIds = new Set<string>()
  for (const node of index.nodes.values()) {
    if (node.kind === 'endpoint' && matchesEndpoint(node, query)) {
      matchIds.add(node.id)
    }
  }

  // 可见集＝命中接口 ∪ 全部祖先；子图只保留可见节点间的边
  const visible = new Set<string>(matchIds)
  const ancestorsToExpand: string[] = []
  for (const id of matchIds) {
    const node = index.nodes.get(id)
    for (const ancestorId of node?.parentIds ?? []) {
      if (!visible.has(ancestorId)) {
        visible.add(ancestorId)
        ancestorsToExpand.push(ancestorId)
      }
    }
  }

  const nodes = new Map<string, ApiTreeNode>()
  const childrenOf = new Map<string, string[]>()
  const rootChildren: string[] = []
  for (const id of visible) {
    const node = index.nodes.get(id)
    if (!node) continue
    nodes.set(id, node)
    const children = (index.childrenOf.get(id) ?? []).filter((childId) => visible.has(childId))
    childrenOf.set(id, children)
  }
  for (const id of index.rootChildren) {
    if (visible.has(id)) rootChildren.push(id)
  }

  return {
    index: { nodes, childrenOf, rootChildren },
    ancestorsToExpand,
    hasMatches: matchIds.size > 0,
  }
}

/** 进入过滤模式的展开合并（纯函数）：基线展开 ∪ 命中祖先 */
export function expandForFilter(baseExpanded: string[], ancestorsToExpand: string[]): string[] {
  if (ancestorsToExpand.length === 0) return baseExpanded
  return Array.from(new Set([...baseExpanded, ...ancestorsToExpand]))
}
