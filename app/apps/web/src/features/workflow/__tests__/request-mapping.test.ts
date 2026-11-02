import { describe, expect, it } from 'vitest'

import {
  collectMappingCandidates,
  displayPathRows,
  displayQueryRows,
  extractUpstreamRequestId,
  prefilledBodyText,
  upsertOverrideValue,
  upstreamExtractNodeIds,
} from '../canvas/request-mapping'
import {
  emptyWriteback,
  type OverrideRow,
  type WorkflowGraph,
  type WorkflowNode,
} from '../workflow-model'

/**
 * 入参映射候选收集与预填行投影（编辑期纯派生）：直接上游提取节点的一跳
 * 遍历、逐规则裸名候选（顶层＋对象 / 数组产物经实测根的深层展开与无实测
 * 数据回落，非直接上游不进候选）；query 定义参数行 ∪ 自由行的显示投影、
 * 路径模板参数行投影、覆写行 upsert 落库通道与 body 预填文本派生。
 */

function extractNode(
  id: string,
  name: string,
  productName: string,
  source: 'jsonPath' | 'header' | 'statusCode' = 'jsonPath',
  path = '',
): WorkflowNode {
  return {
    id,
    name,
    position: { x: 0, y: 0 },
    config: {
      type: 'extract',
      source,
      rules: [{ path, name: productName }],
      writeback: emptyWriteback(),
    },
  }
}

function requestNode(id: string, name: string): WorkflowNode {
  return {
    id,
    name,
    position: { x: 0, y: 0 },
    config: {
      type: 'request',
      endpointKey: 'svc:GET /users',
      query: [],
      pathParams: [],
      body: null,
      timeoutMs: null,
    },
  }
}

function graphOf(nodes: WorkflowNode[], edges: [string, string][]): WorkflowGraph {
  return {
    schemaVersion: 3,
    nodes,
    edges: edges.map(([source, target], index) => ({
      id: `e${index}`,
      source,
      target,
      label: null,
    })),
  }
}

describe('request-mapping：直接上游一跳遍历', () => {
  it('入边 source 为提取节点才入候选；隔跳上游不计', () => {
    const graph = graphOf(
      [
        extractNode('ext1', '登录', 'token', 'jsonPath', '$.token'),
        requestNode('req1', '查询'),
        requestNode('req2', '下游'),
      ],
      [
        ['ext1', 'req1'],
        ['req1', 'req2'],
      ],
    )
    expect(upstreamExtractNodeIds(graph, 'req1')).toEqual(['ext1'])
    // req2 的直接上游是请求节点，提取节点隔了一跳
    expect(upstreamExtractNodeIds(graph, 'req2')).toEqual([])
    expect(collectMappingCandidates(graph, 'req2', new Map())).toEqual([])
  })

  it('多条入边指向同一提取节点时去重', () => {
    const graph = graphOf(
      [extractNode('ext1', '登录', ''), requestNode('req1', '查询')],
      [
        ['ext1', 'req1'],
        ['ext1', 'req1'],
      ],
    )
    expect(upstreamExtractNodeIds(graph, 'req1')).toEqual(['ext1'])
  })

  it('提取节点的上游请求节点定位（实测响应体锚）', () => {
    const graph = graphOf(
      [
        requestNode('req0', '登录接口'),
        extractNode('ext1', '登录', ''),
        requestNode('req1', '查询'),
      ],
      [
        ['req0', 'ext1'],
        ['ext1', 'req1'],
      ],
    )
    expect(extractUpstreamRequestId(graph, 'ext1')).toBe('req0')
    expect(extractUpstreamRequestId(graph, 'req1')).toBeNull()
  })
})

