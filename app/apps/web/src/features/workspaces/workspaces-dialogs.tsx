import * as React from 'react'

import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  ScrollArea,
} from '@workspace/ui/components'

import { useI18n } from '@/i18n'
import { reportError } from '@/services/error-center'
import { WORKSPACE_SETTINGS_TAB_ID, useTabsStore } from '@/stores/tabs.store'
import { useWorkspacesStore, type WorkspacesDialog } from './workspaces.store'
import {
  defaultCheckedIndexes,
  importSelectAllState,
  annotateImportGroups,
  type ImportGroupCheck,
} from './import-groups'
import {
  useServiceImportMutations,
  useWorkspaceMutations,
  useWorkspaceServiceMutations,
  useWorkspaceServicesQuery,
  useWorkspacesQuery,
} from './api'

/**
 * 工作空间域对话框宿主（全局唯一挂载）：工作空间（新建 / 重命名 / 删除
 * 确认）、服务（新建 / 编辑，名称 + 可选文档地址同构接口树表单、删除确认）
 * 与批量导入向导（入口页地址 → 分组勾选两步）。开合与向导态由
 * workspaces.store 持有；消费方（左栏树视图、工作空间详情页）只发 store
 * 信号，IPC 提交与错误呈现（reportError）自持在本组件——宿主全局在场，
 * 对话框不随左栏视图切换丢失宿主。
 */

/** 表单骨架：受控开合 + 提交行（取消 / 保存，提交 pending 防重复） */
function FormShell({
  title,
  onClose,
  onSubmit,
  submitLabel,
  submitDisabled,
  submitPending,
  children,
}: {
  title: string
  onClose: () => void
  onSubmit: (event: React.FormEvent) => void
  submitLabel: string
  submitDisabled?: boolean
  submitPending?: boolean
  children: React.ReactNode
}) {
  const { t } = useI18n()
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit(event)
          }}
          className="grid gap-4"
        >
          {children}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('workspace.cancel')}
            </Button>
            <Button type="submit" disabled={submitDisabled || submitPending}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** 工作空间表单：新建 / 重命名（重命名只动名称；BaseUrl 编辑归设置页） */
function WorkspaceFormDialog({
  state,
  onClose,
  onSubmit,
  submitPending,
}: {
  state: Extract<WorkspacesDialog, { type: 'ws-new' | 'ws-rename' }>
  onClose: () => void
  onSubmit: (name: string) => void
  submitPending: boolean
}) {
  const { t } = useI18n()
  const isNew = state.type === 'ws-new'
  const [name, setName] = React.useState(isNew ? '' : state.name)
  return (
    <FormShell
      title={isNew ? t('workspace.wsNewTitle') : t('workspace.wsRenameTitle')}
      onClose={onClose}
      submitLabel={t('workspace.save')}
      submitDisabled={name.trim() === ''}
      submitPending={submitPending}
      onSubmit={() => onSubmit(name.trim())}
    >
      <Field label={t('workspace.wsNameLabel')}>
        <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
      </Field>
    </FormShell>
  )
}

/** 服务表单：新建 / 编辑同构（名称 + 可选文档地址；空地址＝纯手工容器） */
function ServiceFormDialog({
  state,
  onClose,
  onSubmit,
  submitPending,
}: {
  state: Extract<WorkspacesDialog, { type: 'service-new' | 'service-edit' }>
  onClose: () => void
  onSubmit: (name: string, docUrl: string | null) => void
  submitPending: boolean
}) {
  const { t } = useI18n()
  const isNew = state.type === 'service-new'
  const [name, setName] = React.useState(isNew ? '' : state.name)
  const [docUrl, setDocUrl] = React.useState(isNew ? '' : (state.docUrl ?? ''))
  return (
    <FormShell
      title={isNew ? t('workspace.serviceNewTitle') : t('workspace.serviceEditTitle')}
      onClose={onClose}
      submitLabel={t('workspace.save')}
      submitDisabled={name.trim() === ''}
      submitPending={submitPending}
      onSubmit={() => {
        const url = docUrl.trim() === '' ? null : docUrl.trim()
        onSubmit(name.trim(), url)
      }}
    >
      <Field label={t('workspace.serviceNameLabel')}>
        <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
      </Field>
      <Field label={t('workspace.serviceDocUrlLabel')}>
        <Input
          value={docUrl}
          onChange={(event) => setDocUrl(event.target.value)}
          placeholder={t('workspace.serviceDocUrlPlaceholder')}
        />
      </Field>
    </FormShell>
  )
}

