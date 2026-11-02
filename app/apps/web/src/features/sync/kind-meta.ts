import type { EndpointDiff } from './diff-contract'

/**
 * 接口级变更种类的呈现单源（确认段统计页签与完成段统计卡共用）：
 * 标签键 / 符号前缀 / 语义色。符号前缀销「徽标与方法徽章双绿」账——
 * 色弱可辨不依赖颜色通道。
 */

export type SyncKind = EndpointDiff['kind']

export const SYNC_KINDS = ['added', 'changed', 'removed'] as const

export const KIND_META: Record<
  SyncKind,
  {
    labelKey: 'sync.wizard.groupAdded' | 'sync.wizard.groupChanged' | 'sync.wizard.groupRemoved'
    symbol: string
    text: string
    bg: string
  }
> = {
  added: {
    labelKey: 'sync.wizard.groupAdded',
    symbol: '＋',
    text: 'text-success',
    bg: 'bg-success/10',
  },
  changed: {
    labelKey: 'sync.wizard.groupChanged',
    symbol: 'Δ',
    text: 'text-warning',
    bg: 'bg-warning/10',
  },
  removed: {
    labelKey: 'sync.wizard.groupRemoved',
    symbol: '−',
    text: 'text-destructive',
    bg: 'bg-destructive/10',
  },
}
