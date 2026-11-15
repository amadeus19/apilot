import { expect, invokeIpc, ensureAppPage, currentPage, cdpPages, test } from './cdp'
import type { Page } from '@playwright/test'
import * as http from 'node:http'
import * as net from 'node:net'

/**
 * 响应快照窗 E2E（真实多窗口全链）：触发弹窗、内容定格、复制表面、
 * 置顶切换持久化、关窗互不干扰。本仓首例 CDP 多 target 断言——
 * Tauri 每窗一个 target（同属 default context），主窗与快照窗共用 dev
 * 入口（URL 同为 localhost:5173），按 URL 无法区分，识别靠页面内容
 * data-testid（快照窗根挂 snapshot-window，主窗无此节点）。
 *
 * 数据独立（领域承诺）：测试数据收敛在「E2E 快照空间」——beforeAll 建立
 * 并切换、afterAll 级联删除并切回原空间；settings 键 responseSnapshotWindow
 * 测试前写 null（从未记忆态，保证建窗默认路径与置顶显示态的确定起点）、
 * afterAll 还原测试前原值，真实用户偏好零残留。响应源＝测试内 node:http
 * 随机端口 fixture 服务，与 sync / workflow spec 的 fixture 均无关。
 *
 * 文案口径：与既有 spec 一致按 system locale＝中文断言（「悬浮」）。
 */

const E2E_WORKSPACE = 'E2E 快照空间'
const E2E_SERVICE = 'E2E 快照服务'
const E2E_ENDPOINT_ONE = '快照接口一'
const E2E_ENDPOINT_TWO = '快照接口二'
/** fixture 响应的特征键值（Pretty 态单行片段，两接口取不同值证定格） */
const MARK_ONE = '"e2eMark": "snapshot-1"'
const MARK_TWO = '"e2eMark": "snapshot-2"'

/** beforeAll 记录的原始当前空间（afterAll 切回） */
let originalWorkspaceId: string | null = null
/** 测试前 settings 键 responseSnapshotWindow 的原值（undefined＝键不存在；afterAll 还原） */
let snapshotWindowSettingOriginal: unknown
/** fixture HTTP 服务（随机端口，两路径各回固定 JSON） */
let fixtureServer: http.Server | null = null
let fixtureBaseUrl = ''
/** 快照窗 page（场景一打开后跨场景复用；serial 数据依赖） */
let snapshotPage: Page | null = null

/** 标签栏 Tab（accessible 文本含标题） */
function tabByTitle(page: Page, title: string) {
  return page.getByTestId('tabbar-tab').filter({ hasText: title })
}

/** 接口树行（treeitem，文本含节点名） */
function treeRow(page: Page, name: string) {
  return page.getByRole('treeitem').filter({ hasText: name })
}

/** fixture JSON 响应（200，声明 application/json → Pretty 走 JSON 格式化档） */
const jsonResponse = (res: http.ServerResponse, body: unknown): void => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** 起随机端口 fixture 服务（/one 与 /two 回不同特征体） */
async function startFixture(): Promise<void> {
  fixtureServer = http.createServer((req, res) => {
    if (req.url === '/one') {
      jsonResponse(res, { e2eMark: 'snapshot-1', items: [1, 2] })
      return
    }
    if (req.url === '/two') {
      jsonResponse(res, { e2eMark: 'snapshot-2' })
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => {
    fixtureServer!.listen(0, '127.0.0.1', resolve)
  })
  const address = fixtureServer!.address() as net.AddressInfo
  fixtureBaseUrl = `http://127.0.0.1:${address.port}`
}

/**
 * 在快照窗页面上下文调 Tauri 窗口 close（系统 X 的等价链路：CloseRequested
 * → Rust 对非主窗 label 放行 → 窗口销毁）。页面 target 随窗口拆除，evaluate
 * 通道断开属预期，失败按已关处理。
 */
async function closeSnapshotWindow(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
            metadata: { currentWindow: { label: string } }
          }
        }
      ).__TAURI_INTERNALS__
      return internals.invoke('plugin:window|close', {
        label: internals.metadata.currentWindow.label,
      })
    })
    .catch(() => {
      /* 窗口销毁令页面一并拆除，返回通道断开＝关闭已生效 */
    })
}

