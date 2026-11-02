import * as React from "react"
import { XIcon } from "lucide-react"
import { cn } from "cn"

import { useUiText } from "../ui-text"
import { Input } from "./input"

/**
 * 搜索输入（type=search + 统一清除钮）：清除钮只在有值时出现，点击清空
 * 并保持输入框焦点（清空后继续输入不打断）。Input 全局隐藏了原生取消钮
 * （WebView2 原生钮样式不可令牌化），清除语义由本组件统一承载，
 * 业务侧不再各自绘制清除钮。
 *
 * hint 为输入为空时右端的辅助提示槽（快捷键徽标等）：它与清除钮同位，
 * 同屏只出现一个。提供 hint 时右内边距按快捷键徽标量级预留 64px
 * （徽标约 50px ＋ 8px 内缩），且常驻不随输入变化——否则提示被清除钮顶掉
 * 的同时文字行宽还会跳动。
 *
 * 填充：**不留填充，以描边界定**。填充色现在专属于状态（悬停 / 当前项），
 * 输入框再占一层填充会让「可点区域」与「可输入区域」混作一色；留着描边即可
 * 界定，且描边（`--input` 对面板 1.26:1）本身就是可辨的。
 * dark 档显式写一次 `bg-transparent`，是为盖过底座 Input 的 `dark:bg-input/30`
 * ——不盖过则深色下会多出一层说不出理由的浅填充。
 */

/** 搜索框填充＝透明（理由见组件注释） */
const SEARCH_FILL = "dark:bg-transparent"
function SearchInput({
  className,
  value,
  onChange,
  hint,
  ref: externalRef,
  ...props
}: Omit<React.ComponentProps<"input">, "type"> & {
  ref?: React.Ref<HTMLInputElement>
  /** 输入为空时右端的辅助提示（有值时让位给清除钮） */
  hint?: React.ReactNode
}) {
  const uiText = useUiText()
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  // 外部 ref（聚焦信号等）与内部 ref（清除后焦点保持）合一
  const setRef = (node: HTMLInputElement | null): void => {
    inputRef.current = node
    if (typeof externalRef === "function") externalRef(node)
    else if (externalRef) externalRef.current = node
  }

  const clear = (): void => {
    const input = inputRef.current
    if (!input) return
    // 受控形态下 DOM 值由父 state 决定：经原型 setter 置空再派发 input
    // 事件，React 的 onChange 才会以空值触发（父 setState('') 后回灌）
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set
    valueSetter?.call(input, "")
    input.dispatchEvent(new Event("input", { bubbles: true }))
    input.focus()
  }

  return (
    <div className="relative w-full">
      <Input
        ref={setRef}
        type="search"
        value={value}
        onChange={onChange}
        className={cn(SEARCH_FILL, hint ? "pr-16" : "pr-7", className)}
        {...props}
      />
      {value ? (
        <button
          type="button"
          aria-label={uiText.searchClearLabel}
          onClick={clear}
          className="absolute inset-y-0 right-1 my-auto grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <XIcon aria-hidden className="size-3.5" />
        </button>
      ) : (
        hint && (
          <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center">
            {hint}
          </span>
        )
      )}
    </div>
  )
}

export { SearchInput }
