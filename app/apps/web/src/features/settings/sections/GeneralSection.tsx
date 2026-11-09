import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@workspace/ui/components'

import { useI18n, type DictKey } from '@/i18n'
import { CLOSE_BEHAVIOR_ACTIONS, type CloseBehaviorAction } from '@/lib/settings-schema'
import { useSettingsStore } from '@/stores/settings.store'
import { SettingRow, SettingRows } from '@/components/common/SettingRow'

/**
 * 通用组：应用级行为偏好。关闭按钮行为三态下拉
 * （每次询问 / 最小化到托盘 / 退出应用），切换即时生效，
 * 持久化协议同其余偏好（写失败不回滚）。
 */

/** 关闭按钮行为三态的标签键（下拉项文案经字典注入） */
const CLOSE_BEHAVIOR_LABEL_KEYS: Record<CloseBehaviorAction, DictKey> = {
  ask: 'settings.closeBehaviorAsk',
  tray: 'settings.closeBehaviorTray',
  exit: 'settings.closeBehaviorExit',
}

export function GeneralSection() {
  const { t } = useI18n()
  const action = useSettingsStore((s) => s.closeBehavior.action)
  const setCloseBehavior = useSettingsStore((s) => s.setCloseBehavior)

  return (
    <section aria-label={t('settings.navGeneral')} className="p-6">
      <h2 className="text-sm font-medium">{t('settings.navGeneral')}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t('settings.navGeneralDesc')}</p>

      <div className="mt-5">
        <SettingRows>
          <SettingRow
            label={t('settings.closeBehaviorLabel')}
            description={t('settings.closeBehaviorDesc')}
            htmlFor="settings-close-behavior"
            control={
              <Select
                value={action}
                onValueChange={(value) => setCloseBehavior(value as CloseBehaviorAction)}
              >
                <SelectTrigger
                  id="settings-close-behavior"
                  className="w-40"
                  aria-label={t('settings.closeBehaviorLabel')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CLOSE_BEHAVIOR_ACTIONS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(CLOSE_BEHAVIOR_LABEL_KEYS[value])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        </SettingRows>
      </div>
    </section>
  )
}
