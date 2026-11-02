import * as React from 'react'

import { createPortal } from 'react-dom'

import { Badge, Input } from '@workspace/ui/components'
import { cn } from 'cn'

import { useI18n } from '@/i18n'
import { useIpcQuery } from '@/services/ipc-query'

import { variableEffective, variableKeys, type EffectiveVariableDto } from './variable-api'
import {
  clampSuggestLeft,
  clampTooltipLeft,
  createInputTextMeasurer,
  pickReferenceAtX,
} from './variable-hover'
import { findVariableReferences, matchVariableFragment } from './variable-suggest-match'

/**
 * `{{` 变量联想输入框：值内输入 `{{` 即弹出生效变量补全面板（键名＋当前值
 * 预览＋来源层），方向键 / Enter 选择插入 `{{键}}`，Esc 或失焦关闭；闭合
 * `{{键}}` 引用悬浮显示当前解析值（发送前可见，hover 变量解析）。
 *
 * - 数据源＝生效变量集查询（variable.effective，与发送侧解析同源——补全
 *   列出的键必然可解析）；Secret 行值恒掩码（`***`），与生效集展示端
 *   恒掩码纪律一致；
 * - 触发＝光标前存在未闭合的 `{{` 片段（matchVariableFragment），继续
 *   输入按键名大小写不敏感过滤；输入法组合态（isComposing）不拦截按键，
 *   中文输入法的 Enter 确认候选不误触发插入；
 * - 读屏语义＝combobox 模式：输入框 role=combobox＋aria-controls 指向浮层，
 *   方向键高亮经 aria-activedescendant 通报（浮层容器 role=listbox、行
 *   role=option＋aria-selected，焦点恒留输入框的视觉决策下读屏不静默）；
 * - 浮层 fixed＋portal：贴输入框下缘，左缘按最小宽度钳制防视口右缘溢出
 *   （clampSuggestLeft）；滚动 / 改窗即关（不随滚动追踪——输入中的滚动
 *   意味着目标行已离开视线，关闭比错位更可预期；浮层自身列表的滚动
 *   除外——长列表需要滚动浏览）；焦点恒留
 *   输入框（浮层行 onMouseDown 阻止夺焦），键盘流不中断；
 * - hover 解析＝指针落在闭合 `{{键}}` 引用的水平区间时出提示（几何命中
 *   见 variable-hover）：显示键名与解析值，Secret 行掩码＋「Secret 变量」
 *   标注、生效集未含的键标「未定义」；提示纯展示不拦截指针，输入框原生
 *   点击 / 选区行为不受影响；编辑值与滚动改窗即关；同一引用区间内指针
 *   微动经浅比较去重（hover 状态引用不变，提示子树跳过重渲染），片段
 *   量宽按值缓存（值变化即失效）。
 *
 * workspaceId 缺省＝不启用联想，退化为普通受控 Input（宿主无工作空间
 * 上下文时零开销透传）。
 */

/** 补全浮层（fixed 定位；供键盘与鼠标共用的行渲染收敛在此）。
 *  读屏语义：容器 role=listbox（id 供输入框 aria-controls 引用）、行
 *  role=option＋aria-selected＋高亮行 id（供 aria-activedescendant 引用）；
 *  空态文案 role=presentation——listbox 内非 option 子项不冒充选项 */
