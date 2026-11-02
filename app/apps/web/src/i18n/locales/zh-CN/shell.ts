/**
 * App Shell 文案（原 shell-copy 常量文件已收编删除）。
 */
export const shell = {
  // 标题栏
  workspaceSwitcherLabel: '工作空间',
  workspaceSwitcherEmpty: '尚无工作空间',
  workspaceSettingsEntry: '工作空间设置',
  panelToggle: '收展左栏面板',
  syncButton: '同步',
  settingsButton: '设置',
  themeToggleToDark: '切换到深色',
  themeToggleToLight: '切换到浅色',
  themeToggleHint: '明暗切换（跟随系统在设置面板选择）',
  minimize: '最小化',
  maximize: '最大化',
  restore: '还原',
  close: '关闭',

  // 左栏视图
  viewApis: '接口树',
  viewHistory: '请求历史',
  viewVariables: '变量树',
  viewWorkspaces: '工作空间清单',
  viewWorkflows: '工作流',
  leftNavLabel: '左栏视图',
  panelResizeLabel: '调整左栏宽度',
  panelCollapseLabel: '收起左栏面板',
  panelExpandLabel: '展开左栏面板',

  // 搜索占位
  searchApisPlaceholder: '搜索接口',
  searchHistoryPlaceholder: '搜索请求历史',
  searchVariablesPlaceholder: '搜索变量',
  searchWorkspacesPlaceholder: '搜索工作空间',
  searchWorkflowsPlaceholder: '搜索工作流',

  // 空态（文案＋可选动作，不做插画；接口树 / 请求历史两视图的空态由各自业务面板消费）
  apisEmptyTitle: '尚无服务',
  apisEmptyDescription: '在当前工作空间创建服务，或从文档地址同步接口定义。',
  apisCreateService: '新建服务',
  historyEmptyTitle: '暂无请求记录',
  historyEmptyDescription: '发送请求后，历史记录将在此显示',
  historyEmptyCta: '去发送第一个请求',

  // 标签栏 / 主区
  searchClearInput: '清空搜索',
  tabbarLabel: '标签栏',
  tabbarEmpty: '无打开的标签页',
  welcomeDescription: '从左栏选择或新建接口，开始调试。',
  responseResizeLabel: '调整响应区高度',
  responseTitle: '响应',
  responseCollapseLabel: '折叠响应区',
  responseEmptyDescription: '发送请求后，响应将在此显示',
  responseStatusLabel: '响应区已折叠',
  responseExpandLabel: '展开响应区',

  // 启动阻断错误屏（DB_CORRUPTED 终态；code + 英文 message 行恒原样不翻）
  bootErrorTitle: '数据库无法使用',
  bootErrorDescription:
    '应用数据文件损坏或无法读取，已停止加载以保护你的数据。可打开日志目录查看诊断信息。',
  bootErrorOpenLogs: '打开日志目录',
  bootErrorRetry: '重试',
} as const
