import { SparklesIcon, WrapTextIcon } from 'lucide-react'

import { Button, Tabs, TabsList, TabsTrigger } from '@workspace/ui/components'

import { useI18n } from '@/i18n'

import { isTextBodyKind, type BodyKind } from './body-envelope'

/**
 * Body 类型行：左侧六分段类型切换（pill 页签，标签恒英文协议名不翻译；
 * 无 auto——嗅探只作旧数据读侧迁移口径），右侧工具仅文本系（json/xml/text）
 * 显示——格式化（Sparkles 图标＋文字；json 需解析合法、xml 内容非空即可，
 * 禁用态给对应 hint）与自动换行（纯图标开关：选中常规工具色、未选中置灰，
 * 无底色填充）。行不画底边线（上方页签行已有线，近处再来一条是重复分隔）。
 */

/** 分段呈现序与字样（协议名与格式名原样恒不翻译；kind 值即信封 kind） */
const BODY_KIND_ITEMS: readonly { kind: BodyKind; label: string }[] = [
  { kind: 'none', label: 'none' },
  { kind: 'form-data', label: 'form-data' },
  { kind: 'urlencoded', label: 'x-www-form-urlencoded' },
  { kind: 'json', label: 'JSON' },
  { kind: 'xml', label: 'XML' },
  { kind: 'text', label: 'Text' },
]

export function BodyTypeRow({
  kind,
  onKindChange,
  formatEnabled,
  formatHint,
  onFormat,
  wordWrap,
  onWordWrapChange,
}: {
  kind: BodyKind
  onKindChange: (kind: BodyKind) => void
  /** 格式化可用性：json 需内容解析合法；xml 内容非空即可（畸形输入格式化器原样返回） */
  formatEnabled: boolean
  /** 禁用原因 hint（可用态为 null，不给 title；xml 无禁用态提示） */
  formatHint: string | null
  onFormat: () => void
  wordWrap: boolean
  onWordWrapChange: (next: boolean) => void
}) {
  const { t } = useI18n()
  return (
    <div className="mx-3 flex h-8 shrink-0 items-center gap-0.5" data-testid="editor-body-type-row">
      <Tabs
        value={kind}
        onValueChange={(value) => {
          const next = BODY_KIND_ITEMS.find((item) => item.kind === value)
          if (next) onKindChange(next.kind)
        }}
        className="min-h-0 gap-0"
      >
        <TabsList variant="pill">
          {BODY_KIND_ITEMS.map((item) => (
            <TabsTrigger key={item.kind} value={item.kind}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {isTextBodyKind(kind) && (
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs"
            disabled={!formatEnabled}
            title={formatHint ?? undefined}
            onClick={onFormat}
            data-testid="editor-body-format"
          >
            <SparklesIcon aria-hidden className="size-3.5" />
            {t('editor.bodyFormat')}
          </Button>
          {/* 自动换行＝纯图标开关：选中不带背景（图标取常规工具色），
              未选中把图标置灰即可——不要提亮，也不要底色填充 */}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-pressed={wordWrap}
            aria-label={t('editor.bodyWordWrap')}
            title={t('editor.bodyWordWrap')}
            onClick={() => onWordWrapChange(!wordWrap)}
            className={
              wordWrap
                ? 'text-muted-foreground'
                : 'text-muted-foreground/40 hover:text-muted-foreground'
            }
            data-testid="editor-body-word-wrap"
          >
            <WrapTextIcon aria-hidden />
          </Button>
        </div>
      )}
    </div>
  )
}
