/**
 * 变量域字典（zh-CN 基准）：左栏变量树、变量配置页（键值表＋生效变量集）、
 * BaseUrl 候选与接口级覆写、认证转 Secret 变量、变量配置 Tab 标题。
 * zh-CN 与 en 两侧成对文件同步维护。
 */
export const variables = {
  // 左栏·变量树（两层树：全局分类置顶＋本空间分类；行菜单与激活切换）
  tree: {
    newCategory: '新建分类',
    open: '打开',
    activate: '激活',
    deactivate: '取消激活',
    rename: '重命名',
    delete: '删除',
    copyVariable: '复制变量',
    moveUp: '上移',
    moveDown: '下移',
    loadFailedTitle: '变量分类加载失败',
    loadFailedRetry: '重试',
    emptyTitle: '暂无变量分类',
    emptyDescription: '新建分类以成组管理环境变量，激活其一即可整组切换',
    /** 分类行折叠指示 title（箭头是唯一展开/收起命中区） */
    expand: '展开',
    collapse: '收起',
    // 树搜索过滤空结果（清除通道回到左栏搜索框）
    searchNoResults: '无匹配分类或变量',
    searchNoResultsHint: '换个关键词试试，或清除搜索恢复完整树。',
    searchClear: '清除搜索',
  },
  // 重命名分类对话框
  renameDialog: {
    title: '重命名分类',
    description: '左栏名称与配置页 Tab 标题同步更新',
    nameLabel: '分类名称',
    confirm: '重命名',
    cancel: '取消',
  },
  // 新建分类对话框
  newCategoryDialog: {
    title: '新建变量分类',
    description: '分类是成组切换的环境变量集合',
    nameLabel: '分类名称',
    namePlaceholder: '输入分类名称…',
    globalLabel: '全局分类',
    globalHint: '全局分类对所有工作空间兜底生效，不可激活',
    create: '创建',
    cancel: '取消',
  },
  // 变量配置页（横幅＋键值表卡）
  config: {
    activeBadge: '已激活',
    globalBadge: '全局',
    activate: '激活',
    deactivate: '取消激活',
    renameCategory: '重命名分类',
    deleteCategory: '删除分类',
    deleteConfirmTitle: '删除变量分类',
    deleteConfirmDescription:
      '将删除「{name}」及其全部变量；若它正在激活，激活状态一并取消，不可撤销。',
    deleteConfirmAction: '删除',
    deleteConfirmPending: '删除中…',
    cancel: '取消',
    keyColumn: '变量',
    valueColumn: '值',
    secretColumn: 'Secret',
    addVariable: '新增变量',
    addDialogTitle: '新增变量',
    addDialogDescription: '同分类下变量名不可重复',
    addKeyLabel: '变量名',
    addKeyPlaceholder: '输入变量名…',
    addValueLabel: '值',
    addValuePlaceholder: '输入变量值…',
    addSecretLabel: '标记为 Secret',
    addSecretHint: 'Secret 变量在展示与输出面默认掩码',
    add: '添加',
    deleteVariable: '删除变量 {key}',
    deletedToast: '已删除变量 {key}',
    undoDelete: '撤销',
    editKey: '编辑变量名 {key}',
    emptyVariables: '暂无变量',
    emptyVariablesHint: '点击「新增变量」建立键值对，激活分类后整组生效',
    // Secret 值列：默认掩码、眼睛临时明文、复制直接明文
    showSecret: '显示明文',
    hideSecret: '隐藏明文',
    copySecret: '复制明文',
    categoryMissing: '分类不存在或已删除',
    // 横幅 meta 摘要行：变量数＋生效参与态
    metaVariableCount: '{count} 个变量',
    metaActiveChain: '参与生效集（最高优先级）',
    metaNotInChain: '未激活，不参与生效集',
    metaGlobalChain: '全局兜底参与生效集',
    effectivePreview: '生效预览',
  },
  // 生效预览面板（恒掩码，按兜底链呈现来源；「兜底链」为内部术语不直出 UI）
  effective: {
    priorityLabel: '生效优先级',
    noActive: '未激活',
    finalLabel: '最终生效',
    sourceActive: '激活分类',
    sourceGlobal: '全局变量',
    sourceBuiltin: '内置',
    empty: '暂无生效变量',
    searchPlaceholder: '搜索键或值…',
    searchEmpty: '无匹配变量',
  },
  // 变量批量进出（分类导出 / 导入＋新增批量页签；导出默认脱敏）
  transfer: {
    exportButton: '导出 JSON',
    importButton: '导入变量',
    exportTitle: '导出「{name}」',
    exportDescription: '以 JSON 复制到剪贴板，可在其他分类粘贴导入',
    exportSecretLabel: '包含 Secret 明文值',
    exportSecretHint: '默认导出掩码（***）；勾选后剪贴板将包含 Secret 明文，请谨慎粘贴',
    exportCopy: '复制 JSON',
    importTitle: '导入变量',
    importDescription: '粘贴导出的 JSON（{ "variables": […] } 或数组），逐条导入当前分类',
    importPasteLabel: 'JSON 内容',
    importPastePlaceholder: '粘贴 JSON…',
    importInvalidJson: '不是合法 JSON，请检查粘贴内容',
    importInvalidJsonAt: '第 {line} 行不是合法 JSON，请检查粘贴内容',
    importInvalidShape: 'JSON 结构不符合变量清单形态（需 key 字段）',
    importInvalidShapeAt: '第 {index} 条不符合变量清单形态（需 key 字段）',
    importMaskSkipped: '值疑似导出掩码，未导入',
    importStrategyLabel: '同名键处理',
    importStrategySkip: '跳过（保留现有值）',
    importStrategyOverwrite: '覆盖（导入值替换现有值）',
    importSubmit: '导入',
    importRowError: '{key}：{message}',
    importDone: '已导入 {count} 条',
    modeSingle: '单条',
    modeBulk: '批量',
    bulkLabel: '批量键值对',
    bulkPlaceholder: 'token: abc123\nhost: https://api.example.com',
    bulkHint: '每行一对，首个冒号分隔；批量行一律按非 Secret 创建',
    bulkSubmit: '批量添加',
    bulkMissingColon: '缺少「键: 值」分隔冒号',
    bulkEmptyKey: '冒号前没有键名',
    bulkDuplicate: '变量名重复（本批次内）',
    bulkRowError: '第 {line} 行：{message}',
  },
  // 变量配置 Tab 标题（TabBar 呈现；title＝分类名）
  tabTitle: '变量 · {name}',
  // BaseUrl 候选下拉（工作空间设置页）
  baseUrlPicker: {
    openLabel: 'BaseUrl 候选',
    title: 'BaseUrl 候选',
    empty: '暂无候选地址',
    addPlaceholder: '输入新地址…',
    add: '添加',
    remove: '删除候选 {url}',
  },
  // 接口级 BaseUrl 切换（地址栏地址块；内存级会话态——Tab 覆写与会话档，
  // 纯地址选择；会话档＝所有 Tab 生效、退出即清）
  override: {
    buttonLabel: '切换 BaseUrl',
    activeButtonLabel: 'BaseUrl 已切换为 {url}',
    emptyBaseUrl: '未配置 BaseUrl',
    sessionSection: '本会话 · 所有 Tab',
    sessionEmpty: '未设置 · 跟随工作空间',
    sessionClear: '清除会话地址',
    pickSession: '设为会话地址（所有 Tab 生效）：{url}',
    tabSection: '本 Tab 覆写',
  },
  // 环境快捷切换（地址栏环境块；激活分类＝环境整组切换）
  quickSwitch: {
    title: '环境',
    triggerLabel: '切换激活环境',
    triggerActiveLabel: '当前环境 {name}，点按切换',
    noActive: '未激活',
    empty: '暂无本空间分类',
    deactivateAll: '全部不激活',
  },
  // `{{` 变量联想下拉（编辑面输入 `{{` 触发；值预览 Secret 恒掩码）
  suggest: {
    empty: '无匹配变量',
    listLabel: '变量联想候选',
  },
  // hover 变量解析（闭合 {{键}} 引用悬浮出解析值，发送前可见）
  hover: {
    secretBadge: 'Secret 变量',
    undefinedBadge: '未定义',
  },
  // 认证字面量转 Secret 变量（Auth 页签行内入口）
  toSecret: {
    buttonLabel: '转为 Secret 变量',
    noCategoryError: '没有可用的变量分类',
    converted: '已转为 Secret 变量 {key}',
  },
  // 变量解析预览（响应区「已发送请求」页签；resolved 信息随发送响应附带）
  preview: {
    title: '变量解析',
    resolvedUrlLabel: '解析后 URL',
    copyUrl: '复制解析后 URL',
    missedBadge: '未命中',
    secretBadge: 'Secret',
    empty: '本次发送未消费变量',
  },
} as const
