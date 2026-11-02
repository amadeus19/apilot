/**
 * 工作空间与服务域字典（zh-CN 基准）：左栏工作空间树视图（两级树、
 * 右键动作、新建 / 重命名 / 删除 / 切换、服务编辑与删除、批量导入向导）
 * 与标题栏切换器。zh-CN 与 en 两侧成对文件同步维护。
 */
export const workspace = {
  // —— 树视图（加载失败态与搜索空态） ——
  loadFailedTitle: '工作空间加载失败',
  loadFailedRetry: '重试',
  searchNoResults: '无匹配工作空间或服务',
  searchNoResultsHint: '换个关键词试试，或清除搜索恢复完整树。',
  searchClear: '清除搜索',

  // —— 树与底部动作 ——
  newWorkspace: '新建工作空间',
  newService: '新建服务',
  importEntry: '批量导入',
  /** 无文档地址＝纯手工容器，同步跳过 */
  serviceNoDoc: '无文档地址',

  // —— 工作空间详情页服务列表 ——
  serviceSectionTitle: '服务',
  serviceEmptyTitle: '尚无服务',
  serviceStatusHeader: '状态',
  serviceActionsHeader: '操作',
  serviceListEmpty: '尚无服务，可新建或从文档批量导入。',

  // —— 行动作（菜单项） ——
  actionSetCurrent: '设为当前',
  /** 当前空间页头徽章（非当前空间才显示「设为当前」按钮） */
  currentBadge: '当前',
  actionRename: '重命名',
  actionEdit: '编辑',
  actionDelete: '删除',

  // —— 双击设当前（行手势反馈） ——
  /** 切换成功的一次性 toast（action 位可切回原空间） */
  switchedToast: '已切换到「{name}」',
  switchBack: '切回',
  /** 工作空间行 title：双击手势提示 */
  doubleClickHint: '双击设为当前工作空间',
  /** 工作空间行折叠指示 title（箭头是唯一展开/收起命中区） */
  expand: '展开',
  collapse: '收起',

  // —— 排序动作（拖拽的键盘替代通道） ——
  moveUp: '上移',
  moveDown: '下移',

  // —— 通用表单 ——
  cancel: '取消',
  save: '保存',

  // —— 工作空间表单与删除确认 ——
  wsNewTitle: '新建工作空间',
  wsRenameTitle: '重命名工作空间',
  wsNameLabel: '名称',
  /** 级联范围明示：删除接受数据消失 */
  wsDeleteTitle: '删除工作空间',
  wsDeleteDescription: '将永久删除「{name}」及其全部服务、接口与测试数据，不可恢复。',
  wsDeleteConfirm: '删除',

  // —— 服务表单与删除确认 ——
  serviceNewTitle: '新建服务',
  serviceEditTitle: '编辑服务',
  serviceNameLabel: '服务名称',
  serviceDocUrlLabel: '文档地址',
  serviceDocUrlPlaceholder: '/swagger/v1/swagger.json（可选）',
  serviceDeleteTitle: '删除服务',
  serviceDeleteDescription: '将永久删除「{name}」及其接口定义与测试数据，不可恢复。',
  serviceDeleteConfirm: '删除',

  // —— 批量导入向导（Swashbuckle 入口页发现） ——
  importTitle: '批量导入服务',
  importEntryLabel: '入口页地址',
  importEntryPlaceholder: '/swagger 或 https://host/swagger',
  importEntryHint: '拉取 Swashbuckle 入口页并发现其中的 swagger 文档分组。',
  importDiscoverAction: '发现服务',
  importDiscovering: '发现中…',
  importFoundCount: '发现 {count} 个分组',
  /** 勾选步表头全选无障碍名（全选集恒排除名称撞车行） */
  importSelectAll: '全选分组',
  /** 名称与现有服务重复（默认不勾选，可强行勾选，落库自动追加序号） */
  importExistsBadge: '已存在',
  importUrlExistsBadge: '地址重复',
  importImportAction: '导入 {count} 个服务',
  importImporting: '导入中…',
  importBack: '上一步',
} as const
