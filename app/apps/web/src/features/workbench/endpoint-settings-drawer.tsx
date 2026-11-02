import * as React from 'react'

import { Settings2Icon, XIcon } from 'lucide-react'

import {
  Button,
  Field,
  Input,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
} from '@workspace/ui/components'

import { useI18n, type DictKey } from '@/i18n'

/**
 * 接口设置抽屉：接口级超时覆写（user_data 域，手工与同步接口共有）
 * ＋标题重命名与分类归属（endpoints 域）：同步接口这两行置灰锁定——
 * 标题与分组随同步文档更新（应用时按文档值覆写），禁止本地编辑。
 * 覆盖式形态——Sheet 锚定到工作台主区容器（覆盖参数区与响应区，
 * 不遮标签栏与左栏），从右缘滑入；模态语义（遮罩点击关闭、Esc、
 * 焦点圈禁）与进出场动画的卸载时机由 Base UI 托管；
 * 关闭后焦点归还触发按钮（focusTargetRef 由调用方传入）。
 */

/** 超时三态（继承全局＝null / 不限制＝0 / 自定义＝正整数秒） */
type TimeoutMode = 'inherit' | 'unlimited' | 'custom'

const TIMEOUT_MODES: readonly TimeoutMode[] = ['inherit', 'unlimited', 'custom']

/** 三态的标签键（单选项文案经字典注入） */
const TIMEOUT_MODE_LABEL_KEYS: Record<TimeoutMode, DictKey> = {
  inherit: 'editor.timeoutInherit',
  unlimited: 'editor.timeoutUnlimited',
  custom: 'editor.timeoutCustom',
}

function deriveTimeoutMode(timeoutSeconds: number | null): TimeoutMode {
  if (timeoutSeconds === null) return 'inherit'
  if (timeoutSeconds === 0) return 'unlimited'
  return 'custom'
}

/** 自定义秒数解析：1–86400 整数（与 Rust 侧写前校验同值域），非法返回 null 不上抛 */
function parseCustomSeconds(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 86400) return null
  return parsed
}

export interface EndpointSettingsDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 关闭后焦点归还的目标（面包屑设置按钮） */
  focusReturnRef: React.RefObject<HTMLButtonElement | null>
  /** 标题 / 分类置灰锁定（同步接口：随同步文档更新，禁止本地编辑） */
  entityLocked: boolean
  title: string
  categoryId: string | null
  /** 分类选项（当前服务的分类清单） */
  categories: { id: string; name: string }[]
  onTitleChange: (title: string) => void
  onCategoryChange: (categoryId: string | null) => void
  /** 接口级超时覆写（null 继承全局 / 0 不限制 / >0 秒） */
  timeoutSeconds: number | null
  onTimeoutChange: (timeoutSeconds: number | null) => void
}

/** 抽屉宿主：工作台主区容器（覆盖参数区＋响应区的定位基准）；缺位时兜底 body */
function drawerHost(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  return document.querySelector<HTMLElement>('[data-slot="workbench-main"]') ?? document.body
}

