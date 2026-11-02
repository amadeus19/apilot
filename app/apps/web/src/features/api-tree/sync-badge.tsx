import type { ReactNode } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components'

import { useI18n } from '@/i18n'

/**
 * 同步徽标（树行小徽标）：上次同步应用写入、下次同步滚动清旧的
 * new / changed 两态短标签——新增＝应用事务插入的接口，变更＝本次应用
 * 更新定义面的接口；无变化行在应用时清空（不残留上轮标记）。
 * 形态沿可达芯片与请求级徽标的「语义浅底深字」体系——新增＝success、
 * 变更＝warning，不打散方法徽章的视觉主次。
 * 短词不自释义，悬停走统一 Tooltip 说明两态含义（TrailingMark 同款形态）。
 *
 * 字号 text-micro 与颜色类同以 text- 前缀，为避免 cn 的 tailwind-merge
 * 互吞，整个 className 以模板串直连、不经 cn 合并（method-badge 同款
 * 纪律）。未识别值不渲染（防御：非两值在 selector 层已收窄为无徽标）。
 */

const BADGE_CLASS: Record<'new' | 'changed', string> = {
  new: 'shrink-0 rounded-full bg-success/10 px-1.5 text-micro text-success',
  changed: 'shrink-0 rounded-full bg-warning/10 px-1.5 text-micro text-warning',
}

export function SyncBadgeChip({ badge }: { badge: 'new' | 'changed' }): ReactNode {
  const { t } = useI18n()
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <span className={BADGE_CLASS[badge]}>
          {badge === 'new' ? t('apiTree.syncBadgeNew') : t('apiTree.syncBadgeChanged')}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {badge === 'new' ? t('apiTree.syncBadgeNewHint') : t('apiTree.syncBadgeChangedHint')}
      </TooltipContent>
    </Tooltip>
  )
}
