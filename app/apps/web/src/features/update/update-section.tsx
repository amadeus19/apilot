import { Badge, Button, Switch } from '@workspace/ui/components'
import { AppLogo } from '@/components/common/AppLogo'
import { useUpdateFlow } from './use-update-flow'
import { useI18n } from '@/i18n'
import { useAppVersion } from '@/lib/use-app-version'
import { useSettingsStore } from '@/stores/settings.store'
import { SettingRow, SettingRows } from '@/components/common/SettingRow'

/**
 * 更新段视图（纯视图）：版本块 + 检查更新按钮 + 可安装横幅 + 自动检查
 * 开关。全部流程状态（checking / installing / availableVersion）来自
 * useUpdateFlow 单一事实源，本组件不持有流程状态；就绪确认对话框在根
 * 挂载（features/update/update-ready-dialog.tsx）。
 */
export function UpdateSection() {
  const { t } = useI18n()
  const version = useAppVersion()
  const checking = useUpdateFlow((s) => s.checking)
  const installing = useUpdateFlow((s) => s.installing)
  const availableVersion = useUpdateFlow((s) => s.availableVersion)
  const availableIsDowngrade = useUpdateFlow((s) => s.availableIsDowngrade)
  const checkUpdates = useUpdateFlow((s) => s.checkUpdates)
  const downloadAndInstall = useUpdateFlow((s) => s.downloadAndInstall)
  // 自动检查更新开关（boot 静默检查的闸门；检查动作本体在 services/update-check）
  const autoCheckEnabled = useSettingsStore((s) => s.autoCheckUpdates.enabled)
  const setAutoCheckUpdates = useSettingsStore((s) => s.setAutoCheckUpdates)

  return (
    <>
      {/* 版本块 */}
      <div className="mt-5 flex items-center gap-3 rounded-lg border border-border bg-card p-4">
        <AppLogo className="size-10 shrink-0" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">APilot</span>
            <Badge variant="secondary" className="font-mono text-micro">
              v{version}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('settings.versionLabel')} {version} ·{' '}
            {t(import.meta.env.DEV ? 'settings.buildDebug' : 'settings.buildRelease')}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => {
            void checkUpdates()
          }}
          disabled={checking}
        >
          {t('settings.checkUpdates')}
        </Button>
      </div>

      {/* 检查出可安装版本后出现（升级 / 回滚同一路径）：校验通过弹就绪确认
          对话框，确认后才安装。回滚用警示配色与专属文案区分方向。 */}
      {availableVersion && (
        <div
          className={`mt-3 flex items-center gap-2 rounded-lg border p-3 ${
            availableIsDowngrade
              ? 'border-warning/40 bg-warning/10'
              : 'border-success/40 bg-success/10'
          }`}
        >
          <p className="min-w-0 flex-1 text-xs text-foreground">
            {t(
              availableIsDowngrade
                ? 'settings.updateDowngradeBadge'
                : 'settings.updateAvailableBadge',
              { version: availableVersion },
            )}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void downloadAndInstall()
            }}
            disabled={installing}
          >
            {t('settings.downloadAndInstall')}
          </Button>
        </div>
      )}

      {/* 自动检查更新开关 */}
      <div className="mt-3">
        <SettingRows>
          <SettingRow
            label={t('settings.autoCheckUpdates')}
            description={t('settings.autoCheckUpdatesDesc')}
            htmlFor="settings-auto-check-updates"
            control={
              <Switch
                id="settings-auto-check-updates"
                checked={autoCheckEnabled}
                onCheckedChange={setAutoCheckUpdates}
              />
            }
          />
        </SettingRows>
      </div>
    </>
  )
}
