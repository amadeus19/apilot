/**
 * elkjs@0.12.0 的 `lib/main.js` 在运行时按需探测 `web-worker` 包（仅当调用方
 * 显式传 `workerUrl` 时使用，缺失则回退内置主线程 fake worker），但该包被
 * 错误声明在 elkjs 的 devDependencies——pnpm 严格 node_modules 下打包器静态
 * 解析必然失败。本 stub 让解析通过；默认调用路径（无 workerUrl）不会触达
 * 该导出，行为与包缺失时的主线程回退完全一致。
 */
export default {}
