import * as React from 'react'

import { useQueryClient } from '@tanstack/react-query'
import { CheckIcon, LayersIcon, PlusIcon, XIcon } from 'lucide-react'

import { cn } from 'cn'
import { Button, Input, Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components'

import { useI18n } from '@/i18n'
import { reportError } from '@/services/error-center'
import { useIpcMutation, useIpcQuery } from '@/services/ipc-query'
import { useVariableStore } from '@/stores/variable.store'
import { SEMANTIC_ICONS } from '@/features/icons/semantic-icons'

import {
  variableAddBaseUrl,
  variableDeleteBaseUrl,
  variableKeys,
  variableListBaseUrls,
} from './variable-api'

/**
 * BaseUrl 候选与接口级覆写控件（spec 定案：候选＝纯 GUI 备选清单，删除候选
 * 不影响 workspaces.base_url 生效值；接口级覆写＝内存级 Tab 会话态，不落库）。
 *
 * 两个消费面共用候选行呈现：
 * - 设置页（BaseUrlCandidatesControl）：点候选＝替换生效值（由消费方写
 *   workspaces.base_url）；现场新增＝只入候选清单；行内删除＝轻操作无确认；
 * - 地址栏（BaseUrlOverrideControl）：纯地址选择（无新增 / 删除 / 手输，
 *   候选在工作空间设置页维护）；点选＝设置该 Tab 的内存覆写（发送链消费
 *   归 Resolver 发送票据，本控件只落会话态），行尾会话档钮＝设置所有 Tab
 *   生效的会话档。
 */

/** 候选行清单（两消费面共用呈现；行点击＝选择，onDelete 提供时行尾出 X，
 *  onPickSession 提供时行尾出会话档钮） */
function CandidateRows({
  items,
  currentUrl,
  onPick,
  onDelete,
  onPickSession,
  testIdPrefix,
}: {
  items: { id: string; url: string }[]
  /** 当前生效 / 覆写中的 URL（等值行打勾标识） */
  currentUrl: string
  onPick: (url: string) => void
  /** 行内删除（缺省＝纯选择清单，不渲染删除钮） */
  onDelete?: (id: string) => void
  /** 行尾「设为会话档」动作（地址栏形态专用；缺省不渲染） */
  onPickSession?: (url: string) => void
  testIdPrefix: string
}) {
  const { t } = useI18n()
  if (items.length === 0) {
    return (
      <p className="px-1 py-2 text-xs text-muted-foreground">
        {t('variables.baseUrlPicker.empty')}
      </p>
    )
  }
  return (
    <div className="flex max-h-56 flex-col overflow-y-auto" data-testid={`${testIdPrefix}-list`}>
      {items.map((item) => (
        <div
          key={item.id}
          className="group/cand flex items-center gap-1 rounded-sm px-1 py-0.5 hover:bg-accent"
          data-testid={`${testIdPrefix}-row`}
          data-url={item.url}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-0.5 text-left font-mono text-xs outline-none"
            data-testid={`${testIdPrefix}-pick`}
            data-url={item.url}
            onClick={() => onPick(item.url)}
          >
            {item.url === currentUrl ? (
              <CheckIcon aria-hidden className="size-3 shrink-0 text-primary" />
            ) : (
              <span aria-hidden className="size-3 shrink-0" />
            )}
            <span className="truncate">{item.url}</span>
          </button>
          {/* 行尾「设为会话档」：所有 Tab 生效的会话档设置通道（地址栏形态专用） */}
          {onPickSession && (
            <button
              type="button"
              aria-label={t('variables.override.pickSession', { url: item.url })}
              title={t('variables.override.pickSession', { url: item.url })}
              className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-sm text-muted-foreground opacity-0 outline-none group-hover/cand:opacity-100 hover:text-foreground focus-visible:opacity-100"
              data-testid={`${testIdPrefix}-session-pick`}
              data-url={item.url}
              onClick={(event) => {
                event.stopPropagation()
                onPickSession(item.url)
              }}
            >
              <LayersIcon aria-hidden className="size-3" />
            </button>
          )}
          {/* 行内删除：轻操作无确认（不影响生效值）；纯选择清单不渲染 */}
          {onDelete && (
            <button
              type="button"
              aria-label={t('variables.baseUrlPicker.remove', { url: item.url })}
              title={t('variables.baseUrlPicker.remove', { url: item.url })}
              className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-sm text-muted-foreground opacity-0 outline-none group-hover/cand:opacity-100 hover:text-destructive focus-visible:opacity-100"
              data-testid={`${testIdPrefix}-delete`}
              onClick={(event) => {
                event.stopPropagation()
                onDelete(item.id)
              }}
            >
              <XIcon aria-hidden className="size-3" />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

/** 新增候选输入行（只入候选清单，不触碰生效值；回车 / 按钮提交） */
function AddCandidateRow({
  workspaceId,
  testIdPrefix,
}: {
  workspaceId: string
  testIdPrefix: string
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [url, setUrl] = React.useState('')
  // 提交成功即清空（失败保留输入供修改重试）
  const addMutation = useIpcMutation({
    mutationFn: () => variableAddBaseUrl(workspaceId, url),
    onSuccess: (list) => {
      queryClient.setQueryData(variableKeys.baseUrls(workspaceId), list)
      setUrl('')
    },
    onError: reportError,
  })
  const submit = () => {
    if (url.trim() === '' || addMutation.isPending) return
    addMutation.mutate()
  }
  return (
    <div className="flex items-center gap-1 border-t border-border pt-2">
      <Input
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') submit()
        }}
        aria-label={t('variables.baseUrlPicker.addPlaceholder')}
        placeholder={t('variables.baseUrlPicker.addPlaceholder')}
        className="h-7 min-w-0 flex-1 font-mono text-xs"
        spellCheck={false}
        data-testid={`${testIdPrefix}-add-input`}
      />
      <Button
        variant="outline"
        size="icon-sm"
        className="shrink-0"
        aria-label={t('variables.baseUrlPicker.add')}
        title={t('variables.baseUrlPicker.add')}
        disabled={url.trim() === '' || addMutation.isPending}
        data-testid={`${testIdPrefix}-add-button`}
        onClick={submit}
      >
        <PlusIcon aria-hidden />
      </Button>
    </div>
  )
}

/** 候选清单查询＋删除 mutation 的公共接线（两消费面共用行为语义） */
function useBaseUrlCandidates(workspaceId: string) {
  const queryClient = useQueryClient()
  const listQuery = useIpcQuery({
    queryKey: variableKeys.baseUrls(workspaceId),
    queryFn: () => variableListBaseUrls(workspaceId),
    staleTime: 30_000,
  })
  const deleteMutation = useIpcMutation({
    mutationFn: (id: string) => variableDeleteBaseUrl(workspaceId, id),
    onSuccess: (list) => {
      queryClient.setQueryData(variableKeys.baseUrls(workspaceId), list)
    },
    onError: reportError,
  })
  return { items: listQuery.data?.items ?? [], deleteMutation }
}

/**
 * 设置页形态：BaseUrl 候选下拉，触发器内嵌在编辑框右缘（消费方须提供
 * `relative` ＋ `group/field` 的包装——触发器绝对定位于包装内，悬浮 /
 * 键盘聚焦 / 展开时显形）。点候选＝替换生效值（onPick 由消费方接
 * 防抖写 workspaces.base_url）；现场新增只入候选；行内删除不影响生效值。
 */
export function BaseUrlCandidatesControl({
  workspaceId,
  currentBaseUrl,
  onPick,
}: {
  workspaceId: string
  /** 当前生效值（等值行打勾） */
  currentBaseUrl: string
  /** 选择候选＝替换生效值 */
  onPick: (url: string) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = React.useState(false)
  const { items, deleteMutation } = useBaseUrlCandidates(workspaceId)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={t('variables.baseUrlPicker.openLabel')}
            title={t('variables.baseUrlPicker.openLabel')}
            data-testid="base-url-candidates-trigger"
            className="absolute top-1/2 right-1 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-sm text-muted-foreground opacity-0 transition-[opacity,background-color] duration-150 outline-none group-hover/field:opacity-100 hover:bg-muted focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:opacity-100 [&_svg]:pointer-events-none [&_svg]:size-3.5"
          />
        }
      >
        <SEMANTIC_ICONS.baseUrlSwitch aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <p className="text-xs font-medium text-muted-foreground">
          {t('variables.baseUrlPicker.title')}
        </p>
        <CandidateRows
          items={items}
          currentUrl={currentBaseUrl}
          testIdPrefix="base-url-candidates"
          onPick={(url) => {
            onPick(url)
            setOpen(false)
          }}
          onDelete={(id) => deleteMutation.mutate(id)}
        />
        <AddCandidateRow workspaceId={workspaceId} testIdPrefix="base-url-candidates" />
      </PopoverContent>
    </Popover>
  )
}

/**
 * 地址栏形态：内嵌在地址栏前方的 baseUrl 地址块（灰底块，Apifox 式）。
 * 触发器直接显示当前覆写生效值——无覆写＝工作空间 base_url（全量不截断），
 * 有覆写＝覆写值并以主色点亮；覆写解析＝Tab 覆写 > 会话档（store 解析
 * 单点）。弹层两段：会话档区（所有 Tab 生效、退出即清）与候选清单（点选
 * ＝本 Tab 覆写、行尾钮＝设为会话档；清单恒含工作空间当前生效地址——候选
 * 里没有时置顶合成，切走后总能选回）。全部内存态，不落库。
 */
export function BaseUrlOverrideControl({
  workspaceId,
  tabId,
  effectiveUrl,
}: {
  workspaceId: string
  tabId: string
  /** 工作空间生效值（未覆写时前缀显示它；null＝未配置，显示占位文案） */
  effectiveUrl: string | null
}) {
  const { t } = useI18n()
  const [open, setOpen] = React.useState(false)
  const { items } = useBaseUrlCandidates(workspaceId)
  // 覆写生效值两个来源经 selector 细粒度订阅（任一变化即重渲染）；展示用
  // 合并表达式（Tab 覆写 ?? 会话档）与 store 的 resolveBaseUrlOverride 单点
  // 是就地重复的等价表达式：store 单点为命令式 getState（发送侧一次性取值
  // 用），展示侧需响应式订阅故不共用——优先级语义（Tab 覆写 > 会话档）改动
  // 须两处同步
  const tabOverride = useVariableStore((s) => s.baseUrlOverrides[tabId])
  const sessionBaseUrl = useVariableStore((s) => s.sessionBaseUrl)
  const setOverride = useVariableStore((s) => s.setBaseUrlOverride)
  const setSessionBaseUrl = useVariableStore((s) => s.setSessionBaseUrl)
  const overrideUrl = tabOverride ?? sessionBaseUrl ?? null

  // 工作空间生效地址恒在清单中（无同值候选时置顶合成行）——切换后可回
  const rows = React.useMemo(() => {
    if (effectiveUrl === null || items.some((item) => item.url === effectiveUrl)) return items
    return [{ id: '__workspace__', url: effectiveUrl }, ...items]
  }, [items, effectiveUrl])

  const label = overrideUrl
    ? t('variables.override.activeButtonLabel', { url: overrideUrl })
    : t('variables.override.buttonLabel')
  // 前缀文本＝当前生效值（覆写优先；未配置给占位提示）
  const prefixText = overrideUrl ?? effectiveUrl ?? t('variables.override.emptyBaseUrl')

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              // 地址块双色语义：常态中性（muted 底＋muted 字——与主题色解耦，
              // 蓝色主题下不再与紧邻的方法徽章撞色）；仅覆写生效（Tab 覆写 /
              // 会话档）时主题色点亮（bg-primary/10 族与 selection 令牌同源，
              // 暗色 20% 档补偿深色承载面）。悬浮字微升不换底；h-6 与方法
              // 徽章同高（32px 地址栏内上下各留 4px）
              'h-6 shrink-0 bg-muted px-2 font-mono text-xs whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground dark:bg-input/40 dark:hover:bg-input/40',
              overrideUrl &&
                'bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary dark:bg-primary/20 dark:hover:bg-primary/20',
            )}
            aria-label={label}
            title={overrideUrl ?? label}
            data-testid="base-url-override-trigger"
            data-active={overrideUrl ? true : undefined}
          >
            <span className="min-w-0">{prefixText}</span>
          </Button>
        }
      />
      <PopoverContent align="start" className="w-80">
        {/* 会话档区：所有 Tab 生效（新 Tab 即受其约束），退出应用即清 */}
        <p className="px-1 text-xs font-medium text-muted-foreground">
          {t('variables.override.sessionSection')}
        </p>
        <div
          className="flex items-center gap-1.5 rounded-sm px-1 py-0.5 font-mono text-xs"
          data-testid="base-url-override-session"
        >
          {sessionBaseUrl ? (
            <>
              <CheckIcon aria-hidden className="size-3 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate">{sessionBaseUrl}</span>
              <button
                type="button"
                aria-label={t('variables.override.sessionClear')}
                title={t('variables.override.sessionClear')}
                className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-sm text-muted-foreground outline-none hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/50"
                data-testid="base-url-override-session-clear"
                onClick={() => setSessionBaseUrl(null)}
              >
                <XIcon aria-hidden className="size-3" />
              </button>
            </>
          ) : (
            <>
              <span aria-hidden className="size-3 shrink-0" />
              <span className="text-muted-foreground">{t('variables.override.sessionEmpty')}</span>
            </>
          )}
        </div>

        {/* 候选清单：点选＝本 Tab 覆写（工作空间生效地址＝回到跟随，覆写
            与会话档一并清除）；行尾钮＝设为会话档 */}
        <p className="px-1 pt-2 text-xs font-medium text-muted-foreground">
          {t('variables.override.tabSection')}
        </p>
        <CandidateRows
          items={rows}
          currentUrl={overrideUrl ?? effectiveUrl ?? ''}
          testIdPrefix="base-url-override"
          onPick={(url) => {
            // 点选工作空间生效地址＝回到跟随（清 Tab 覆写＋会话档）；
            // 其余地址＝设为 Tab 覆写
            if (url === effectiveUrl) {
              setOverride(tabId, null)
              setSessionBaseUrl(null)
            } else {
              setOverride(tabId, url)
            }
            setOpen(false)
          }}
          onPickSession={(url) => {
            setSessionBaseUrl(url)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
