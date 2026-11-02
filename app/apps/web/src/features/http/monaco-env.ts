import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
// 说明符走包 exports 通配（./* → ./esm/vs/*）：不带 esm/vs 前缀
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker'

/**
 * Monaco 本地化引导（副作用模块，仅随文本编辑器底座懒加载 chunk 求值）：
 * - 桌面离线场景禁走 `@monaco-editor/react` 默认的 jsdelivr CDN 加载路径——
 *   `loader.config({ monaco })` 把本地打包的 monaco 实例直接交给 loader，
 *   其 init() 检测到实例后短路，永不注入 CDN script；
 * - language worker 经 Vite `?worker` 打成同源本地 chunk（editor + json 两种，
 *   其余语言 worker 不会按需加载）。
 */

// worker 工厂全本地：label 对应语言服务的 worker 种类（json 之外一律兜底 editor）
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'json') return new jsonWorker()
    return new editorWorker()
  },
}

// 关键一步：本地实例注入 loader，覆盖默认 CDN paths（离线可用的前提）
loader.config({ monaco })
