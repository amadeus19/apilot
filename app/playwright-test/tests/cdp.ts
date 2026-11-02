import { test as base, chromium, type Browser, type Page } from '@playwright/test'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import * as net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

/**
 * CDP 接线夹具：Playwright 经 chromium.connectOverCDP
 * 接入 Tauri WebView2（--remote-debugging-port=9222）。
 *
 * 实例来源两级：优先复用外部已启动的 dev 实例（CDP 端口可达即连）；
 * 否则自起 `pnpm tauri dev`（注入 CDP 端口 env）并轮询连接（首跑含 Rust 编译，容忍长等待）。
 * 全局单实例：CDP 只有一个 WebView2 target，测试串行（workers=1）。
 * 当前仅支持单个 spec 文件（teardown 挂 per-file afterAll，见文件尾注）。
 *
 * 数据独立（领域承诺）：E2E 只写 settings 表的四个偏好键，afterAll 统一还原
 * ——Phase 1 无业务数据，偏好还原即不触碰真实用户数据。
 */

const CDP_PORT = 9222
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
/** CDP 就绪等待预算（CI 冷缓存编译 Rust 全量常超默认值，经环境变量注入） */
const CDP_READY_TIMEOUT_MS = Number(process.env.E2E_CDP_TIMEOUT_MS ?? 240_000)

let appProcess: ChildProcess | null = null
let browser: Browser | null = null
let sharedPage: Page | null = null
/** 页面关闭是否预期内（restartApp 主动关闭前置位，异常取证排除用） */
let expectedPageClose = false
/** 测试前偏好快照（teardown 恢复目标；null = 快照未建立，退回出厂默认） */
let preferencesSnapshot: Record<string, unknown> | null = null
/** 自起实例的输出尾部（有界缓冲；超时诊断 dump 用，stdio: 'ignore' 曾使超时不可诊断） */
const devOutput: string[] = []

/** 自起实例输出尾部 dump（页面异常关闭/渲染崩溃/进程退出时留 app 侧证据） */
function dumpDevOutput(reason: string): void {
  if (devOutput.length === 0) return
  console.warn(`[e2e] 自起实例输出尾部（${reason}）：\n${devOutput.slice(-60).join('')}`)
}

/**
 * 端口占用进程直杀（Windows）：taskkill /T 沿父子链杀树，链上进程
 * 先死（shell 抢先退出等）时子树会漏——残留 vite/app 会污染下一轮的
 * 实例复用判定（脏状态混入测试），故树杀后按端口兜底。
 */
