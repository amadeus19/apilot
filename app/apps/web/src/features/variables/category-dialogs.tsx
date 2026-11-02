import * as React from 'react'

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Switch,
} from '@workspace/ui/components'

import { useI18n } from '@/i18n'
import { VARIABLES_TAB_ID_PREFIX, useTabsStore } from '@/stores/tabs.store'

import { useVariableMutations } from './variable-mutations'

/**
 * 变量分类对话框组（新建 / 重命名）：左栏树（右键 / F2 / 空白区）与变量
 * 配置页横幅（改名入口）共用，同一对话框形态单点维护。按会话挂载——
 * 关闭即卸载弃草稿；重命名成功后 Tab 标题随清单视图同步（单一事实源在
 * tabs store）。
 */

/** 新建分类对话框（名称＋「全局分类」开关；按会话挂载——关闭即卸载弃草稿） */
export function NewCategoryDialog({
  workspaceId,
  onOpenChange,
}: {
  workspaceId: string
  onOpenChange: (open: false) => void
}) {
  const { t } = useI18n()
  const { createCategoryMutation } = useVariableMutations(workspaceId)
  const [name, setName] = React.useState('')
  const [global, setGlobal] = React.useState(false)

  const submit = () => {
    if (name.trim() === '' || createCategoryMutation.isPending) return
    createCategoryMutation.mutate(
      { global, name },
      {
        onSuccess: () => onOpenChange(false),
      },
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onOpenChange(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('variables.newCategoryDialog.title')}</DialogTitle>
          <DialogDescription>{t('variables.newCategoryDialog.description')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter') submit()
            }}
            aria-label={t('variables.newCategoryDialog.nameLabel')}
            placeholder={t('variables.newCategoryDialog.namePlaceholder')}
            className="h-8"
            autoFocus
          />
          <label className="flex items-center gap-2 text-xs">
            <Switch checked={global} onCheckedChange={(checked) => setGlobal(checked === true)} />
            <span>{t('variables.newCategoryDialog.globalLabel')}</span>
          </label>
          <p className="text-micro text-muted-foreground">
            {t('variables.newCategoryDialog.globalHint')}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('variables.newCategoryDialog.cancel')}
          </Button>
          <Button
            disabled={name.trim() === '' || createCategoryMutation.isPending}
            onClick={submit}
            data-testid="variables-create-category-confirm"
          >
            {t('variables.newCategoryDialog.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 重命名分类对话框（按会话挂载；Tab 标题随清单视图同步） */
export function RenameCategoryDialog({
  workspaceId,
  target,
  onOpenChange,
}: {
  workspaceId: string
  target: { id: string; name: string }
  onOpenChange: (open: false) => void
}) {
  const { t } = useI18n()
  const { renameCategoryMutation } = useVariableMutations(workspaceId)
  const setTabTitle = useTabsStore((s) => s.setTabTitle)
  const [name, setName] = React.useState(target.name)

  const submit = () => {
    const next = name.trim()
    if (next === '' || next === target.name || renameCategoryMutation.isPending) return
    renameCategoryMutation.mutate(
      { categoryId: target.id, name: next },
      {
        onSuccess: (view) => {
          const renamed = view.items.find((c) => c.id === target.id)
          if (renamed) setTabTitle(`${VARIABLES_TAB_ID_PREFIX}${target.id}`, renamed.name)
          onOpenChange(false)
        },
      },
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onOpenChange(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('variables.renameDialog.title')}</DialogTitle>
          <DialogDescription>{t('variables.renameDialog.description')}</DialogDescription>
        </DialogHeader>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') submit()
          }}
          aria-label={t('variables.renameDialog.nameLabel')}
          placeholder={t('variables.newCategoryDialog.namePlaceholder')}
          className="h-8"
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('variables.renameDialog.cancel')}
          </Button>
          <Button
            disabled={
              name.trim() === '' || name.trim() === target.name || renameCategoryMutation.isPending
            }
            onClick={submit}
            data-testid="variables-rename-confirm"
          >
            {t('variables.renameDialog.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
