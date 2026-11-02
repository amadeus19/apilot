import { describe, expect, it } from 'vitest'

import {
  clampSuggestLeft,
  clampTooltipLeft,
  createInputTextMeasurer,
  pickReferenceAtX,
  SUGGEST_OVERLAY_MARGIN,
  TOOLTIP_HALF_WIDTH,
} from '../variable-hover'
import { findVariableReferences } from '../variable-suggest-match'

/** 等宽桩量宽器：每字符 10px（命中区间手工可算） */
const measure10 = (text: string) => text.length * 10

describe('findVariableReferences（闭合引用提取，镜像后端 resolve_value 扫描口径）', () => {
  it('单个引用：返回整段模板偏移与 trim 后键名', () => {
    expect(findVariableReferences('{{token}}')).toEqual([{ start: 0, end: 9, key: 'token' }])
  })

  it('键名 trim：{{ id }} 等价 {{id}}', () => {
    expect(findVariableReferences('{{ id }}')).toEqual([{ start: 0, end: 8, key: 'id' }])
  })

  it('多个引用按出现序排列，字面段偏移正确', () => {
    expect(findVariableReferences('https://{{host}}/api/{{id}}')).toEqual([
      { start: 8, end: 16, key: 'host' },
      { start: 21, end: 27, key: 'id' },
    ])
  })

  it('空名不产引用；未闭合余段视字面量', () => {
    expect(findVariableReferences('{{}}')).toEqual([])
    expect(findVariableReferences('{{unclosed')).toEqual([])
    expect(findVariableReferences('a {{ok}} {{ b')).toEqual([{ start: 2, end: 8, key: 'ok' }])
  })

  it('{{{ 连击：键含花括号仍成引用（后端同样按未命中消费）', () => {
    expect(findVariableReferences('{{{a}}')).toEqual([{ start: 0, end: 6, key: '{a' }])
  })

  it('相邻引用逐段切开；}} 单独出现无引用', () => {
    expect(findVariableReferences('{{a}}{{b}}')).toEqual([
      { start: 0, end: 5, key: 'a' },
      { start: 5, end: 10, key: 'b' },
    ])
    expect(findVariableReferences('}}')).toEqual([])
  })
})

describe('pickReferenceAtX（指针命中片段水平区间）', () => {
  const refs = findVariableReferences('pre{{a}}post')

  it('命中：返回片段下标与片段中心锚点', () => {
    // originX=100：字面 pre 宽 30 → 片段区间 [130, 180)
    expect(pickReferenceAtX('pre{{a}}post', refs, measure10, 100, 130)).toEqual({
      index: 0,
      anchorX: 155,
    })
    expect(pickReferenceAtX('pre{{a}}post', refs, measure10, 100, 179)).toEqual({
      index: 0,
      anchorX: 155,
    })
  })

  it('区间外（含右开边界）不命中', () => {
    expect(pickReferenceAtX('pre{{a}}post', refs, measure10, 100, 129)).toBeNull()
    expect(pickReferenceAtX('pre{{a}}post', refs, measure10, 100, 180)).toBeNull()
  })

  it('多引用逐段定位', () => {
    const two = findVariableReferences('{{a}}{{b}}')
    expect(pickReferenceAtX('{{a}}{{b}}', two, measure10, 0, 49)).toEqual({ index: 0, anchorX: 25 })
    expect(pickReferenceAtX('{{a}}{{b}}', two, measure10, 0, 50)).toEqual({ index: 1, anchorX: 75 })
  })
})

describe('clampTooltipLeft（提示水平钳制）', () => {
  it('视口内随锚点，越界收边（两侧留 8px）', () => {
    expect(clampTooltipLeft(500, 1024)).toBe(500)
    expect(clampTooltipLeft(40, 1024)).toBe(TOOLTIP_HALF_WIDTH + 8)
    expect(clampTooltipLeft(2000, 1024)).toBe(1024 - TOOLTIP_HALF_WIDTH - 8)
  })

  it('极窄视口钳到最小边不越界', () => {
    expect(clampTooltipLeft(500, 300)).toBe(TOOLTIP_HALF_WIDTH + 8)
  })
})

describe('clampSuggestLeft（联想浮层左缘钳制）', () => {
  it('视口内随输入框左缘；右缘将溢出时按最小宽度收边（右侧留 8px）', () => {
    expect(clampSuggestLeft(100, 1024, 200)).toBe(100)
    // left 1000 + minWidth 200 溢出 176px → 收到 1024-200-8
    expect(clampSuggestLeft(1000, 1024, 200)).toBe(1024 - 200 - SUGGEST_OVERLAY_MARGIN)
    expect(clampSuggestLeft(2000, 1024, 200)).toBe(1024 - 200 - SUGGEST_OVERLAY_MARGIN)
  })

  it('左缘越界与极窄视口都钳到边距，不越出视口', () => {
    expect(clampSuggestLeft(0, 1024, 200)).toBe(SUGGEST_OVERLAY_MARGIN)
    // 视口 300 容得下最小宽 200：右缘收边到 300-200-8
    expect(clampSuggestLeft(500, 300, 200)).toBe(92)
    // 视口容不下最小宽（210 < 200+8+8）：贴左边距，不追右缘
    expect(clampSuggestLeft(500, 210, 200)).toBe(SUGGEST_OVERLAY_MARGIN)
  })
})

describe('createInputTextMeasurer（jsdom 无 2d 上下文）', () => {
  it('canvas 不可用时返回 null（宿主侧不启用 hover）', () => {
    const el = document.createElement('input')
    expect(createInputTextMeasurer(el)).toBeNull()
  })
})
