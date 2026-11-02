import { useState } from 'react'

import { PlusIcon, XIcon } from 'lucide-react'

import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@workspace/ui/components'

import { useI18n, type DictKey } from '@/i18n'

import type { AssertRule } from '../workflow-model'

/**
 * 断言节点配置编辑面：行式规则编辑（增 / 删 / 类型切换），全部满足（AND）
 * 才通过。规则对象＝上游请求响应（上游必须是请求节点，执行引擎在执行期
 * 拦截，完整执行前校验清单另行收敛）；改动即经更新通道落编辑会话（标脏，
 * 保存走工具栏 / Ctrl+S）。
 */

/** 规则类型四选（值＝领域判别联合的 type 面，文案经 i18n） */
const RULE_KINDS: readonly { value: AssertRule['type']; labelKey: DictKey }[] = [
  { value: 'statusCode', labelKey: 'workflows.assertRuleStatusCode' },
  { value: 'jsonPath', labelKey: 'workflows.assertRuleJsonPath' },
  { value: 'exists', labelKey: 'workflows.assertRuleExists' },
  { value: 'contains', labelKey: 'workflows.assertRuleContains' },
]

/** 各规则类型的期望值语义（占位文案随类型切换） */
const EXPECTED_PLACEHOLDER_KEYS: Record<AssertRule['type'], DictKey> = {
  statusCode: 'workflows.assertExpectedStatusCode',
  jsonPath: 'workflows.assertExpectedValue',
  exists: 'workflows.assertExpectedValue',
  contains: 'workflows.assertContainsValue',
}

/** 新建规则行（类型直选默认＝状态码等于 200——最高频形态） */
function makeRule(type: AssertRule['type']): AssertRule {
  switch (type) {
    case 'statusCode':
      return { type: 'statusCode', expected: '200' }
    case 'jsonPath':
      return { type: 'jsonPath', path: '', expected: '' }
    case 'exists':
      return { type: 'exists', path: '' }
    case 'contains':
      return { type: 'contains', path: null, value: '' }
  }
}

/** 判别联合上的同名字段拾取（变体无该字段时返回 null） */
const pickExpected = (rule: AssertRule): string | null =>
  'expected' in rule ? rule.expected : null
const pickPath = (rule: AssertRule): string | null => ('path' in rule ? rule.path : null)
const pickValue = (rule: AssertRule): string | null => ('value' in rule ? rule.value : null)

/**
 * 类型切换的字段保留：形态骨架由 makeRule 重建，同名字段自原规则回填——
 * expected 跨 statusCode/jsonPath 保留、path 跨 jsonPath/exists/contains
 * 保留，切换不再静默丢弃已填内容。exists 缺 expected/value 字段：回填来
 * 源回落到切入 exists 前的暂存形态（memory）；当前规则已持有的同名字段
 * 恒优先（exists 上改过的 path 不被暂存覆盖），两者皆无时落 makeRule 的
 * 类型默认值（与新增行默认一致）。
 */
function switchRuleType(
  rule: AssertRule,
  next: AssertRule['type'],
  memory: AssertRule | null,
): AssertRule {
  // 回落通道仅在当前为 exists 时生效：直接切换不复活更早的历史值
  const fromFallback = (pick: (rule: AssertRule) => string | null): string | null =>
    rule.type === 'exists' && memory ? pick(memory) : null
  switch (next) {
    case 'statusCode':
      return {
        type: 'statusCode',
        expected: pickExpected(rule) ?? fromFallback(pickExpected) ?? '200',
      }
    case 'jsonPath':
      return {
        type: 'jsonPath',
        path: pickPath(rule) ?? fromFallback(pickPath) ?? '',
        expected: pickExpected(rule) ?? fromFallback(pickExpected) ?? '',
      }
    case 'exists':
      return { type: 'exists', path: pickPath(rule) ?? fromFallback(pickPath) ?? '' }
    case 'contains':
      return {
        type: 'contains',
        path: pickPath(rule) ?? fromFallback(pickPath) ?? null,
        value: pickValue(rule) ?? fromFallback(pickValue) ?? '',
      }
  }
}

