/**
 * shadcn CLI 的 utils 别名锚点（components.json 的 aliases.utils 指向
 * `@workspace/ui/lib/utils`，经本包 tsconfig paths 解析）——不是对外出口，
 * package.json exports 不暴露它；包内组件一律直引 `cn` 包。
 */
export { cn } from "cn"
