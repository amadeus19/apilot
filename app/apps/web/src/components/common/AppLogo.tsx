/**
 * 应用 logo：正视纸飞机剪影，与应用图标（src-tauri/icons/icon-source.svg）同构。
 * 令牌取色，明暗两主题等价。
 */

import { cn } from 'cn'

export function AppLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="APilot" className={cn('size-4.5', className)}>
      <rect x="1" y="1" width="22" height="22" rx="5" className="fill-primary" />
      <path d="M12 5.7 6.9 18.3 12 15l5.1 3.3Z" className="fill-primary-foreground" />
    </svg>
  )
}
