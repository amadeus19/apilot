/**
 * 响应面板域（features/http 消费：状态行、三分区、错误三分、SSE 流式视图）；
 * zh-CN 与 en 两侧成对文件同步维护。
 */
export const response = {
  // 状态行
  sending: '发送中…',
  // 发送中内容区占位（安静提示：不放动作按钮——取消入口在地址栏按钮）
  waitingResponse: '正在等待响应…',
  noResponse: '无响应',
  cancelled: '已取消',
  // 三分区（Body / Headers 恒英文原样，恒不翻译清单约定）
  sentRequest: '已发送请求',
  // Body 视图（Pretty / Raw 恒英文原样）
  truncated: '已截断',
  // 分级徽标（全文＝响应体全量在手；预览＝超大响应仅前缀片段）
  tierFullMemory: '全文（内存）',
  tierFullFile: '全文（文件）',
  tierPreview: '预览',
  tierFullMemoryHint: '响应体全量保存在内存中',
  tierFullFileHint: '响应体全量落盘为临时文件',
  tierPreviewHint: '超大响应仅保留前缀片段预览，无法全量查看',
  saveBody: '保存',
  savedBody: '响应体已保存（{size}）',
  saveCancelled: '已取消保存',
  loadFull: '加载全量',
  loadingFull: '加载中 {percent}%',
  backToPreview: '回到预览',
  sizeLimited: '全量查看受大小限制',
  toggleWrap: '自动换行',
  // 已发送请求分区（脱敏）
  showSecrets: '显示敏感值',
  hideSecrets: '隐藏敏感值',
  copyUrl: '复制 URL',
  copyAllHeaders: '复制全部 Headers',
  copyAllHeadersHint: '敏感头值以 *** 掩码复制',
  // Headers 页签过滤（子串、大小写不敏感）
  headersFilterLabel: '过滤响应头',
  headersFilterPlaceholder: '过滤 Headers…',
  headersFilterEmpty: '无匹配 Headers',
  // 响应头「存为变量」（行内动作＋命名浮层）
  headerVariable: {
    actionLabel: '将 {name} 存为变量',
    title: '存为变量',
    nameLabel: '变量名',
    secretLabel: 'Secret',
    targetCategory: '存入激活分类：{name}',
    overwriteHint: '同名变量已存在，保存将更新其值',
    save: '保存',
    noActiveCategory: '当前无激活分类，请先激活一个分类再保存',
    openVariables: '打开变量视图',
    savedToast: '已存为变量 {key}',
  },
  // 错误三分
  timeoutTitle: '请求超时',
  timeoutMessage: '已按超时设置终止',
  timeoutOpenSettings: '调整超时设置',
  errorTitle: '请求失败',
  // SSE 流式视图
  streamButton: '流式',
  streamStop: '停止',
  streamDone: '流已结束',
  streamCancelled: '流已取消',
  streamErrorTitle: '流式接收失败',
  streamReceived: '已接收 {size}',
  streamBackToLatest: '回到最新',
  // 空态「发送请求」CTA（经草稿桥取当前编辑器草稿直接发送）
  emptySendCta: '发送请求',
  // Preview 视图（可渲染类型判定与提示）
  previewUnavailable:
    'Preview 只对可渲染类型（html / 图片 / PDF / 文本）可用——当前响应是二进制内容（{contentType}）。',
  contentTypeNone: '未知类型',
  previewFrameLabel: '响应内容预览',
  // 格式 / 编码选择器（视图层口径：高亮语言、格式化可用性、按字节重解码）
  formatSelectorLabel: '响应体格式',
  formatSelectorHint: '响应体格式（影响高亮与能否格式化）',
  charsetSelectorLabel: '响应体编码',
  charsetSelectorHint: '响应体编码（按该编码重新解码文本）',
  charsetDecodeFailed: '无法按 {charset} 解码，已按 UTF-8 显示。',
  // 接口文档预览抽屉（数据源＝同步定义侧元数据；仅同步接口有入口）
  docButton: '接口文档',
  docTitle: '接口文档',
  docClose: '关闭文档抽屉',
  docLoading: '文档加载中…',
  docLoadFailed: '文档加载失败，请重试',
  docEmpty: '暂无文档数据，随首次同步应用生成',
  docNoDescription: '暂无描述',
  docSummarySection: '摘要',
  docParamsSection: '参数',
  docParamLocation_path: '路径参数',
  docParamLocation_query: '查询参数',
  docParamLocation_header: '请求头参数',
  docExamplePrefix: '示例：',
  docBodySection: '请求体',
  docBodyNoFields: '无字段定义',
  docBodyFormNoFields: '表单请求体（未声明字段定义）',
  docBodyExample: '请求体示例',
  docNoRequestBody: '无请求体',
  docResponsesSection: '响应',
  docResponseTrack: '呈现轨道',
  docTrackSample: '示例',
  docTrackStructure: '结构',
  docSourceDefined: '定义侧 example',
  docSourceGenerated: '由 schema 生成',
  docResponseNoBody: '无响应体',
} as const
