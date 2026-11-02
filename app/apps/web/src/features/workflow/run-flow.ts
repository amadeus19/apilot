import { toast } from '@workspace/ui/components'

import { queryClient } from '@/app/query-client'
import { reportError } from '@/services/error-center'
import { translate, type DictKey, type TranslateParams } from '@/i18n/core'
import { selectResolvedLocale, useSettingsStore } from '@/stores/settings.store'
import { variableKeys } from '@/features/variables/variable-api'

import { useWorkflowExecutionStore } from './execution.store'
import {
  issuesFromRejection,
  workflowExecute,
  workflowKeys,
  workflowValidate,
  type WorkflowIssueDto,
} from './workflow-api'
import type { WorkflowGraph } from './workflow-model'

/**
 * 工作流运行协议单点（编辑器工具栏与第五视图行内运行共用）：
 * 执行前校验闸（失败不启动，问题清单交呈现方定位）→ 乐观置 running →
 * 阻塞执行至终态 → 记录对齐＋清单失效 → 终态 toast（通过 / 失败经右下角
 * 呈现，清单行不设历史结果徽标；取消是用户主动停止，不另弹提示）→ 调用
 * 失败回滚乐观槽。差异项由调用方注入：校验图（编辑态传当前图，缺省校验
 * 落库图＝清单行内口径）、问题呈现（编辑器写校验面板；清单行 toast 指路）。
 */

/** 模块级取词（非组件环境）：locale 按调用时设置快照解析（error-center 同款） */
function t(key: DictKey, params?: TranslateParams): string {
  return translate(selectResolvedLocale(useSettingsStore.getState()), key, params)
}

export interface RunWorkflowOptions {
  workflowId: string
  /** 显示名（完成 toast 插值；调用方持有——清单行名 / 编辑会话名） */
  name: string
  /** 校验用图（编辑器传当前编辑态图；缺省＝校验落库图） */
  graph?: WorkflowGraph
  /** 校验问题呈现（本闸与引擎落库图拒绝双闸共用此出口：编辑器写入校验
   *  面板——空表即清面板；清单行只在非空时提示） */
  onIssues: (issues: WorkflowIssueDto[]) => void
}

export function executeWorkflowGuarded({
  workflowId,
  name,
  graph,
  onIssues,
}: RunWorkflowOptions): void {
  void workflowValidate(workflowId, graph)
    .then((issues) => {
      onIssues(issues)
      if (issues.length > 0) return
      useWorkflowExecutionStore.getState().startLocal(workflowId)
      void workflowExecute(workflowId)
        .then((record) => {
          // 终态记录对齐（事件流已推进大部分；覆盖写同终态无跳变）
          useWorkflowExecutionStore.getState().seedFromRecord(record)
          void queryClient.invalidateQueries({ queryKey: workflowKeys.listPrefix })
          // 存变量写回在引擎侧落库（自愈重建分类＋upsert 变量），不经前端
          // mutation，变量域缓存感知不到这次数据变更，按域根整体失效
          void queryClient.invalidateQueries({ queryKey: variableKeys.root })
          if (record.status === 'passed') {
            toast.success(t('workflows.runPassedToast', { name }))
          } else if (record.status === 'failed') {
            toast.error(t('workflows.runFailedToast', { name }))
          }
        })
        .catch((error) => {
          // 并发拒绝等调用失败：回滚乐观槽＋统一报错；引擎按落库图校验
          // 拒绝（编辑态已修复未保存的双闸面）时问题清单与本地校验同面
          // 呈现，错误可定位
          useWorkflowExecutionStore.getState().failLocal(workflowId)
          const rejected = issuesFromRejection(error)
          if (rejected != null) onIssues(rejected)
          // 半途写回不回滚（失败执行已写回的值保留），变量域同样失效
          void queryClient.invalidateQueries({ queryKey: variableKeys.root })
          reportError(error)
        })
    })
    .catch((error) => reportError(error))
}
