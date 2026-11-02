import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Tauri 组合配置（02 号调研 §1.7）
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // Windows WebView2 目标
    target: 'chrome105',
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      // elkjs@0.12 把 web-worker 错放在 devDependencies，打包器静态解析失败；
      // 运行时默认路径走内置主线程 fake worker，stub 仅让解析通过（详见 shims 文件头注）
      'web-worker': path.resolve(import.meta.dirname, './src/shims/web-worker.ts'),
    },
  },
})
