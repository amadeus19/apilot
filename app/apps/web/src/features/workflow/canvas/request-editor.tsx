import * as React from 'react'

import { ChevronDownIcon, PlusIcon, TriangleAlertIcon, XIcon } from 'lucide-react'

import {
  Button,
  Command,
  CommandItem,
  CommandList,
  Field,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Textarea,
} from '@workspace/ui/components'

import { useI18n } from '@/i18n'
import { invoke } from '@/services/ipc'
import { useIpcQuery } from '@/services/ipc-query'
import { workbenchKeys, userDataGet, type TreeDto } from '@/services/workbench-api'
import { useCurrentWorkspaceTreeQuery } from '@/features/workspaces/api'
import type { EndpointDoc } from '@/features/http/endpoint-doc-logic'

import { splitStableKey } from '../endpoint-dnd'
import { useObservedRoots } from './use-observed-roots'
import { pathTemplateParams, type OverrideRow, type RequestNodeConfig } from '../workflow-model'
import { useWorkflowEditorStore } from '../workflow-editor.store'
import { MethodBadge } from '@/features/api-tree/method-badge'
import { WorkflowIdContext } from './workflow-id-context'
import {
  collectMappingCandidates,
  displayPathRows,
  displayQueryRows,
  prefilledBodyText,
  upsertOverrideValue,
  upstreamExtractNodeIds,
  type PathDisplayRow,
  type QueryDisplayRow,
} from './request-mapping'
import { InvalidRefContext } from './validation-context'

/**
 * 请求节点配置编辑面：稳定键展示＋path 模板参数字段化＋query 覆写行
 * （接口定义参数预填）＋body（接口配置预填）＋超时覆写＋值候选下拉（上游
 * 提取产物引用，按连线识别上游）。覆写叠加在引用接口用户数据之上，改动
 * 即经更新通道落编辑会话（标脏，保存走工具栏 / Ctrl+S）。header 覆写已取消
 * （Content-Type 等由接口用户数据承担）。失效引用＝警示块＋重接引导（稳定
 * 键留痕恒可见：方法＋路径不因失效消失；从接口树拖入接口到节点即重接），
 * 失效态不预填。
 *
 * 预填全是渲染期纯派生（定义参数行 / 模板参数行 / body 文本），无 effect
 * 播种：绑定接口经树反查唯一命中后经既有 IPC 读取 doc 与用户数据，读取
 * 失败 / 歧义命中静默降级为不预填。body 显示值＝config.body（用户编辑过，
 * 含显式清空的空串）?? 预填文本（null＝从未编辑），用户清空落空串不再转
 * null——null 与空串的区分只在这个显示面（执行层两者都跟随接口用户数据），
 * 由此「清空不回灌预填」与「未编辑恒显示预填」并存。
 */

/** 超时输入解析（毫秒）：空串＝清除覆写（null＝继承），零 / 负数 / 非数字
 * 输入回落原值不落库（0 在超时档家族里无「立即超时」的产品语义，禁入） */
