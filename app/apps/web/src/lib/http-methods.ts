/**
 * HTTP 方法七选（协议名即展示名，恒不翻译）。
 * 新建接口对话框与接口编辑器共用；**方法的展示形态与语义色统一经 api-tree
 * 的 MethodBadge**（树行 / 标签栏 / 选择器值区与选项都走它），本文件只定
 * 七选的集合与顺序——展示样式另起一套，方法就会在两个地方长得不一样。
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

export type HttpMethod = (typeof HTTP_METHODS)[number]
