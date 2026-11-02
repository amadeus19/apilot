import { describe, expect, it } from 'vitest'

import {
  AUTH_INHERIT,
  AUTH_NONE,
  authTypeIdOf,
  parseAuthDraft,
  serializeAuthDraft,
  switchAuthType,
} from '../auth-config'

/** 七类型的完整草稿样本（覆盖判别联合每一支） */
const SAMPLES = {
  inherit: { type: 'inherit' },
  none: { type: 'none' },
  bearer: { type: 'bearer', token: 'tk' },
  basic: { type: 'basic', username: 'u', password: 'p' },
  apiKeyHeader: { type: 'apiKey', position: 'header', key: 'X-Key', value: 'v' },
  apiKeyQuery: { type: 'apiKey', position: 'query', key: 'api_key', value: 'v' },
  apiKeyCookie: { type: 'apiKey', position: 'cookie', key: 'sid', value: 'v' },
} as const

describe('认证配置纯函数', () => {
  it('七类型序列化形态与契约一致（type 在前，字段随后）', () => {
    expect(serializeAuthDraft(SAMPLES.inherit)).toBe('{"type":"inherit"}')
    expect(serializeAuthDraft(SAMPLES.none)).toBe('{"type":"none"}')
    expect(serializeAuthDraft(SAMPLES.bearer)).toBe('{"type":"bearer","token":"tk"}')
    expect(serializeAuthDraft(SAMPLES.basic)).toBe('{"type":"basic","username":"u","password":"p"}')
    expect(serializeAuthDraft(SAMPLES.apiKeyHeader)).toBe(
      '{"type":"apiKey","position":"header","key":"X-Key","value":"v"}',
    )
    expect(serializeAuthDraft(SAMPLES.apiKeyQuery)).toBe(
      '{"type":"apiKey","position":"query","key":"api_key","value":"v"}',
    )
    expect(serializeAuthDraft(SAMPLES.apiKeyCookie)).toBe(
      '{"type":"apiKey","position":"cookie","key":"sid","value":"v"}',
    )
  })

  it('解析 / 序列化往返恒等还原（七类型全覆盖）', () => {
    for (const sample of Object.values(SAMPLES)) {
      expect(parseAuthDraft(serializeAuthDraft(sample))).toEqual(sample)
    }
  })

  it('null / 空白 / 非法 JSON 回落 fallback（默认继承；不改写用户数据）', () => {
    expect(parseAuthDraft(null)).toEqual(AUTH_INHERIT)
    expect(parseAuthDraft('')).toEqual(AUTH_INHERIT)
    expect(parseAuthDraft('   ')).toEqual(AUTH_INHERIT)
    expect(parseAuthDraft('not json')).toEqual(AUTH_INHERIT)
    expect(parseAuthDraft('{bad')).toEqual(AUTH_INHERIT)
    // 工作空间级 fallback：回落「不使用」
    expect(parseAuthDraft(null, AUTH_NONE)).toEqual(AUTH_NONE)
    expect(parseAuthDraft('oops', AUTH_NONE)).toEqual(AUTH_NONE)
  })

  it('形态不符回落 fallback：非对象 / 未知类型 / 字段缺失或非字符串 / 非法位置', () => {
    const bad = [
      '[]',
      '"str"',
      '123',
      '{"type":"oauth2"}',
      '{"type":"bearer"}',
      '{"type":"bearer","token":1}',
      '{"type":"basic","username":"u"}',
      '{"type":"apiKey","position":"body","key":"k","value":"v"}',
      '{"type":"apiKey","position":"header","key":"k"}',
    ]
    for (const raw of bad) {
      expect(parseAuthDraft(raw), `应回落 inherit: ${raw}`).toEqual(AUTH_INHERIT)
    }
  })

  it('{{变量}} 引用形态原样透传（不校验合法性）', () => {
    const json = '{"type":"bearer","token":"{{secret.token}}"}'
    expect(parseAuthDraft(json)).toEqual({ type: 'bearer', token: '{{secret.token}}' })
  })

  it('authTypeIdOf：apiKey 按位置拆为三选一，其余原样', () => {
    expect(authTypeIdOf(SAMPLES.inherit)).toBe('inherit')
    expect(authTypeIdOf(SAMPLES.none)).toBe('none')
    expect(authTypeIdOf(SAMPLES.bearer)).toBe('bearer')
    expect(authTypeIdOf(SAMPLES.basic)).toBe('basic')
    expect(authTypeIdOf(SAMPLES.apiKeyHeader)).toBe('apiKey-header')
    expect(authTypeIdOf(SAMPLES.apiKeyQuery)).toBe('apiKey-query')
    expect(authTypeIdOf(SAMPLES.apiKeyCookie)).toBe('apiKey-cookie')
  })

  it('switchAuthType：同族字段值随选保留，跨族切换给空字段', () => {
    // bearer 重选保留 token；换 basic 后 username/password 为空
    expect(switchAuthType(SAMPLES.bearer, 'bearer')).toEqual(SAMPLES.bearer)
    expect(switchAuthType(SAMPLES.bearer, 'basic')).toEqual({
      type: 'basic',
      username: '',
      password: '',
    })
    // apiKey 换注入位置保留 key/value
    expect(switchAuthType(SAMPLES.apiKeyHeader, 'apiKey-query')).toEqual({
      type: 'apiKey',
      position: 'query',
      key: 'X-Key',
      value: 'v',
    })
    // basic → apiKey 保留逻辑不跨族
    expect(switchAuthType(SAMPLES.basic, 'apiKey-cookie')).toEqual({
      type: 'apiKey',
      position: 'cookie',
      key: '',
      value: '',
    })
    // 无字段类型切换
    expect(switchAuthType(SAMPLES.bearer, 'inherit')).toEqual({ type: 'inherit' })
    expect(switchAuthType(SAMPLES.bearer, 'none')).toEqual({ type: 'none' })
  })
})
