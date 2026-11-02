/**
 * 同步域字典（zh-CN 基准）：向导四段文案。zh-CN 与 en 两侧成对文件同步维护。
 * 参数与请求体在应用事务内静默对齐（补缺删多、已填值不动），无裁决交互面。
 */
export const sync = {
  wizard: {
    title: '同步',
    // 头部右上角：最近一次全量应用时刻（本地时区 MM-DD HH:mm）
    lastSyncedAt: '上次同步 {time}',
    // 向导概述（aria-describedby；视觉隐藏不打乱紧凑布局）
    description: '拉取服务文档并与快照对比，确认后应用变更',
    // 步骤条
    stepFetch: '拉取',
    stepCompare: '对比',
    stepConfirm: '确认',
    stepDone: '完成',
    // 拉取段（进入即暂停的服务选择态）
    selectTitle: '选择要同步的服务',
    selectHint: '未勾选的服务本次跳过、不读不写',
    selectAll: '全选',
    selectFooterCount: '已选 {selected} / {total} 个服务',
    noDocUrl: '无文档地址 · 不可同步',
    startSync: '开始同步 · {count} 服务',
    // 拉取运行（串联编排：活动面板呈现当前服务与总进度）
    runActivity: '正在拉取 · {name}',
    runElapsed: '已用时',
    runQueued: '排队中',
    runFetching: '拉取中…',
    runDiffing: '对比中…',
    runOk: '完成',
    runSkipped: '已跳过',
    runCancelled: '已取消',
    cancelFetch: '取消',
    runningCloseHint: '关闭将取消剩余拉取，不写入任何数据',
    // 全部跳过（拉取 / 对比失败的确认段呈现——不得误作「无变化」）
    allSkippedTitle: '所选服务本次全部跳过',
    allSkippedHint: '无一服务成功拉取，本次未写入任何数据；请检查服务可达与文档地址后重新同步。',
    retryButton: '重试',
    skippedSection: '拉取失败 · 可单独重试',
    // 确认段：统计页签（计数单点）与承诺条
    compareSelectedCount: '已选 {checked} / {total}',
    summarySecondary: '无变化 {unchanged} · 跳过 {skipped}',
    promiseData: '用户测试数据按稳定键索引 · 同步永不触碰',
    previewBar: '预览阶段 · 尚未写入任何数据',
    // 清单三组与行面
    groupAdded: '新增',
    groupChanged: '变更',
    groupRemoved: '已移除',
    rowCheckLabel: '应用此接口',
    changeChip: '+{added} −{removed} ~{changed}',
    removedUsageCount: '{count} 个工作流引用',
    applyButton: '确认应用 · {count} 项变更',
    applying: '应用中…',
    noChanges: '所选项与快照一致 · 无变化',
    // 混合终态：成功服务全部无变化、另有拉取失败（失败清单仍可重试）
    noChangesSkippedTitle: '{services} 个服务无变化 · {skipped} 个服务拉取失败',
    closeHint: '关闭＝放弃，不写入任何数据',
    closeWizardButton: '关闭向导',
    // 明细（三页签）
    tabParams: '参数',
    tabBody: '请求体',
    tabResponses: '响应',
    schemaSection: 'Schema 变化',
    emptyTab: '本页签无变化',
    diffLoading: '对比视图加载中…',
    // 新增轻定义卡
    lightCardLabel: '新接口',
    lightCardParams: '参数 {count}',
    lightCardBodyKeys: '体键 {count}',
    lightCardResponses: '响应 {count}',
    // 已移除保留卡
    keepCardTitle: '用户数据原地保留',
    keepCardBody: '该接口的测试数据、置顶与历史全部保留；接口再次出现时将重新导入并接回这些数据',
    // 完成段
    doneTitle: '同步完成',
    doneUnchanged: '无变化',
    doneBadgeNote: '树内徽标已按本次应用刷新；未应用的接口徽标保留至其下次应用',
    finishButton: '完成',
  },
} as const