function SuggestOverlay({
  items,
  highlight,
  rect,
  id,
  optionId,
  onPick,
  onHover,
}: {
  items: EffectiveVariableDto[]
  highlight: number
  rect: { top: number; left: number; width: number }
  /** listbox 容器 id（＝输入框 aria-controls 的指向） */
  id: string
  /** 行 id 生成（＝高亮时输入框 aria-activedescendant 的指向） */
  optionId: (index: number) => string
  onPick: (item: EffectiveVariableDto) => void
  onHover: (index: number) => void
}) {
  const { t } = useI18n()
  const sourceLabels: Record<EffectiveVariableDto['source'], string> = {
    active: t('variables.effective.sourceActive'),
    global: t('variables.effective.sourceGlobal'),
    builtin: t('variables.effective.sourceBuiltin'),
  }
  // 最小宽度与左缘钳制用同一估值：实际宽度内容自适应，按保守值防右缘溢出
  const minWidth = Math.max(rect.width, 200)
  return createPortal(
    <div
      id={id}
      role="listbox"
      aria-label={t('variables.suggest.listLabel')}
      data-testid="var-suggest-list"
      data-var-suggest-overlay=""
      style={{
        top: rect.top,
        left: clampSuggestLeft(rect.left, window.innerWidth, minWidth),
        minWidth,
      }}
      className="fixed z-50 flex max-h-60 flex-col overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
      // 阻止 mousedown 夺焦：焦点与光标留在输入框，点击行为不中断键盘流
      onMouseDown={(event) => event.preventDefault()}
    >
      {items.length === 0 ? (
        <p
          role="presentation"
          className="px-2 py-1.5 text-xs text-muted-foreground"
          data-testid="var-suggest-empty"
        >
          {t('variables.suggest.empty')}
        </p>
      ) : (
        items.map((item, index) => (
          <button
            key={item.key}
            type="button"
            role="option"
            id={optionId(index)}
            aria-selected={index === highlight}
            data-testid="var-suggest-row"
            data-highlight={index === highlight || undefined}
            className={cn(
              'flex min-w-0 items-center gap-2 rounded-sm px-2 py-1 text-left text-xs',
              index === highlight && 'bg-accent',
            )}
            onMouseEnter={() => onHover(index)}
            onClick={() => onPick(item)}
          >
            <span className="shrink-0 font-mono">{item.key}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
              {item.secret ? '***' : item.value}
            </span>
            <span className="shrink-0 text-micro text-muted-foreground">
              {sourceLabels[item.source]}
            </span>
          </button>
        ))
      )}
    </div>,
    document.body,
  )
}

/** hover 解析提示（fixed＋portal，纯展示不拦截指针）：键名＋解析值，Secret
 *  行恒掩码并标注、生效集未含的键标「未定义」；role=tooltip 声明悬浮提示
 *  语义（读屏在浏览模式外亦可识别其与触发元素的关联形态）。
 *  memo 化与 handleMouseMove 的 setHover 浅比较配套：同一引用区间微动时
 *  hover 状态引用不变（tip props 浅等），此子树整体跳过重渲染——React 19
 *  起相同引用的 setState 不再于派发时短路，父组件 render 不可免，提示
 *  子树的零渲染由 memo 边界承担 */
const HoverResolveTooltip = React.memo(function HoverResolveTooltip({
  tip,
}: {
  tip: { key: string; item: EffectiveVariableDto | null; left: number; top: number }
}) {
  const { t } = useI18n()
  return createPortal(
    <div
      role="tooltip"
      data-testid="var-hover-tip"
      style={{ top: tip.top, left: tip.left, transform: 'translateX(-50%)' }}
      className="pointer-events-none fixed z-50 max-w-[360px] min-w-[200px] rounded-md bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10"
    >
      <div className="flex items-center gap-1.5 text-xs">
        <span className="shrink-0 font-mono">{`{{${tip.key}}}`}</span>
        {tip.item === null ? (
          <Badge variant="outline" className="h-4 shrink-0 px-1.5 text-micro">
            {t('variables.hover.undefinedBadge')}
          </Badge>
        ) : (
          tip.item.secret && (
            <Badge variant="outline" className="h-4 shrink-0 px-1.5 text-micro">
              {t('variables.hover.secretBadge')}
            </Badge>
          )
        )}
      </div>
      {tip.item !== null && (
        <div className="mt-1 font-mono text-xs break-all text-muted-foreground">
          {tip.item.secret ? '***' : tip.item.value}
        </div>
      )}
    </div>,
    document.body,
  )
})

/** 受控输入的 value/onChange 收窄，其余 input 属性原样透传（placeholder /
 *  aria / className / onPaste 等） */
type VariableSuggestInputProps = Omit<React.ComponentProps<'input'>, 'value' | 'onChange'> & {
  value: string
  onChange: (value: string) => void
  /** 生效变量集归属空间；null / undefined＝不启用联想（退化为普通 Input） */
  workspaceId: string | null | undefined
}

export function VariableSuggestInput({
  value,
  onChange,
  workspaceId,
  ...inputProps
}: VariableSuggestInputProps) {
  // 分流在组件边界：非启用分支是纯 Input（不挂查询 hook——宿主无工作空间
  // 上下文时零依赖，测试与工具面的普通渲染不需要 QueryProvider）
  if (workspaceId == null || workspaceId === '') {
    return (
      <Input {...inputProps} value={value} onChange={(event) => onChange(event.target.value)} />
    )
  }
  return (
    <SuggestCapableInput
      {...inputProps}
      value={value}
      onChange={onChange}
      workspaceId={workspaceId}
    />
  )
}

