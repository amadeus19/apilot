import { useEffect, useState } from 'react'
import { CheckIcon, CloudOffIcon, LoaderCircleIcon, MinusIcon, type LucideIcon } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components'

import { useI18n, type DictKey } from '@/i18n'

import { probeStatusOf, useProbeStore, type ProbeStatusKind } from '@/stores/probe.store'

/**
 * 服务可达性徽标（树行四态）：探测中／不可达／未知＝图标＋短标签＋语义
 * 浅底徽标，持续呈现——不可达＝destructive、未知＝中性灰、探测中＝muted
 * ＋图标旋转（状态转换进行态的既定动效面）。可达＝一次性的好消息宣告：
 * 完整徽标保持 3 秒（读满「可达」）后整体退场（浅底与文字随宽度、透明度
 * 收敛，200ms ease-out），退场完成在探测 store 标记「已展示」并从树行
 * 卸载——虚拟滚动重挂载不重现，唯新一轮探测（probing 事件清标记）后
 * 重新宣告。重探入口＝树底计数行的全量刷新按钮，徽标自身非交互。
 *
 * 退场形变不做条件渲染：背景层、图标、标签恒在 DOM，仅切类名（背景
 * 透明度／padding／gap／max-w／opacity／scale 过渡），同一元素重渲染时
 * CSS transition 自然播放。浅底承载在背景层（absolute inset-0 恒随外层
 * 尺寸，rounded-full＋外层 overflow-hidden 裁进圆角）。行高 leading-normal：
 * leading-none 会让 CJK 被 overflow-hidden 垂直裁字，py 相应收为 0 抵消
 * 行高增量。暗 / 亮档由主题变量自然承载；状态短词即徽标全部文字，悬浮
 * 提示为状态全文（经字典注入），无文字丢失面。
 *
 * 字号 text-micro 与颜色类同以 text- 前缀，为避免 cn 的 tailwind-merge
 * 互吞，整个 className 以模板串直连、不经 cn 合并（method-badge 同款纪律）。
 */

/** 可达徽标完整保持时长（ms），期满开始退场 */
const REACHABLE_HOLD_MS = 3000

/** 退场动画时长（ms）：与 duration-200 同速，播完标记已展示并卸载 */
const REACHABLE_EXIT_MS = 200

interface StatusMeta {
  icon: LucideIcon
  /** 徽标字色（外层元素承载；完整字面量，Tailwind 静态扫描可及） */
  cls: string
  /** 背景层浅底（完整字面量，Tailwind 静态扫描可及） */
  bgCls: string
}

const STATUS_META: Record<ProbeStatusKind, StatusMeta> = {
  reachable: { icon: CheckIcon, cls: 'text-success', bgCls: 'bg-success/10' },
  unreachable: { icon: CloudOffIcon, cls: 'text-destructive', bgCls: 'bg-destructive/10' },
  unknown: { icon: MinusIcon, cls: 'text-muted-foreground', bgCls: 'bg-muted-foreground/10' },
  probing: {
    icon: LoaderCircleIcon,
    cls: 'text-muted-foreground',
    bgCls: 'bg-muted-foreground/10',
  },
}

const STATUS_LABEL_KEY: Record<ProbeStatusKind, DictKey> = {
  reachable: 'apiTree.probeReachable',
  unreachable: 'apiTree.probeUnreachable',
  unknown: 'apiTree.probeUnknown',
  probing: 'apiTree.probeProbing',
}

/** 徽标可见短词（原型形态；悬浮提示用上方全文键） */
const STATUS_TAG_KEY: Record<ProbeStatusKind, DictKey> = {
  reachable: 'apiTree.probeTagReachable',
  unreachable: 'apiTree.probeTagUnreachable',
  unknown: 'apiTree.probeTagUnknown',
  probing: 'apiTree.probeTagProbing',
}

