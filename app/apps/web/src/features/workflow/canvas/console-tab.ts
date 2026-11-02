/**
 * 底部控制台的 tab 导航信号（与组件文件分离导出，fast-refresh 只容忍组件
 * 文件导出组件）：运行信号与空侧回落两处切换规则的纯函数口径，编辑器与
 * 控制台共用。
 */

export type WorkflowConsoleTab = 'validation' | 'execution'

/** 运行信号 → 活跃 tab：问题清单非空＝执行被拒跳校验；空＝放行即启动跳执行 */
export function consoleTabForRunSignal(issueCount: number): WorkflowConsoleTab {
  return issueCount > 0 ? 'validation' : 'execution'
}

/**
 * 活跃 tab 侧失去内容而另一侧有内容时的回落目标（null＝无需回落）。调用
 * 方在渲染期以返回值驱动自身 setState（派生态调整模式）——修复完校验问
 * 题、第五视图失败徽标打开（校验无问题）等空侧活跃场景自动落到有内容的
 * 一侧；信号切换的目标 tab 必有内容，与此回落不冲突。
 */
export function consoleTabFallback(
  activeTab: WorkflowConsoleTab,
  hasIssues: boolean,
  hasExecution: boolean,
): WorkflowConsoleTab | null {
  if (activeTab === 'validation' && !hasIssues && hasExecution) return 'execution'
  if (activeTab === 'execution' && !hasExecution && hasIssues) return 'validation'
  return null
}
