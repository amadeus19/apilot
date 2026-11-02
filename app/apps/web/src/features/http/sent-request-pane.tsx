import * as React from 'react'

import { Button, CopyButton, CopySurface } from '@workspace/ui/components'

import { useI18n } from '@/i18n'
import { MethodBadge } from '@/features/api-tree/method-badge'
import { isSensitiveHeader, maskSecretValues, maskUrlQuery } from './constants'
import type { RequestSnapshotDto } from './http-api'

/**
 * 「已发送请求」分区：sent mirror 回显（最终 URL / headers），鉴权可视化
 * 落点——实际注入的认证头在此可见。敏感值默认脱敏（标准敏感头名单＋本次
 * 请求 redactions 提示的自定义头名 / query 键＋Secret 变量消费值全文替换），
 * 「显示敏感值」供开发调试显式放行；复制口径恒掩码（不随放行泄漏）。
 */
export function SentRequestPane({ request }: { request: RequestSnapshotDto }) {
  const { t } = useI18n()
  const [reveal, setReveal] = React.useState(false)
  const secretValues = request.redactions.secretValues

  // Secret 值全文替换在 query 键掩码之外（覆盖 path 段与非名单头的任意位置）；
  // 两个口径串联应用
  const maskedUrl = maskSecretValues(
    maskUrlQuery(request.url, request.redactions.queryKeys),
    secretValues,
    false,
  )
  const url = reveal ? request.url : maskedUrl

  // 复制口径＝掩码后的展示 URL：敏感 query 与 Secret 值恒掩码（不随「显示
  // 敏感值」放行——复制内容可能被粘贴到日志 / 工单，不给出泄露通道）
  const copyUrl = (): string => maskedUrl

  // 复制口径＝每行 name: value 的脱敏文本：敏感头与 Secret 值恒掩码（同上）
  const copyHeaders = (): string =>
    request.headers
      .map(([name, value]) => {
        const sensitive = isSensitiveHeader(name, request.redactions.headerNames)
        const masked = sensitive ? '***' : maskSecretValues(value, secretValues, false)
        return `${name}: ${masked}`
      })
      .join('\n')

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="response-sent-request">
      <div className="flex items-center gap-2 font-mono text-xs break-all">
        <MethodBadge method={request.method} />
        <span data-testid="response-sent-url">{url}</span>
      </div>
      <CopySurface className="flex flex-col gap-0.5" data-testid="response-sent-headers">
        {request.headers.map(([name, value], index) => {
          // 行掩码口径：敏感名单头整值 ***；非名单头做 Secret 值全文替换
          // （替换后的部分值掩码，如 "Bearer sk-x" → "Bearer ***"）
          const sensitive = isSensitiveHeader(name, request.redactions.headerNames)
          const maskedValue = sensitive ? '***' : maskSecretValues(value, secretValues, false)
          const masked = maskedValue !== value
          return (
            <div key={`${index}-${name}`} className="flex gap-2 text-xs">
              <dt className="w-48 shrink-0 truncate text-muted-foreground" title={name}>
                {name}
              </dt>
              <dd
                className={`min-w-0 flex-1 truncate font-mono ${
                  masked && !reveal ? 'text-muted-foreground' : ''
                }`}
                title={masked && !reveal ? undefined : value}
              >
                {masked && !reveal ? maskedValue : value}
              </dd>
            </div>
          )
        })}
      </CopySurface>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          aria-pressed={reveal}
          onClick={() => setReveal((prev) => !prev)}
        >
          {reveal ? t('response.hideSecrets') : t('response.showSecrets')}
        </Button>
        <CopyButton
          variant="ghost"
          className="h-6 px-2 text-xs"
          label={t('response.copyUrl')}
          data-testid="response-sent-copy-url"
          getText={copyUrl}
        />
        <CopyButton
          variant="ghost"
          className="h-6 px-2 text-xs"
          label={t('response.copyAllHeaders')}
          getText={copyHeaders}
        />
      </div>
    </div>
  )
}
