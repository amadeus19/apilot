import { useCallback } from 'react'

import { selectResolvedLocale, useSettingsStore } from '@/stores/settings.store'

import {
  formatBytes,
  formatDateTime as formatDateTimeFor,
  formatDuration,
  formatNumber as formatNumberFor,
  translate,
  type DictKey,
  type TranslateParams,
} from './core'

export {
  formatBytes,
  formatDateTime,
  formatNumber,
  formatDuration,
  translate,
  translateError,
  type DictKey,
  type TranslateParams,
} from './core'

/**
 * useI18n：订阅生效语言，切换即时 re-render——
 * `const { t } = useI18n(); t('shell.minimize')`。
 * 格式化器随 hook 返回绑定生效语言的闭包，业务代码不直接拼 Intl 的 locale 参数。
 */
export function useI18n() {
  const locale = useSettingsStore(selectResolvedLocale)

  const t = useCallback(
    (key: DictKey, params?: TranslateParams) => translate(locale, key, params),
    [locale],
  )
  const formatDateTime = useCallback(
    (value: Date | number) => formatDateTimeFor(value, locale),
    [locale],
  )
  const formatNumber = useCallback((value: number) => formatNumberFor(value, locale), [locale])

  return { locale, t, formatDateTime, formatNumber, formatDuration, formatBytes }
}