/** 启用联想的分支（workspaceId 恒非空）：查询生效集与补全交互全在此 */
function SuggestCapableInput({
  value,
  onChange,
  workspaceId,
  onKeyDown,
  onBlur,
  onMouseMove,
  onMouseLeave,
  ...inputProps
}: Omit<VariableSuggestInputProps, 'workspaceId'> & { workspaceId: string }) {
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [highlight, setHighlight] = React.useState(0)
  const [rect, setRect] = React.useState<{ top: number; left: number; width: number } | null>(null)
  // combobox 关联 id（useId 会话内稳定）：listbox 容器与各行由 aria-controls /
  // aria-activedescendant 引用（焦点恒留输入框的形态下高亮对读屏的通报通道）
  const listboxId = React.useId()
  const optionId = (index: number) => `${listboxId}-option-${index}`
  // hover 解析提示（null＝关）：快照键名＋生效项＋提示锚位
  const [hover, setHover] = React.useState<{
    key: string
    item: EffectiveVariableDto | null
    left: number
    top: number
  } | null>(null)
  // 输入框量宽上下文（首个 mousemove 惰性构建；字体不随值变化，一次即可）
  const measureRef = React.useRef<ReturnType<typeof createInputTextMeasurer>>(null)
  // 片段量宽缓存：键＝当前值的子串，值变化即整体失效（跨值复用无意义）；
  // 单值内子串集合有限（命中测试每次只产生 2×引用数个），有界
  const widthCacheRef = React.useRef<{ value: string; cache: Map<string, number> } | null>(null)

  const effectiveQuery = useIpcQuery({
    queryKey: variableKeys.effective(workspaceId),
    queryFn: () => variableEffective(workspaceId),
    staleTime: 30_000,
  })
  const items = effectiveQuery.data?.items
  const filtered = React.useMemo(() => {
    const needle = query.toLowerCase()
    return (items ?? []).filter((item) => item.key.toLowerCase().includes(needle))
  }, [items, query])

  // 打开期间定位输入框（fixed 坐标）；滚动 / 改窗即关——错位比消失更糟
  React.useEffect(() => {
    if (!open) return
    const measure = () => {
      const el = inputRef.current
      if (!el) return
      const box = el.getBoundingClientRect()
      setRect({ top: box.bottom + 4, left: box.left, width: box.width })
    }
    measure()
    const close = (event: Event) => {
      // 浮层自身列表的滚动（overflow 容器）不算错位信号，长列表要能滚
      if (event.target instanceof Element && event.target.closest('[data-var-suggest-overlay]')) {
        return
      }
      setOpen(false)
    }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  /** onChange 后按光标前片段决定浮层开合与过滤词 */
  const syncFromCursor = (text: string, cursor: number) => {
    const frag = matchVariableFragment(text.slice(0, cursor))
    if (frag) {
      setOpen(true)
      setQuery(frag.query)
      setHighlight(0)
    } else {
      setOpen(false)
    }
  }

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const el = event.currentTarget
    onChange(el.value)
    setHover(null) // 编辑值即失锚：提示关闭，指针再动按新值重开
    syncFromCursor(el.value, el.selectionStart ?? el.value.length)
  }

  // —— hover 变量解析（发送前可见）：指针落在闭合 {{键}} 引用水平区间时出
  //    提示。几何命中走 variable-hover（canvas 量宽与输入框字体一致）；联想
  //    浮层打开期间让位不提示。同一引用区间内指针微动是最高频情形，双重
  //    去重：命中产物（锚位随片段恒定）经浅比较保持 hover 状态引用不变
  //    （提示子树经 memo 边界跳过重渲染）；片段量宽走值内缓存，微动不
  //    重复 canvas measureText ——
  const handleMouseMove = (event: React.MouseEvent<HTMLInputElement>) => {
    onMouseMove?.(event)
    if (event.defaultPrevented) return
    const el = event.currentTarget
    // 联想浮层打开期间让位；生效集未加载时无解析依据，两者都不出提示
    if (open || items === undefined) {
      setHover(null)
      return
    }
    const measure = (measureRef.current ??= createInputTextMeasurer(el))
    if (measure === null) return
    let widthCache = widthCacheRef.current
    if (widthCache?.value !== el.value) {
      widthCache = { value: el.value, cache: new Map() }
      widthCacheRef.current = widthCache
    }
    const cachedMeasure = (text: string): number => {
      const cached = widthCache.cache.get(text)
      if (cached !== undefined) return cached
      const width = measure.measure(text)
      widthCache.cache.set(text, width)
      return width
    }
    const refs = findVariableReferences(el.value)
    const rect = el.getBoundingClientRect()
    const hit =
      refs.length === 0
        ? null
        : pickReferenceAtX(
            el.value,
            refs,
            cachedMeasure,
            rect.left + measure.paddingLeft - el.scrollLeft,
            event.clientX,
          )
    if (hit === null) {
      setHover(null)
      return
    }
    const key = refs[hit.index]?.key
    if (key === undefined) {
      setHover(null)
      return
    }
    const item = items.find((candidate) => candidate.key === key) ?? null
    const left = clampTooltipLeft(hit.anchorX, window.innerWidth)
    const top = rect.bottom + 4
    setHover((prev) =>
      prev !== null &&
      prev.key === key &&
      prev.item?.key === item?.key &&
      Math.round(prev.left) === Math.round(left) &&
      Math.round(prev.top) === Math.round(top)
        ? prev // 同一引用区间微动：保持状态引用，提示子树经 memo 跳过
        : { key, item, left, top },
    )
  }

  /** 指针离开输入框即收提示；宿主自有 onMouseLeave 保留 */
  const handleMouseLeave = (event: React.MouseEvent<HTMLInputElement>) => {
    setHover(null)
    onMouseLeave?.(event)
  }

  // 提示开着期间滚动 / 改窗即收（视口移动后锚位失真，指针再动按新位置重开）
  const hoverOpen = hover !== null
  React.useEffect(() => {
    if (!hoverOpen) return
    const close = () => setHover(null)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [hoverOpen])

  /** 插入高亮项：替换光标前的 `{{查询` 片段为 `{{键}}`，光标落 `}}` 之后。
   *  受控回写后光标会被重置到串尾，rAF 里重设（React 同步 flush 后执行） */
  const insert = (item: EffectiveVariableDto) => {
    const el = inputRef.current
    if (!el) return
    const cursor = el.selectionStart ?? value.length
    const frag = matchVariableFragment(value.slice(0, cursor))
    setOpen(false)
    if (!frag) return
    const reference = `{{${item.key}}}`
    onChange(value.slice(0, frag.start) + reference + value.slice(cursor))
    const caret = frag.start + reference.length
    requestAnimationFrame(() => {
      const target = inputRef.current
      target?.focus()
      target?.setSelectionRange(caret, caret)
    })
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented) return
    // 输入法组合态不拦截：Enter 是候选确认，方向键在候选窗内导航
    if (event.nativeEvent.isComposing) return
    if (!open) return
    if (event.key === 'ArrowDown' && filtered.length > 0) {
      event.preventDefault()
      setHighlight((prev) => (prev + 1) % filtered.length)
    } else if (event.key === 'ArrowUp' && filtered.length > 0) {
      event.preventDefault()
      setHighlight((prev) => (prev - 1 + filtered.length) % filtered.length)
    } else if (event.key === 'Enter') {
      // 无匹配时空列表也拦截 Enter 并关浮层——不穿透给宿主（宿主可能是
      // 表单，穿透即误提交）；用户再按 Enter 才到达宿主，是明确意图
      event.preventDefault()
      const picked = filtered[highlight] ?? filtered[0]
      if (picked) insert(picked)
      else setOpen(false)
    } else if (event.key === 'Tab' && filtered.length > 0) {
      // Tab 采纳高亮项按 IDE 惯例保留（焦点本就恒留输入框，Tab 不承担
      // 离场职能；无匹配时放行，正常 tab 导航不受劫持）
      event.preventDefault()
      const picked = filtered[highlight] ?? filtered[0]
      if (picked) insert(picked)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      // 防御性截断冒泡：宿主处于 Dialog / Sheet 内时，Base UI 在 document
      // 层的 Escape 监听会连坐关容器——浮层已就地关闭，事件不再外泄
      event.stopPropagation()
      setOpen(false)
    }
  }

  /** 失焦即关（点击浮层行不触发——行 onMouseDown 已阻止夺焦） */
  const handleBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    setOpen(false)
    setHover(null)
    onBlur?.(event)
  }

  return (
    <>
      <Input
        {...inputProps}
        ref={inputRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        // combobox 读屏语义：aria-controls 仅在浮层实际挂载时给出（不悬空
        // 引用），aria-activedescendant 仅在存在高亮行时给出（空列表无指向）
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open || undefined}
        aria-controls={open && rect !== null ? listboxId : undefined}
        aria-activedescendant={open && filtered.length > 0 ? optionId(highlight) : undefined}
      />
      {open && rect !== null && (
        <SuggestOverlay
          items={filtered}
          highlight={highlight}
          rect={rect}
          id={listboxId}
          optionId={optionId}
          onPick={insert}
          onHover={setHighlight}
        />
      )}
      {hover !== null && <HoverResolveTooltip tip={hover} />}
    </>
  )
}
