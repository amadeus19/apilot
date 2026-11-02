import { describe, expect, it } from 'vitest'

import { draftPromotionPlan } from '../draft-promotion'
import type { EndpointDraftData } from '../draft.store'

const DATA: EndpointDraftData = {
  method: 'POST',
  pathTemplate: 'https://other.test/v1/orders',
  paramsJson: '[{"name":"verbose","value":"true"}]',
  headersJson: '[{"name":"authorization","value":"Bearer t"}]',
  body: '{"kind":"json","text":"{\\"a\\":1}"}',
  bodyTruncated: false,
  sensitiveHeaderNames: [],
  sourceServiceId: 's1',
}

describe('draft-promotion：转正落库计划（纯函数）', () => {
  it('当前服务下未分类新手工接口：实体五列＋用户数据整包透传', () => {
    const plan = draftPromotionPlan(DATA, 's1')
    expect(plan.endpoint).toEqual({
      serviceId: 's1',
      method: 'POST',
      pathTemplate: 'https://other.test/v1/orders',
      title: 'POST https://other.test/v1/orders',
      categoryId: null,
    })
    expect(plan.userData).toEqual({
      body: DATA.body,
      params: DATA.paramsJson,
      headers: DATA.headersJson,
      // 快照无意图面：超时与认证不随草稿，转正后由接口编辑器显式配置
      timeoutSeconds: null,
      auth: null,
    })
  })

  it('标题＝`方法 + 模板` 超限截断（80 字符）', () => {
    const long = { ...DATA, pathTemplate: `https://x.test/${'a'.repeat(200)}` }
    const plan = draftPromotionPlan(long, 's1')
    expect(plan.endpoint.title.length).toBeLessThanOrEqual(80)
  })
})
