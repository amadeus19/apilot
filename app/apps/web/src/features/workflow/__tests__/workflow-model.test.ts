import { describe, expect, it } from 'vitest'

import {
  GRAPH_SCHEMA_VERSION,
  emptyGraph,
  isWorkflowNodeKind,
  pathTemplateParams,
  tailKeyOfPath,
} from '../workflow-model'

/**
 * 领域模型镜像测试：路径尾键（产物名缺省建议值；历史图读侧归一在 Rust
 * serde 桥接，前端只接收单来源形态）、路径模板参数段（与 Rust 引擎占位
 * 识别同口径）、kind 词表面（存变量已自词表移除）。
 */

describe('workflow-model：路径尾键（产物名缺省建议值）', () => {
  it('点切尾段、引号属性取引号内、数组下标取段前属性名', () => {
    expect(tailKeyOfPath('$.data.token')).toBe('token')
    expect(tailKeyOfPath('$.data')).toBe('data')
    expect(tailKeyOfPath("$['access-token']")).toBe('access-token')
    expect(tailKeyOfPath('$.list[0]')).toBe('list')
    expect(tailKeyOfPath('X-Token')).toBe('X-Token')
    expect(tailKeyOfPath('$')).toBe('')
    expect(tailKeyOfPath('  ')).toBe('')
  })
})

describe('workflow-model：路径模板参数段（{param} 识别）', () => {
  it('模板段逐个产出；无模板段＝空集', () => {
    expect(pathTemplateParams('/users/{id}/posts/{postId}')).toEqual(['id', 'postId'])
    expect(pathTemplateParams('/users')).toEqual([])
  })

  it('{{变量}} 双括号是变量引用占位，跳过不产出；未闭合 `{` 起余段为字面', () => {
    expect(pathTemplateParams('/a/{{var}}/b/{id}')).toEqual(['id'])
    expect(pathTemplateParams('/a/{unclosed')).toEqual([])
  })
})

describe('workflow-model：kind 词表（schema v3 面）', () => {
  it('空图携带当前 schema 版本（v3）', () => {
    expect(GRAPH_SCHEMA_VERSION).toBe(3)
    expect(emptyGraph().schemaVersion).toBe(3)
  })

  it('存变量已自 kind 词表移除：白名单守卫拒绝该值', () => {
    expect(isWorkflowNodeKind('extract')).toBe(true)
    expect(isWorkflowNodeKind('setVariable')).toBe(false)
    expect(isWorkflowNodeKind('mystery')).toBe(false)
  })
})
