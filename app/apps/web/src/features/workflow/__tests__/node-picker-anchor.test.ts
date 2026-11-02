import { describe, expect, it } from 'vitest'

import {
  NODE_PICKER_SIZE,
  NODE_PICKER_TOOLBAR_CLEARANCE,
  pickerAnchorLocal,
  toolbarPickerAnchorLocal,
} from '../canvas/node-picker-anchor'

/**
 * 节点选择面板锚点几何：右键挂载点保持既有收口语义（margin 夹取、按估高
 * 收口、maxHeight 不压缩真实面板）；工具栏挂载点底缘让出工具栏占位——
 * 面板底（top ＋ maxHeight）恒不越过「画布高 − 让位空间」，操作栏全程
 * 可见可点。
 */

describe('pickerAnchorLocal：右键挂载点（既有收口语义）', () => {
  const canvas = { width: 1200, height: 800 }
  const bottomLine = canvas.height - 8

  it('可视区内的坐标直通为面板左上角', () => {
    expect(pickerAnchorLocal(300, 200, canvas, bottomLine)).toEqual({
      left: 300,
      top: 200,
      maxHeight: bottomLine - 200,
    })
  })

  it('贴右 / 下边缘时按估宽估高收口在可视区内', () => {
    const anchor = pickerAnchorLocal(1150, 780, canvas, bottomLine)
    expect(anchor.left).toBe(canvas.width - NODE_PICKER_SIZE.width - 8)
    expect(anchor.top).toBe(bottomLine - NODE_PICKER_SIZE.height)
  })

  it('越出左 / 上边缘时夹取到 margin', () => {
    const anchor = pickerAnchorLocal(-20, -10, canvas, bottomLine)
    expect(anchor.left).toBe(8)
    expect(anchor.top).toBe(8)
  })

  it('maxHeight 不小于估高（真实面板不被压缩）', () => {
    const anchor = pickerAnchorLocal(300, 200, canvas, bottomLine)
    expect(anchor.maxHeight).toBeGreaterThanOrEqual(NODE_PICKER_SIZE.height)
  })
})

describe('toolbarPickerAnchorLocal：工具栏挂载点（底缘让位）', () => {
  it('常规画布：面板底缘（top ＋ 估高）不越过工具栏让位线', () => {
    const canvas = { width: 1200, height: 800 }
    const anchor = toolbarPickerAnchorLocal(canvas)
    expect(anchor.top).toBe(canvas.height - NODE_PICKER_TOOLBAR_CLEARANCE - NODE_PICKER_SIZE.height)
    expect(anchor.top + NODE_PICKER_SIZE.height).toBeLessThanOrEqual(
      canvas.height - NODE_PICKER_TOOLBAR_CLEARANCE,
    )
  })

  it('矮画布：回落顶部 margin 并压缩 maxHeight，底缘仍贴让位线', () => {
    const canvas = { width: 900, height: 480 }
    const anchor = toolbarPickerAnchorLocal(canvas)
    expect(anchor.top).toBe(8)
    expect(anchor.top + anchor.maxHeight).toBe(canvas.height - NODE_PICKER_TOOLBAR_CLEARANCE)
    expect(anchor.maxHeight).toBeLessThan(NODE_PICKER_SIZE.height)
  })

  it('水平左上角取画布中线，贴右边缘时收口、极窄画布下保底 margin', () => {
    const wide = toolbarPickerAnchorLocal({ width: 1200, height: 800 })
    expect(wide.left).toBe(600)
    const snug = toolbarPickerAnchorLocal({ width: 320, height: 800 })
    expect(snug.left).toBe(320 - NODE_PICKER_SIZE.width - 8)
    const narrow = toolbarPickerAnchorLocal({ width: 200, height: 800 })
    expect(narrow.left).toBe(8)
  })
})