function parseTimeoutMs(value: string, fallback: number | null): number | null {
  if (value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

/** 树反查绑定接口（预填数据源定位面）：稳定键在工作空间树内唯一命中才
 * 返回（0 命中＝失效引用、多命中＝稳定键歧义，都静默降级为不预填） */
interface BoundEndpointRef {
  serviceId: string
  key: string
  pathTemplate: string
}

function findBoundEndpoint(
  tree: TreeDto | undefined,
  endpointKey: string | null,
): BoundEndpointRef | null {
  if (tree == null || endpointKey == null) return null
  const hits = tree.services
    .flatMap((service) => service.endpoints)
    .filter((endpoint) => endpoint.key === endpointKey)
  if (hits.length !== 1) return null
  const hit = hits[0]
  return { serviceId: hit.serviceId, key: hit.key, pathTemplate: hit.definition.pathTemplate }
}

/** 候选引用插入语义：值尾追加（插入后可手改） */
function appendRef(value: string, ref: string): string {
  return `${value}{{${ref}}}`
}

/** 行值输入（候选下拉＋自由输入）：候选点击把 `{{引用}}` 追加到值尾；
 * 无上游提取候选时退化为纯输入框（不渲染下拉钮） */
function RefValueInput({
  value,
  candidates,
  onChange,
}: {
  value: string
  candidates: readonly string[]
  onChange: (value: string) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = React.useState(false)
  const input = (
    <Input
      value={value}
      placeholder={t('workflows.overrideValuePlaceholder')}
      className="h-6 min-w-0 flex-1 px-1.5 text-xs"
      onChange={(event) => onChange(event.target.value)}
    />
  )
  if (candidates.length === 0) return input
  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5">
      {input}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('workflows.valueCandidatesLabel')}
              data-testid="workflow-override-value-candidates"
              className="shrink-0"
            >
              <ChevronDownIcon aria-hidden className="size-3" />
            </Button>
          }
        />
        <PopoverContent className="w-56 p-0" align="end">
          <Command>
            <CommandList>
              {candidates.map((ref) => (
                <CommandItem
                  key={ref}
                  value={ref}
                  onSelect={() => {
                    onChange(appendRef(value, ref))
                    setOpen(false)
                  }}
                >
                  <span className="font-mono text-xs">{`{{${ref}}}`}</span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}

/** path 模板参数填值区（模板参数逐行：名称固定只读＋值输入；无模板参数
 * 整区不渲染）。值空＝不填充（执行期占位洞原样保留），落库走 upsert
 * 通道（值空＝移除同名行）。 */
function PathParamsRows({
  rows,
  candidates,
  onUpsert,
}: {
  rows: readonly PathDisplayRow[]
  candidates: readonly string[]
  onUpsert: (name: string, value: string) => void
}) {
  const { t } = useI18n()
  return (
    <div data-testid="workflow-override-path">
      <div className="mb-1 text-micro text-muted-foreground">{t('workflows.overridePath')}</div>
      {rows.map((row) => (
        <div key={row.name} className="mb-1 flex items-center gap-1">
          <span
            className="h-6 min-w-0 flex-1 truncate px-1.5 font-mono text-xs leading-6 text-muted-foreground"
            title={row.name}
          >
            {row.name}
          </span>
          <RefValueInput
            value={row.value}
            candidates={candidates}
            onChange={(value) => onUpsert(row.name, value)}
          />
        </div>
      ))}
    </div>
  )
}

/** query 区（定义参数预填行＋自由覆写行）：定义行名称固定＋必填标记＋
 * 值输入（值空＝不覆写该参数），无删除钮（删除语义＝清空值，执行等价）；
 * 自由行完整可编辑可删（编辑按显示行定位到落库行下标，不扰动定义行的
 * 落库切片）。 */
function QueryRowsSection({
  rows,
  storedRows,
  candidates,
  onUpsert,
  onStoredRowsChange,
}: {
  rows: readonly QueryDisplayRow[]
  storedRows: readonly OverrideRow[]
  candidates: readonly string[]
  onUpsert: (name: string, value: string) => void
  onStoredRowsChange: (rows: OverrideRow[]) => void
}) {
  const { t } = useI18n()
  const freeRows = rows.filter((row) => !row.defined)
  const updateFreeRow = (freeIndex: number, patch: Partial<OverrideRow>) => {
    const target = freeRows[freeIndex]
    if (target == null) return
    onStoredRowsChange(
      storedRows.map((row, i) => (i === target.rowIndex ? { ...row, ...patch } : row)),
    )
  }
  const removeFreeRow = (freeIndex: number) => {
    const target = freeRows[freeIndex]
    if (target == null) return
    onStoredRowsChange(storedRows.filter((_, i) => i !== target.rowIndex))
  }
  return (
    <div data-testid="workflow-override-query">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-micro text-muted-foreground">{t('workflows.overrideQuery')}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('workflows.addRow')}
          onClick={() => onStoredRowsChange([...storedRows, { name: '', value: '' }])}
        >
          <PlusIcon aria-hidden className="size-3" />
        </Button>
      </div>
      {rows.map((row) =>
        row.defined ? (
          <div key={`defined:${row.name}`} className="mb-1 flex items-center gap-1">
            <span
              className="h-6 min-w-0 flex-1 truncate px-1.5 font-mono text-xs leading-6"
              title={row.name}
            >
              {row.name}
              {row.required && (
                <span
                  className="ml-0.5 text-destructive"
                  title={t('workflows.requiredMarkTitle')}
                  data-testid="workflow-override-required-mark"
                >
                  *
                </span>
              )}
            </span>
            <RefValueInput
              value={row.value}
              candidates={candidates}
              onChange={(value) => onUpsert(row.name, value)}
            />
          </div>
        ) : (
          <div key={`free:${row.rowIndex}`} className="mb-1 flex items-center gap-1">
            <Input
              value={row.name}
              placeholder={t('workflows.overrideNamePlaceholder')}
              className="h-6 min-w-0 flex-1 px-1.5 text-xs"
              onChange={(event) =>
                updateFreeRow(freeRows.indexOf(row), { name: event.target.value })
              }
            />
            <RefValueInput
              value={row.value}
              candidates={candidates}
              onChange={(value) => updateFreeRow(freeRows.indexOf(row), { value })}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('workflows.removeRow')}
              className="shrink-0"
              onClick={() => removeFreeRow(freeRows.indexOf(row))}
            >
              <XIcon aria-hidden className="size-3" />
            </Button>
          </div>
        ),
      )}
    </div>
  )
}

/** 请求节点配置编辑面（稳定键只读；覆写可编辑；失效态附重接引导） */
export function RequestEditor({
  nodeId,
  config,
  onChange,
}: {
  nodeId: string
  config: RequestNodeConfig
  onChange: (next: RequestNodeConfig) => void
}) {
  const { t } = useI18n()
  const workflowId = React.useContext(WorkflowIdContext)
  const stable = config.endpointKey != null ? splitStableKey(config.endpointKey) : null
  const invalidRefs = React.useContext(InvalidRefContext)
  const invalid = config.endpointKey != null && invalidRefs.has(nodeId)

  // 预填数据源（树反查唯一命中 → doc 参数与用户数据 body）：失效引用态
  // 不预填（留痕展示不变），读取失败 / 歧义命中静默降级为不预填
  const { data: tree } = useCurrentWorkspaceTreeQuery()
  const bound = React.useMemo(
    () => findBoundEndpoint(tree, config.endpointKey),
    [tree, config.endpointKey],
  )
  const prefillEnabled = bound != null && !invalid
  const docQuery = useIpcQuery({
    queryKey: workbenchKeys.endpointDoc(bound?.serviceId ?? '', bound?.key ?? ''),
    queryFn: () =>
      invoke<EndpointDoc | null>('endpoint.doc', {
        serviceId: bound?.serviceId ?? '',
        key: bound?.key ?? '',
      }),
    enabled: prefillEnabled,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const userDataQuery = useIpcQuery({
    queryKey: workbenchKeys.userData(bound?.serviceId ?? '', bound?.key ?? ''),
    queryFn: () => userDataGet(bound?.serviceId ?? '', bound?.key ?? ''),
    enabled: prefillEnabled,
  })

  // 显示行投影（渲染期纯派生，无 effect 播种）：query 定义参数行预填自
  // doc parameters（location=query），path 行自路径模板 `{param}` 段
  // （树命中的定义模板优先，稳定键路径留痕兜底——失效态仍显示参数行）
  const definedParams = React.useMemo(
    () =>
      (docQuery.data?.parameters ?? [])
        .filter((param) => param.location === 'query')
        .map((param) => ({ name: param.name, required: param.required })),
    [docQuery.data],
  )
  const templateParams = React.useMemo(
    () => pathTemplateParams(bound?.pathTemplate ?? stable?.path ?? ''),
    [bound?.pathTemplate, stable?.path],
  )
  const queryRows = React.useMemo(
    () => displayQueryRows(config.query, definedParams),
    [config.query, definedParams],
  )
  const pathRows = React.useMemo(
    () => displayPathRows(config.pathParams, templateParams),
    [config.pathParams, templateParams],
  )
  const prefilledBody = React.useMemo(
    () => prefilledBodyText(userDataQuery.data?.body ?? null, docQuery.data?.requestBody?.example),
    [userDataQuery.data, docQuery.data],
  )

  // 候选集（值输入下拉数据面）：最近执行记录（实测字段数据源）编辑面开启
  // 即取（取数面见 use-observed-roots，与写回分支共用），上游提取节点的
  // 实测根与全量候选（collectMappingCandidates，含深层展开）在此收集
  const graph = useWorkflowEditorStore((s) =>
    workflowId != null ? s.sessions[workflowId]?.graph : undefined,
  )
  const extractIds = React.useMemo(
    () => (graph != null ? upstreamExtractNodeIds(graph, nodeId) : []),
    [graph, nodeId],
  )
  const observedRoots = useObservedRoots(workflowId, graph, extractIds)
  const candidateRefs = React.useMemo(
    () => (graph != null ? collectMappingCandidates(graph, nodeId, observedRoots) : []),
    [graph, nodeId, observedRoots],
  )

  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="workflow-request-editor">
      <div>
        <div className="text-micro text-muted-foreground">{t('workflows.requestEndpoint')}</div>
        {config.endpointKey == null ? (
          <p className="mt-0.5 text-muted-foreground">{t('workflows.requestBindHint')}</p>
        ) : stable != null ? (
          <div className="mt-0.5 flex items-center gap-1.5">
            <MethodBadge method={stable.method} />
            <span className="min-w-0 font-mono text-micro break-all">{stable.path}</span>
          </div>
        ) : (
          <div className="mt-0.5 font-mono text-micro break-all">{config.endpointKey}</div>
        )}
        {invalid && (
          <div
            className="mt-1.5 rounded-sm border border-destructive/40 bg-destructive/10 px-1.5 py-1"
            data-testid="workflow-request-invalid-hint"
          >
            <p className="flex items-start gap-1 font-medium text-destructive">
              <TriangleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
              {t('workflows.requestInvalidHint')}
            </p>
            <p className="mt-0.5 text-muted-foreground">{t('workflows.requestRebindHint')}</p>
          </div>
        )}
      </div>
      {pathRows.length > 0 && (
        <PathParamsRows
          rows={pathRows}
          candidates={candidateRefs}
          onUpsert={(name, value) =>
            onChange({ ...config, pathParams: upsertOverrideValue(config.pathParams, name, value) })
          }
        />
      )}
      <QueryRowsSection
        rows={queryRows}
        storedRows={config.query}
        candidates={candidateRefs}
        onUpsert={(name, value) =>
          onChange({ ...config, query: upsertOverrideValue(config.query, name, value) })
        }
        onStoredRowsChange={(query) => onChange({ ...config, query })}
      />
      <div>
        <div className="mb-1 text-micro text-muted-foreground">{t('workflows.overrideBody')}</div>
        <Textarea
          value={config.body ?? prefilledBody}
          placeholder={t('workflows.overrideBodyPlaceholder')}
          className="max-h-40 min-h-16 overflow-y-auto text-xs"
          onChange={(event) => onChange({ ...config, body: event.target.value })}
        />
      </div>
      <Field label={t('workflows.overrideTimeoutLabel')}>
        <Input
          type="number"
          min={0}
          value={config.timeoutMs ?? ''}
          placeholder={t('workflows.overrideTimeoutPlaceholder')}
          data-testid="workflow-request-timeout-input"
          className="h-6 px-1.5 font-mono text-xs"
          onChange={(event) =>
            onChange({
              ...config,
              timeoutMs: parseTimeoutMs(event.target.value, config.timeoutMs),
            })
          }
        />
      </Field>
    </div>
  )
}
