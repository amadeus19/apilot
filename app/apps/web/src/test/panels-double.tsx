import * as React from 'react'

/**
 * react-resizable-panels 测试替身（分栏接线测试专用）：
 * 库内部几何行为已有上游测试基线，前端只测「库管几何，store 管语义」的
 * 接线面——本替身复刻接线所需的最小库语义：
 * - Panel 挂载时调用 panelRef(api) 并回调一次 onResize（defaultSize 折算 px）；
 * - collapsible 面板尺寸低于 minSize 自动收起（snapped 到 collapsedSize），
 *   越过 (collapsedSize+minSize)/2 阈值自动展开（与库 v4 文档一致）；
 * - 约束 props（minSize / maxSize / collapsedSize / defaultSize）可断言；
 * - 测试经 firePanelResize 驱动尺寸变化、经 panelApi 检查 imperative 下发。
 */

export interface FakePanelApi {
  collapse: () => void
  expand: () => void
  isCollapsed: () => boolean
  getSize: () => { asPercentage: number; inPixels: number }
  resize: (size: number | string) => void
}

interface PanelRecord {
  props: Record<string, unknown>
  api: FakePanelApi
  collapsed: boolean
  lastSizePx: number
  minSizePx: number
  collapsedSizePx: number
  collapsible: boolean
  onResize?: (size: { inPixels: number; asPercentage: number }, id?: string | number) => void
}

/** 百分比与 asPercentage 的换算基准（假想 Group 宽度） */
export const FAKE_GROUP_WIDTH_PX = 1000

const panelRegistry = new Map<string, PanelRecord>()

export function resetPanelsDouble(): void {
  panelRegistry.clear()
}

/** 读取某面板挂载时收到的原始 props（约束断言用） */
export function panelProps(id: string): Record<string, unknown> | undefined {
  return panelRegistry.get(id)?.props
}

/** 面板 imperative 句柄（下发断言用） */
export function panelApi(id: string): FakePanelApi | undefined {
  return panelRegistry.get(id)?.api
}

/** 驱动面板尺寸变化（自动收起 / 展开语义同库） */
export function firePanelResize(id: string, sizeInPixels: number): void {
  const record = panelRegistry.get(id)
  if (!record) throw new Error(`panel not registered: ${id}`)
  let effective = sizeInPixels
  if (record.collapsible) {
    const expandThreshold = (record.collapsedSizePx + record.minSizePx) / 2
    if (!record.collapsed && sizeInPixels < record.minSizePx) {
      record.collapsed = true
      effective = record.collapsedSizePx
    } else if (record.collapsed && sizeInPixels > expandThreshold) {
      record.collapsed = false
      effective = sizeInPixels
    } else if (record.collapsed) {
      effective = record.collapsedSizePx
    }
  }
  record.lastSizePx = record.collapsed ? record.collapsedSizePx : effective
  emit(record, id)
}

function sizeToPx(value: unknown, fallback: number): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    if (value.endsWith('px')) return Number.parseFloat(value)
    if (value.endsWith('%')) return (Number.parseFloat(value) / 100) * FAKE_GROUP_WIDTH_PX
  }
  return fallback
}

function emit(record: PanelRecord, id: string): void {
  const size = record.api.getSize()
  record.onResize?.(size, id)
}

export function Panel({
  children,
  id,
  panelRef,
  onResize,
  defaultSize,
  minSize,
  maxSize,
  collapsible,
  collapsedSize,
  ...rest
}: React.PropsWithChildren<
  Record<string, unknown> & {
    id?: string | number
    panelRef?: (api: FakePanelApi | null) => void
    onResize?: (size: { inPixels: number; asPercentage: number }, id?: string | number) => void
    defaultSize?: number | string
    minSize?: number | string
    maxSize?: number | string
    collapsible?: boolean
    collapsedSize?: number | string
  }
>): React.ReactElement {
  const key = String(id ?? 'anonymous')
  React.useEffect(() => {
    const record: PanelRecord = {
      props: { ...rest, id, defaultSize, minSize, maxSize, collapsible, collapsedSize },
      api: null as unknown as FakePanelApi,
      collapsed: false,
      lastSizePx: sizeToPx(defaultSize, FAKE_GROUP_WIDTH_PX / 3),
      minSizePx: sizeToPx(minSize, 0),
      collapsedSizePx: sizeToPx(collapsedSize ?? 0, 0),
      collapsible: collapsible === true,
      onResize,
    }
    const api: FakePanelApi = {
      collapse: () => {
        if (!record.collapsible || record.collapsed) return
        record.collapsed = true
        emit(record, key)
      },
      expand: () => {
        if (!record.collapsed) return
        record.collapsed = false
        emit(record, key)
      },
      isCollapsed: () => record.collapsed,
      getSize: () => {
        const inPixels = record.collapsed ? record.collapsedSizePx : record.lastSizePx
        return { inPixels, asPercentage: (inPixels / FAKE_GROUP_WIDTH_PX) * 100 }
      },
      resize: (size: number | string) => {
        // 真实库语义：像素落定后按尺寸判定折叠态（isCollapsed 按尺寸比较）
        record.lastSizePx = sizeToPx(size, record.lastSizePx)
        record.collapsed = record.collapsible && record.lastSizePx <= record.collapsedSizePx
        emit(record, key)
      },
    }
    record.api = api
    panelRegistry.set(key, record)
    panelRef?.(api)
    emit(record, key)
    return () => {
      panelRef?.(null)
      panelRegistry.delete(key)
    }
    // 挂载期一次性登记：接线测试不重挂载改约束（假件语义＝空依赖，重跑
    // 会以新 props 覆盖登记快照，破坏「登记时快照」的断言口径；oxlint 兼容
    // eslint-disable 注释语法，exhaustive-deps 据此豁免）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <div data-testid={`panel-${key}`}>{children}</div>
}

export function Group({
  children,
  ...rest
}: React.PropsWithChildren<Record<string, unknown>>): React.ReactElement {
  return <div {...rest}>{children}</div>
}

export function Separator(props: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return <div role="separator" tabIndex={0} {...props} />
}
