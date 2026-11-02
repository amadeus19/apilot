import type { ReactNode } from 'react'

import { cn } from 'cn'

/**
 * 卡片式设置行：左标签（＋可选描述）、右控件，
 * divide-y 分隔——组内多行容器用 SettingRows 包裹。
 */
export function SettingRows({ children }: { children: ReactNode }) {
  return (
    <div className="divide-border rounded-lg border bg-card">
      <div className="divide-y">{children}</div>
    </div>
  )
}

export function SettingRow({
  label,
  description,
  control,
  htmlFor,
  className,
}: {
  label: string
  description?: string
  control: ReactNode
  htmlFor?: string
  className?: string
}) {
  return (
    <div className={cn('flex items-center justify-between gap-6 px-4 py-3.5', className)}>
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="block text-sm leading-5 font-medium">
          {label}
        </label>
        {description && (
          <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  )
}