/** 删除确认（级联范围在描述文案明示，确认钮 destructive） */
function DeleteConfirmDialog({
  title,
  description,
  confirmLabel,
  onClose,
  onConfirm,
  confirmPending,
}: {
  title: string
  description: string
  confirmLabel: string
  onClose: () => void
  onConfirm: () => void
  confirmPending: boolean
}) {
  const { t } = useI18n()
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('workspace.cancel')}
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={confirmPending}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 批量导入向导：entry（输入入口页地址）→ groups（勾选发现分组）两步；
 * 步骤与勾选态经 workspaces.store 持有，提交与错误呈现归视图层。 */
function ImportDialog({
  onClose,
  onDiscover,
  onImport,
  discoverPending,
  importPending,
}: {
  onClose: () => void
  onDiscover: (entryUrl: string) => void
  onImport: (groups: readonly ImportGroupCheck[]) => void
  discoverPending: boolean
  importPending: boolean
}) {
  const { t } = useI18n()
  const step = useWorkspacesStore((s) => s.importStep)
  const entryUrl = useWorkspacesStore((s) => s.importEntryUrl)
  const setEntryUrl = useWorkspacesStore((s) => s.setImportEntryUrl)
  const groups = useWorkspacesStore((s) => s.importGroups)
  const checked = useWorkspacesStore((s) => s.importChecked)
  const toggleChecked = useWorkspacesStore((s) => s.toggleImportChecked)
  const setChecked = useWorkspacesStore((s) => s.setImportChecked)
  const backToEntry = useWorkspacesStore((s) => s.backToImportEntry)
  // 表头全选三态：由可勾行全集推导（名称撞车行不在全集内）
  const selectAll = importSelectAllState(groups, checked)

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('workspace.importTitle')}</DialogTitle>
          {step === 'entry' && (
            <DialogDescription>{t('workspace.importEntryHint')}</DialogDescription>
          )}
        </DialogHeader>
        {step === 'entry' ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              if (entryUrl.trim() !== '' && !discoverPending) onDiscover(entryUrl.trim())
            }}
          >
            <Field label={t('workspace.importEntryLabel')}>
              <Input
                value={entryUrl}
                onChange={(event) => setEntryUrl(event.target.value)}
                placeholder={t('workspace.importEntryPlaceholder')}
                autoFocus
              />
            </Field>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                {t('workspace.cancel')}
              </Button>
              <Button type="submit" disabled={entryUrl.trim() === '' || discoverPending}>
                {discoverPending
                  ? t('workspace.importDiscovering')
                  : t('workspace.importDiscoverAction')}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="grid gap-4">
            {/* 表头行用 div 而非 label 包裹：避免 label 关联改写 Checkbox 的
                可访问名（aria-labelledby 优先于 aria-label，会把计数文案并进名内） */}
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox
                checked={selectAll === 'all'}
                indeterminate={selectAll === 'partial'}
                onCheckedChange={(next) =>
                  // 全选集＝全部可勾行，与默认勾选同口径（名称撞车行恒排除）
                  setChecked(next ? defaultCheckedIndexes(groups) : [])
                }
                aria-label={t('workspace.importSelectAll')}
              />
              <span>{t('workspace.importFoundCount', { count: groups.length })}</span>
            </div>
            <ScrollArea className="max-h-64 rounded-md border">
              <ul className="grid gap-1 p-2">
                {groups.map((group, index) => (
                  <li key={`${group.docUrl}#${index}`} className="grid gap-1">
                    <label className="flex items-start gap-2 rounded-sm px-1 py-1.5 hover:bg-accent">
                      <Checkbox
                        checked={checked.includes(index)}
                        onCheckedChange={() => toggleChecked(index)}
                        aria-label={group.name}
                      />
                      <span className="grid min-w-0 flex-1 gap-0.5">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-sm">{group.name}</span>
                          {group.nameExists && (
                            <Badge variant="secondary">{t('workspace.importExistsBadge')}</Badge>
                          )}
                          {!group.nameExists && group.urlExists && (
                            <Badge variant="secondary">{t('workspace.importUrlExistsBadge')}</Badge>
                          )}
                        </span>
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {group.docUrl}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </ScrollArea>
            <DialogFooter>
              <Button variant="ghost" onClick={backToEntry} disabled={importPending}>
                {t('workspace.importBack')}
              </Button>
              <Button
                onClick={() => onImport(checked.map((index) => groups[index]!))}
                disabled={checked.length === 0 || importPending}
              >
                {importPending
                  ? t('workspace.importImporting')
                  : t('workspace.importImportAction', { count: checked.length })}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * 对话框宿主：store 的 dialog 状态分发，mutation 自持（消费方只发信号）。
 * 服务新建与导入的目标工作空间随对话框携带（可对任意空间操作）。
 * 联动职责：重命名同步详情 Tab 标题；删除工作空间时清树选中并关闭
 * 指向该空间的详情 Tab（内容指针悬空即关）。
 */
export function WorkspacesDialogHost() {
  const dialog = useWorkspacesStore((s) => s.dialog)
  const closeDialog = useWorkspacesStore((s) => s.closeDialog)
  const importDiscovered = useWorkspacesStore((s) => s.importDiscovered)
  const setTreeSelectedWorkspace = useWorkspacesStore((s) => s.setTreeSelectedWorkspace)
  const { t } = useI18n()

  const { data: workspaceList } = useWorkspacesQuery()
  const workspaceMutations = useWorkspaceMutations()
  const serviceMutations = useWorkspaceServiceMutations()
  const importMutations = useServiceImportMutations()
  // 导入查重比对目标空间现有服务：仅 import 对话框在场时拉取
  const importWorkspaceId = dialog?.type === 'import' ? dialog.workspaceId : null
  const targetServicesQuery = useWorkspaceServicesQuery(importWorkspaceId)

  /** 详情 Tab 是否开着且指向给定空间（标题 / 关闭联动的判定单点） */
  const detailTabPointsTo = (workspaceId: string): boolean =>
    useTabsStore
      .getState()
      .tabs.some((tab) => tab.id === WORKSPACE_SETTINGS_TAB_ID && tab.key === workspaceId)

  const handleSubmitWorkspace = (name: string, id: string | null): void => {
    if (id === null) {
      workspaceMutations.createMutation.mutate(name, {
        onSuccess: () => closeDialog(),
        onError: (error) => reportError(error),
      })
    } else {
      // 重命名只动名称：BaseUrl 保留现值（其编辑归工作空间详情页）
      const target = workspaceList?.items.find((item) => item.id === id)
      workspaceMutations.renameMutation.mutate(
        { id, name, baseUrl: target?.baseUrl ?? null },
        {
          onSuccess: () => {
            if (detailTabPointsTo(id)) {
              useTabsStore.getState().setTabTitle(WORKSPACE_SETTINGS_TAB_ID, name)
            }
            closeDialog()
          },
          onError: (error) => reportError(error),
        },
      )
    }
  }

  const handleConfirmWorkspaceDelete = (id: string): void => {
    workspaceMutations.deleteMutation.mutate(id, {
      onSuccess: () => {
        // 删的是正在查看的空间：树选中清掉（行已不存在，选中不悬空），
        // 指向该空间的详情 Tab 一并关闭
        if (useWorkspacesStore.getState().treeSelectedWorkspaceId === id) {
          setTreeSelectedWorkspace(null)
        }
        if (detailTabPointsTo(id)) useTabsStore.getState().close(WORKSPACE_SETTINGS_TAB_ID)
        closeDialog()
      },
      onError: (error) => reportError(error),
    })
  }

  const handleSubmitService = (input: {
    name: string
    docUrl: string | null
    id: string | null
    workspaceId: string | null
  }): void => {
    if (input.id === null) {
      if (input.workspaceId === null) return
      serviceMutations.createMutation.mutate(
        { workspaceId: input.workspaceId, name: input.name, docUrl: input.docUrl },
        {
          onSuccess: () => closeDialog(),
          onError: (error) => reportError(error),
        },
      )
    } else {
      serviceMutations.updateMutation.mutate(
        { id: input.id, name: input.name, docUrl: input.docUrl },
        {
          onSuccess: () => closeDialog(),
          onError: (error) => reportError(error),
        },
      )
    }
  }

  const handleConfirmServiceDelete = (id: string): void => {
    serviceMutations.deleteMutation.mutate(id, {
      onSuccess: () => closeDialog(),
      onError: (error) => reportError(error),
    })
  }

  const handleDiscover = (workspaceId: string, entryUrl: string): void => {
    importMutations.discoverMutation.mutate(
      { workspaceId, entryUrl },
      {
        onSuccess: (dto) => {
          const annotated = annotateImportGroups(dto.groups, targetServicesQuery.data ?? [])
          importDiscovered(annotated, defaultCheckedIndexes(annotated))
        },
        // 失败留在输入步：地址已保留，便于修正后重试
        onError: (error) => reportError(error),
      },
    )
  }

  const handleImport = (workspaceId: string, groups: readonly ImportGroupCheck[]): void => {
    importMutations.createMutation.mutate(
      { workspaceId, groups },
      {
        onSuccess: () => closeDialog(),
        onError: (error) => reportError(error),
      },
    )
  }

  switch (dialog?.type) {
    case 'ws-new':
    case 'ws-rename':
      return (
        <WorkspaceFormDialog
          state={dialog}
          onClose={closeDialog}
          submitPending={
            workspaceMutations.createMutation.isPending ||
            workspaceMutations.renameMutation.isPending
          }
          onSubmit={(name) =>
            handleSubmitWorkspace(name, dialog.type === 'ws-rename' ? dialog.id : null)
          }
        />
      )
    case 'ws-delete':
      return (
        <DeleteConfirmDialog
          title={t('workspace.wsDeleteTitle')}
          description={t('workspace.wsDeleteDescription', { name: dialog.name })}
          confirmLabel={t('workspace.wsDeleteConfirm')}
          onClose={closeDialog}
          confirmPending={workspaceMutations.deleteMutation.isPending}
          onConfirm={() => handleConfirmWorkspaceDelete(dialog.id)}
        />
      )
    case 'service-new':
    case 'service-edit':
      return (
        <ServiceFormDialog
          state={dialog}
          onClose={closeDialog}
          submitPending={
            serviceMutations.createMutation.isPending || serviceMutations.updateMutation.isPending
          }
          onSubmit={(name, docUrl) =>
            handleSubmitService({
              name,
              docUrl,
              id: dialog.type === 'service-edit' ? dialog.id : null,
              workspaceId: dialog.type === 'service-new' ? dialog.workspaceId : null,
            })
          }
        />
      )
    case 'service-delete':
      return (
        <DeleteConfirmDialog
          title={t('workspace.serviceDeleteTitle')}
          description={t('workspace.serviceDeleteDescription', { name: dialog.name })}
          confirmLabel={t('workspace.serviceDeleteConfirm')}
          onClose={closeDialog}
          confirmPending={serviceMutations.deleteMutation.isPending}
          onConfirm={() => handleConfirmServiceDelete(dialog.id)}
        />
      )
    case 'import':
      return (
        <ImportDialog
          onClose={closeDialog}
          onDiscover={(entryUrl) => handleDiscover(dialog.workspaceId, entryUrl)}
          onImport={(groups) => handleImport(dialog.workspaceId, groups)}
          discoverPending={importMutations.discoverMutation.isPending}
          importPending={importMutations.createMutation.isPending}
        />
      )
    default:
      return null
  }
}
