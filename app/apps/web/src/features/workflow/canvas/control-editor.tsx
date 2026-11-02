import { Field, Input } from '@workspace/ui/components'

import { useI18n } from '@/i18n'

import type { DelayNodeConfig, RetryNodeConfig } from '../workflow-model'

/**
 * 控制组节点配置编辑面（延时 / 重试）：延时＝固定等待毫秒；重试＝最大
 * 重试次数与重试间隔（本节点不单独执行，作用于紧接的下游节点）。数值
 * 输入以空串回落 0（0＝无延时 / 无重试语义），非数字输入不落配置。改动
 * 经更新通道落编辑会话（标脏，保存走工具栏 / Ctrl+S）。
 */

/** 数值输入的统一解析：空串＝0（无语义值），非数字输入回落原值不落库 */
function parseCount(value: string, fallback: number): number {
  if (value.trim() === '') return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback
}

export function DelayEditor({
  config,
  onChange,
}: {
  config: DelayNodeConfig
  onChange: (next: DelayNodeConfig) => void
}) {
  const { t } = useI18n()
  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="workflow-delay-editor">
      <Field label={t('workflows.delayDurationLabel')}>
        <Input
          type="number"
          min={0}
          value={config.durationMs}
          className="h-6 px-1.5 font-mono text-xs"
          onChange={(event) =>
            onChange({
              ...config,
              durationMs: parseCount(event.target.value, config.durationMs),
            })
          }
        />
      </Field>
      <p className="text-micro text-muted-foreground">{t('workflows.delayHint')}</p>
    </div>
  )
}

export function RetryEditor({
  config,
  onChange,
}: {
  config: RetryNodeConfig
  onChange: (next: RetryNodeConfig) => void
}) {
  const { t } = useI18n()
  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="workflow-retry-editor">
      <Field label={t('workflows.retryAttemptsLabel')}>
        <Input
          type="number"
          min={0}
          value={config.maxAttempts}
          className="h-6 px-1.5 font-mono text-xs"
          onChange={(event) =>
            onChange({
              ...config,
              maxAttempts: parseCount(event.target.value, config.maxAttempts),
            })
          }
        />
      </Field>
      <Field label={t('workflows.retryIntervalLabel')}>
        <Input
          type="number"
          min={0}
          value={config.intervalMs}
          className="h-6 px-1.5 font-mono text-xs"
          onChange={(event) =>
            onChange({
              ...config,
              intervalMs: parseCount(event.target.value, config.intervalMs),
            })
          }
        />
      </Field>
      <p className="text-micro text-muted-foreground">{t('workflows.retryHint')}</p>
    </div>
  )
}