describe('request-mapping：候选收集（裸键展平）', () => {
  it('多个上游提取节点的产物都进候选（产物名裸键，无节点名前缀）', () => {
    const graph = graphOf(
      [
        extractNode('ext1', '登录', 'token', 'jsonPath', '$.token'),
        extractNode('ext2', '用户信息', 'traceId', 'header', 'X-Trace'),
        requestNode('req1', '查询'),
      ],
      [
        ['ext1', 'req1'],
        ['ext2', 'req1'],
      ],
    )
    expect(collectMappingCandidates(graph, 'req1', new Map())).toEqual(['token', 'traceId'])
  })

  it('产物名为空不出候选；提取节点书写名不再参与候选（未命名节点的产物照出）', () => {
    const graph = graphOf(
      [
        extractNode('ext1', '', 'token', 'jsonPath', '$.token'),
        extractNode('ext2', '登录', ''),
        requestNode('req1', '查询'),
      ],
      [
        ['ext1', 'req1'],
        ['ext2', 'req1'],
      ],
    )
    expect(collectMappingCandidates(graph, 'req1', new Map())).toEqual(['token'])
  })

  it('非直接上游提取节点的产物不出候选（一跳口径）', () => {
    // ext1 隔了一跳（ext1 → req1 → req2），req2 候选只含直接上游 ext2 的产物
    const graph = graphOf(
      [
        extractNode('ext1', '登录', 'token', 'jsonPath', '$.token'),
        extractNode('ext2', '配置', 'flag', 'jsonPath', '$.flag'),
        requestNode('req1', '中转'),
        requestNode('req2', '下游'),
      ],
      [
        ['ext1', 'req1'],
        ['req1', 'req2'],
        ['ext2', 'req2'],
      ],
    )
    expect(collectMappingCandidates(graph, 'req2', new Map())).toEqual(['flag'])
  })

  it('多规则逐条出候选：各自顶层与深层展开按规则序排列', () => {
    const graph = graphOf(
      [
        requestNode('req0', '登录接口'),
        {
          id: 'ext1',
          name: '登录',
          position: { x: 0, y: 0 },
          config: {
            type: 'extract',
            source: 'jsonPath',
            rules: [
              { path: '$.data', name: 'data' },
              { path: '$.traceId', name: 'traceId' },
            ],
            writeback: emptyWriteback(),
          },
        },
        requestNode('req1', '查询'),
      ],
      [
        ['req0', 'ext1'],
        ['ext1', 'req1'],
      ],
    )
    // 首规则对象产物展开键名，次规则标量产物只出顶层
    const observedRoots = new Map<string, unknown | null>([
      ['ext1', { data: { token: '***', exp: 9 }, traceId: '***' }],
    ])
    expect(collectMappingCandidates(graph, 'req1', observedRoots)).toEqual([
      'data',
      'data.token',
      'data.exp',
      'traceId',
    ])
  })
})

describe('request-mapping：深层展开与无实测回落', () => {
  const upstream = graphOf(
    [
      requestNode('req0', '登录接口'),
      extractNode('ext1', '登录', 'data', 'jsonPath', '$.data'),
      requestNode('req1', '查询'),
    ],
    [
      ['req0', 'ext1'],
      ['ext1', 'req1'],
    ],
  )

  it('对象产物展开键名、数组产物取首元素展开（data.token 等深层引用）', () => {
    // 实测根＝上游请求节点的掩码响应体解析根（产物路径相对响应体）
    const observedRoots = new Map<string, unknown | null>([
      ['ext1', { data: { token: '***', exp: 9 } }],
    ])
    expect(collectMappingCandidates(upstream, 'req1', observedRoots)).toEqual([
      'data',
      'data.token',
      'data.exp',
    ])
  })

  it('无执行记录（根缺失或 null）只出顶层候选；路径未命中同样回落', () => {
    expect(collectMappingCandidates(upstream, 'req1', new Map())).toEqual(['data'])
    const emptyRoot = new Map<string, unknown | null>([['ext1', null]])
    expect(collectMappingCandidates(upstream, 'req1', emptyRoot)).toEqual(
      collectMappingCandidates(upstream, 'req1', new Map()),
    )
    const missRoot = new Map<string, unknown | null>([['ext1', { other: 1 }]])
    expect(collectMappingCandidates(upstream, 'req1', missRoot)).toEqual(
      collectMappingCandidates(upstream, 'req1', new Map()),
    )
  })
})

