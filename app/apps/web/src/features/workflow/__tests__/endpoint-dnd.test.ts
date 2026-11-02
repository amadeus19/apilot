import { describe, expect, it } from 'vitest'

import {
  bindEndpointToNode,
  decodeEndpointDragPayload,
  encodeEndpointDragPayload,
  isBindableDropTarget,
  splitStableKey,
  type EndpointDragPayload,
} from '../endpoint-dnd'
import type { WorkflowNode } from '../workflow-model'

/** 拖出载荷样例（接口树行现成数据） */
function payload(overrides: Partial<EndpointDragPayload> = {}): EndpointDragPayload {
  return {
    serviceId: 's1',
    key: 'POST /api/auth/login',
    method: 'POST',
    pathTemplate: '/api/auth/login',
    name: '登录',
    ...overrides,
  }
}

/** 请求节点样例（占位起步，覆写已配置） */
function placeholderNode(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id: 'n1',
    name: '',
    position: { x: 0, y: 0 },
    config: {
      type: 'request',
      endpointKey: null,
      query: [{ name: 'verbose', value: 'true' }],
      pathParams: [],
      body: null,
      timeoutMs: null,
    },
    ...overrides,
  }
}

describe('endpoint-dnd：拖放载荷编解码', () => {
  it('encode → decode 往返零丢失', () => {
    const raw = encodeEndpointDragPayload(payload())
    expect(decodeEndpointDragPayload(raw)).toEqual(payload())
  })

  it('非法 JSON / 非对象 / 缺字段 / 类型漂移均拒收（null）', () => {
    expect(decodeEndpointDragPayload('{broken')).toBeNull()
    expect(decodeEndpointDragPayload('"just a string"')).toBeNull()
    expect(decodeEndpointDragPayload('{"serviceId":"s1"}')).toBeNull()
    expect(decodeEndpointDragPayload(JSON.stringify({ ...payload(), key: 42 }))).toBeNull()
  })
})

describe('endpoint-dnd：稳定键拆分', () => {
  it('标准稳定键 → 方法＋路径', () => {
    expect(splitStableKey('GET /users/{id}')).toEqual({ method: 'GET', path: '/users/{id}' })
  })

  it('方法大小写敏感（小写不识别）＋ UUID 手工键不识别', () => {
    expect(splitStableKey('get /users')).toBeNull()
    expect(splitStableKey('550e8400-e29b-41d4-a716-446655440000')).toBeNull()
    expect(splitStableKey('GET')).toBeNull()
  })
})

describe('endpoint-dnd：绑定动作', () => {
  it('占位绑定：endpointKey 填充，名称空缺以接口标题兜底，覆写播种为空', () => {
    const bound = bindEndpointToNode(placeholderNode(), payload())
    expect(bound.config).toEqual({
      type: 'request',
      endpointKey: 'POST /api/auth/login',
      query: [],
      pathParams: [],
      body: null,
      timeoutMs: null,
    })
    expect(bound.name).toBe('登录')
    expect(bound.id).toBe('n1')
  })

  it('已命名节点重接（重绑＝新配置播种）：引用替换、名称与超时保留、覆写清空', () => {
    const named = placeholderNode({
      name: '我的登录步骤',
      config: {
        type: 'request',
        endpointKey: 'POST /api/auth/login',
        query: [{ name: 'verbose', value: 'true' }],
        pathParams: [{ name: 'id', value: '1' }],
        body: '{"a":1}',
        timeoutMs: 5000,
      },
    })
    const rebound = bindEndpointToNode(named, payload({ key: 'GET /healthz', name: '健康检查' }))
    expect(rebound.name).toBe('我的登录步骤')
    expect(rebound.config).toEqual({
      type: 'request',
      endpointKey: 'GET /healthz',
      query: [],
      pathParams: [],
      body: null,
      timeoutMs: 5000,
    })
  })

  it('同键重复落点不重置（无重绑语义，节点原样）', () => {
    const bound = placeholderNode({
      config: {
        type: 'request',
        endpointKey: 'POST /api/auth/login',
        query: [{ name: 'verbose', value: 'true' }],
        pathParams: [],
        body: null,
        timeoutMs: null,
      },
    })
    expect(bindEndpointToNode(bound, payload())).toBe(bound)
  })

  it('非请求节点原样返回（不误改）', () => {
    const start = placeholderNode({
      config: { type: 'start' },
    }) as WorkflowNode
    expect(bindEndpointToNode(start, payload())).toBe(start)
  })
})

describe('endpoint-dnd：drop 落点路由', () => {
  const boundRequest = placeholderNode({
    config: {
      type: 'request',
      endpointKey: 'POST /api/auth/login',
      query: [],
      pathParams: [],
      body: null,
      timeoutMs: null,
    },
  })

  it('待绑定占位（endpointKey null）开放绑定', () => {
    expect(isBindableDropTarget(placeholderNode().config, new Set(), 'n1')).toBe(true)
  })

  it('失效引用节点开放重接：endpointKey 非空但节点在校验失效集内', () => {
    expect(isBindableDropTarget(boundRequest.config, new Set(['n1']), 'n1')).toBe(true)
  })

  it('健康已绑定节点不响应：不在失效集内时落点回退画布空白语义', () => {
    expect(isBindableDropTarget(boundRequest.config, new Set(['other']), 'n1')).toBe(false)
  })

  it('非 request 节点不响应（如延时节点）', () => {
    expect(isBindableDropTarget({ type: 'delay', durationMs: 100 }, new Set(['n1']), 'n1')).toBe(
      false,
    )
  })
})

describe('endpoint-dnd：覆写序列化（serde 形态钉住）', () => {
  it('含覆写的请求节点 JSON 往返相等', () => {
    const node = placeholderNode({
      config: {
        type: 'request',
        endpointKey: 'POST /api/auth/login',
        query: [{ name: 'verbose', value: 'true' }],
        pathParams: [{ name: 'id', value: '42' }],
        body: '{"user":"a"}',
        timeoutMs: 30000,
      },
    })
    const roundtrip = JSON.parse(JSON.stringify(node)) as WorkflowNode
    expect(roundtrip).toEqual(node)
    // 序列化面只含稳定键＋覆写：无方法 / 路径快照字段
    const serialized = JSON.stringify(node.config)
    expect(serialized).toContain('"endpointKey":"POST /api/auth/login"')
    expect(serialized).toContain('"timeoutMs":30000')
    expect(serialized).not.toContain('pathTemplate')
    expect(serialized).not.toContain('"method"')
  })
})