/** 枚举 CDP 页面 target 找快照窗（根挂 snapshot-window；主窗无此节点）。
 *  页面可能仍在加载（testid 未挂）或正在销毁（查询抛错），均跳过 */
async function findSnapshotPage(): Promise<Page | null> {
  for (const page of cdpPages()) {
    if (page.isClosed()) continue
    try {
      if ((await page.locator('[data-testid="snapshot-window"]').count()) > 0) return page
    } catch {
      /* target 过渡态（加载/销毁中），跳过本轮 */
    }
  }
  return null
}

/** 读 settings 键 responseSnapshotWindow（经主窗 IPC；写穿缓存即时可见） */
async function readSnapshotSetting(page: Page): Promise<unknown> {
  const boot = (await invokeIpc(page, 'get_boot_settings')) as {
    settings: Record<string, unknown>
  }
  return boot.settings['responseSnapshotWindow']
}

/** 读记忆键的 alwaysOnTop 位（null / 缺失归 false；场景三断言用） */
async function readAlwaysOnTop(page: Page): Promise<boolean> {
  const setting = await readSnapshotSetting(page)
  if (setting === null || setting === undefined) return false
  return (setting as { alwaysOnTop?: unknown }).alwaysOnTop === true
}

/** 发送并等待主窗响应 Pretty 文本出现（Monaco chunk 首载放宽预算；显式
 *  条件等待，不 sleep） */
async function sendAndAwaitBody(page: Page, mark: string): Promise<void> {
  await page.getByTestId('editor-send-button').click()
  await expect(page.getByTestId('response-body')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('response-body-monaco').locator('.view-lines')).toContainText(
    mark,
    { timeout: 30_000 },
  )
}

