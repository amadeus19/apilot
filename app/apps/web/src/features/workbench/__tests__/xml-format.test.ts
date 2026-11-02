import { describe, expect, it } from 'vitest'

import { formatXml } from '../xml-format'

/** 缩进档位（两空格，与 JSON.stringify(…, 2) 同档） */
const ind = (depth: number): string => '  '.repeat(depth)

describe('formatXml 缩进规整', () => {
  it('嵌套标签按深度缩进，每个结构节点独占一行', () => {
    expect(formatXml('<root><a><b>1</b></a></root>')).toBe(
      `<root>\n${ind(1)}<a>\n${ind(2)}<b>1</b>\n${ind(1)}</a>\n</root>`,
    )
  })

  it('XML 声明与处理指令原样保留在独立行（不缩进）', () => {
    expect(formatXml('<?xml version="1.0" encoding="UTF-8"?><root/>')).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<root/>',
    )
    expect(formatXml('<?php echo 1; ?><root/>')).toBe('<?php echo 1; ?>\n<root/>')
  })

  it('DOCTYPE 含内部子集时整体原样保留', () => {
    const doctype = '<!DOCTYPE note [<!ENTITY n "nano">]>'
    expect(formatXml(`${doctype}<note>&n;</note>`)).toBe(`${doctype}\n<note>&n;</note>`)
  })

  it('注释原样保留在所在深度行', () => {
    expect(formatXml('<root><!-- 头注 --><a/></root>')).toBe(
      `<root>\n${ind(1)}<!-- 头注 -->\n${ind(1)}<a/>\n</root>`,
    )
  })

  it('CDATA 段原样保留（内含未转义的 < 与换行不动）', () => {
    const cdata = '<![CDATA[ if (a < b) { } ]]>'
    expect(formatXml(`<root>${cdata}</root>`)).toBe(`<root>\n${ind(1)}${cdata}\n</root>`)
  })

  it('属性值引号内的 < > 不破坏结构，标签原文切片保留', () => {
    const tag = '<b attr="x<y" cond=\'a>b\'>t</b>'
    expect(formatXml(`<root>${tag}</root>`)).toBe(`<root>\n${ind(1)}${tag}\n</root>`)
  })

  it('自闭合标签原样保留并占独立行', () => {
    expect(formatXml('<root><a/></root>')).toBe(`<root>\n${ind(1)}<a/>\n</root>`)
  })

  it('空元素与短文本叶子内联为一行', () => {
    expect(formatXml('<root><a></a></root>')).toBe(`<root>\n${ind(1)}<a></a>\n</root>`)
    expect(formatXml('<root><a>  </a></root>')).toBe(`<root>\n${ind(1)}<a></a>\n</root>`)
    expect(formatXml('<root><a>x</a></root>')).toBe(`<root>\n${ind(1)}<a>x</a>\n</root>`)
    expect(formatXml('<root><a>  x  </a></root>')).toBe(`<root>\n${ind(1)}<a>x</a>\n</root>`)
  })

  it('文本节点保留内容、边缘空白裁剪', () => {
    expect(formatXml('<root>  hello world  </root>')).toBe('<root>hello world</root>')
    expect(formatXml('<a>x</a><b>y</b>')).toBe(`<a>x</a>\n<b>y</b>`)
  })

  it('根外空白容忍（首尾换行不判畸形）', () => {
    expect(formatXml('\n  <root/>\n')).toBe('<root/>')
  })
})

describe('formatXml 容错与幂等', () => {
  it.each([
    ['标签未闭合', '<root><a></root>'],
    ['深度不平（多闭标签）', '</root>'],
    ['孤立小于号', '<root>a < b</root>'],
    ['非法标签起始字符', '<root><1a/></root>'],
    ['根外非空白文本', 'junk<root/>'],
    ['未闭合注释', '<root><!-- x</root>'],
    ['未闭合 CDATA', '<root><![CDATA[x</root>'],
    ['引号未闭合的属性', '<root><a attr="x></a></root>'],
    ['空串', ''],
  ])('畸形输入（%s）整体原样返回', (_name, input) => {
    expect(formatXml(input)).toBe(input)
  })

  it('幂等：已格式化文本再格式化无变化', () => {
    const once = formatXml('<?xml version="1.0"?><root><a>1</a><b attr="x<y">t</b></root>')
    expect(formatXml(once)).toBe(once)
  })

  it('确定性：同输入恒同输出', () => {
    const input = '<root><a><b/></a></root>'
    expect(formatXml(input)).toBe(formatXml(input))
  })
})
