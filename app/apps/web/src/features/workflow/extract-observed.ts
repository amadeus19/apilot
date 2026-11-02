/**
 * 提取产物的实测字段解析纯函数（写回值下拉与引用候选深层展开的实测
 * 来源层）：从本工作流最近一次执行的上游请求节点响应体（Rust 侧掩码
 * 摘要——合法 JSON 保留结构与标量、字符串值掩码）解析实测字段名。掩码
 * 体可解析结构（字段名非敏感），只产出路径不产出值。不含 React，供
 * ExtractEditor 与测试共用。
 */

/** 受限 JSONPath 求值（`$.a.b` / `['a']` / `[0]`，根符 `$` 可省）——与
 * Rust `json_path::evaluate` 同口径的最小前端镜像（过滤器 / 通配 / 切片
 * 不支持，未命中返回 undefined）。仅供实测字段定位，不承担引擎求值。 */
export function evaluateJsonPathLite(path: string, root: unknown): unknown {
  const trimmed = path.trim()
  let rest = trimmed.startsWith('$') ? trimmed.slice(1) : trimmed
  let current = root
  while (rest !== '') {
    if (rest.startsWith('.')) {
      rest = rest.slice(1)
      const end = rest.search(/[.[]/)
      const name = end < 0 ? rest : rest.slice(0, end)
      if (name === '') return undefined
      current = descend(current, { key: name })
      rest = end < 0 ? '' : rest.slice(end)
      continue
    }
    if (rest.startsWith('[')) {
      const close = rest.indexOf(']')
      if (close < 0) return undefined
      const inner = rest.slice(1, close)
      rest = rest.slice(close + 1)
      const quoted = inner.match(/^'(.*)'$/) ?? inner.match(/^"(.*)"$/)
      current = quoted
        ? descend(current, { key: quoted[1] ?? '' })
        : descend(current, { index: Number(inner) })
      continue
    }
    // 首段隐式属性（`data.token` 等价 `$.data.token`）
    const end = rest.search(/[.[]/)
    const name = end < 0 ? rest : rest.slice(0, end)
    if (name === '') return undefined
    current = descend(current, { key: name })
    rest = end < 0 ? '' : rest.slice(end)
  }
  return current
}

function descend(value: unknown, step: { key?: string; index?: number }): unknown {
  if (step.key !== undefined) {
    return typeof value === 'object' && value !== null && step.key in value
      ? (value as Record<string, unknown>)[step.key]
      : undefined
  }
  return Array.isArray(value) && step.index !== undefined && Number.isInteger(step.index)
    ? (value[step.index] ?? undefined)
    : undefined
}

/** 掩码响应体摘要 → JSON 根（非法 JSON 返回 null——无实测数据回落）。 */
export function parseObservedBody(body: string | null | undefined): unknown | null {
  if (body == null || body === '') return null
  try {
    return JSON.parse(body) as unknown
  } catch {
    return null
  }
}

/** 单个 Body 源产物在掩码响应体上的实测字段路径（一层展开）：对象产物展开
 * 键名（`产物名.键`）；数组产物取首元素为对象时展开其键名
 * （`产物名.0.键`）；单值产物不展开。产物名为空不入展开。 */
export function expandObservedFields(
  productName: string,
  productPath: string,
  root: unknown | null,
): string[] {
  const name = productName.trim()
  if (name === '' || root == null) return []
  const value = evaluateJsonPathLite(productPath, root)
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.keys(value).map((key) => `${name}.${key}`)
  }
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    typeof value[0] === 'object' &&
    value[0] !== null
  ) {
    return Object.keys(value[0] as Record<string, unknown>).map((key) => `${name}.0.${key}`)
  }
  return []
}
