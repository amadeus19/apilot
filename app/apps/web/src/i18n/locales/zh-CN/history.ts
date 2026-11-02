/**
 * 请求历史视图（features/history 消费：平铺列表、搜索、刷新、勾选与批删）。
 */
export const history = {
  loadMore: '加载更多',
  refresh: '刷新',
  loading: '加载中…',
  // source 芯片（GUI / CLI 记录同现）
  sourceGui: 'GUI',
  sourceCli: 'CLI',
  // 相对时间四档（en 侧复数节点按 count 分支）
  relativeSeconds: { one: '{count} 秒前', other: '{count} 秒前' },
  relativeMinutes: { one: '{count} 分钟前', other: '{count} 分钟前' },
  relativeHours: { one: '{count} 小时前', other: '{count} 小时前' },
  relativeDays: { one: '{count} 天前', other: '{count} 天前' },
  // 搜索无结果
  searchNoResults: '无匹配记录',
  searchNoResultsHint: '换个关键词试试，或清除搜索恢复完整列表。',
  searchClear: '清除搜索',
  // 列表加载失败（重试动作）
  loadFailedTitle: '历史加载失败',
  loadFailedRetry: '重试',
  // 历史管理：行首 Checkbox 的无障碍标签
  selectRow: '选择该记录',
  // 状态芯片成词（取消 / 失败终态无状态码，以词代码）
  statusCancelled: '取消',
  statusFailed: '失败',
  // 底部状态栏（常驻）：三态全选框、已选计数、删除、历史总条数
  selectAllVisible: '全选',
  deselectAll: '取消全选',
  selectedCount: '已选 {count} 条',
  deleteSelected: '删除',
  loadedCount: '共 {count} 条',
  // 右键菜单（打开 / 复制 URL / 删除）
  menuOpen: '打开详情',
  menuCopyUrl: '复制 URL',
  menuDelete: '删除',
  // 删除确认（destructive；动作不带「…」，成句描述带句号）
  cancel: '取消',
  confirmDelete: '删除',
  deleteConfirmTitle: '删除历史记录',
  deleteConfirmDescription: {
    one: '将永久删除 {count} 条历史记录，删除后不可再查看。',
    other: '将永久删除 {count} 条历史记录，删除后不可再查看。',
  },
} as const
