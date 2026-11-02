/**
 * 状态栏域（shell 状态栏消费）：工作空间 / 同步 / 固定工作流三段文案——
 * 同步段为向导运行态的聚合档位（进行中 / 完成 / 失败；本次会话无同步动作
 * 时同步段不渲染，无空态文案）；固定段是唯一可点击段（点击直跑固定工作流）。
 * zh-CN 与 en 两侧成对文件同步维护。
 */
export const statusBar = {
  workspaceNotSelected: '未选择工作空间',
  syncRunning: '同步中…',
  syncDone: { one: '已同步 {count} 个服务', other: '已同步 {count} 个服务' },
  syncPartialFailed: '已同步 {synced} · 失败 {failed}',
  syncFailed: '同步失败',
  pinnedRun: '运行固定工作流',
} as const
