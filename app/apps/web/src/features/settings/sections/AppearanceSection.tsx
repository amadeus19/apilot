import { cn } from 'cn'

import { Radio, RadioGroup } from '@workspace/ui/components'

import { useI18n } from '@/i18n'
import { ACCENTS, type AccentName, type ThemePreference } from '@/lib/settings-schema'
import { selectResolvedTheme, useSettingsStore } from '@/stores/settings.store'
import { SettingRow, SettingRows } from '@/components/common/SettingRow'

/**
 * 外观组：主题三态迷你预览卡（浅 / 深 / 跟随系统，
 * 各带窗口缩略示意）＋ 6 强调色板（即时生效，data-accent 通道）；
 * 跟随系统显示解析行（当前解析值）。
 */

/** 色板静态代表值（globals.css 浅色 --primary，不随当前 accent 变）；
 * graphite 取中性灰而非近黑浅色主值——色板需在明暗两主题背景上均可辨 */
const ACCENT_SWATCH: Record<AccentName, string> = {
  indigo: 'oklch(0.546 0.16 258)',
  teal: 'oklch(0.54 0.11 172)',
  violet: 'oklch(0.54 0.18 300)',
  orange: 'oklch(0.55 0.14 45)',
  rose: 'oklch(0.55 0.17 15)',
  graphite: 'oklch(0.55 0 0)',
}

/** 窗口缩略示意：顶栏 + 内容两块。配色为固定中性色而非主题令牌——
 * 预览必须在明暗两主题下呈现一致，跟随令牌会随主题反转 */
function MiniWindow({ variant }: { variant: 'light' | 'dark' | 'split' }) {
  const light = { pane: 'bg-white', bar: 'bg-neutral-300', body: 'bg-neutral-200' }
  const dark = { pane: 'bg-neutral-800', bar: 'bg-neutral-600', body: 'bg-neutral-700' }
  const tone = variant === 'dark' ? dark : light
  return (
    <span
      aria-hidden
      className={cn(
        'mx-auto flex h-14 w-20 flex-col overflow-hidden rounded-md border border-border/60',
        variant !== 'split' && tone.pane,
      )}
    >
      {variant === 'split' ? (
        <span className="flex h-full">
          <span className="flex flex-1 flex-col gap-1 bg-white p-1.5">
            <span className="h-1.5 w-full rounded-sm bg-neutral-300" />
            <span className="h-4 w-full rounded-sm bg-neutral-200" />
          </span>
          <span className="flex flex-1 flex-col gap-1 bg-neutral-800 p-1.5">
            <span className="h-1.5 w-full rounded-sm bg-neutral-600" />
            <span className="h-4 w-full rounded-sm bg-neutral-700" />
          </span>
        </span>
      ) : (
        <>
          <span className={cn('mt-1.5 ml-1.5 h-1.5 w-8 rounded-sm', tone.bar)} />
          <span className={cn('mx-1.5 mt-1.5 h-6 w-auto rounded-sm', tone.body)} />
        </>
      )}
    </span>
  )
}

/** 主题卡单选项（Radio 自定义视觉）：选中态描边 + 悬停提亮由 data-checked
 * 驱动；roving tabindex / 方向键导航 / Space 选中由所在 RadioGroup 提供 */
function ThemeCard({
  value,
  label,
  children,
}: {
  value: ThemePreference
  label: string
  children: React.ReactNode
}) {
  return (
    <Radio
      value={value}
      className={cn(
        'flex w-24 flex-col gap-1.5 rounded-lg border p-2 pb-1.5 ring-border transition-colors hover:bg-accent focus-visible:ring-ring',
        'data-checked:border-primary data-checked:ring-2 data-checked:ring-primary',
      )}
    >
      {children}
      <span className="text-center text-xs leading-4 text-foreground">{label}</span>
    </Radio>
  )
}

export function AppearanceSection() {
  const { t } = useI18n()
  const preference = useSettingsStore((s) => s.theme.preference)
  const accent = useSettingsStore((s) => s.theme.accent)
  const setThemePreference = useSettingsStore((s) => s.setThemePreference)
  const setAccent = useSettingsStore((s) => s.setAccent)
  const resolvedTheme = useSettingsStore(selectResolvedTheme)

  const resolvedThemeText =
    resolvedTheme === 'dark' ? t('settings.themeDark') : t('settings.themeLight')
  const accentNameKey = {
    indigo: 'settings.accentIndigo',
    teal: 'settings.accentTeal',
    violet: 'settings.accentViolet',
    orange: 'settings.accentOrange',
    rose: 'settings.accentRose',
    graphite: 'settings.accentGraphite',
  } as const

  return (
    <section aria-label={t('settings.navAppearance')} className="p-6">
      <h2 className="text-sm font-medium">{t('settings.navAppearance')}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t('settings.navAppearanceDesc')}</p>

      <div className="mt-5">
        <SettingRows>
          <SettingRow
            label={t('settings.themeLabel')}
            description={t('settings.themeDesc')}
            control={
              <RadioGroup
                aria-label={t('settings.themeLabel')}
                value={preference}
                onValueChange={(value) => setThemePreference(value as ThemePreference)}
                className="flex w-auto flex-row gap-2"
              >
                <ThemeCard value="light" label={t('settings.themeLight')}>
                  <MiniWindow variant="light" />
                </ThemeCard>
                <ThemeCard value="dark" label={t('settings.themeDark')}>
                  <MiniWindow variant="dark" />
                </ThemeCard>
                <ThemeCard value="system" label={t('settings.themeSystem')}>
                  <MiniWindow variant="split" />
                </ThemeCard>
              </RadioGroup>
            }
          />

          <SettingRow
            label={t('settings.accentLabel')}
            description={t('settings.accentDesc')}
            control={
              <RadioGroup
                aria-label={t('settings.accentLabel')}
                value={accent}
                onValueChange={(value) => setAccent(value as AccentName)}
                className="flex w-auto flex-row items-center gap-2"
              >
                {ACCENTS.map((name: AccentName) => (
                  <Radio
                    key={name}
                    value={name}
                    title={t(accentNameKey[name])}
                    style={{ backgroundColor: ACCENT_SWATCH[name] }}
                    className={cn(
                      'size-6 rounded-full ring-offset-card transition-shadow hover:ring-foreground/40 focus-visible:ring-offset-2',
                      'ring-1 ring-border',
                      'data-checked:ring-2 data-checked:ring-foreground data-checked:ring-offset-2',
                    )}
                  />
                ))}
              </RadioGroup>
            }
          />
        </SettingRows>

        {/* 跟随系统的解析行：system 态显示当前解析值 */}
        {preference === 'system' && (
          <p className="mt-3 text-xs text-muted-foreground" data-testid="theme-resolved">
            {t('settings.themeSystemResolved', { value: resolvedThemeText })}
          </p>
        )}
      </div>
    </section>
  )
}