describe('request-mapping：query 显示行投影（定义参数预填）', () => {
  it('定义参数行在前（定义序），值取落库同名行；定义外自由行按落库序缀后', () => {
    const stored: OverrideRow[] = [
      { name: 'free', value: '1' },
      { name: 'page', value: '2' },
    ]
    expect(
      displayQueryRows(stored, [
        { name: 'page', required: true },
        { name: 'size', required: false },
      ]),
    ).toEqual([
      { name: 'page', required: true, value: '2', defined: true, rowIndex: -1 },
      { name: 'size', required: false, value: '', defined: true, rowIndex: -1 },
      { name: 'free', required: false, value: '1', defined: false, rowIndex: 0 },
    ])
  })

  it('无定义参数时显示行＝落库自由行原样投影', () => {
    const stored: OverrideRow[] = [{ name: 'q', value: '' }]
    expect(displayQueryRows(stored, [])).toEqual([
      { name: 'q', required: false, value: '', defined: false, rowIndex: 0 },
    ])
  })
})

describe('request-mapping：path 显示行投影', () => {
  it('模板参数逐行投影，值取落库同名行（无＝空＝不填充）', () => {
    const stored: OverrideRow[] = [{ name: 'id', value: '42' }]
    expect(displayPathRows(stored, ['id', 'org'])).toEqual([
      { name: 'id', value: '42' },
      { name: 'org', value: '' },
    ])
  })

  it('无模板参数＝空行集（调用方整区不渲染）', () => {
    expect(displayPathRows([{ name: 'id', value: '1' }], [])).toEqual([])
  })
})

describe('request-mapping：覆写行 upsert 落库通道', () => {
  const stored: OverrideRow[] = [
    { name: 'page', value: '2' },
    { name: 'free', value: '1' },
  ]

  it('值非空＝同名行改值（既有行原位、其余原样）', () => {
    expect(upsertOverrideValue(stored, 'page', '3')).toEqual([
      { name: 'page', value: '3' },
      { name: 'free', value: '1' },
    ])
  })

  it('值非空且无同名行＝新行缀尾', () => {
    expect(upsertOverrideValue(stored, 'size', '10')).toEqual([
      ...stored,
      { name: 'size', value: '10' },
    ])
  })

  it('值空白＝移除同名行（行值空＝不覆写该参数的落库形态）；未命中原样', () => {
    expect(upsertOverrideValue(stored, 'page', '  ')).toEqual([{ name: 'free', value: '1' }])
    expect(upsertOverrideValue(stored, 'gone', '')).toEqual(stored)
  })
})

describe('request-mapping：body 预填文本派生', () => {
  it('用户数据信封文本系取 text；旧纯文本原样', () => {
    expect(prefilledBodyText('{"kind":"json","text":"{\\"a\\":1}"}', null)).toBe('{"a":1}')
    expect(prefilledBodyText('{"a":1}', null)).toBe('{"a":1}')
  })

  it('form 系行载体与 none 静默降级为不预填（空串，不弹错）', () => {
    expect(prefilledBodyText('{"kind":"form-data","rows":[{"name":"a","value":"1"}]}', null)).toBe(
      '',
    )
    expect(prefilledBodyText('{"kind":"none"}', null)).toBe('')
  })

  it('无用户数据 body 时回落定义侧 example 序列化文本；都无＝空串', () => {
    expect(prefilledBodyText(null, { id: 1 })).toBe('{\n  "id": 1\n}')
    expect(prefilledBodyText(null, null)).toBe('')
    expect(prefilledBodyText('', undefined)).toBe('')
  })
})
