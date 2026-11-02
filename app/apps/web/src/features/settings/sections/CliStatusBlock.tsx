import { CopyButton, CopySurface } from '@workspace/ui/components'
import { TriangleAlertIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { useI18n } from '@/i18n'
import type { CliStatus, IpcError } from '@/services/ipc'

/**
 * CLI 状态块：开关行下方恒显三行（版本 / 路径 / PATH），按七态呈现——
 * S1 正常；S2 未注册；S3 未注册＋被遮蔽；S4 已注册＋被遮蔽；S5 残留旧目录；
 * S6 二进制不可用（版本行 ⚠）；S7 开发构建目录（路径行警示）。
 *
 * 纯呈现：真值由 get_cli_status 聚合探测给出，此处只映射文案与警示，
 * 不提供修复动作——遮蔽 / 残留只报告，应用永不替用户重排或删除 PATH 条目。
 */
export function CliStatusBlock({
  status,
  error,
}: {
  status: CliStatus | undefined
  error: IpcError | null
}) {
  const { t } = useI18n()

  if (error) {
    return (
      <StatusRow
        label={t('settings.cliStatusPathEnv')}
        hint={<WarningLine>{t('settings.cliStatusFailed')}</WarningLine>}
        value={null}
        testId="cli-status-error"
      />
    )
  }

  if (!status) {
    const loading = t('settings.cliStatusLoading')
    return (
      <>
        <StatusRow
          label={t('settings.cliStatusVersion')}
          value={loading}
          testId="cli-status-version"
        />
        <StatusRow label={t('settings.cliStatusPath')} value={loading} testId="cli-status-path" />
        <StatusRow
          label={t('settings.cliStatusPathEnv')}
          value={loading}
          testId="cli-status-path-env"
        />
      </>
    )
  }

  // PATH 行附加说明：遮蔽（⚠）优先于残留（提示）；两者都无则不显示
  const pathEnvHint = status.shadowedBy ? (
    <WarningLine>
      {t(
        status.registered ? 'settings.cliShadowedRegistered' : 'settings.cliShadowedUnregistered',
        { dir: status.shadowedBy },
      )}
    </WarningLine>
  ) : status.staleDirs.length > 0 ? (
    <MutedLine>{t('settings.cliStaleHint')}</MutedLine>
  ) : null

  return (
    <>
      <StatusRow
        label={t('settings.cliStatusVersion')}
        hint={
          status.binaryAvailable ? null : (
            <WarningLine>{t('settings.cliBinaryUnavailable')}</WarningLine>
          )
        }
        value={status.version ?? '—'}
        testId="cli-status-version"
      />
      <StatusRow
        label={t('settings.cliStatusPath')}
        hint={
          <>
            <CopySurface className="mt-0.5 truncate font-mono text-xs leading-4 text-muted-foreground">
              {status.exePath}
            </CopySurface>
            {status.isDevBuild && <WarningLine>{t('settings.cliDevBuildWarning')}</WarningLine>}
          </>
        }
        control={
          <CopyButton
            variant="outline"
            size="sm"
            label={t('settings.cliCopyPath')}
            getText={() => status.exePath}
          />
        }
        testId="cli-status-path"
      />
      <StatusRow
        label={t('settings.cliStatusPathEnv')}
        hint={pathEnvHint}
        value={
          status.registered ? t('settings.cliPathRegistered') : t('settings.cliPathUnregistered')
        }
        testId="cli-status-path-env"
      />
    </>
  )
}

/** 与 SettingRow 同款布局（label 域承载动态内容，不用其 string API） */
function StatusRow({
  label,
  hint,
  value,
  control,
  testId,
}: {
  label: string
  hint?: ReactNode
  value?: string | null
  control?: ReactNode
  testId: string
}) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3.5" data-testid={testId}>
      <div className="min-w-0">
        <p className="text-sm leading-5 font-medium">{label}</p>
        {hint}
      </div>
      <div className="shrink-0">
        {control ?? (
          <span className="font-mono text-xs text-muted-foreground" data-testid={`${testId}-value`}>
            {value}
          </span>
        )}
      </div>
    </div>
  )
}

function WarningLine({ children }: { children: ReactNode }) {
  return (
    <p className="mt-0.5 flex items-start gap-1 text-xs leading-4 text-warning">
      <TriangleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
      <span>{children}</span>
    </p>
  )
}

function MutedLine({ children }: { children: ReactNode }) {
  return <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{children}</p>
}
