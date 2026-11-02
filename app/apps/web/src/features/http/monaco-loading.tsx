import { Loader2Icon } from 'lucide-react'

import { useI18n } from '@/i18n'

/**
 * Monaco chunk 懒加载期间的居中 spinner 承载：请求 Body 与响应 Pretty 两处
 * Suspense 装配点共用。spinner 复用 Loader 旋转形态视觉（状态指示，非装饰）；
 * 容器 absolute inset-0 内居中，与编辑器装配层同一高度链，fallback 与编辑器
 * 互换不引起布局跳动。无障碍：role="status"＋aria-label（经 i18n 通用键注入）。
 */
export function MonacoLoading() {
  const { t } = useI18n()
  return (
    <div
      role="status"
      aria-label={t('common.editorLoading')}
      data-testid="monaco-loading"
      className="absolute inset-0 flex items-center justify-center"
    >
      <Loader2Icon aria-hidden className="size-3.5 animate-spin text-muted-foreground" />
    </div>
  )
}
