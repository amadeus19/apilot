import * as React from 'react'

import { Badge, CopyButton } from '@workspace/ui/components'

import { useI18n } from '@/i18n'
import { maskSecretValues } from './constants'
import type { ResolvedPreviewDto } from './http-api'

/**
 * 变量解析预览（Variable Preview）：展示本次发送的解析后 URL 与值命中
 * 明细（命中 / 未命中标示），确认变量消费情况。数据源＝发送响应附带的
 * resolved 信息（预览不新增 IPC——与 GUI 发送、CLI `api run` 同一 Rust
 * Resolver 的产物）。
 *
 * 掩码口径：Secret 行的解析值默认掩码（全路径脱敏纪律，与生效集右栏
 * 一致）；「显示敏感值」仅放行本面板展示。
 */
export function VariablePreview({ resolved }: { resolved: ResolvedPreviewDto }) {
  const { t } = useI18n()
  const [reveal, setReveal] = React.useState(false)
  const hasSecrets = resolved.hits.some((hit) => hit.hit && hit.secret)

  // 预览 URL 的 Secret 值掩码随「显示明文」放行；复制口径恒掩码（MaskedUrl
  // 固定不随放行变化——剪贴板内容可能被粘贴到日志 / 工单）。掩码输入＝后端
  // 算好的消费清单（与请求镜像 redactions 同源）
  const maskedUrl = maskSecretValues(resolved.url, resolved.secretValues, false)
  const resolvedUrl = reveal ? resolved.url : maskedUrl

  return (
    <div className="flex flex-col gap-2 border-t border-border p-3" data-testid="variable-preview">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium">{t('variables.preview.title')}</span>
        {hasSecrets && (
          <ButtonGhostToggle reveal={reveal} onToggle={() => setReveal((prev) => !prev)} />
        )}
      </div>
      <div className="flex items-center gap-1.5 text-micro">
        <span className="shrink-0 text-muted-foreground">
          {t('variables.preview.resolvedUrlLabel')}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono select-text"
          data-testid="variable-preview-url"
        >
          {resolvedUrl}
        </span>
        <CopyButton
          variant="ghost"
          className="h-5 shrink-0 px-1.5"
          aria-label={t('variables.preview.copyUrl')}
          data-testid="variable-preview-copy-url"
          // 复制口径恒掩码（Secret 值不随「显示明文」放行进剪贴板）
          getText={() => maskedUrl}
        />
      </div>
      {resolved.hits.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('variables.preview.empty')}</p>
      ) : (
        <dl className="flex flex-col gap-0.5" data-testid="variable-preview-hits">
          {resolved.hits.map((hit, index) => (
            <div key={`${index}-${hit.key}`} className="flex items-center gap-2 text-xs">
              <dt
                className="w-48 shrink-0 truncate font-mono text-muted-foreground"
                title={hit.key}
              >
                {hit.key}
              </dt>
              <dd className="flex min-w-0 flex-1 items-center gap-1.5">
                <span
                  className={`min-w-0 flex-1 truncate font-mono ${
                    hit.hit ? '' : 'text-muted-foreground'
                  }`}
                  title={hit.hit && hit.secret && !reveal ? undefined : hit.resolved}
                  data-testid="variable-preview-hit-value"
                >
                  {hit.hit
                    ? hit.secret && !reveal
                      ? '***'
                      : hit.resolved
                    : `${t('variables.preview.missedBadge')} · ${hit.template}`}
                </span>
                {hit.secret && hit.hit && (
                  <Badge variant="outline" className="h-4 shrink-0 px-1.5 text-micro">
                    {t('variables.preview.secretBadge')}
                  </Badge>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

/** Secret 行的「显示敏感值」放行（仅展示侧；复制口径恒掩码） */
function ButtonGhostToggle({ reveal, onToggle }: { reveal: boolean; onToggle: () => void }) {
  const { t } = useI18n()
  return (
    <button
      type="button"
      className="h-5 rounded px-1.5 text-micro text-muted-foreground hover:bg-accent hover:text-foreground"
      aria-pressed={reveal}
      onClick={onToggle}
    >
      {reveal ? t('variables.config.hideSecret') : t('variables.config.showSecret')}
    </button>
  )
}
