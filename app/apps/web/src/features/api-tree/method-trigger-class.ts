/**
 * 方法选择器触发器的形态类（Apifox 式：整个触发器就是方法徽章，下拉箭头
 * 包在色块内＝箭头随文字色）；底与字 token 与 MethodBadge md 同源。
 * 暗色 hover 需压掉底座 dark:hover:bg-input/50（变体必须完整字面量出现，
 * Tailwind 静态扫描），故逐方法全量列出；底色 token 两主题各自派生，浅色
 * 无 hover 变色面。消费面：接口编辑器与草稿编辑器的地址栏方法选择器。
 * 独立文件而非随 MethodBadge 导出：组件文件混出常量会破坏 Fast Refresh。
 */
export const METHOD_TRIGGER_CLASS: Record<string, string> = {
  GET: 'text-method-get! bg-method-get-bg dark:bg-method-get-bg dark:hover:bg-method-get-bg',
  POST: 'text-method-post! bg-method-post-bg dark:bg-method-post-bg dark:hover:bg-method-post-bg',
  PUT: 'text-method-put! bg-method-put-bg dark:bg-method-put-bg dark:hover:bg-method-put-bg',
  DELETE:
    'text-method-delete! bg-method-delete-bg dark:bg-method-delete-bg dark:hover:bg-method-delete-bg',
  PATCH:
    'text-method-patch! bg-method-patch-bg dark:bg-method-patch-bg dark:hover:bg-method-patch-bg',
  HEAD: 'text-method-misc! bg-method-misc-bg dark:bg-method-misc-bg dark:hover:bg-method-misc-bg',
  OPTIONS:
    'text-method-misc! bg-method-misc-bg dark:bg-method-misc-bg dark:hover:bg-method-misc-bg',
}
