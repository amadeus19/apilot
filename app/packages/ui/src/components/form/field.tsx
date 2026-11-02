import * as React from "react"
import { cn } from "cn"

/**
 * 包裹式 label 字段行（控件隐式关联）：label 与控件（可选 hint 说明）的
 * 统一密度与排布。业务表单（对话框 / 抽屉 / 设置页）不再各自复制字段行
 * 实现导致间距漂移——密度经 variant 显式表达：
 * - dialog（默认）：对话框 / 抽屉的紧凑表单密度；
 * - page：整页设置表单的舒朗密度。
 * 标签固定小字弱化档（text-xs + muted）：与控件值拉开字级与色阶两档层级，
 * 全应用表单共用同一档位，不逐页覆写。
 * label 与 hint 文案由调用方经 i18n 字典注入（本组件不含用户可见文案）。
 */
function Field({
  label,
  hint,
  variant = "dialog",
  className,
  children,
  ...props
}: React.ComponentProps<"label"> & {
  label: React.ReactNode
  /** 控件下方的补充说明（可选） */
  hint?: React.ReactNode
  /** 密度形态：dialog＝对话框紧凑（默认）；page＝整页表单舒朗 */
  variant?: "dialog" | "page"
}) {
  return (
    <label
      data-slot="field"
      className={cn(
        "grid text-sm leading-none",
        variant === "dialog" ? "gap-1.5" : "gap-2",
        className,
      )}
      {...props}
    >
      <span data-slot="field-label" className="text-xs font-medium text-muted-foreground">
        {label}
      </span>
      {children}
      {hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}
    </label>
  )
}

export { Field }