/** 单条规则行：类型选择＋类型相关字段＋行删除 */
function AssertRuleRow({
  rule,
  onChange,
  onRemove,
}: {
  rule: AssertRule
  onChange: (next: AssertRule) => void
  onRemove: () => void
}) {
  const { t } = useI18n()
  // 切入 exists 前的形态暂存：exists 无 expected/value 同名字段，切回时经
  // switchRuleType 的回落通道还原；行实例按 index 保持，状态跨类型切换存活
  const [preExistsRule, setPreExistsRule] = useState<AssertRule | null>(null)
  return (
    <div
      className="mb-1.5 rounded-sm border border-border p-1.5"
      data-testid="workflow-assert-rule-row"
    >
      <div className="mb-1 flex items-center gap-1">
        <Select
          value={rule.type}
          onValueChange={(value) => {
            const next = (value ?? 'statusCode') as AssertRule['type']
            if (next === 'exists' && rule.type !== 'exists') setPreExistsRule(rule)
            onChange(switchRuleType(rule, next, preExistsRule))
          }}
        >
          <SelectTrigger className="h-6 min-w-0 flex-1 px-1.5 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RULE_KINDS.map((kind) => (
              <SelectItem key={kind.value} value={kind.value}>
                {t(kind.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('workflows.removeRow')}
          className="shrink-0"
          onClick={onRemove}
        >
          <XIcon aria-hidden className="size-3" />
        </Button>
      </div>
      {rule.type === 'statusCode' && (
        <Input
          value={rule.expected}
          placeholder={t(EXPECTED_PLACEHOLDER_KEYS.statusCode)}
          className="h-6 px-1.5 font-mono text-xs"
          onChange={(event) => onChange({ ...rule, expected: event.target.value })}
        />
      )}
      {rule.type === 'jsonPath' && (
        <div className="flex flex-col gap-1">
          <Input
            value={rule.path}
            placeholder={t('workflows.assertPathPlaceholder')}
            className="h-6 px-1.5 font-mono text-xs"
            onChange={(event) => onChange({ ...rule, path: event.target.value })}
          />
          <Input
            value={rule.expected}
            placeholder={t(EXPECTED_PLACEHOLDER_KEYS.jsonPath)}
            className="h-6 px-1.5 font-mono text-xs"
            onChange={(event) => onChange({ ...rule, expected: event.target.value })}
          />
        </div>
      )}
      {rule.type === 'exists' && (
        <Input
          value={rule.path}
          placeholder={t('workflows.assertPathPlaceholder')}
          className="h-6 px-1.5 font-mono text-xs"
          onChange={(event) => onChange({ ...rule, path: event.target.value })}
        />
      )}
      {rule.type === 'contains' && (
        <div className="flex flex-col gap-1">
          <Input
            value={rule.path ?? ''}
            placeholder={t('workflows.assertContainsPathPlaceholder')}
            className="h-6 px-1.5 font-mono text-xs"
            onChange={(event) =>
              onChange({ ...rule, path: event.target.value === '' ? null : event.target.value })
            }
          />
          <Input
            value={rule.value}
            placeholder={t(EXPECTED_PLACEHOLDER_KEYS.contains)}
            className="h-6 px-1.5 font-mono text-xs"
            onChange={(event) => onChange({ ...rule, value: event.target.value })}
          />
        </div>
      )}
    </div>
  )
}

/** 断言节点配置编辑面（规则行集增删；AND 组合语义提示常驻） */
export function AssertEditor({
  config,
  onChange,
}: {
  config: { type: 'assert'; rules: AssertRule[] }
  onChange: (next: { type: 'assert'; rules: AssertRule[] }) => void
}) {
  const { t } = useI18n()
  const rules = config.rules
  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="workflow-assert-editor">
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-micro text-muted-foreground">
            {t('workflows.assertRulesLabel')}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('workflows.assertAddRule')}
            onClick={() => onChange({ ...config, rules: [...rules, makeRule('statusCode')] })}
          >
            <PlusIcon aria-hidden className="size-3" />
          </Button>
        </div>
        {rules.map((rule, index) => (
          // 行身份用 index：窄栏轻编辑（无行插入 / 拖拽重排），删行焦点错位
          // 为已接受权衡（与覆写行编辑器同口径）
          <AssertRuleRow
            key={index}
            rule={rule}
            onChange={(next) =>
              onChange({ ...config, rules: rules.map((row, i) => (i === index ? next : row)) })
            }
            onRemove={() => onChange({ ...config, rules: rules.filter((_, i) => i !== index) })}
          />
        ))}
      </div>
      <p className="text-micro text-muted-foreground">{t('workflows.assertHint')}</p>
    </div>
  )
}