test.describe('响应快照窗 E2E（多窗口全链）', () => {
  // 场景间存在数据依赖链（同一快照窗跨场景复用），串行执行
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    // 钩子预算覆盖冷编译（Rust 侧改动触发 tauri dev 重建）
    test.setTimeout(240_000)
    await startFixture()
    const page = await ensureAppPage()

    // 同进程残留的快照窗先关（上次运行中途失败兜底；正常路径无窗），
    // 并等 target 拆除——残留态会让「起点无快照窗」断言误报
    const staleSnapshot = await findSnapshotPage()
    if (staleSnapshot) {
      await closeSnapshotWindow(staleSnapshot)
      await expect.poll(findSnapshotPage, { timeout: 15_000 }).toBeNull()
    }

    // —— E2E 空间：自建自清范式（variable-suggest / workbench 同款）——
    const list = (await invokeIpc(page, 'workspace.list')) as {
      items: Array<{ id: string; name: string }>
      currentId: string | null
    }
    originalWorkspaceId = list.currentId
    const stale = list.items.find((item) => item.name === E2E_WORKSPACE)
    if (stale) await invokeIpc(page, 'workspace.delete', { id: stale.id })
    const created = (await invokeIpc(page, 'workspace.create', { name: E2E_WORKSPACE })) as {
      items: Array<{ id: string; name: string }>
    }
    const createdId = created.items.find((item) => item.name === E2E_WORKSPACE)!.id
    await invokeIpc(page, 'workspace.set_current', { id: createdId })
    // IPC 直调不触发前端状态，重载让 boot 读到新的当前空间
    await page.reload()
    await page.waitForSelector('[data-testid="statusbar-workspace"]')

    // —— 快照窗记忆键：记录原值 → 写 null（从未记忆态）——
    // 起点确定：建窗走默认参数（无记忆＝默认置顶，按钮显示态回退
    // DEFAULT_ALWAYS_ON_TOP=true 与建窗侧同源）；afterAll 还原原值
    snapshotWindowSettingOriginal = await readSnapshotSetting(page)
    await invokeIpc(page, 'set_setting', { key: 'responseSnapshotWindow', value: null })

    // —— 建服务与两个接口（路径＝fixture 绝对 URL，绕过 BaseUrl 直发）——
    await page.getByRole('button', { name: '新建服务' }).click()
    const serviceDialog = page.getByRole('dialog')
    await serviceDialog.getByLabel('服务名称').fill(E2E_SERVICE)
    await serviceDialog.getByRole('button', { name: '保存' }).click()
    const serviceRow = treeRow(page, E2E_SERVICE)
    await expect(serviceRow).toBeVisible()
    for (const [path, title] of [
      ['/one', E2E_ENDPOINT_ONE],
      ['/two', E2E_ENDPOINT_TWO],
    ] as const) {
      await serviceRow.click({ button: 'right' })
      await page.getByRole('menuitem', { name: '新建接口' }).click()
      const endpointDialog = page.getByRole('dialog')
      await endpointDialog.getByLabel('路径模板').fill(`${fixtureBaseUrl}${path}`)
      await endpointDialog.getByLabel('接口标题').fill(title)
      await endpointDialog.getByRole('button', { name: '保存' }).click()
      await expect(tabByTitle(page, title)).toBeVisible()
    }
  })

  test.afterAll(async () => {
    // 快照窗兜底关闭（正常路径场景四已关）：先关窗再还原记忆键——
    // 窗口几何记忆的防抖写回（500ms）不得覆盖还原值
    const leftover = await findSnapshotPage()
    if (leftover) await closeSnapshotWindow(leftover)
    const page = currentPage()
    if (!page) {
      await new Promise<void>((resolve) => fixtureServer?.close(() => resolve()))
      return
    }
    try {
      await invokeIpc(page, 'set_setting', {
        key: 'responseSnapshotWindow',
        value: snapshotWindowSettingOriginal ?? null,
      })
      const list = (await invokeIpc(page, 'workspace.list')) as {
        items: Array<{ id: string; name: string }>
      }
      const e2e = list.items.find((item) => item.name === E2E_WORKSPACE)
      if (e2e) {
        if (originalWorkspaceId && list.items.some((item) => item.id === originalWorkspaceId)) {
          await invokeIpc(page, 'workspace.set_current', { id: originalWorkspaceId })
        }
        await invokeIpc(page, 'workspace.delete', { id: e2e.id })
      }
    } catch (error) {
      // 清理失败不阻塞收尾，但必须可观察（数据独立承诺失败的追责线索）
      console.warn('[e2e] 快照窗测试数据清理失败，可能残留测试写入：', error)
    }
    await new Promise<void>((resolve) => fixtureServer?.close(() => resolve()))
  })

  test('场景一：发送后悬浮定格——快照窗作为新 target 出现，内容＝当前响应 Pretty 文本', async ({
    appPage,
  }) => {
    const page = appPage
    // 起点干净态：CDP 无快照窗 target
    expect(await findSnapshotPage()).toBeNull()

    // 接口一发送 → 响应区 Pretty（Monaco）出现特征文本
    await tabByTitle(page, E2E_ENDPOINT_ONE).click()
    await sendAndAwaitBody(page, MARK_ONE)

    // Body 工具栏「悬浮」→ 建窗（CDP 多出一个 page target，按页面内容识别）
    await page.getByRole('button', { name: '悬浮', exact: true }).click()
    await expect.poll(findSnapshotPage, { timeout: 15_000 }).not.toBeNull()
    snapshotPage = await findSnapshotPage()
    const snap = snapshotPage!

    // 标题＝接口（Tab）名；内容＝Pretty 文本（Monaco 只读视图，json 语言档）
    await expect(snap.getByTestId('snapshot-title')).toHaveText(E2E_ENDPOINT_ONE)
    await expect(snap.getByTestId('snapshot-json')).toContainText(MARK_ONE, { timeout: 30_000 })
    // json 档分流：text 档不渲染；行号随 Monaco 底座默认在场（行号条以
    // 首行行号文本断言——几何 visible 判定在刚 show 的窗口上不稳）
    await expect(snap.getByTestId('snapshot-text')).toHaveCount(0)
    await expect(snap.getByTestId('snapshot-json').locator('.view-lines')).toBeVisible()
    await expect(snap.getByTestId('snapshot-json').locator('.line-numbers').first()).toHaveText(
      /^1$/,
    )
  })

  test('场景二：主窗切换接口重发——快照窗内容定格不跟随', async ({ appPage }) => {
    const page = appPage
    const snap = snapshotPage!
    // 接口二重发：主窗响应更新为第二份特征体
    await tabByTitle(page, E2E_ENDPOINT_TWO).click()
    await sendAndAwaitBody(page, MARK_TWO)

    // 快照窗仍定格首份载荷：标题与内容都不跟随主窗变化
    await expect(snap.getByTestId('snapshot-title')).toHaveText(E2E_ENDPOINT_ONE)
    await expect(snap.getByTestId('snapshot-json')).toContainText(MARK_ONE)
    await expect(snap.getByTestId('snapshot-json')).not.toContainText(MARK_TWO)
  })

  test('场景三：置顶开关——aria-pressed 翻转且记忆键持久化', async ({ appPage }) => {
    const page = appPage
    const snap = snapshotPage!
    const pinButton = snap.getByTestId('snapshot-always-on-top')

    // 起点显示态 true（beforeAll 已把记忆键写 null；无记忆时回退默认置顶，
    // 与建窗侧 always_on_top 默认一致）
    await expect(pinButton).toHaveAttribute('aria-pressed', 'true')

    // 关 → 按钮翻转 + 记忆键落库（fire-and-forget 写，poll 等库值）
    await pinButton.click()
    await expect(pinButton).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(() => readAlwaysOnTop(page)).toBe(false)

    // 开回 → 翻转回 true + true 持久化
    await pinButton.click()
    await expect(pinButton).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => readAlwaysOnTop(page)).toBe(true)
  })

  test('场景四：关闭快照窗——target 消失且主窗互不干扰', async ({ appPage }) => {
    const page = appPage
    const snap = snapshotPage!
    // 自绘标题栏的关闭钮（真实用户路径：win.close() → CloseRequested 放行
    // → 窗口销毁；evaluate 直调版保留在 beforeAll 残留清扫兜底）
    await snap.getByTestId('snapshot-close').click()
    await expect.poll(findSnapshotPage, { timeout: 15_000 }).toBeNull()

    // 主窗不受影响：page 仍在、无关闭确认对话框（不弹 ask）、壳仍挂载
    expect(page.isClosed()).toBe(false)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByTestId('statusbar-workspace')).toBeVisible()
    // 主窗仍可正常操作：切回接口一 Tab，其上一响应仍在（不进托盘、不退出）
    await tabByTitle(page, E2E_ENDPOINT_ONE).click()
    await expect(page.getByTestId('response-tab-strip')).toBeVisible()
    await expect(page.getByTestId('response-body-monaco').locator('.view-lines')).toContainText(
      MARK_ONE,
    )
  })

  test('场景五：主窗隐藏到托盘——快照窗保持显示且可独立交互', async ({ appPage }) => {
    const page = appPage
    // 场景四已关快照窗：重新悬浮建窗（顺带覆盖关闭后重建路径）
    await page.getByRole('button', { name: '悬浮', exact: true }).click()
    await expect.poll(findSnapshotPage, { timeout: 15_000 }).not.toBeNull()
    const snap = (await findSnapshotPage())!

    // 主窗隐藏到托盘（决策：快照窗的意义即主窗切走后仍可看可复制）
    await invokeIpc(page, 'app.hide_to_tray')
    // 快照窗 target 仍在、内容仍在、仍可交互（置顶开关可点）
    expect(snap.isClosed()).toBe(false)
    await expect(snap.getByTestId('snapshot-json')).toContainText(MARK_ONE)
    const pin = snap.getByTestId('snapshot-always-on-top')
    const pressedBefore = await pin.getAttribute('aria-pressed')
    await pin.click()
    await expect(pin).toHaveAttribute('aria-pressed', pressedBefore === 'true' ? 'false' : 'true')

    // afterAll 清理经主窗 page invoke 正常（隐藏≠销毁，WebView 通道仍在）
  })
})
