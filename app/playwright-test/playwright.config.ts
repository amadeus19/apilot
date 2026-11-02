import { defineConfig, devices } from '@playwright/test'

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// import dotenv from 'dotenv';
// import path from 'path';
// dotenv.config({ path: path.resolve(__dirname, '.env') });

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  /* CDP 单实例：全部测试串行共享一个 Tauri WebView2 target */
  fullyParallel: false,
  workers: 1,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Tauri 桌面 E2E：浏览器由 CDP 连接提供，不使用 Playwright 自建浏览器 */
  use: {
    trace: 'retain-on-failure',
  },
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: process.env.CI ? 'line' : 'list',
  /* 单 project：CDP 连接的 WebView2 即 Chromium 内核，多 browser project 只会
     对同一 target 重复执行（首跑实测 4 场景 × 3 project = 同序列 3 遍） */
  projects: [
    {
      name: 'tauri-webview2',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  /* Run your local dev server before starting the tests */
  // webServer: {
  //   command: 'npm run start',
  //   url: 'http://localhost:3000',
  //   reuseExistingServer: !process.env.CI,
  // },
})
