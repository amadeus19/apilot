import * as React from 'react'

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@workspace/ui/components'

import { useI18n } from '@/i18n'
import { HTTP_METHODS } from '@/lib/http-methods'
import { useIpcQuery } from '@/services/ipc-query'
import { workflowEndpointUsage, workflowKeys } from '@/features/workflow/workflow-api'
import { useCurrentWorkspaceTreeQuery } from '@/features/workspaces/api'

import type { ApiTreeNode } from './selector'
import { MethodBadge } from './method-badge'

/**
 * 接口树对话框族：服务（新建 / 编辑，名称 + 可选文档地址同一对话框）、
 * 分类（新建 / 重命名）、接口（新建三字段 / 重命名单字段）与三级联删除
 * 确认（级联范围明示）。开合与提交由 api-tree-panel 持状态机驱动；
 * 错误经统一错误协议（reportError）呈现，表单态在开合间重置。
 */

/** 对话框状态机：panel 的三通道菜单 / F2 / 空态按钮统一切换到此形态 */
export type TreeDialogState =
  | { type: 'service-new' }
  | { type: 'service-edit'; node: ApiTreeNode }
  | { type: 'category-new'; serviceId: string }
  | { type: 'category-rename'; node: ApiTreeNode }
  | { type: 'endpoint-new'; serviceId: string; categoryId: string | null }
  | { type: 'endpoint-rename'; node: ApiTreeNode }
  | { type: 'delete-endpoint'; node: ApiTreeNode }
  | { type: 'delete-category'; node: ApiTreeNode }
  | { type: 'delete-service'; node: ApiTreeNode }

