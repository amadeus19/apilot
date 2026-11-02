/**
 * 接口树视图域（features/api-tree 消费）；zh-CN 与 en 两侧成对文件同步维护。
 */
export const apiTree = {
  // 树行
  pinnedGroup: '置顶',
  manualEndpoint: '手工接口',
  docService: '配置了文档地址（同步启用）',
  // 服务可达性探测四态（树行徽标；可达短暂展示后自动退场，重探入口＝计数行全量刷新）
  probeReachable: '服务可达',
  probeUnreachable: '服务不可达',
  probeUnknown: '可达性未知',
  probeProbing: '探测中…',
  // 徽标可见短词（原型形态；悬浮提示仍用上方全文键）
  probeTagReachable: '可达',
  probeTagUnreachable: '不可达',
  probeTagUnknown: '未知',
  probeTagProbing: '探测中',
  // 同步徽标（树行名称旁小徽标；应用时写入、下次同步滚动清旧）
  syncBadgeNew: '新增',
  syncBadgeChanged: '变更',
  syncBadgeNewHint: '上次同步新增的接口，下次同步后清除标识',
  syncBadgeChangedHint: '上次同步更新的接口，下次同步后清除标识',
  countLine: '{services} 个服务 · {endpoints} 个接口',
  // 一键展开 / 收起（左栏搜索行尾部动作）
  expandAll: '展开全部',
  collapseAll: '收起全部',
  // 搜索无结果
  searchNoResults: '无匹配接口',
  searchNoResultsHint: '换个关键词试试，或清除搜索恢复完整树。',
  searchClear: '清除搜索',
  // 菜单动作（动作文案不带「…」）
  open: '打开',
  newService: '新建服务',
  newEndpoint: '新建接口',
  newCategory: '新建分类',
  syncService: '同步此服务',
  /** 「同步此服务」置灰时的行尾原因徽标 */
  syncServiceNoDoc: '无文档地址',
  probeRefreshAll: '刷新全部可达性',
  edit: '编辑',
  rename: '重命名',
  pin: '置顶',
  unpin: '取消置顶',
  moveUp: '上移',
  moveDown: '下移',
  delete: '删除',
  // 服务表单（新建 / 编辑同构）
  serviceFormNewTitle: '新建服务',
  serviceFormEditTitle: '编辑服务',
  serviceNameLabel: '服务名称',
  serviceDocUrlLabel: '文档地址（可选）',
  serviceDocUrlPlaceholder: 'https://example.com/openapi.json',
  // 分类表单
  categoryFormNewTitle: '新建分类',
  categoryFormRenameTitle: '重命名分类',
  categoryNameLabel: '分类名称',
  // 接口表单
  endpointFormNewTitle: '新建接口',
  endpointFormRenameTitle: '重命名接口',
  endpointMethodLabel: '方法',
  endpointPathLabel: '路径模板',
  endpointPathPlaceholder: '/users/{id}',
  endpointTitleLabel: '接口标题',
  // 删除确认（级联范围明示）
  deleteEndpointTitle: '删除接口',
  deleteEndpointDescription:
    '将永久删除「{title}」，其用户数据（请求体、参数、请求头）与置顶状态一并清除，不可撤销。',
  deleteCategoryTitle: '删除分类',
  deleteCategoryDescription: '将删除分类「{title}」，其下接口上移到服务散层，接口数据不受影响。',
  deleteServiceTitle: '删除服务',
  deleteServiceDescription:
    '将永久删除服务「{title}」及其全部分类、接口、用户数据与置顶状态，不可撤销。',
  deleteEndpointRefsCount: '被 {count} 个工作流引用：',
  confirmDelete: '删除',
  cancel: '取消',
  save: '保存',
  // 树加载失败（重试动作）
  loadFailedTitle: '接口树加载失败',
  loadFailedRetry: '重试',
} as const
