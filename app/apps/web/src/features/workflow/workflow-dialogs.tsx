import * as React from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@workspace/ui/components'

import { useIpcMutation } from '@/services/ipc-query'
import { useI18n } from '@/i18n'
import { queryClient } from '@/app/query-client'
import { reportError } from '@/services/error-center'
import type {
  WorkflowDto,
  WorkflowGroupDto,
  WorkflowPasteReportDto,
  WorkflowSummaryDto,
} from './workflow-api'
import {
  workflowCreate,
  workflowGroupCreate,
  workflowGroupRename,
  workflowKeys,
  workflowPaste,
} from './workflow-api'
import type { WorkflowClipboardEntry } from './workflow-clipboard.store'
import { REDACT_MASK, type WorkflowGraph } from './workflow-model'
import { nodeDisplayName } from './canvas/node-meta'

/**
 * 工作流对话框组（新建 / 重命名 / 删除确认 / 导入报告）：左栏第五视图
 * 单点消费，按会话挂载——关闭即卸载弃草稿。新建成功回调带新建实体（调用方
 * 决定打开编辑 Tab）；重命名与删除的缓存同步（清单失效 / Tab 关闭）由调用方
 * mutation 承担，本文件只做表单与确认交互。
 */

/** 新建工作流对话框（名称；成功后 onCreated 携新建实体） */
export function WorkflowCreateDialog({
  workspaceId,
  onCreated,
  onOpenChange,
}: {
  workspaceId: string
  onCreated: (dto: WorkflowDto) => void
  onOpenChange: (open: false) => void
}) {
  const { t } = useI18n()
  const [name, setName] = React.useState('')
  const createMutation = useIpcMutation({
    mutationFn: (name: string) => workflowCreate(workspaceId, name),
    onSuccess: (dto) => {
      void queryClient.invalidateQueries({ queryKey: workflowKeys.list(workspaceId) })
      onCreated(dto)
    },
  })

  const submit = () => {
    if (name.trim() === '' || createMutation.isPending) return
    createMutation.mutate(name)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onOpenChange(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('workflows.createTitle')}</DialogTitle>
          <DialogDescription>{t('workflows.createDescription')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter') submit()
            }}
            aria-label={t('workflows.nameLabel')}
            placeholder={t('workflows.namePlaceholder')}
            className="h-8"
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('workflows.cancel')}
          </Button>
          <Button
            disabled={name.trim() === '' || createMutation.isPending}
            onClick={submit}
            data-testid="workflow-create-confirm"
          >
            {t('workflows.createConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 解析报告体（粘贴 / 导入共用，「一条解析链两入口」的报告单点）：命中
 * 统计＋未命中清单（定位单元＝节点，稳定键原样回显；节点名取落地实体图）
 * ＋未命中重接指引＋写回激活引导；showMaskedHint 时对含掩码覆写值的导入
 * 图补敏感值失效提示（掩码字面量即落盘值，需人工补全）。标题、动作按钮
 * 与测试锚点前缀由入口自带。
 */
export function WorkflowReportBody({
  report,
  testId,
  showMaskedHint = false,
}: {
  report: WorkflowPasteReportDto
  /** 报告体测试锚点（`data-testid` 原值） */
  testId: string
  /** 导入入口传 true：图内存在掩码覆写值时补敏感值补全提示 */
  showMaskedHint?: boolean
}) {
  const { t } = useI18n()
  const graph = report.workflow.graph
  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      <p className="text-sm font-medium">{report.workflow.name}</p>
      <p className="text-xs text-muted-foreground">
        {t('workflows.pasteReportSummary', {
          hits: report.hitCount,
          misses: report.misses.length,
        })}
      </p>
      {report.misses.length > 0 && (
        <>
          <ul className="max-h-48 overflow-auto rounded-md border border-border">
            {report.misses.map((miss) => {
              const node = graph.nodes.find((candidate) => candidate.id === miss.nodeId)
              const displayName = node == null ? miss.nodeId : nodeDisplayName(node, t)
              return (
                <li
                  key={miss.nodeId}
                  className="flex items-center justify-between gap-2 border-b border-border px-2 py-1 text-xs last:border-b-0"
                >
                  <span className="min-w-0 truncate">
                    <span className="font-medium">{displayName}</span>
                    <span className="ml-1.5 font-mono text-muted-foreground">
                      {miss.endpointKey}
                    </span>
                  </span>
                  <span className="shrink-0 text-destructive">
                    {missReasonText(miss.reason, t)}
                  </span>
                </li>
              )
            })}
          </ul>
          <p className="text-xs text-muted-foreground">{t('workflows.pasteMissHint')}</p>
        </>
      )}
      {hasCategoryWriteback(graph) && (
        <p className="text-xs text-muted-foreground" data-testid={`${testId}-writeback-hint`}>
          {t('workflows.pasteWritebackHint')}
        </p>
      )}
      {showMaskedHint && hasMaskedOverride(graph) && (
        <p className="text-xs text-muted-foreground" data-testid={`${testId}-masked-hint`}>
          {t('workflows.importMaskedHint')}
        </p>
      )}
    </div>
  )
}

/** 粘贴工作流对话框（两相：命名 → 解析报告）。名称预填「副本」后缀可改；
 * 报告相＝共用解析报告体（见 WorkflowReportBody）；「打开」携带落地实体
 * 交给调用方开编辑 Tab。 */
export function WorkflowPasteDialog({
  workspaceId,
  entry,
  onOpen,
  onOpenChange,
}: {
  workspaceId: string
  entry: WorkflowClipboardEntry
  onOpen: (dto: WorkflowDto) => void
  onOpenChange: (open: false) => void
}) {
  const { t } = useI18n()
  const [name, setName] = React.useState(() => entry.name + t('workflows.pasteNameSuffix'))
  const [report, setReport] = React.useState<WorkflowPasteReportDto | null>(null)
  const pasteMutation = useIpcMutation({
    mutationFn: (name: string) => workflowPaste(workspaceId, name, entry.graph),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: workflowKeys.list(workspaceId) })
      setReport(result)
    },
    onError: reportError,
  })

  const submit = () => {
    if (name.trim() === '' || pasteMutation.isPending) return
    pasteMutation.mutate(name)
  }

  if (report) {
    return (
      <Dialog open onOpenChange={(open) => !open && onOpenChange(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('workflows.pasteReportTitle')}</DialogTitle>
          </DialogHeader>
          <WorkflowReportBody report={report} testId="workflows-paste-report" />
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('workflows.pasteDone')}
            </Button>
            <Button onClick={() => onOpen(report.workflow)} data-testid="workflows-paste-open">
              {t('workflows.pasteOpen')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onOpenChange(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('workflows.pasteWorkflow')}</DialogTitle>
          <DialogDescription>
            {t('workflows.pasteDescription', { name: entry.name })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter') submit()
            }}
            aria-label={t('workflows.nameLabel')}
            className="h-8"
            autoFocus
            onFocus={(event) => event.target.select()}
            data-testid="workflows-paste-name"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('workflows.cancel')}
          </Button>
          <Button
            disabled={name.trim() === '' || pasteMutation.isPending}
            onClick={submit}
            data-testid="workflows-paste-confirm"
          >
            {t('workflows.pasteConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 未命中原因 → 本地化文案（未知原因回落原词——词表演进期不炸渲染）。 */
function missReasonText(reason: string, t: ReturnType<typeof useI18n>['t']): string {
  if (reason === 'notFound') return t('workflows.pasteMissReasonNotFound')
  if (reason === 'ambiguous') return t('workflows.pasteMissReasonAmbiguous')
  return reason
}

/**
 * 导入完成报告对话框：与粘贴报告同体（共用解析报告体），叠加掩码补值
 * 引导——导出文件中的敏感覆写值以掩码字面量落盘，导入后不可直接使用。
 * 「打开」携带落地实体交给调用方开编辑 Tab。
 */
export function WorkflowImportReportDialog({
  report,
  onOpen,
  onOpenChange,
}: {
  report: WorkflowPasteReportDto
  onOpen: (dto: WorkflowDto) => void
  onOpenChange: (open: false) => void
}) {
  const { t } = useI18n()
  return (
    <Dialog open onOpenChange={(open) => !open && onOpenChange(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('workflows.importReportTitle')}</DialogTitle>
        </DialogHeader>
        <WorkflowReportBody report={report} testId="workflows-import-report" showMaskedHint />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('workflows.pasteDone')}
          </Button>
          <Button onClick={() => onOpen(report.workflow)} data-testid="workflows-import-open">
            {t('workflows.pasteOpen')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 图内可判定：存在启用写回分支且目标分类名非空的参数提取节点
 * （报告激活引导的触发条件；只看图，不查目标空间的激活态）。 */
function hasCategoryWriteback(graph: WorkflowGraph): boolean {
  return graph.nodes.some(
    (node) =>
      node.config.type === 'extract' &&
      node.config.writeback.enabled &&
      node.config.writeback.categoryName != null &&
      node.config.writeback.categoryName !== '',
  )
}

/** 图内可判定：存在覆写行值为掩码字面量的请求节点（导入图的掩码值即落盘
 * 值、不可直接使用；与 Rust `redact::MASK` 同源常量比对）。 */
function hasMaskedOverride(graph: WorkflowGraph): boolean {
  return graph.nodes.some(
    (node) =>
      node.config.type === 'request' &&
      (node.config.query.some((row) => row.value === REDACT_MASK) ||
        node.config.pathParams.some((row) => row.value === REDACT_MASK)),
  )
}

/** 重命名工作流对话框（按会话挂载） */
export function WorkflowRenameDialog({
  target,
  pending,
  onSubmit,
  onOpenChange,
}: {
  target: WorkflowSummaryDto
  pending: boolean
  onSubmit: (name: string) => void
  onOpenChange: (open: false) => void
}) {
  const { t } = useI18n()
  const [name, setName] = React.useState(target.name)

  const submit = () => {
    const next = name.trim()
    if (next === '' || next === target.name || pending) return
    onSubmit(next)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onOpenChange(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('workflows.renameTitle')}</DialogTitle>
        </DialogHeader>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') submit()
          }}
          aria-label={t('workflows.nameLabel')}
          className="h-8"
          autoFocus
          onFocus={(event) => event.target.select()}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('workflows.cancel')}
          </Button>
          <Button disabled={name.trim() === '' || pending} onClick={submit}>
            {t('workflows.renameConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 删除工作流确认框（硬删除警示；确认后回调执行 mutation） */
export function WorkflowDeleteDialog({
  target,
  pending,
  onSubmit,
  onOpenChange,
}: {
  target: WorkflowSummaryDto
  pending: boolean
  onSubmit: () => void
  onOpenChange: (open: false) => void
}) {
  const { t } = useI18n()
  return (
    <AlertDialog open onOpenChange={(open) => !open && onOpenChange(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('workflows.deleteTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('workflows.deleteDescription', { name: target.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('workflows.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(event) => {
              event.preventDefault()
              onSubmit()
            }}
            data-testid="workflow-delete-confirm"
          >
            {t('workflows.deleteConfirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** 新建分组对话框（名称；成功回调带新建实体）。重名等失败走统一错误
 * 上报（error-center 按 `errors.WORKFLOW_GROUP_NAME_EXISTS` 本地化呈现）。 */
export function WorkflowGroupCreateDialog({
  workspaceId,
  onCreated,
  onOpenChange,
}: {
  workspaceId: string
  onCreated: (dto: WorkflowGroupDto) => void
  onOpenChange: (open: false) => void
}) {
  const { t } = useI18n()
  const [name, setName] = React.useState('')
  const createMutation = useIpcMutation({
    mutationFn: (name: string) => workflowGroupCreate(workspaceId, name),
    onSuccess: (dto) => {
      void queryClient.invalidateQueries({ queryKey: workflowKeys.groups(workspaceId) })
      onCreated(dto)
    },
    onError: reportError,
  })

  const submit = () => {
    if (name.trim() === '' || createMutation.isPending) return
    createMutation.mutate(name)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onOpenChange(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('workflows.groupCreateTitle')}</DialogTitle>
          <DialogDescription>{t('workflows.groupCreateDescription')}</DialogDescription>
        </DialogHeader>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') submit()
          }}
          aria-label={t('workflows.nameLabel')}
          className="h-8"
          autoFocus
          data-testid="workflow-group-name"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('workflows.cancel')}
          </Button>
          <Button
            disabled={name.trim() === '' || createMutation.isPending}
            onClick={submit}
            data-testid="workflow-group-confirm"
          >
            {t('workflows.groupConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 重命名分组对话框（按会话挂载；分组名变更经 groups 前缀失效同步树） */
export function WorkflowGroupRenameDialog({
  target,
  onOpenChange,
}: {
  target: WorkflowGroupDto
  onOpenChange: (open: false) => void
}) {
  const { t } = useI18n()
  const [name, setName] = React.useState(target.name)
  const renameMutation = useIpcMutation({
    mutationFn: (name: string) => workflowGroupRename(target.id, name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workflowKeys.groupsPrefix })
    },
    onError: reportError,
  })

  const submit = () => {
    const next = name.trim()
    if (next === '' || next === target.name || renameMutation.isPending) return
    renameMutation.mutate(next, { onSuccess: () => onOpenChange(false) })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onOpenChange(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('workflows.groupRenameTitle')}</DialogTitle>
        </DialogHeader>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') submit()
          }}
          aria-label={t('workflows.nameLabel')}
          className="h-8"
          autoFocus
          onFocus={(event) => event.target.select()}
          data-testid="workflow-group-name"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('workflows.cancel')}
          </Button>
          <Button disabled={name.trim() === '' || renameMutation.isPending} onClick={submit}>
            {t('workflows.renameConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 删除分组确认框（组内工作流回落未分组，不删工作流） */
export function WorkflowGroupDeleteDialog({
  target,
  pending,
  onSubmit,
  onOpenChange,
}: {
  target: WorkflowGroupDto
  pending: boolean
  onSubmit: () => void
  onOpenChange: (open: false) => void
}) {
  const { t } = useI18n()
  return (
    <AlertDialog open onOpenChange={(open) => !open && onOpenChange(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('workflows.groupDeleteTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('workflows.groupDeleteDescription', { name: target.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('workflows.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={(event) => {
              event.preventDefault()
              onSubmit()
            }}
            data-testid="workflow-group-delete-confirm"
          >
            {t('workflows.deleteConfirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
