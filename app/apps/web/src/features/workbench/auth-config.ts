/**
 * 认证配置 JSON 契约（前后端唯一事实源）：请求级（接口 Auth 页签）与
 * 工作空间级（工作空间设置页认证区）共用的组装 / 解析纯函数。
 *
 * JSON 形态（Rust services/http/auth.rs 的 parse_auth_json 解析消费）：
 * - 请求级：`{"type":"inherit"}`（默认）/ `{"type":"none"}` /
 *   `{"type":"bearer","token":"..."}` / `{"type":"basic","username":"...","password":"..."}`
 *   / `{"type":"apiKey","position":"header"|"query"|"cookie","key":"...","value":"..."}`
 * - 工作空间级：同上但无 inherit 项；列 NULL＝未配置（等价无认证）。
 *
 * 字段值形态：字面量或 `{{变量}}` 引用（不校验，原样透传；变量域点亮后生效）。
 *
 * 解析容错：读模式失败回落 fallback（请求级＝inherit、工作空间级＝none），
 * 只影响呈现不改写用户数据——只有用户显式操作才序列化回写。
 */

/** API Key 注入位置（三选；与 Rust ApiKeyPosition 一一对应） */
export type ApiKeyPosition = 'header' | 'query' | 'cookie'

/** 认证草稿（判别联合；与 Rust AuthConfig 的七类型一一对应） */
export type AuthDraft =
  | { type: 'inherit' }
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apiKey'; position: ApiKeyPosition; key: string; value: string }

/** 类型选择器的稳定值：apiKey 三位置各占一项（position 由所选类型决定） */
export type AuthTypeId =
  'inherit' | 'none' | 'bearer' | 'basic' | 'apiKey-header' | 'apiKey-query' | 'apiKey-cookie'

/** 请求级默认：继承上级（读模式回落的 fallback） */
export const AUTH_INHERIT: AuthDraft = { type: 'inherit' }

/** 工作空间级默认：不使用（读模式回落的 fallback；无「继承上级」项） */
export const AUTH_NONE: AuthDraft = { type: 'none' }

/**
 * 解析认证配置 JSON 为草稿。null / 空白 / 非法 JSON / 形态不符（未知类型、
 * 字段缺失或非字符串）均回落 fallback——呈现层永不因脏数据崩溃，也不改写。
 */
export function parseAuthDraft(json: string | null, fallback: AuthDraft = AUTH_INHERIT): AuthDraft {
  // 宽松空判定：null / 空白 / 缺字段(undefined) 一律回落（脏 DTO 不致命）
  if (!json || json.trim() === '') return fallback
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return fallback
  }
  if (typeof parsed !== 'object' || parsed === null) return fallback
  const record = parsed as Record<string, unknown>
  const str = (key: string): string | null => {
    const value = record[key]
    return typeof value === 'string' ? value : null
  }
  switch (record.type) {
    case 'inherit':
      return { type: 'inherit' }
    case 'none':
      return { type: 'none' }
    case 'bearer': {
      const token = str('token')
      return token === null ? fallback : { type: 'bearer', token }
    }
    case 'basic': {
      const username = str('username')
      const password = str('password')
      return username === null || password === null
        ? fallback
        : { type: 'basic', username, password }
    }
    case 'apiKey': {
      const key = str('key')
      const value = str('value')
      const position = record.position
      if (
        key === null ||
        value === null ||
        (position !== 'header' && position !== 'query' && position !== 'cookie')
      ) {
        return fallback
      }
      return { type: 'apiKey', position, key, value }
    }
    default:
      return fallback
  }
}

/** 序列化草稿为存储 JSON（键序与契约一致：type 在前，字段随后） */
export function serializeAuthDraft(draft: AuthDraft): string {
  return JSON.stringify(draft)
}

/** 草稿 → 类型选择器值（apiKey 按 position 拆为三选一） */
export function authTypeIdOf(draft: AuthDraft): AuthTypeId {
  if (draft.type === 'apiKey') return `apiKey-${draft.position}`
  return draft.type
}

/**
 * 类型切换的新草稿：同族字段值随选保留（如 bearer 重选不丢已填 token、
 * apiKey 换注入位置保留 key/value），跨族切换给空字段待输入。
 */
export function switchAuthType(current: AuthDraft, target: AuthTypeId): AuthDraft {
  switch (target) {
    case 'inherit':
      return { type: 'inherit' }
    case 'none':
      return { type: 'none' }
    case 'bearer':
      return { type: 'bearer', token: current.type === 'bearer' ? current.token : '' }
    case 'basic':
      return {
        type: 'basic',
        username: current.type === 'basic' ? current.username : '',
        password: current.type === 'basic' ? current.password : '',
      }
    case 'apiKey-header':
    case 'apiKey-query':
    case 'apiKey-cookie': {
      const position = target.slice('apiKey-'.length) as ApiKeyPosition
      return {
        type: 'apiKey',
        position,
        key: current.type === 'apiKey' ? current.key : '',
        value: current.type === 'apiKey' ? current.value : '',
      }
    }
  }
}