async function killPortListeners(port: number): Promise<void> {
  if (process.platform !== 'win32') return
  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique`,
    ])
    const pids = stdout
      .split(/\s+/)
      .map(Number)
      .filter((pid) => pid > 0 && pid !== process.pid)
    for (const pid of pids) {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']).catch(() => {})
    }
  } catch {
    // 查询失败按无占用处理（端口释放等待逻辑另行兜底）
  }
}

async function cdpReachable(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, {
      signal: AbortSignal.timeout(1500),
    })
    return response.ok
  } catch {
    return false
  }
}

/** 轮询 CDP 端口直到可达（含首跑 Rust 编译，最长 4 分钟） */
async function waitCdpReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cdpReachable()) return
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  const tail = devOutput.slice(-50).join('')
  throw new Error(
    `CDP 端口 ${CDP_PORT} 在 ${timeoutMs}ms 内不可达。` +
      (tail
        ? `自起实例输出尾部：
${tail}`
        : '无自起实例输出（复用外部实例路径）。请手动运行 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=' +
          `--remote-debugging-port=${CDP_PORT} pnpm tauri dev 复现编译输出`),
  )
}

async function ensurePage(): Promise<Page> {
  if (sharedPage) return sharedPage

  // 外部复用判定：CDP 可达 **且** 页面 target 为本应用 dev 页面（localhost:5173），
  // 防止误连 9222 上的无关调试进程；自起前短窗口二次确认，降低双实例竞态
  async function externalAppTargetReady(): Promise<boolean> {
    if (!(await cdpReachable())) return false
    const probe = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)
    try {
      return probe
        .contexts()[0]
        .pages()
        .some((p) => p.url().includes('localhost:5173'))
    } finally {
      await probe.close().catch(() => {})
    }
  }

  if (!(await externalAppTargetReady())) {
    appProcess = spawn('pnpm', ['tauri', 'dev'], {
      cwd: REPO_ROOT,
      shell: true,
      env: {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
      },
      // pipe 收集输出尾部（超时诊断）；15s 二次确认避免与外部实例启动竞态
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })
    appProcess.stdout?.on('data', (chunk: Buffer) => {
      devOutput.push(chunk.toString())
      if (devOutput.length > 200) devOutput.shift()
    })
    appProcess.stderr?.on('data', (chunk: Buffer) => {
      devOutput.push(chunk.toString())
      if (devOutput.length > 200) devOutput.shift()
    })
    appProcess.once('exit', (code, signal) => {
      dumpDevOutput(`app 进程退出 code=${code} signal=${signal}`)
    })
    const secondChanceDeadline = Date.now() + 15_000
    while (Date.now() < secondChanceDeadline && (await externalAppTargetReady())) {
      appProcess = null
      break
    }
  }
  await waitCdpReady(appProcess ? CDP_READY_TIMEOUT_MS : 10_000)

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)
  // WebView2 的页面 target：按 dev 页面 URL 选取（CDP target 列表混有
  // vite HMR 的 blob: shared_worker 等非页面项，按序号取首位会拿到它）
  const context = browser.contexts()[0]
  const findAppPage = (): Page | null =>
    context.pages().find((p) => p.url().includes('localhost:5173')) ?? null
  let page = findAppPage()
  if (!page) {
    // 页面 target 可能晚于浏览器连接出现，等待之
    for (let i = 0; i < 30 && !page; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      page = findAppPage()
    }
  }
  if (!page) throw new Error('CDP 连接成功但未发现页面 target')
  sharedPage = page
  expectedPageClose = false

  // 页面异常取证：restartApp 主动关闭前置位 expectedPageClose，届时 close 事件不告警
  page.on('close', () => {
    if (sharedPage === page && !expectedPageClose) dumpDevOutput('页面意外关闭')
  })
  page.on('crash', () => {
    dumpDevOutput('页面渲染进程崩溃')
  })

  // 壳就绪判定（App Shell 状态栏挂载即 boot 完成）
  await page.waitForSelector('[data-testid="statusbar-workspace"]', { timeout: 30_000 })

  // 偏好快照仅首次连接建立：中途重启（restartApp）后的设置已被测试改写，
  // teardown 必须还原到测试前的状态而非中途状态
  if (preferencesSnapshot === null) {
    const boot = (await invokeIpc(page, 'get_boot_settings')) as {
      settings: Record<string, unknown>
    }
    preferencesSnapshot = boot.settings
  }
  return page
}

/** Tauri IPC 直调（页面上下文经 __TAURI_INTERNALS__，与 UI 同协议） */
export async function invokeIpc(
  page: Page,
  cmd: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  // 参数经 JSON 序列化传入（page.evaluate 的数组参数类型推断对可选元组不友好）
  const payload = JSON.stringify({ cmd, args: args ?? {} })
  return page.evaluate((raw) => {
    const parsed = JSON.parse(raw) as { cmd: string; args: Record<string, unknown> }
    return (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
        }
      }
    ).__TAURI_INTERNALS__.invoke(parsed.cmd, parsed.args)
  }, payload)
}

/** 还原偏好：优先恢复测试前快照（不抹掉用户非默认偏好）；快照缺失退回出厂默认 */
export async function restorePreferences(page: Page): Promise<void> {
  if (preferencesSnapshot) {
    for (const [key, value] of Object.entries(preferencesSnapshot)) {
      await invokeIpc(page, 'set_setting', { key, value })
    }
    return
  }
  await invokeIpc(page, 'set_setting', {
    key: 'theme',
    value: { preference: 'system', accent: 'indigo' },
  })
  await invokeIpc(page, 'set_setting', { key: 'locale', value: { preference: 'system' } })
  await invokeIpc(page, 'set_setting', { key: 'devMode', value: { enabled: false } })
  await invokeIpc(page, 'set_setting', { key: 'logLevel', value: { level: 'info' } })
}

async function teardown(): Promise<void> {
  dumpDevOutput('worker teardown')
  if (sharedPage) {
    try {
      await restorePreferences(sharedPage)
    } catch (error) {
      // 还原失败不阻塞收尾，但必须可观察（数据独立承诺失败的追责线索）
      console.warn('[e2e] 偏好还原失败，可能残留测试写入：', error)
    }
    sharedPage = null
  }
  await browser?.close().catch(() => {})
  browser = null
  if (appProcess) {
    // 自起实例：树杀（Windows shell 包装进程 → tauri dev → app.exe / vite）
    if (process.platform === 'win32' && appProcess.pid) {
      spawn('taskkill', ['/PID', String(appProcess.pid), '/T', '/F'], {
        shell: true,
        stdio: 'ignore',
      })
    } else {
      appProcess.kill('SIGTERM')
    }
    appProcess = null
    // 树杀兜底：链断漏杀的 vite/app 按端口直杀（仅自起场景执行，绝不触碰外部实例）
    await killPortListeners(5173)
    await killPortListeners(CDP_PORT)
  }
}

/** 当前共享页面（重启后为重连的新页面；未连接时 null） */
export function currentPage(): Page | null {
  return sharedPage
}

/** 测试钩子（beforeAll 等 fixture 不可用处）获取共享页面 */
export async function ensureAppPage(): Promise<Page> {
  return ensurePage()
}

/** 端口是否有进程监听（connect 成功即有；TIME_WAIT 不影响 listen 判定） */
function portHasListener(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' })
    const settle = (result: boolean): void => {
      socket.destroy()
      resolve(result)
    }
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
  })
}

/**
 * 真实用户路径重启：标题栏关闭钮触发退出链（flush 草稿与 Tab 会话 →
 * `app.ready_to_exit` 放行）→ 进程退出 → 重新拉起并连接。
 * 自起的 tauri dev shell 随应用退出自行结束，逾期树杀兜底；
 * shell 退出不等于整树死透——残余 vite 仍占 5173 会让新实例漂移端口、
 * 页面加载到垂死的旧 dev server 后断链，故须等 vite/CDP 端口全部释放。
 */
export async function restartApp(): Promise<Page> {
  if (!sharedPage) return ensurePage()
  const page = sharedPage
  // 残留对话框先退场（无对话框时 Esc 无害）
  await page.keyboard.press('Escape').catch(() => {})
  await page.keyboard.press('Escape').catch(() => {})
  expectedPageClose = true
  // accessible name 为子串匹配，限定 banner + 全等防误中「关闭 {标签名}」
  await page.getByRole('banner').getByRole('button', { name: '关闭', exact: true }).click()
  const exitDeadline = Date.now() + 20_000
  while (Date.now() < exitDeadline && (await cdpReachable())) {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  sharedPage = null
  await browser?.close().catch(() => {})
  browser = null
  await stopSelfStartedApp()
  const releaseDeadline = Date.now() + 15_000
  while (
    Date.now() < releaseDeadline &&
    ((await portHasListener(5173)) || (await portHasListener(CDP_PORT)))
  ) {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return ensurePage()
}

/** 自起实例 shell 进程收尾：随应用退出自行结束，逾期树杀兜底 */
async function stopSelfStartedApp(): Promise<void> {
  const proc = appProcess
  if (!proc) return
  appProcess = null
  await new Promise<void>((resolve) => {
    const killTree = () => {
      if (process.platform === 'win32' && proc.pid) {
        spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { shell: true, stdio: 'ignore' })
      } else {
        proc.kill('SIGKILL')
      }
    }
    const timer = setTimeout(() => {
      killTree()
      resolve()
    }, 8_000)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  // 树杀兜底：链断漏杀的 vite/app 按端口直杀，避免重启后旧实例占端口
  await killPortListeners(5173)
  await killPortListeners(CDP_PORT)
}

export const test = base.extend<{ appPage: Page }, { _workerTeardown: void }>({
  // worker 收尾（auto，幂等）：还原偏好 → 断开连接 → 树杀自起实例。
  // worker 作用域 = 该 spec 文件全部测试结束后执行一次，多 spec 文件安全
  _workerTeardown: [
    async ({}, use) => {
      await use()
      await teardown()
    },
    { scope: 'worker', auto: true },
  ],
  // 串行单实例：override worker scope 的 page（不用 Playwright 自建 browser）
  appPage: [
    async ({}, use) => {
      const page = await ensurePage()
      await use(page)
    },
    { scope: 'test' },
  ],
})
export { expect } from '@playwright/test'