export function EndpointSettingsDrawer({
  open,
  onOpenChange,
  focusReturnRef,
  entityLocked,
  title,
  categoryId,
  categories,
  onTitleChange,
  onCategoryChange,
  timeoutSeconds,
  onTimeoutChange,
}: EndpointSettingsDrawerProps) {
  const { t } = useI18n()
  const titleInputRef = React.useRef<HTMLInputElement>(null)
  // 超时组名标题 id（RadioGroup aria-labelledby 关联点）
  const timeoutHeadingId = React.useId()

  // —— 超时三态本地编辑态：单选切换即时上抛（null / 0），「自定义」等
  // 有效秒数落定才写（中间输入态不发起写）；重开抽屉回落当前生效值 ——
  const [timeoutMode, setTimeoutMode] = React.useState<TimeoutMode>(() =>
    deriveTimeoutMode(timeoutSeconds),
  )
  const [customInput, setCustomInput] = React.useState(() =>
    timeoutSeconds !== null && timeoutSeconds > 0 ? String(timeoutSeconds) : '',
  )
  // 渲染期调整：每次打开以当前生效值重置编辑态（上次会话未落定的选择不残留）
  const [prevOpen, setPrevOpen] = React.useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) {
      setTimeoutMode(deriveTimeoutMode(timeoutSeconds))
      setCustomInput(timeoutSeconds !== null && timeoutSeconds > 0 ? String(timeoutSeconds) : '')
    }
  }

  /** 自定义秒数落定：有效值即时上抛（调用方防抖整包写） */
  const commitCustomSeconds = (raw: string) => {
    const seconds = parseCustomSeconds(raw)
    if (seconds !== null) onTimeoutChange(seconds)
  }

  /** 失焦回落：无效输入不改写生效值，显示回落为当前生效值（无则清空待输入） */
  const normalizeCustomInput = () => {
    if (parseCustomSeconds(customInput) === null) {
      setCustomInput(timeoutSeconds !== null && timeoutSeconds > 0 ? String(timeoutSeconds) : '')
    }
  }

  const handleTimeoutModeChange = (mode: TimeoutMode) => {
    setTimeoutMode(mode)
    if (mode === 'inherit') onTimeoutChange(null)
    else if (mode === 'unlimited') onTimeoutChange(0)
    // custom：切到自定义时若输入框已有有效值立即复写，否则等输入落定
    else commitCustomSeconds(customInput)
  }

  // 打开即聚焦标题输入（可编辑时的高频编辑对象，晚一拍压过库的默认首焦点）；
  // 锁定态无聚焦目标，首焦点交由库的默认圈禁；关闭时焦点归还触发按钮。
  // 归还目标在打开时刻定格（捕获节点而非清理期再读 ref——后者可能已改指）
  React.useEffect(() => {
    if (!open) return
    const returnNode = focusReturnRef.current
    const timer = window.setTimeout(() => {
      if (!entityLocked) titleInputRef.current?.focus()
    }, 0)
    return () => {
      window.clearTimeout(timer)
      returnNode?.focus()
    }
  }, [open, focusReturnRef, entityLocked])

  // value→label 映射：触发器显示分类名而非实体 id（Base UI SelectValue 默认渲染原始值）
  const categoryItems: Record<string, React.ReactNode> = {
    '': t('editor.categoryNone'),
    ...Object.fromEntries(categories.map((category) => [category.id, category.name])),
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* 局部锚定：portal 宿主＝工作台主区（覆盖参数区与响应区，不遮标签栏与左栏），
          遮罩以 absolute 落在宿主内（保留官方遮罩模糊效果，但只作用于主区） */}
      <SheetContent
        side="right"
        showCloseButton={false}
        portalContainer={drawerHost() ?? undefined}
        overlayClassName="absolute"
        className="absolute w-80 gap-0 sm:max-w-none"
        data-testid="endpoint-settings-drawer"
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
          <Settings2Icon aria-hidden className="size-4 text-muted-foreground" />
          <SheetTitle className="text-sm font-medium">{t('editor.settingsTitle')}</SheetTitle>
          <SheetClose
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto text-muted-foreground"
                aria-label={t('editor.settingsClose')}
              />
            }
          >
            <XIcon aria-hidden />
          </SheetClose>
        </div>
        <div className="flex flex-col gap-5 overflow-y-auto p-4">
          {/* 超时行（手工与同步接口共有）：可见组名＋三态单选＋自定义秒数
              动态出现。多控件不并入 Field 的包裹式 label（隐式关联会点选
              首个单选），组名以独立标题呈现并经 aria-labelledby 关联组 */}
          <div className="grid gap-1.5">
            <span id={timeoutHeadingId} className="text-sm leading-none font-medium">
              {t('editor.timeoutLabel')}
            </span>
            <RadioGroup
              aria-labelledby={timeoutHeadingId}
              value={timeoutMode}
              onValueChange={(value) => {
                const mode = TIMEOUT_MODES.find((candidate) => candidate === value)
                if (mode) handleTimeoutModeChange(mode)
              }}
              className="gap-2"
            >
              {TIMEOUT_MODES.map((mode) => (
                <span key={mode} className="flex items-center gap-1.5">
                  <RadioGroupItem value={mode} id={`endpoint-timeout-${mode}`} />
                  <label
                    htmlFor={`endpoint-timeout-${mode}`}
                    className="cursor-pointer text-sm leading-5"
                  >
                    {t(TIMEOUT_MODE_LABEL_KEYS[mode])}
                  </label>
                </span>
              ))}
            </RadioGroup>
            {timeoutMode === 'custom' && (
              <Input
                type="number"
                min={1}
                max={86400}
                value={customInput}
                onChange={(event) => {
                  setCustomInput(event.target.value)
                  commitCustomSeconds(event.target.value)
                }}
                onBlur={normalizeCustomInput}
                placeholder={t('editor.timeoutSecondsPlaceholder')}
                aria-label={t('editor.timeoutCustomLabel')}
                data-testid="endpoint-timeout-input"
                className="h-7 font-mono text-xs"
              />
            )}
          </div>

          {/* 标题 / 分类行：同步接口置灰锁定（标题与分组随同步文档更新），
              悬浮提示解释禁用原因 */}
          <Field label={t('editor.entityCategoryLabel')}>
            <Select
              items={categoryItems}
              value={categoryId ?? ''}
              disabled={entityLocked}
              onValueChange={(value) => onCategoryChange(value === '' ? null : (value ?? null))}
            >
              <SelectTrigger
                aria-label={t('editor.entityCategoryLabel')}
                title={entityLocked ? t('editor.entityLockedHint') : undefined}
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">{t('editor.categoryNone')}</SelectItem>
                {categories.map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('editor.entityTitleLabel')}>
            <Input
              ref={titleInputRef}
              value={title}
              disabled={entityLocked}
              onChange={(event) => onTitleChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  onOpenChange(false)
                }
              }}
              aria-label={t('editor.entityTitleLabel')}
              title={entityLocked ? t('editor.entityLockedHint') : undefined}
              placeholder={t('editor.entityTitleLabel')}
            />
          </Field>
        </div>
      </SheetContent>
    </Sheet>
  )
}
