/**
 * 树节点身份编解码（树节点 id ≡ 工作台 Tab id 的单点真相）：
 * 接口树行 id 与接口 Tab 的单实例身份是同一格式串（`endpoint:{serviceId}:{key}`），
 * 「激活 Tab → 树行高亮」「树行 → 打开 Tab」的等价关系完全依赖两串相等。
 * 全部构造与解析只此一份——tabs.store、接口树 selector、拖拽判定、
 * AppShell 接线一律经此模块，禁止内联模板串或第二份构造器
 * （格式一旦漂移，失败形态是静默错位：高亮失效、徽章查不到，无报错可追）。
 *
 * 服务与分类节点 id 同源维护（`service:{id}` / `category:{id}`）。
 */

/** 接口节点 id（与接口 Tab 的单实例身份同构，打开 Tab 直接复用） */
export function makeEndpointNodeId(serviceId: string, key: string): string {
  return `endpoint:${serviceId}:${key}`
}

export function makeServiceNodeId(serviceId: string): string {
  return `service:${serviceId}`
}

export function makeCategoryNodeId(categoryId: string): string {
  return `category:${categoryId}`
}

/** 从节点 id 提取接口身份（非接口节点返回 null） */
export function parseEndpointNodeId(id: string): { serviceId: string; key: string } | null {
  if (!id.startsWith('endpoint:')) return null
  const rest = id.slice('endpoint:'.length)
  const sep = rest.indexOf(':')
  if (sep <= 0 || sep === rest.length - 1) return null
  return { serviceId: rest.slice(0, sep), key: rest.slice(sep + 1) }
}

/** 从节点 id 提取服务实体 id（非服务节点返回 null） */
export function parseServiceNodeId(id: string): string | null {
  if (!id.startsWith('service:')) return null
  return id.slice('service:'.length) || null
}

/** 从节点 id 提取分类实体 id（非分类节点返回 null） */
export function parseCategoryNodeId(id: string): string | null {
  if (!id.startsWith('category:')) return null
  return id.slice('category:'.length) || null
}