/** 表单骨架：受控开合 + 提交行（取消 / 提交，提交 pending 防重复） */
function FormShell({
  title,
  open,
  onClose,
  onSubmit,
  submitDisabled,
  children,
}: {
  title: string
  open: boolean
  onClose: () => void
  onSubmit: (event: React.FormEvent) => void
  submitDisabled?: boolean
  children: React.ReactNode
}) {
  const { t } = useI18n()
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
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
              {t('apiTree.cancel')}
            </Button>
            <Button type="submit" disabled={submitDisabled}>
              {t('apiTree.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** 服务表单：新建 / 编辑同构（名称 + 可选文档地址；空文档地址＝纯手工容器） */
function ServiceFormDialog({
  state,
  onClose,
  onSubmit,
}: {
  state: Extract<TreeDialogState, { type: 'service-new' | 'service-edit' }>
  onClose: () => void
  onSubmit: (name: string, docUrl: string | null) => void
}) {
  const { t } = useI18n()
  const isNew = state.type === 'service-new'
  const [name, setName] = React.useState(isNew ? '' : state.node.name)
  const [docUrl, setDocUrl] = React.useState(isNew ? '' : (state.node.docUrl ?? ''))

  return (
    <FormShell
      title={isNew ? t('apiTree.serviceFormNewTitle') : t('apiTree.serviceFormEditTitle')}
      open
      onClose={onClose}
      submitDisabled={name.trim() === ''}
      onSubmit={() => {
        const url = docUrl.trim() === '' ? null : docUrl.trim()
        onSubmit(name.trim(), url)
      }}
    >
      <Field label={t('apiTree.serviceNameLabel')}>
        <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <Field label={t('apiTree.serviceDocUrlLabel')}>
        <Input
          value={docUrl}
          onChange={(e) => setDocUrl(e.target.value)}
          placeholder={t('apiTree.serviceDocUrlPlaceholder')}
        />
      </Field>
    </FormShell>
  )
}

/** 分类表单：新建（归属上下文由状态机携带）/ 重命名 */
function CategoryFormDialog({
  state,
  onClose,
  onSubmit,
}: {
  state: Extract<TreeDialogState, { type: 'category-new' | 'category-rename' }>
  onClose: () => void
  onSubmit: (name: string) => void
}) {
  const { t } = useI18n()
  const isNew = state.type === 'category-new'
  const [name, setName] = React.useState(isNew ? '' : state.node.name)

  return (
    <FormShell
      title={isNew ? t('apiTree.categoryFormNewTitle') : t('apiTree.categoryFormRenameTitle')}
      open
      onClose={onClose}
      submitDisabled={name.trim() === ''}
      onSubmit={() => onSubmit(name.trim())}
    >
      <Field label={t('apiTree.categoryNameLabel')}>
        <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
    </FormShell>
  )
}

/** 接口表单：新建（方法 + 路径 + 标题）/ 重命名（仅标题；方法路径归编辑器） */
function EndpointFormDialog({
  state,
  onClose,
  onSubmit,
}: {
  state: Extract<TreeDialogState, { type: 'endpoint-new' | 'endpoint-rename' }>
  onClose: () => void
  onSubmit: (form: { title: string; method: string; pathTemplate: string }) => void
}) {
  const { t } = useI18n()
  const isNew = state.type === 'endpoint-new'
  const [title, setTitle] = React.useState(isNew ? '' : state.node.name)
  const [method, setMethod] = React.useState(isNew ? 'GET' : (state.node.method ?? 'GET'))
  const [pathTemplate, setPathTemplate] = React.useState(
    isNew ? '' : (state.node.pathTemplate ?? ''),
  )

  return (
    <FormShell
      title={isNew ? t('apiTree.endpointFormNewTitle') : t('apiTree.endpointFormRenameTitle')}
      open
      onClose={onClose}
      submitDisabled={title.trim() === '' || (isNew && pathTemplate.trim() === '')}
      onSubmit={() => onSubmit({ title: title.trim(), method, pathTemplate: pathTemplate.trim() })}
    >
      {isNew && (
        <>
          <Field label={t('apiTree.endpointMethodLabel')}>
            <Select value={method} onValueChange={(value) => setMethod(value ?? 'GET')}>
              <SelectTrigger className="w-full">
                {/* 值区与方法选项都经 MethodBadge：与树行 / 标签栏 / 编辑器同一套方法色 */}
                <SelectValue>{(value: string) => <MethodBadge method={value} />}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {HTTP_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    <MethodBadge method={m} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('apiTree.endpointPathLabel')}>
            <Input
              value={pathTemplate}
              onChange={(e) => setPathTemplate(e.target.value)}
              placeholder={t('apiTree.endpointPathPlaceholder')}
              autoFocus
              className="font-mono"
            />
          </Field>
        </>
      )}
      <Field label={t('apiTree.endpointTitleLabel')}>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
    </FormShell>
  )
}

/**
 * 删除接口确认框的引用清单（提示不阻断：反查在途或失败时只呈现基础确认
 * 文案，确认钮照常可用；有引用时列「被 N 个工作流引用」+ 逐行名称）。
 */
function EndpointUsageList({ endpointKey }: { endpointKey: string }) {
  const { t } = useI18n()
  const { workspaceId } = useCurrentWorkspaceTreeQuery()
  const usageQuery = useIpcQuery({
    queryKey: workflowKeys.endpointUsage(workspaceId ?? '', [endpointKey]),
    queryFn: () => workflowEndpointUsage(workspaceId ?? '', [endpointKey]),
    enabled: workspaceId !== null,
  })
  const usage = usageQuery.data?.[endpointKey]
  if (usage == null || usage.length === 0) return null
  return (
    <div className="mt-2" data-testid="delete-endpoint-usage">
      <p className="text-xs font-medium">
        {t('apiTree.deleteEndpointRefsCount', { count: usage.length })}
      </p>
      <ul className="mt-0.5 list-inside list-disc text-xs text-muted-foreground">
        {usage.map((row) => (
          <li key={row.workflowId} className="truncate">
            {row.workflowName}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** 删除确认（级联范围在描述文案中明示，确认钮 destructive） */
function DeleteConfirmDialog({
  state,
  onClose,
  onConfirm,
}: {
  state: Extract<
    TreeDialogState,
    { type: 'delete-endpoint' | 'delete-category' | 'delete-service' }
  >
  onClose: () => void
  onConfirm: () => void
}) {
  const { t } = useI18n()
  const copy: Record<TreeDialogState['type'], { title: string; description: string }> = {
    'delete-endpoint': {
      title: t('apiTree.deleteEndpointTitle'),
      description: t('apiTree.deleteEndpointDescription', { title: state.node.name }),
    },
    'delete-category': {
      title: t('apiTree.deleteCategoryTitle'),
      description: t('apiTree.deleteCategoryDescription', { title: state.node.name }),
    },
    'delete-service': {
      title: t('apiTree.deleteServiceTitle'),
      description: t('apiTree.deleteServiceDescription', { title: state.node.name }),
    },
    // 删除确认只消费三种 delete-* 形态；其余键位不可达
    'service-new': { title: '', description: '' },
    'service-edit': { title: '', description: '' },
    'category-new': { title: '', description: '' },
    'category-rename': { title: '', description: '' },
    'endpoint-new': { title: '', description: '' },
    'endpoint-rename': { title: '', description: '' },
  }
  const entry = copy[state.type]!

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{entry.title}</DialogTitle>
          <DialogDescription>{entry.description}</DialogDescription>
        </DialogHeader>
        {state.type === 'delete-endpoint' && state.node.key != null && (
          <EndpointUsageList endpointKey={state.node.key} />
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('apiTree.cancel')}
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {t('apiTree.confirmDelete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 树对话框宿主：panel 挂一个实例；状态机形态分发到对应对话框，
 * 提交回调由 panel 注入（mutation 全在其闭包内），本组件保持纯展示。
 */
export function TreeDialogHost({
  state,
  onClose,
  onSubmitService,
  onSubmitCategory,
  onSubmitEndpoint,
  onDelete,
}: {
  state: TreeDialogState | null
  onClose: () => void
  onSubmitService: (name: string, docUrl: string | null, node: ApiTreeNode | null) => void
  onSubmitCategory: (name: string, node: ApiTreeNode | null) => void
  onSubmitEndpoint: (form: { title: string; method: string; pathTemplate: string }) => void
  onDelete: (node: ApiTreeNode) => void
}) {
  switch (state?.type) {
    case 'service-new':
    case 'service-edit':
      return (
        <ServiceFormDialog
          state={state}
          onClose={onClose}
          onSubmit={(name, docUrl) =>
            onSubmitService(name, docUrl, state.type === 'service-edit' ? state.node : null)
          }
        />
      )
    case 'category-new':
    case 'category-rename':
      return (
        <CategoryFormDialog
          state={state}
          onClose={onClose}
          onSubmit={(name) =>
            onSubmitCategory(name, state.type === 'category-rename' ? state.node : null)
          }
        />
      )
    case 'endpoint-new':
    case 'endpoint-rename':
      return <EndpointFormDialog state={state} onClose={onClose} onSubmit={onSubmitEndpoint} />
    case 'delete-endpoint':
    case 'delete-category':
    case 'delete-service':
      return (
        <DeleteConfirmDialog
          state={state}
          onClose={onClose}
          onConfirm={() => onDelete(state.node)}
        />
      )
    default:
      return null
  }
}
