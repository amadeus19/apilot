import { Badge } from '@workspace/ui/components'
import { cn } from 'cn'

import { useI18n, type DictKey } from '@/i18n'
import { UpdateSection } from '@/features/update'

/**
 * 关于组：更新段（版本块 / 检查更新 / 自动检查开关，见 features/update）
 * ＋许可 / 文档链接＋Changelog 静态时间线（最新版展开）。
 */

/** Changelog 静态数据源（静态起步）；
 * 条目文案进字典（settings.changelog*），类型徽章三色（新增=绿 / 改进=琥珀 / 修复=主色） */
type ChangelogType = 'new' | 'improved' | 'fixed'

const CHANGELOG_V010: Array<{ type: ChangelogType; itemKey: DictKey }> = [
  { type: 'new', itemKey: 'settings.changelogV010Item1' },
  { type: 'new', itemKey: 'settings.changelogV010Item2' },
  { type: 'new', itemKey: 'settings.changelogV010Item3' },
  { type: 'new', itemKey: 'settings.changelogV010Item4' },
  { type: 'new', itemKey: 'settings.changelogV010Item5' },
  { type: 'new', itemKey: 'settings.changelogV010Item6' },
]

/** 深字浅底：两主题下均以本档色作文字色（浅底为 15% 淡彩），
 * 不用 *-foreground（浅色主题下为白字，压淡彩底不可读） */
const TYPE_BADGE_CLASS: Record<ChangelogType, string> = {
  new: 'bg-success/15 text-success',
  improved: 'bg-warning/15 text-warning',
  fixed: 'bg-primary/10 text-primary',
}

/** 仓库相关外链（Phase 1 无部署域名，指向仓库路径约定） */
const REPO_URL = 'https://github.com/amadeus19/Apilot2'
const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE.txt`

const TYPE_LABEL_KEY = {
  new: 'settings.changelogNew',
  improved: 'settings.changelogImproved',
  fixed: 'settings.changelogFixed',
} as const

export function AboutSection() {
  const { t } = useI18n()

  return (
    <section aria-label={t('settings.navAbout')} className="p-6">
      <h2 className="text-sm font-medium">{t('settings.navAbout')}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t('settings.navAboutDesc')}</p>

      {/* 更新段（features/update）：状态机在 useUpdateFlow，本组件不感知 */}
      <UpdateSection />

      {/* 许可 / 文档链接（外链占位：Phase 1 无部署域名，指向仓库路径约定） */}
      <div className="mt-3 flex items-center gap-2 text-xs">
        <a
          href={LICENSE_URL}
          target="_blank"
          rel="noreferrer"
          className="text-primary hover:underline"
        >
          {t('settings.licenseLink')}
        </a>
        <span className="text-muted-foreground">·</span>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="text-primary hover:underline"
        >
          {t('settings.docsLink')}
        </a>
      </div>

      {/* Changelog 时间线：类型徽章 + 条目列表（最新版展开） */}
      <h3 className="mt-6 text-sm font-medium">{t('settings.changelogTitle')}</h3>
      <div className="mt-3 rounded-lg border border-border p-4">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">v0.1.0</span>
          <Badge variant="secondary" className="font-mono text-micro">
            2026-09
          </Badge>
        </div>
        <p className="mt-2 text-sm text-foreground">{t('settings.changelogV010Intro')}</p>
        <ul className="mt-3 space-y-1.5">
          {CHANGELOG_V010.map(({ type, itemKey }) => (
            <li key={itemKey} className="flex items-start gap-2">
              <Badge
                variant="ghost"
                className={cn('mt-0.5 text-micro leading-3', TYPE_BADGE_CLASS[type])}
              >
                {t(TYPE_LABEL_KEY[type])}
              </Badge>
              <span className="min-w-0 text-xs leading-4 text-muted-foreground">{t(itemKey)}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
