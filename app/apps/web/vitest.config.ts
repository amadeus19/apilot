import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// 单测配置：jsdom 环境 + RTL；与 vite.config.ts 分离，测试不加载 Tailwind 插件
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    // vmThreads：jsdom 每 worker 创建一次复用（文件级隔离保持）
    pool: 'vmThreads',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    // 覆盖率（@vitest/coverage-v8，vitest 官方配套）：先报告对账不设阈值——
    // 分层阈值待真实基线的薄弱点补测到位后设防，不为凑数设整体硬门禁
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**'],
      exclude: ['src/test/**', 'src/**/__tests__/**'],
    },
  },
})
