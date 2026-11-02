/**
 * 工作空间详情页（工作空间详情 Tab 内容）：拍板版式（16 号变体 D）——
 * 身份横幅＋居中三卡分节；字段标签即语义锚点，无说明性赘述文案。
 */
export const workspaceSettings = {
  sectionBasic: '基本信息',
  sectionAuth: '认证',
  nameLabel: '工作空间名称',
  baseUrlLabel: 'BaseUrl',
  baseUrlPlaceholder: 'https://api.example.com',
  authTypeLabel: '认证方式',
  /** Tab 内容指针指向的空间已被删除 / 不可达时的空态 */
  notFound: '工作空间不存在或已删除',
  // 保存态回显：自动保存不可静默，保存中 / 已保存 / 失败三态必须可见
  saveSaving: '保存中…',
  saveSaved: '已保存',
  saveFailed: '保存失败',
  saveRetry: '重试',
  /** 名称清空的行内校验（空名不落库，等待有效输入） */
  nameEmptyError: '名称不能为空',
  // 横幅 meta 摘要行（BaseUrl · 认证方式 · 服务数）
  metaNoBaseUrl: '未设置 BaseUrl',
  metaAuthNone: '未配置认证',
  metaServicesCount: '{count} 个服务',
} as const
