/**
 * HTTP 方法徽章：等宽、大写、方法语义色恒定不随强调色变化，手工 / 同步
 * 同形。三档形态：
 * - sm（11px 彩字）：树行 / 标签栏等紧凑场景，密度优先；
 * - md（13px 浅底深字）：编辑器地址条（方法选择器触发值与同步只读徽章），
 *   浅背景＋方法色深字的强调形态，底色由字级方法色低比例派生（随调色联动）；
 * - lg（13px 彩字）：方法选择器的下拉选项——选项行不带底色（悬浮高亮由
 *   菜单行的 focus 底承担），只放大字号保证可扫视。
 *
 * 宽度随方法自然伸缩（GET 窄于 OPTIONS）。曾试过定宽列（48px）求名称列
 * 对齐，代价是短方法在徽章与名称之间留出约 28px 空洞——方法与名称本应
 * 读作一体，空洞比「名称起点随方法长度浮动」更伤扫视，故回退。名称起点
 * 浮动也是本领域通行形态。
 *
 * 方法语义色是全项目恒定语义（树行 / 标签栏 / 方法选择器同源），故文字色
 * 类带尾置 `!`（important）：SelectItem 等菜单项在聚焦时以
 * `**:text-accent-foreground`（选择器比 0-3-0）统一后代文字色，普通单类
 * （0-1-0）会被压掉——方法色会在指针压上选项行的瞬间消失。md 浅底不受
 * 该规则影响（规则只改文字色，底色由徽章自身绘制盖在选项行悬停底之上）。
 *
 * 字号与颜色不得同走 cn 合并：cn 的 tailwind-merge 引擎把不认识的自定义
 * `text-*` 名一律归入颜色组互吞（`text-micro` 会被 `text-method-get` 覆盖），
 * 字号与颜色类因此以模板串直连，整个 className 不经过 cn 合并。
 */

import { METHOD_TRIGGER_CLASS } from '@/features/api-tree/method-trigger-class'

const METHOD_TEXT_CLASS: Record<string, string> = {
  GET: 'text-method-get!',
  POST: 'text-method-post!',
  PUT: 'text-method-put!',
  DELETE: 'text-method-delete!',
  PATCH: 'text-method-patch!',
  HEAD: 'text-method-misc!',
  OPTIONS: 'text-method-misc!',
}

export function MethodBadge({
  method,
  size = 'sm',
  active = false,
}: {
  method: string
  /** sm＝树行 / 标签栏；md＝地址条浅底深字；lg＝下拉选项彩字大字号 */
  size?: 'sm' | 'md' | 'lg'
  /**
   * 激活态（树行选中＝当前打开的接口）：纯字形态（sm / lg）的文字切主题色，
   * 方法语义色让位——激活行的定位线索优先于方法分类线索；md 浅底形态
   * 不参与（编辑器地址条无激活语义）
   */
  active?: boolean
}) {
  return (
    <span
      className={
        size === 'md'
          ? `flex h-7 shrink-0 items-center rounded-md px-2 font-mono text-[13px] leading-none font-medium tracking-wide uppercase tabular-nums ${
              METHOD_TRIGGER_CLASS[method] ?? METHOD_TRIGGER_CLASS.HEAD
            }`
          : `shrink-0 font-mono ${
              size === 'lg' ? 'text-[13px]' : 'text-micro'
            } font-medium tracking-wide uppercase tabular-nums ${
              active ? 'text-primary!' : (METHOD_TEXT_CLASS[method] ?? 'text-method-misc!')
            }`
      }
      aria-label={method}
    >
      {method}
    </span>
  )
}
