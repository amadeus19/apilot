/**
 * 公共域字典（zh-CN 基准）：跨视图复用的通用文案（对话框、复制反馈、无障碍标签）。
 */
export const common = {
  // 复数机制锚点键（{ one?, other } 形态）：中文无复数变形，one 与 other 同值；
  // en 侧补 one 形态（类型上复数节点放宽为 one 可选，见 zh-CN.ts 的 DictShape）。
  // Phase 1 无 UI 使用点，供复数分支运行时验证；列表多选场景 Phase 3 起接入。
  nSelected: { one: '{count} 项已选中', other: '{count} 项已选中' },
  // 通用错误对话框（ErrorDialogHost）
  errorDialogTitle: '操作无法完成',
  errorDialogAcknowledge: '知道了',
  // 通用关闭文案（@workspace/ui 的 toast / dialog 关闭按钮经注入接缝消费）
  close: '关闭',
  // 命令面板对话框无障碍文案（CommandDialog 经注入接缝消费）
  commandPaletteTitle: '命令面板',
  commandPaletteDescription: '搜索要运行的命令…',
  // 复制反馈（@workspace/ui 的 CopyButton toast 经注入接缝消费）
  copyDone: '已复制',
  copyFailed: '复制失败，请手动复制',
  // Monaco chunk 懒加载期间 spinner 的无障碍标签（请求 Body 与响应 Pretty 两处装配点共用）
  editorLoading: '编辑器加载中',
} as const
