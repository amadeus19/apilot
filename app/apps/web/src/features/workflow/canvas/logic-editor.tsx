import { PlusIcon, XIcon } from 'lucide-react'

import {
  Button,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@workspace/ui/components'

import { useI18n } from '@/i18n'

import type { ConditionNodeConfig, JoinMode, JoinNodeConfig } from '../workflow-model'

/**
 * 逻辑组节点配置编辑面（条件判断 / Join）：条件节点＝分支表达式行编辑
 * （IF / ELSE IF 行集，增删行；分支 id＝行身份、出边 Handle 与边 label
 * 共用它）＋ 上游引用引导与 Default 兜底出口提示（恒有、不可编辑）；
 * Join＝汇聚模式
 * 二选（等待全部 / 任一）。改动经更新通道落编辑会话（标脏，保存走
 * 工具栏 / Ctrl+S）。
 */

export function ConditionEditor({
  config,
  onChange,
}: {
  config: ConditionNodeConfig
  onChange: (next: ConditionNodeConfig) => void
}) {
  const { t } = useI18n()

  const updateBranch = (id: string, expression: string) => {
    onChange({
      ...config,
      branches: config.branches.map((branch) =>
        branch.id === id ? { ...branch, expression } : branch,
      ),
    })
  }

  const removeBranch = (id: string) => {
    onChange({ ...config, branches: config.branches.filter((branch) => branch.id !== id) })
  }

  const addBranch = () => {
    onChange({
      ...config,
      branches: [...config.branches, { id: crypto.randomUUID(), expression: '' }],
    })
  }

  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="workflow-condition-editor">
      <Field label={t('workflows.conditionBranchesLabel')}>
        <div className="flex flex-col gap-1.5">
          {config.branches.map((branch) => (
            <div key={branch.id} className="flex items-center gap-1">
              <Input
                value={branch.expression}
                placeholder={t('workflows.conditionExpressionPlaceholder')}
                className="h-6 px-1.5 font-mono text-xs"
                onChange={(event) => updateBranch(branch.id, event.target.value)}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('workflows.conditionRemoveBranch')}
                onClick={() => removeBranch(branch.id)}
              >
                <XIcon aria-hidden className="size-3 text-muted-foreground" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" className="w-full" onClick={addBranch}>
            <PlusIcon aria-hidden className="size-3" />
            {t('workflows.conditionAddBranch')}
          </Button>
        </div>
      </Field>
      <p className="text-micro text-muted-foreground">{t('workflows.conditionReferenceHint')}</p>
      <p className="text-micro text-muted-foreground">{t('workflows.conditionHint')}</p>
      <p className="text-micro text-muted-foreground">{t('workflows.conditionDefaultHint')}</p>
    </div>
  )
}

export function JoinEditor({
  config,
  onChange,
}: {
  config: JoinNodeConfig
  onChange: (next: JoinNodeConfig) => void
}) {
  const { t } = useI18n()
  const modes: readonly {
    value: JoinMode
    labelKey: 'workflows.joinModeAll' | 'workflows.joinModeAny'
  }[] = [
    { value: 'all', labelKey: 'workflows.joinModeAll' },
    { value: 'any', labelKey: 'workflows.joinModeAny' },
  ]
  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="workflow-join-editor">
      <Field label={t('workflows.joinModeLabel')}>
        <Select
          value={config.mode}
          onValueChange={(value) => onChange({ ...config, mode: (value ?? 'all') as JoinMode })}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {modes.map((mode) => (
              <SelectItem key={mode.value} value={mode.value}>
                {t(mode.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <p className="text-micro text-muted-foreground">{t('workflows.joinHint')}</p>
    </div>
  )
}
