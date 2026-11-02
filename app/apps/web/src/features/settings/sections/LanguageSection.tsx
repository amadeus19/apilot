import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@workspace/ui/components'

import { useI18n } from '@/i18n'
import { LOCALES, type LocalePreference } from '@/lib/settings-schema'
import { useSettingsStore } from '@/stores/settings.store'
import { SettingRow, SettingRows } from '@/components/common/SettingRow'

/**
 * 语言组：三态下拉（用户指定形态，非卡片/分段），
 * 行式布局左标签右下拉；跟随系统显示解析行。切换即时生效（字典链路），
 * 持久化协议同主题（写失败不回滚）。语言切换入口只在设置面板。
 */
export function LanguageSection() {
  const { t, locale: resolvedLocale } = useI18n()
  const preference = useSettingsStore((s) => s.locale.preference)
  const setLocalePreference = useSettingsStore((s) => s.setLocalePreference)

  const valueLabel = resolvedLocale === 'en' ? t('settings.languageEn') : t('settings.languageZh')

  return (
    <section aria-label={t('settings.navLanguage')} className="p-6">
      <h2 className="text-sm font-medium">{t('settings.navLanguage')}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t('settings.navLanguageDesc')}</p>

      <div className="mt-5">
        <SettingRows>
          <SettingRow
            label={t('settings.languageLabel')}
            description={t('settings.languageDesc')}
            htmlFor="settings-locale"
            control={
              <Select
                value={preference}
                onValueChange={(value) => setLocalePreference(value as LocalePreference)}
              >
                <SelectTrigger
                  id="settings-locale"
                  className="w-40"
                  aria-label={t('settings.languageLabel')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOCALES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value === 'system'
                        ? t('settings.languageSystem')
                        : value === 'zh-CN'
                          ? t('settings.languageZh')
                          : t('settings.languageEn')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        </SettingRows>

        {preference === 'system' && (
          <p className="mt-3 text-xs text-muted-foreground" data-testid="locale-resolved">
            {t('settings.languageResolved', { value: valueLabel })}
          </p>
        )}
      </div>
    </section>
  )
}
