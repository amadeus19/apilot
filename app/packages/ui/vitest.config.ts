import path from "node:path"
import { defineConfig } from "vitest/config"

// UI 包单测：jsdom + RTL；被测代码同包（组件 + 测试都在 packages/ui）。
// 不引 react 插件——纯声明式组件由 Vitest 内置 esbuild 转译即可。
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    // vmThreads：jsdom 每 worker 创建一次复用（文件级隔离保持；与 web 包同约定）
    pool: "vmThreads",
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
    // 覆盖率（@vitest/coverage-v8）：与 web 包同约定，先报告对账不设阈值；
    // 测试资产（__tests__ 内 fixture 等）不计入统计
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**"],
      exclude: ["src/test/**", "src/**/__tests__/**"],
    },
  },
})
