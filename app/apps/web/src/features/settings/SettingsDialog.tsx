import * as React from 'react'
import {
  ArchiveIcon,
  InfoIcon,
  KeyboardIcon,
  NetworkIcon,
  PaletteIcon,
  SearchIcon,
  TerminalIcon,
  LanguagesIcon,
} from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  SearchInput,
} from '@workspace/ui/components'
import { cn } from 'cn'

import { useI18n } from '@/i18n'
import { useAppStore } from '@/stores/app.store'
import { useSettingsStore } from '@/stores/settings.store'
import { SETTINGS_NAVS, type SettingsNav } from './navigation'
import { AppearanceSection } from './sections/AppearanceSection'
import { LanguageSection } from './sections/LanguageSection'
import { KeybindingsSection } from './sections/KeybindingsSection'
import { HttpSection } from './sections/HttpSection'
import { BackupSection } from './sections/BackupSection'
import { DeveloperSection } from './sections/DeveloperSection'
import { AboutSection } from './sections/AboutSection'

/**
 * 设置面板：模态 860×580 + 左 w-52 图标导航 +
 * 右单组内容滚动。入口＝标题栏设置按钮 / Ctrl+,（统一命令分发器）。
 * 搜索按组名 + 设置项标签过滤导航与内容（当前组被滤掉时回落到首个可见组）。
 */

const SECTION_ICONS: Record<SettingsNav['icon'], React.ComponentType<{ className?: string }>> = {
  palette: PaletteIcon,
  languages: LanguagesIcon,
  keyboard: KeyboardIcon,
  network: NetworkIcon,
  archive: ArchiveIcon,
  terminal: TerminalIcon,
  info: InfoIcon,
}

function SectionBody({ id }: { id: SettingsNav['id'] }) {
  switch (id) {
    case 'appearance':
      return <AppearanceSection />
    case 'language':
      return <LanguageSection />
    case 'keybindings':
      return <KeybindingsSection />
    case 'http':
      return <HttpSection />
    case 'backup':
      return <BackupSection />
    case 'developer':
      return <DeveloperSection />
    case 'about':
      return <AboutSection />
  }
}

export function SettingsDialog() {
  const { t } = useI18n()
  const open = useAppStore((s) => s.settingsOpen)
  const setOpen = useAppStore((s) => s.setSettingsOpen)
  // devMode 门控条目的过滤域开关：关时 gated 键/词不进搜索域，
  // 与 DeveloperSection 的条件渲染同语义
  const devModeOn = useSettingsStore((s) => s.devMode.enabled)

  const [activeId, setActiveId] = React.useState<SettingsNav['id']>('appearance')
  const [query, setQuery] = React.useState('')

  // 每次打开重置搜索并定位（模态是低频全局操作，回到起点符合预期；
  // 带初始组打开（如超时卡链接 HTTP 组）则定位到该组）。
  // 渲染期调整模式追踪 open 变化；justOpened 抑制同帧的导航回落
  // （重置后全组可见，回落条件天然不成立，与原 effect 时序语义一致）
  const initialNav = useAppStore((s) => s.settingsInitialNav)
  const [prevOpen, setPrevOpen] = React.useState(open)
  const justOpened = open && !prevOpen
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setQuery('')
      // 初始组经合法性校验（非法 / 未指定回落外观组）
      setActiveId(SETTINGS_NAVS.find((nav) => nav.id === initialNav)?.id ?? 'appearance')
    }
  }

  const lowerQuery = query.trim().toLowerCase()
  const visibleNavs = SETTINGS_NAVS.filter((nav) => {
    if (!lowerQuery) return true
    // 过滤域：组名 + 描述 + 组内设置行标签 + 英文别名；
    // gated 条目（键与别名）仅 devMode 开启时并入（与门控条件渲染同语义的叠加）
    const itemKeys = devModeOn
      ? [...(nav.itemKeys ?? []), ...(nav.gatedItemKeys ?? [])]
      : nav.itemKeys
    const itemText = (itemKeys ?? []).map((key) => t(key)).join(' ')
    const keywords = devModeOn ? `${nav.keywords} ${nav.gatedKeywords ?? ''}` : nav.keywords
    const haystack =
      `${t(nav.labelKey)} ${t(nav.descriptionKey)} ${itemText} ${keywords}`.toLowerCase()
    return haystack.includes(lowerQuery)
  })

  // 当前组被过滤掉时回落到首个可见组（渲染期调整模式，回落提交进 state——
  // 清空搜索后停留在回落组；可见组为空时保持现组，由下方占位提示接管）
  if (!justOpened && visibleNavs.length > 0 && !visibleNavs.some((nav) => nav.id === activeId)) {
    setActiveId(visibleNavs[0].id)
  }

  // 搜索过滤后当前组是否仍可见（不可见时右侧回落占位提示，避免内容与导航脱节）
  const activeVisible = visibleNavs.some((nav) => nav.id === activeId)

  const activeNav = SETTINGS_NAVS.find((n) => n.id === activeId)

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => setOpen(nextOpen)}>
      {/* 860×580 规格：用 style 固定——DialogContent 默认
          sm:max-w-sm 在 Tailwind 变体层优先级高于任意值类，类名对冲不可靠 */}
      <DialogContent
        className="flex flex-col gap-0 overflow-hidden p-0"
        style={{
          width: 860,
          height: 580,
          maxWidth: 'calc(100vw - 2rem)',
          maxHeight: 'calc(100vh - 2rem)',
        }}
      >
        {/* 标题与搜索同一行（底座调整定案）：搜索框定宽右置，头部只占一行 */}
        <DialogHeader className="border-b px-5 py-3">
          <div className="flex items-center gap-4">
            <DialogTitle className="shrink-0 text-base">{t('settings.title')}</DialogTitle>
            <DialogDescription className="sr-only">{t('settings.description')}</DialogDescription>
            <div className="relative w-80">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
              <SearchInput
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('settings.searchPlaceholder')}
                className="h-9 pl-8"
                aria-label={t('settings.searchPlaceholder')}
              />
            </div>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          {/* 左侧图标导航：w-52，组名 + 描述两行 */}
          <nav
            aria-label={t('settings.title')}
            className="w-52 shrink-0 overflow-y-auto border-r bg-sidebar p-2"
          >
            {visibleNavs.map((nav) => {
              const Icon = SECTION_ICONS[nav.icon]
              const active = nav.id === activeId
              return (
                <button
                  key={nav.id}
                  type="button"
                  onClick={() => setActiveId(nav.id)}
                  aria-current={active ? 'true' : undefined}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors outline-none',
                    'focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'bg-selection text-sidebar-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm leading-5">{t(nav.labelKey)}</span>
                    <span className="block truncate text-xs leading-4 opacity-70">
                      {t(nav.descriptionKey)}
                    </span>
                  </span>
                </button>
              )
            })}
            {visibleNavs.length === 0 && (
              <p className="px-2.5 py-4 text-xs text-muted-foreground">
                {t('settings.searchNoResults')}
              </p>
            )}
          </nav>

          {/* 右侧单组内容滚动 */}
          <div className="min-w-0 flex-1 overflow-y-auto">
            {activeNav &&
              (activeVisible ? (
                <SectionBody id={activeId} />
              ) : (
                <div className="p-6">
                  <h2 className="text-sm font-medium">{t(activeNav.labelKey)}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t(activeNav.descriptionKey)}
                  </p>
                  <p className="mt-8 text-center text-sm text-muted-foreground">
                    {t('settings.searchNoResults')}
                  </p>
                </div>
              ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
