/**
 * 接口树 → 请求节点的拖放契约（载荷编解码与绑定动作，纯函数单测点）。
 *
 * 绑定唯一入口＝左树拖入：拖接口落到画布空白处＝创建已绑定请求节点，
 * 落到待绑定占位（endpointKey null 的 request 节点）上＝完成绑定。
 * 请求节点存稳定键引用、永不复制定义快照——载荷只随拖拽会话存活，
 * 序列化落库面只有稳定键＋覆写（绑定产生的名称进节点 name 字段）。
 */

import type { WorkflowNode } from './workflow-model'

/** 接口树行拖出载荷 MIME（画布 drop 端识别用） */
export const ENDPOINT_DRAG_MIME = 'application/x-apilot-workflow-endpoint'

/** 接口树行拖出载荷：树行现成数据（不回查接口定义） */
export interface EndpointDragPayload {
  serviceId: string
  /** 稳定键（同步接口）或手工接口 UUID——请求节点持久化的引用键 */
  key: string
  method: string
  pathTemplate: string
  /** 接口标题（绑定时作节点默认名） */
  name: string
}

/** 载荷 → dataTransfer 字符串（JSON；字段恒存在，编码无失败面） */
export function encodeEndpointDragPayload(payload: EndpointDragPayload): string {
  return JSON.stringify(payload)
}

/** dataTransfer 字符串 → 载荷；形态不符（非法 JSON / 缺字段 / 类型漂移）拒收。 */
export function decodeEndpointDragPayload(raw: string): EndpointDragPayload | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    const record = value as Record<string, unknown>
    if (
      typeof record.serviceId !== 'string' ||
      typeof record.key !== 'string' ||
      typeof record.method !== 'string' ||
      typeof record.pathTemplate !== 'string' ||
      typeof record.name !== 'string'
    ) {
      return null
    }
    return {
      serviceId: record.serviceId,
      key: record.key,
      method: record.method,
      pathTemplate: record.pathTemplate,
      name: record.name,
    }
  } catch {
    return null
  }
}

/** 七法白名单（与 Rust HttpMethod 对齐；稳定键解析的识别面） */
const STABLE_KEY_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
])

/**
 * 稳定键 → 方法＋路径（同步接口身份 `方法 + 空格 + 路由模板` 的显示拆分）。
 * 手工接口 key 为 UUID（无方法路径语义），解析返回 null。
 */
export function splitStableKey(key: string): { method: string; path: string } | null {
  const separator = key.indexOf(' ')
  if (separator <= 0) return null
  const method = key.slice(0, separator)
  if (!STABLE_KEY_METHODS.has(method)) return null
  return { method, path: key.slice(separator + 1) }
}

/** 卡片内能解析出方法徽标的稳定键形态（节点配置面展示同样消费） */
export function isStableKey(key: string): boolean {
  return splitStableKey(key) !== null
}

/**
 * drop 落点路由：待绑定占位（endpointKey null）与失效引用节点开放绑定/
 * 重接；健康已绑定与非 request 节点不响应（落点回退到画布空白语义——
 * 新建已绑定请求节点）。失效是校验按稳定键解析的派生态，编辑器以失效
 * 节点集（InvalidRefContext）路由重接。
 */
export function isBindableDropTarget(
  config: WorkflowNode['config'],
  invalidRefIds: ReadonlySet<string>,
  nodeId: string,
): boolean {
  return config.type === 'request' && (config.endpointKey == null || invalidRefIds.has(nodeId))
}

/**
 * 绑定动作：把接口落到位 request 节点上——占位（endpointKey null）完成
 * 绑定；对已绑定节点落到不同接口＝重接，按新接口重新播种配置（覆写行与
 * 体清空、编辑器对新接口重新预填——重绑＝新配置播种；同键重复落点不重置）。
 * 名称与超时覆写保留（与接口身份无关）。
 */
export function bindEndpointToNode(node: WorkflowNode, payload: EndpointDragPayload): WorkflowNode {
  if (node.config.type !== 'request') return node
  if (node.config.endpointKey === payload.key) return node
  return {
    ...node,
    name: node.name !== '' ? node.name : payload.name,
    config: { ...node.config, endpointKey: payload.key, query: [], pathParams: [], body: null },
  }
}
