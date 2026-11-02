/**
 * 历史详情 Tab（只读全量留痕）。
 */
export const historyDetail = {
  // 只读声明（顶部恒在场：记录本体只展示；恢复动作只产出内存草稿副本）
  readOnlyNotice: '只读留痕：仅展示该次请求的完整记录，可恢复为草稿',
  // 恢复动作（快照缺失时禁用）
  restoreAsDraft: '恢复为草稿',
  // state 徽标
  statePassed: '成功',
  stateFailed: '失败',
  stateCancelled: '已取消',
  // runId 旁的复制按钮无障碍标签（区分页面内多个复制目标）
  copyRunId: '复制 runId',
  // 元信息表
  methodLabel: '方法',
  urlLabel: 'URL',
  durationLabel: '耗时',
  sourceLabel: '来源',
  timeLabel: '时间',
  errorCodeLabel: '错误码',
  // 分区名
  sectionSummary: '概要',
  sectionRequest: '已发送请求',
  requestBody: '请求体',
  sectionResponse: '响应快照',
  noSnapshot: '快照缺失',
  noResponse: '无响应快照',
  // 错误卡（failed；TIMEOUT 用响应面板同款文案）与取消中性卡
  errorCardTitle: '请求失败',
  cancelledCard: '该请求在完成前被取消，未留存响应快照',
  // 记录不存在（已被封顶修剪）
  notFoundTitle: '记录不存在',
  notFoundDescription: '该执行记录可能已被清理',
} as const
