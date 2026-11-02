import { Badge, Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@workspace/ui/components'
import { AppLogo } from '@/components/common/AppLogo'
import { useI18n } from '@/i18n'
import { useAppVersion } from '@/lib/use-app-version'

/**
 * 主区欢迎空态（无打开标签时的落点）：logo＋版本＋左栏入口引导文案。
 */
export function WorkspaceWelcome() {
  const { t } = useI18n()
  const version = useAppVersion()

  return (
    <Empty className="h-full">
      <EmptyHeader>
        <AppLogo className="size-10" />
        <EmptyTitle className="text-base">APilot</EmptyTitle>
        <Badge variant="secondary" className="font-mono text-micro">
          {`v${version}`}
        </Badge>
        <EmptyDescription>{t('shell.welcomeDescription')}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
