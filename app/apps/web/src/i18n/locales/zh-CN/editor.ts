/**
 * 接口 Tab 编辑器（features/workbench 消费）。
 */
export const editor = {
  // 字间空格是文案定案（两字按钮的排布形态），可访问名随实际文案
  send: '发 送',
  // sending 态按钮文案（点击＝取消在途请求）
  sendCancel: '取消',
  // Body 页签：类型行（类型分段标签恒英文协议名，不入字典）、none 空态
  // 与文本系工具（格式化 / 自动换行）
  bodyEmpty: '此请求没有 Body',
  bodyFormat: '格式化',
  bodyFormatHintPlainText: '纯文本无需格式化',
  bodyFormatHintInvalidJson: '内容不是合法 JSON，无法格式化',
  bodyWordWrap: '自动换行',
  // ⋯更多菜单与删除确认（硬删除连带用户数据，级联范围在描述文案中明示）
  moreButton: '更多',
  deleteEndpoint: '删除',
  deleteConfirmTitle: '删除接口',
  deleteConfirmDescription:
    '将永久删除「{title}」，其用户数据（请求体、参数、请求头）与置顶状态一并清除，不可撤销。',
  deleteConfirmCancel: '取消',
  deleteConfirmAction: '删除',
  // 请求级认证（Auth 页签）：七类型（纯注入型；UI 不展示未支持类型）
  authTypeLabel: '认证方式',
  authTypeInherit: '继承上级',
  authTypeNone: '不使用',
  authTypeBearer: 'Bearer Token',
  authTypeBasic: 'Basic Auth',
  authTypeApiKeyHeader: 'API Key · Header',
  authTypeApiKeyQuery: 'API Key · Query',
  authTypeApiKeyCookie: 'API Key · Cookie',
  authInheritHint: '取当前工作空间设置页配置的认证。',
  authNoneHint: '此请求不携带认证信息。',
  authTokenLabel: 'Token',
  authUsernameLabel: 'Username',
  authPasswordLabel: 'Password',
  authKeyLabel: 'Key',
  authValueLabel: 'Value',
  authFieldPlaceholder: '字面量或 {{变量}}',
  kvNamePlaceholder: '参数名',
  kvValuePlaceholder: '参数值',
  kvRemoveRow: '移除该行',
  kvRawModeHint: '内容无法解析为键值对，正在以原文编辑（原样保存，不做格式改写）',
  kvTypeLabel: '类型',
  kvDescriptionLabel: '说明',
  kvDescriptionPlaceholder: '说明（接口文档同步用）',
  // file 行值格的系统选择器入口（选定后行 value 持完整路径、显示文件名）
  kvPickFile: '选择文件',
  // KV 表格列头（宿主面收敛：Headers 无类型列）
  kvColumnName: '参数名',
  kvColumnValue: '参数值',
  kvColumnType: '类型',
  kvColumnDescription: '说明',
  // 行启停勾选（禁用行保留在草稿中但不参与发送）
  kvRowEnabled: '启用该行',
  // 拖拽把手（行排序：原生拖拽或把手 Alt+↑/↓）
  kvReorderLabel: '排序',
  kvReorderHint: '拖拽或按 Alt+↑/↓ 移动该行',
  // path 参数芯片（行名命中路径模板占位符）
  kvPathChipHint: '路径参数：填充路径模板占位，不进 query',
  // 批量编辑（页签工具行：表格 ⇄ 每行一对键值的文本模式）
  kvBulkEdit: '批量编辑',
  kvBulkHint: '每行一对「参数名: 参数值」，同名行仅更新值',
  kvBulkApply: '应用',
  kvBulkCancel: '取消',
  kvBulkMaskedHint: '敏感值已掩码，显示敏感值后可批量编辑',
  settingsButton: '接口设置',
  settingsTitle: '接口设置',
  settingsClose: '关闭接口设置',
  entityTitleLabel: '标题',
  entityCategoryLabel: '分类',
  // 同步接口的标题 / 分组置灰提示（悬浮解释禁用原因）
  entityLockedHint: '标题与分组随同步文档更新',
  categoryNone: '未分类',
  // 接口级超时覆写（user_data 域，抽屉「超时」行）：null 继承全局 / 0 不限制 / >0 秒
  timeoutLabel: '请求超时',
  timeoutInherit: '继承全局',
  timeoutUnlimited: '不限制',
  timeoutCustom: '自定义',
  timeoutCustomLabel: '自定义秒数',
  timeoutSecondsPlaceholder: '1–86400',
  breadcrumbLabel: '面包屑',
  breadcrumbLocateHint: '在接口树中定位「{name}」',
  draftLoadFailedTitle: '草稿加载失败',
  retry: '重试',
  // 草稿 Tab（历史恢复）：转正动作与页内说明
  saveAsEndpoint: '另存为新接口',
  promotionNoService: '暂无服务可存放，请先创建服务',
  draftHeaderNotice: '从历史恢复的草稿 · 未另存前不落库，关闭即弃',
  draftBodyTruncatedNotice: '请求体超出快照保留范围，仅回填截断前缀',
  headersMaskedHint: '敏感头值已掩码，值原样保留',
  showSecrets: '显示敏感值',
  hideSecrets: '隐藏敏感值',
  // 最终 URL 预览行（只读组合结果，与发送侧拼接口径一致）
  finalUrlLabel: '最终 URL',
  finalUrlCopy: '复制最终 URL',
  previewNoBaseUrl: '工作空间未配置 BaseUrl，发送前请在工作空间设置中配置',
  previewInvalidBaseUrl: '工作空间 BaseUrl 需以 http:// 或 https:// 开头',
  // 路径模板形状非法的行内提示（与路径框错误描边同反馈面；合法形态含
  // 相对路径与绝对 URL 两种，占位符 {name} 属模板语法）
  pathInvalidHint:
    '路径需以 / 开头，或为 http(s):// 开头的完整地址（支持 {占位}），不能包含空格或 ?',
  // cURL 互操作（复制出口＝工具行按钮；导入入口＝⋯菜单＋粘贴对话框）
  copyAsCurl: '复制为 cURL',
  curlImportMenu: '从 cURL 导入',
  curlImportTitle: '从 cURL 导入',
  curlImportDescription:
    '粘贴 curl 命令，解析为新草稿标签页。导入不落库，另存为新接口前不写入任何数据。',
  curlImportPlaceholder: "curl 'https://api.example.com/v1/users?page=1' …",
  curlImportCancel: '取消',
  curlImportSubmit: '导入',
  // 导入拒绝原因（前缀「第 {position} 个参数」按词位拼接）
  curlErrorAt: '第 {position} 个参数',
  curlErrorNotCurl: '命令需以 curl 开头。',
  curlErrorUnterminatedQuote: '引号未闭合。',
  curlErrorBadSyntax: '命令形态无法解析（如尾部孤立的反斜杠）。',
  curlErrorMissingUrl: '缺少 URL 参数。',
  curlErrorMultipleUrl: '出现多个 URL 参数。',
  curlErrorInvalidUrl: 'URL 需以 http:// 或 https:// 开头。',
  curlErrorUnsupportedFlag:
    '不支持该选项（仅支持 -X / -H / -d 系 / --data-urlencode / -F 与 URL）。',
  curlErrorMissingValue: '该选项缺少取值。',
  curlErrorBadMethod: '-X 的值需为七种 HTTP 方法之一。',
  curlErrorBadHeader: '-H 需为「名称: 值」形态。',
  curlErrorFileSource: '不支持以 @ 文件充当请求数据源。',
  curlErrorBadForm: '-F 需为「名称=值」或「名称=@文件路径」形态。',
  curlErrorBadUrlencoded: '--data-urlencode 需为「名称=值」形态。',
  curlErrorMixedBody: '-d 与 -F 不能混用。',
} as const
