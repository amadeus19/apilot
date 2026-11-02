import * as React from 'react'

import {
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Switch,
  toast,
} from '@workspace/ui/components'

import { useI18n } from '@/i18n'
import { useIpcQuery } from '@/services/ipc-query'
import { useAppStore } from '@/stores/app.store'

import { useVariableMutations } from './variable-mutations'
import { variableKeys, variableListCategories, variableListVariables } from './variable-api'

/**
 * 响应头「存为变量」行内入口：key 名即触发器（悬浮高亮主题色、可点击，
 * 无独立图标）；点击弹命名浮层，值＝该响应头当前值（明文入库，展示侧
 * 脱敏纪律不涉变量存储），写入当前激活分类——同名变量直接更新值与
 * Secret，否则新建。敏感头默认勾 Secret（调用方按敏感名单判定）。
 * 无激活分类时浮层提示并引导切左栏变量视图激活（保存不可达）。
 *
 * 查询与表单态全部收在浮层体（仅打开时挂载）：未点击的行零查询成本，
 * 关闭即卸载、重开重播种（变量名与 Secret 默认值随当次响应头初始化）。
 */
export function HeaderVariableButton({
  workspaceId,
  headerName,
  headerValue,
  defaultSecret,
}: {
  workspaceId: string
  headerName: string
  headerValue: string
  /** 敏感头默认勾 Secret（掩码展示与 Secret 默认值同一判定面） */
  defaultSecret: boolean
}) {
  const { t } = useI18n()
  const [open, setOpen] = React.useState(false)

  return (
    <dt className="w-48 shrink-0">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              className="w-full cursor-pointer truncate text-left text-muted-foreground transition-colors hover:text-primary focus-visible:text-primary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              aria-label={t('response.headerVariable.actionLabel', { name: headerName })}
              title={headerName}
              data-testid="header-save-variable-trigger"
            >
              {headerName}
            </button>
          }
        />
        <PopoverContent
          align="start"
          className="w-72 p-3"
          data-testid="header-save-variable-popover"
        >
          <HeaderVariableForm
            workspaceId={workspaceId}
            headerName={headerName}
            headerValue={headerValue}
            defaultSecret={defaultSecret}
            onDone={() => setOpen(false)}
          />
        </PopoverContent>
      </Popover>
    </dt>
  )
}

/** 浮层体（仅 Popover 打开时挂载）：查询目标分类与清单、表单态与保存编排 */
function HeaderVariableForm({
  workspaceId,
  headerName,
  headerValue,
  defaultSecret,
  onDone,
}: {
  workspaceId: string
  headerName: string
  headerValue: string
  defaultSecret: boolean
  /** 保存成功 / 引导跳转后的收尾（关浮层） */
  onDone: () => void
}) {
  const { t } = useI18n()
  const [key, setKey] = React.useState(headerName)
  const [secret, setSecret] = React.useState(defaultSecret)
  const setLeftView = useAppStore((s) => s.setLeftView)

  // 激活分类（写入目标）；分类视图未加载时不出表单（浮层异步填充）
  const categoriesQuery = useIpcQuery({
    queryKey: variableKeys.categories(workspaceId),
    queryFn: () => variableListCategories(workspaceId),
  })
  const view = categoriesQuery.data
  const activeCategory = view?.items.find((item) => item.id === view.activeCategoryId) ?? null

  // 目标分类内清单（同名判定：存在＝更新值，否则＝新建；enabled 保证
  // queryFn 跑时 id 非 null，兜底空串仅满足类型）
  const listQuery = useIpcQuery({
    queryKey: variableKeys.variables(activeCategory?.id ?? ''),
    queryFn: () => variableListVariables(activeCategory?.id ?? ''),
    enabled: activeCategory !== null,
  })

  const { createVariableMutation, updateVariableMutation } = useVariableMutations(workspaceId)

  const trimmed = key.trim()
  const exists =
    activeCategory !== null && (listQuery.data?.items ?? []).some((item) => item.key === trimmed)
  const pending = createVariableMutation.isPending || updateVariableMutation.isPending

  const submit = () => {
    if (activeCategory === null || trimmed === '') return
    const input = { categoryId: activeCategory.id, key: trimmed, value: headerValue, secret }
    // per-call 回调只带 UI 副作用（缓存后处理在 mutation 组内收口）
    const sideEffects = {
      onSuccess: () => {
        toast.info(t('response.headerVariable.savedToast', { key: trimmed }))
        onDone()
      },
    }
    if (exists) updateVariableMutation.mutate(input, sideEffects)
    else createVariableMutation.mutate(input, sideEffects)
  }

  const inputId = React.useId()

  return (
    <>
      <p className="text-sm font-medium">{t('response.headerVariable.title')}</p>
      <p
        className="mt-0.5 truncate font-mono text-micro text-muted-foreground"
        title={`${headerName}: ${headerValue}`}
      >
        {headerName}: {headerValue}
      </p>
      {view === undefined ? null : activeCategory === null ? (
        <div className="mt-2">
          <p className="text-xs text-muted-foreground">
            {t('response.headerVariable.noActiveCategory')}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2 h-7"
            onClick={() => {
              setLeftView('variables')
              onDone()
            }}
            data-testid="header-save-variable-open-variables"
          >
            {t('response.headerVariable.openVariables')}
          </Button>
        </div>
      ) : (
        <>
          <div className="mt-2">
            <label htmlFor={inputId} className="text-xs text-muted-foreground">
              {t('response.headerVariable.nameLabel')}
            </label>
            <Input
              id={inputId}
              value={key}
              onChange={(event) => setKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return
                if (event.key === 'Enter') submit()
              }}
              spellCheck={false}
              className="mt-1 h-7 font-mono text-xs"
              data-testid="header-save-variable-key"
            />
          </div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs">{t('response.headerVariable.secretLabel')}</span>
            <Switch
              checked={secret}
              onCheckedChange={(checked) => setSecret(checked === true)}
              aria-label={t('response.headerVariable.secretLabel')}
              data-testid="header-save-variable-secret"
            />
          </div>
          {exists && (
            <p className="mt-1.5 text-micro text-muted-foreground">
              {t('response.headerVariable.overwriteHint')}
            </p>
          )}
          <p className="mt-1.5 text-micro text-muted-foreground">
            {t('response.headerVariable.targetCategory', { name: activeCategory.name })}
          </p>
          <div className="mt-2 flex justify-end">
            <Button
              size="sm"
              className="h-7"
              disabled={trimmed === '' || pending}
              onClick={submit}
              data-testid="header-save-variable-submit"
            >
              {t('response.headerVariable.save')}
            </Button>
          </div>
        </>
      )}
    </>
  )
}