export function ServiceProbeChip({ serviceId }: { serviceId: string }) {
  const { t } = useI18n()
  const status = useProbeStore((state) => probeStatusOf(state.statuses, serviceId))
  const shown = useProbeStore((state) => state.reachShown[serviceId] === true)
  const markShown = useProbeStore((state) => state.markReachShown)

  // 保持→退场两段式：settled＝「保持期已过、已切退场类」。时间驱动的过渡
  // 状态而非渲染期可派生值，由定时器 effect 置位。
  const [settled, setSettled] = useState(false)
  // 渲染期调整模式：任一状态迁移都先回到完整徽标形态——变离可达立即展开，
  // 重新可达则保持期从头计；条件随赋值收敛、不会循环。
  const [heldStatus, setHeldStatus] = useState(status)
  if (heldStatus !== status) {
    setHeldStatus(status)
    setSettled(false)
  }

  useEffect(() => {
    // 仅可达、未退场、未消费时进入保持期；清理：状态变离可达或卸载时清除
    // 定时器，定时器随组件生命周期，不泄漏。
    if (status !== 'reachable' || settled || shown) return
    const timer = setTimeout(() => setSettled(true), REACHABLE_HOLD_MS)
    return () => clearTimeout(timer)
  }, [status, settled, shown])

  useEffect(() => {
    // 退场动画播完后在 store 标记「已展示」：组件卸载、虚拟滚动重挂载不
    // 重现；卸载早于播完时清理定时器（重挂载从头保持期，宣告重来一次，
    // 无害）。标记已存在（shown）时不重复计时。
    if (status !== 'reachable' || !settled || shown) return
    const timer = setTimeout(() => markShown(serviceId), REACHABLE_EXIT_MS)
    return () => clearTimeout(timer)
  }, [status, settled, shown, markShown, serviceId])

  // 可达宣告已消费：整体不渲染（唯 probing 事件清标记后重新展示）
  if (status === 'reachable' && shown) return null

  // 退场形态＝可达且保持期满；全部类名切换以它为唯一开关（DOM 结构恒定）
  const collapsed = status === 'reachable' && settled
  const label = t(STATUS_LABEL_KEY[status])
  const meta = STATUS_META[status]
  const Icon = meta.icon
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-testid={`service-probe-chip-${status}`}
            // 退场收起 gap 与 px（icon/label 已收敛为 0 宽，残留间隙占位），
            // transition-all 让宽度随 padding/gap 平滑收缩；leading-normal 防
            // CJK 竖向裁字，py 相应收为 0 抵消行高增量
            className={`relative flex shrink-0 items-center overflow-hidden rounded-full py-0 text-micro leading-normal font-medium transition-all duration-200 ease-out ${
              collapsed ? 'gap-0 px-0' : 'gap-0.5 px-1.5'
            } ${meta.cls}`}
          />
        }
      >
        {/* 背景层＝浅底 pill 本体：恒渲染、inset-0 恒随外层尺寸并被裁进
            rounded-full；退场期浅底渐透明，随宽度收缩一起消失 */}
        <span
          aria-hidden
          className={`absolute inset-0 rounded-full transition-all duration-200 ease-out ${
            collapsed ? 'bg-success/0' : meta.bgCls
          }`}
        />
        {/* 图标：退场态 max-w／max-h／opacity／scale 归零随徽标收敛；旋转
            原点＝图标自身中心（探测中态），无锚点差异需切换 */}
        <Icon
          aria-hidden
          className={`size-2.5 shrink-0 transition-all duration-200 ease-out ${
            status === 'probing' ? 'animate-spin' : ''
          } ${
            collapsed
              ? 'max-h-0 max-w-0 scale-0 opacity-0'
              : 'max-h-6 max-w-[8rem] scale-100 opacity-100'
          }`}
        />
        <span
          aria-hidden
          className={`overflow-hidden whitespace-nowrap transition-all duration-200 ease-out ${
            collapsed
              ? 'max-h-0 max-w-0 scale-0 opacity-0'
              : 'max-h-6 max-w-[8rem] scale-100 opacity-100'
          }`}
        >
          {t(STATUS_TAG_KEY[status])}
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
