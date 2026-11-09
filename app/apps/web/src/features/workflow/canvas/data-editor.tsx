import * as React from 'react'

import { PlusIcon, XIcon } from 'lucide-react'

import {
  Button,
  Field,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from '@workspace/ui/components'

import { useIpcQuery } from '@/services/ipc-query'
import { useI18n } from '@/i18n'
import { formatBulkKvText, mergeBulkIntoRows, parseBulkKvText } from '@/features/workbench/kv-rows'
import {
  variableKeys,
  variableListCategories,
  type VariableCategoryDto,
} from '@/features/variables/variable-api'
import { useCurrentWorkspaceTreeQuery } from '@/features/workspaces/api'

import { WorkflowIdContext } from './workflow-id-context'

import { expandObservedFields } from '../extract-observed'
import { useObservedRoot } from './use-observed-roots'
import { extractUpstreamRequestId } from './request-mapping'
import { useWorkflowEditorStore } from '../workflow-editor.store'
import {
  tailKeyOfPath,
  type ExtractNodeConfig,
  type ExtractRule,
  type ExtractSource,
  type ExtractWriteback,
} from '../workflow-model'

/**
 * 数据组节点配置编辑面（参数提取单来源多规则配置）：来源节点级选一次，
 * 规则块逐条配取值路径与产物名（路径输入联动产物名尾键建议——用户改过名
 * 不覆盖；规则可增删、可删空，空集由校验面板兜底提示；规则区限高滚动，
 * 批量编辑＝接口侧键值行同款文本模式，产物名＝键、取值路径＝值，同名产物
 * 仅更新路径）＋写回分支（存变量开关与敏感开关同行，敏感开关随写回启用
 * 才可用；写回值下拉列出全部产物——Body 源逐产物展开实测字段——＋目标
 * 分类下拉；执行写回语义按分类名解析、未命中自愈重建、upsert、不回滚，
 * 变量键不展示，选择写回值时自动写值尾段进模型）。改动经更新通道落编辑
 * 会话（标脏，保存走工具栏 / Ctrl+S）。
 */

/** 参数提取来源四选（值＝领域枚举，文案经 i18n；jsonPath 的显示名 Body） */
const EXTRACT_SOURCES: readonly {
  value: ExtractSource
  labelKey:
    | 'workflows.extractSourceJsonPath'
    | 'workflows.extractSourceHeader'
    | 'workflows.extractSourceStatusCode'
    | 'workflows.extractSourceText'
}[] = [
  { value: 'jsonPath', labelKey: 'workflows.extractSourceJsonPath' },
  { value: 'header', labelKey: 'workflows.extractSourceHeader' },
  { value: 'statusCode', labelKey: 'workflows.extractSourceStatusCode' },
  { value: 'text', labelKey: 'workflows.extractSourceText' },
]

/** 路径输入不可用的来源（状态码 / 文本——路径无语义，输入禁用） */
const PATHLESS_SOURCES: ReadonlySet<ExtractSource> = new Set(['statusCode', 'text'])

/** 写回值来源的尾段（选择选项后变量键的缺省建议：`data.token` → `token`）。 */
function tailSegmentOf(productPath: string): string {
  const trimmed = productPath.trim()
  if (trimmed === '') return ''
  return trimmed.split('.').pop() ?? trimmed
}

export function ExtractEditor({
  nodeId,
  config,
  onChange,
}: {
  nodeId: string
  config: ExtractNodeConfig
  onChange: (next: ExtractNodeConfig) => void
}) {
  const { t } = useI18n()
  const pathless = PATHLESS_SOURCES.has(config.source)

  const updateSource = (source: ExtractSource) => {
    onChange({ ...config, source })
  }
  // 逐规则编辑；规则无独立身份，行位即身份（受控输入随行位重排渲染）
  const updateRule = (index: number, next: ExtractRule) => {
    onChange({ ...config, rules: config.rules.map((rule, i) => (i === index ? next : rule)) })
  }
  // 路径输入联动产物名缺省建议（逐规则）：空名或仍等于旧尾键时同步（用户
  // 改过名不覆盖）
  const updateRulePath = (index: number, path: string) => {
    const rule = config.rules[index]
    if (rule == null) return
    const syncName = rule.name === '' || rule.name === tailKeyOfPath(rule.path)
    updateRule(index, { ...rule, path, name: syncName ? tailKeyOfPath(path) : rule.name })
  }
  const addRule = () => {
    onChange({ ...config, rules: [...config.rules, { path: '', name: '' }] })
  }
  const removeRule = (index: number) => {
    // 允许删空（rules 空数组）：产物缺失由校验面板兜底提示
    onChange({ ...config, rules: config.rules.filter((_, i) => i !== index) })
  }

  // 批量编辑态：null＝规则块模式；非 null＝批量文本模式（值即文本框内容）。
  // 语义与接口侧键值行批量编辑同源（kv-rows 纯函数复用）：产物名＝键、取值
  // 路径＝值，同名产物仅更新路径，未提及的既有产物原样保留；空名规则（新建
  // 播种的待填行）不进种子也不进合并基线。路径无语义的来源（状态码 / 文本）
  // 不出批量编辑入口
  const [bulkText, setBulkText] = React.useState<string | null>(null)
  const namedRuleRows = () =>
    config.rules
      .filter((rule) => rule.name.trim() !== '')
      .map((rule) => ({ name: rule.name, value: rule.path }))
  const enterBulk = () => setBulkText(formatBulkKvText(namedRuleRows()))
  const applyBulk = () => {
    if (bulkText === null) return
    const merged = mergeBulkIntoRows(namedRuleRows(), parseBulkKvText(bulkText))
    onChange({ ...config, rules: merged.map((row) => ({ path: row.value, name: row.name })) })
    setBulkText(null)
  }
  const cancelBulk = () => setBulkText(null)

  const updateWriteback = (patch: Partial<ExtractWriteback>) => {
    onChange({ ...config, writeback: { ...config.writeback, ...patch } })
  }
  // 产物集（trim 后非空的规则产物，序＝规则序）：写回值下拉与开启缺省的单一来源
  const products = React.useMemo(
    () =>
      config.rules
        .map((rule) => ({ name: rule.name.trim(), path: rule.path }))
        .filter((product) => product.name !== ''),
    [config.rules],
  )
  // 存变量开关开启：写回值缺省取首个产物、键缺省取其尾段（多规则取第一条）
  const toggleWriteback = (enabled: boolean) => {
    if (!enabled) {
      updateWriteback({ enabled })
      return
    }
    const product = products[0]?.name ?? ''
    updateWriteback({
      enabled,
      productPath: config.writeback.productPath !== '' ? config.writeback.productPath : product,
      key: config.writeback.key !== '' ? config.writeback.key : tailSegmentOf(product),
    })
  }

  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="workflow-extract-editor">
      <Field label={t('workflows.extractSourceLabel')}>
        <Select value={config.source} onValueChange={(value) => updateSource(value ?? 'jsonPath')}>
          <SelectTrigger className="h-6 w-full px-1.5 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EXTRACT_SOURCES.map((entry) => (
              <SelectItem key={entry.value} value={entry.value}>
                {t(entry.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {bulkText === null ? (
        <>
          {config.rules.length > 0 && (
            <div
              className="flex max-h-48 flex-col gap-2 overflow-y-auto pr-0.5"
              data-testid="workflow-extract-rules"
            >
              {config.rules.map((rule, index) => (
                <div
                  key={index}
                  className="relative flex flex-col gap-2 rounded border border-node-line p-2"
                  data-testid="workflow-extract-rule"
                >
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('workflows.extractRemoveRule')}
                    title={t('workflows.extractRemoveRule')}
                    className="absolute top-1 right-1"
                    data-testid="workflow-extract-rule-remove"
                    onClick={() => removeRule(index)}
                  >
                    <XIcon aria-hidden className="size-3" />
                  </Button>
                  <Field label={t('workflows.extractPathLabel')}>
                    <Input
                      value={rule.path}
                      disabled={pathless}
                      placeholder={
                        pathless
                          ? t('workflows.extractPathNotNeeded')
                          : t('workflows.extractPathPlaceholder')
                      }
                      className="h-6 px-1.5 font-mono text-xs"
                      onChange={(event) => updateRulePath(index, event.target.value)}
                    />
                  </Field>
                  <Field label={t('workflows.extractNameLabel')}>
                    <Input
                      value={rule.name}
                      placeholder={t('workflows.extractNamePlaceholder')}
                      className="h-6 px-1.5 text-xs"
                      onChange={(event) => updateRule(index, { ...rule, name: event.target.value })}
                    />
                  </Field>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs"
              data-testid="workflow-extract-rule-add"
              onClick={addRule}
            >
              <PlusIcon aria-hidden className="size-3" />
              {t('workflows.extractAddRule')}
            </Button>
            {!pathless && (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-primary"
                data-testid="workflow-extract-bulk-edit"
                onClick={enterBulk}
              >
                {t('workflows.extractBulkEdit')}
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <p className="min-w-0 flex-1 text-micro text-muted-foreground">
              {t('workflows.extractBulkHint')}
            </p>
            <Button
              type="button"
              size="sm"
              className="h-6 px-2 text-xs"
              data-testid="workflow-extract-bulk-apply"
              onClick={applyBulk}
            >
              {t('workflows.extractBulkApply')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              data-testid="workflow-extract-bulk-cancel"
              onClick={cancelBulk}
            >
              {t('workflows.extractBulkCancel')}
            </Button>
          </div>
          <Textarea
            value={bulkText}
            onChange={(event) => setBulkText(event.target.value)}
            spellCheck={false}
            aria-label={t('workflows.extractBulkEdit')}
            // 基类随内容长高（field-sizing: content），封顶后转内部滚动：
            // 批量文本过长不撑高节点卡片
            className="max-h-48 min-h-32 resize-none overflow-y-auto font-mono text-xs"
            data-testid="workflow-extract-bulk-textarea"
          />
        </div>
      )}
      <p className="text-micro text-muted-foreground">{t('workflows.extractUpstreamHint')}</p>
      <ExtractWritebackBranch
        config={config.writeback}
        source={config.source}
        products={products}
        nodeId={nodeId}
        onChange={updateWriteback}
        onToggle={toggleWriteback}
      />
    </div>
  )
}

/** 写回值来源的产物（trim 后非空的规则产物，序＝规则序） */
interface ExtractProductOption {
  name: string
  path: string
}

/** 写回分支（存变量开关）：写回值下拉顶层选项＝本节点全部产物名，Body 源
 * 逐产物展开最近执行中上游请求节点的实测字段（掩码体可解析字段名，无执行
 * 记录回落自由输入；无实测字段的产物不成组）；产物集为空＝无可选产物，显
 * 空态提示。目标分类下拉＝本空间变量分类清单（不含全局分类）。 */
function ExtractWritebackBranch({
  config,
  source,
  products,
  nodeId,
  onChange,
  onToggle,
}: {
  config: ExtractWriteback
  source: ExtractSource
  products: readonly ExtractProductOption[]
  nodeId: string
  onChange: (patch: Partial<ExtractWriteback>) => void
  onToggle: (enabled: boolean) => void
}) {
  const { t } = useI18n()
  const workflowId = React.useContext(WorkflowIdContext)
  const { workspaceId } = useCurrentWorkspaceTreeQuery()

  const categoriesQuery = useIpcQuery({
    queryKey: variableKeys.categories(workspaceId ?? ''),
    queryFn: () => variableListCategories(workspaceId ?? ''),
    // 写回分支展开才取清单（分类选择的数据源）
    enabled: workspaceId != null && config.enabled,
  })
  const categories: VariableCategoryDto[] = (categoriesQuery.data?.items ?? []).filter(
    (category) => !category.isGlobal,
  )

  // 上游请求节点定位（最近一次执行回看面）→ 产物实测字段（取数面见
  // use-observed-roots，与请求节点入参候选共用）
  const graph = useWorkflowEditorStore((s) =>
    workflowId ? s.sessions[workflowId]?.graph : undefined,
  )
  const upstreamId = React.useMemo(() => extractUpstreamRequestId(graph, nodeId), [graph, nodeId])
  const observedRoot = useObservedRoot(workflowId, upstreamId, config.enabled)

  // Body 源逐产物展开实测字段（无实测数据只显顶层产物名）
  const expandedGroups = React.useMemo(() => {
    if (observedRoot == null || source !== 'jsonPath') return []
    return products
      .map((product) => ({
        name: product.name,
        fields: expandObservedFields(product.name, product.path, observedRoot),
      }))
      .filter((group) => group.fields.length > 0)
  }, [observedRoot, source, products])

  return (
    <div className="flex flex-col gap-2 border-t border-node-line/70 pt-2">
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2">
          <Switch
            checked={config.enabled}
            onCheckedChange={(checked) => onToggle(checked === true)}
            data-testid="workflow-extract-writeback-switch"
          />
          <span>{t('workflows.writebackLabel')}</span>
        </label>
        <label className="ml-auto flex items-center gap-2">
          <Switch
            checked={config.secret}
            disabled={!config.enabled}
            onCheckedChange={(checked) => onChange({ secret: checked === true })}
            data-testid="workflow-extract-writeback-secret"
          />
          <span>{t('workflows.writebackSecretLabel')}</span>
        </label>
      </div>
      {config.enabled && (
        <>
          <Field label={t('workflows.writebackProductLabel')}>
            {products.length === 0 ? (
              <p
                className="text-micro text-muted-foreground"
                data-testid="workflow-extract-writeback-product-empty"
              >
                {t('workflows.writebackProductEmpty')}
              </p>
            ) : (
              <Select
                value={config.productPath === '' ? undefined : config.productPath}
                onValueChange={(value) =>
                  onChange({ productPath: value ?? '', key: tailSegmentOf(value ?? '') })
                }
              >
                <SelectTrigger className="w-full" data-testid="workflow-extract-writeback-product">
                  <SelectValue placeholder={t('workflows.writebackProductPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {products.map((product, index) => (
                    <SelectItem key={`${index}:${product.name}`} value={product.name}>
                      {product.name}
                    </SelectItem>
                  ))}
                  {expandedGroups.map((group) => (
                    <SelectGroup key={group.name}>
                      <SelectLabel>{group.name}</SelectLabel>
                      {group.fields.map((field) => (
                        <SelectItem key={field} value={field}>
                          {field}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field label={t('workflows.writebackCategoryLabel')}>
            <Select
              value={config.categoryName ?? undefined}
              onValueChange={(value) => onChange({ categoryName: value ?? null })}
            >
              <SelectTrigger className="w-full" data-testid="workflow-extract-writeback-category">
                <SelectValue placeholder={t('workflows.writebackCategoryPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {categories.map((category) => (
                  <SelectItem key={category.id} value={category.name}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </>
      )}
    </div>
  )
}
