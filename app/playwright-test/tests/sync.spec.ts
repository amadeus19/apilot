import { expect, invokeIpc, ensureAppPage, currentPage, test } from './cdp'
import type { Locator, Page } from '@playwright/test'
import * as http from 'node:http'
import * as net from 'node:net'

/**
 * Phase 5 同步域 E2E 全链路（ROADMAP 主线条目）：批量导入 → 首次全量入树 →
 * 改 fixture → 二次 diff → 应用 → 已移除删除与回归重导入。
 *
 * 链路数据收敛在「E2E 同步工作空间」（beforeAll 建立、afterAll 级联删除并
 * 切回原空间）——真实用户空间零接触（workbench.spec 同款协议）。文档源＝
 * 测试内 OpenAPI fixture 服务（node:http 随机端口，文档内容按阶段切换），
 * 与 demo-server、src-tauri tests fixture 均无关。
 */

const E2E_WORKSPACE = 'E2E 同步工作空间'
const FIXTURE_TITLE = 'E2E 演示 API'
/** 挂消失键 POST /users 的请求体留存值（XML 信封）：场景四断言其原样重接；
 *  XML 载体不走 JSON 骨架合并，body 列在回归应用时不被改写，可逐字节比对 */
const POST_BODY_RETAINED = JSON.stringify({ kind: 'xml', text: '<user><name>张三</name></user>' })

/** beforeAll 记录的原始当前空间（afterAll 切回） */
let originalWorkspaceId: string | null = null
/** OpenAPI fixture 服务（文档三态：v1 首次全量 / v2 改删增 / v3 回归） */
let fixtureServer: http.Server | null = null
let fixtureBaseUrl = ''

/** 通用 JSON 响应骨架（200） */
const jsonResponse = (res: http.ServerResponse, body: unknown): void => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** OpenAPI 3.0 文档三态：
 *  v1＝/users GET＋POST、/users/{id} GET（3 接口）
 *  v2＝GET 加 pageSize 参数（变更）、POST 消失（移除）、/users/{id} DELETE 出现（新增）
 *  v3＝POST 原样回归（消失后重导入，用户数据原地重接） */
function openapiDoc(version: 1 | 2 | 3): Record<string, unknown> {
  const pageParam = {
    name: 'page',
    in: 'query',
    description: '页码（从 1 起）',
    schema: { type: 'integer', format: 'int32' },
  }
  const pageSizeParam = {
    name: 'pageSize',
    in: 'query',
    required: true,
    description: '每页条数',
    schema: { type: 'integer', format: 'int32' },
  }
  const okJson = {
    200: {
      description: '成功',
      content: { 'application/json': { schema: { type: 'object' } } },
    },
  }
  const listUsers = {
    tags: ['用户'],
    summary: '用户列表',
    description: '分页返回全部用户',
    parameters: version >= 2 ? [pageParam, pageSizeParam] : [pageParam],
    responses: okJson,
  }
  const createUser = {
    tags: ['用户'],
    summary: '创建用户',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } },
    },
    responses: okJson,
  }
  const userDetail = { tags: ['用户'], summary: '用户详情', responses: okJson }
  const deleteUser = { tags: ['用户'], summary: '删除用户', responses: okJson }

  const paths: Record<string, Record<string, unknown>> = {
    '/users': { get: listUsers },
    '/users/{id}': { get: userDetail },
  }
  if (version !== 2) paths['/users'].post = createUser
  if (version >= 2) paths['/users/{id}'].delete = deleteUser
  return {
    openapi: '3.0.1',
    info: { title: FIXTURE_TITLE, version: `1.0.${version}` },
    paths,
  }
}

/** 起随机端口 fixture 服务（openapiDoc 按 version 响应） */
async function startFixture(): Promise<void> {
  let docVersion: 1 | 2 | 3 = 1
  fixtureServer = http.createServer((req, res) => {
    if (req.url === '/openapi.json') {
      jsonResponse(res, openapiDoc(docVersion))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => {
    fixtureServer!.listen(0, '127.0.0.1', resolve)
  })
  const address = fixtureServer!.address() as net.AddressInfo
  fixtureBaseUrl = `http://127.0.0.1:${address.port}`
  // 版本切换挂到 server 实例上（场景间推进链路阶段）
  ;(fixtureServer as unknown as { setDocVersion: (v: 1 | 2 | 3) => void }).setDocVersion = (v) => {
    docVersion = v
  }
}

function setFixtureVersion(version: 1 | 2 | 3): void {
  ;(fixtureServer as unknown as { setDocVersion: (v: 1 | 2 | 3) => void }).setDocVersion(version)
}

/** 左栏视图切换（图标栏 nav） */
function navButton(page: Page, name: string) {
  return page.getByRole('navigation', { name: '左栏视图' }).getByRole('button', { name })
}

/** 接口树行（treeitem，文本含节点名） */
function treeRow(page: Page, name: string) {
  return page.getByRole('treeitem').filter({ hasText: name })
}

/** 完成段四格统计卡取格（顺序＝added / changed / removed / unchanged；格内
 *  数字与文案两行拼接，文本形如「3新增」） */
function doneStat(wizard: Locator, index: number) {
  return wizard.getByTestId('wizard-done-stats').locator('div').nth(index)
}

/** 接口树服务行未展开时点一次展开（展开是 toggle，已展开不可重复点）；
 *  同步接口按 tag 归类，展开链＝服务行 → tag 分类行（fixture 全部 tags=['用户']） */
async function ensureTreeExpanded(page: Page, endpointTitle: string): Promise<void> {
  const isVisible = () =>
    treeRow(page, endpointTitle)
      .isVisible()
      .catch(() => false)
  if (!(await isVisible())) {
    await treeRow(page, FIXTURE_TITLE).click()
    if (!(await isVisible())) {
      await page.getByRole('treeitem', { name: '用户', exact: true }).click()
    }
  }
  await expect(treeRow(page, endpointTitle)).toBeVisible()
}

/** 打开同步向导（标题栏「同步」钮）并勾选全部可同步服务 */
async function openWizardAndSyncAll(page: Page): Promise<void> {
  await page.getByRole('banner').getByRole('button', { name: '同步', exact: true }).click()
  const wizard = page.getByTestId('sync-wizard')
  await expect(wizard).toBeVisible()
  // 选择段：勾选 fixture 服务（打开向导默认无勾选）
  await wizard.getByRole('checkbox', { name: FIXTURE_TITLE }).click()
  await wizard.getByRole('button', { name: '开始同步 · 1 服务' }).click()
}

test.describe('Phase 5 同步 E2E 全链路', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(150_000)

  // beforeAll 含 Tauri 冷启动/编译等待（CDP 就绪最长 240s），钩子预算须显式放大
  test.beforeAll(async () => {
    test.setTimeout(240_000)
    await startFixture()
    const page = await ensureAppPage()
    const list = (await invokeIpc(page, 'workspace.list')) as {
      items: Array<{ id: string; name: string }>
      currentId: string | null
    }
    originalWorkspaceId = list.currentId
    // 上次运行残留的 E2E 空间先清（测试可重复）
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
  })

  test.afterAll(async () => {
    const page = currentPage()
    if (page) {
      try {
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
        console.warn('[e2e] E2E 同步工作空间清理失败，可能残留测试数据：', error)
      }
    }
    await new Promise<void>((resolve) => fixtureServer?.close(() => resolve()))
  })

  test('场景一：批量导入——入口页地址发现服务并落库', async ({ appPage }) => {
    const page = appPage
    // 左栏切工作空间清单，行点击打开详情页（树交互：行点击＝详情）
    await navButton(page, '工作空间清单').click()
    await treeRow(page, E2E_WORKSPACE).click()
    await expect(page.getByRole('tab').filter({ hasText: E2E_WORKSPACE })).toBeVisible()

    // 服务区批量导入：填 fixture 文档地址 → 发现（OpenAPI JSON 直读回退通道）→ 导入
    // （服务卡头与空态引导各有一个「批量导入」入口，按 testid 取卡头入口）
    await page.getByTestId('workspace-service-import').click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('入口页地址').fill(`${fixtureBaseUrl}/openapi.json`)
    await dialog.getByRole('button', { name: '发现服务' }).click()
    await dialog.getByText('发现 1 个分组').waitFor()
    await dialog.getByRole('button', { name: '导入 1 个服务' }).click()
    // 对话框关闭＝落库完成；详情页服务行出现
    await expect(dialog).toBeHidden()
    await expect(page.getByTestId('workspace-service-list')).toContainText(FIXTURE_TITLE)
  })

  test('场景二：首次全量入树——3 新增应用后接口树可见并带徽标', async ({ appPage }) => {
    const page = appPage
    await openWizardAndSyncAll(page)
    const wizard = page.getByTestId('sync-wizard')

    // 对比段：统计页签（symbol＋文案＋计数同元素拼接，文本形如「＋新增3」），
    // 接口行默认全选
    await wizard.getByTestId('wizard-compare').waitFor()
    await expect(wizard.getByTestId('wizard-tab-added')).toHaveText(/＋新增3/)
    await wizard.getByRole('button', { name: '确认应用 · 3 项变更' }).click()

    // 完成段摘要（四格统计卡）→ 关闭向导
    await expect(wizard.getByText('同步完成')).toBeVisible()
    await expect(doneStat(wizard, 0)).toHaveText(/3\s*新增/)
    await wizard.getByRole('button', { name: '完成', exact: true }).click()
    await expect(wizard).toBeHidden()

    // 接口树：首次展开（服务行 → tag 分类行），3 接口全部「新增」徽标
    await navButton(page, '接口树').click()
    await expect(page.getByTestId('api-tree-counts')).toHaveText(/1 个服务 · 3 个接口/)
    await ensureTreeExpanded(page, '用户列表')
    for (const title of ['用户列表', '创建用户', '用户详情']) {
      const row = treeRow(page, title)
      await expect(row).toBeVisible()
      await expect(row.getByText('新增', { exact: true })).toBeVisible()
    }
  })

  test('场景三：改 fixture 二次 diff——增删改混合应用后树形收敛', async ({ appPage }) => {
    const page = appPage
    // 播种两条用户测试数据，各挂一种键性质：
    // - 消失键 POST /users 挂 XML 请求体留存值——v2 应用时定义行直接删除、
    //   用户数据不动，场景四重导入后以 IPC 直读断言凭稳定键原样重接；
    // - 变更键 GET /users 挂 page=9——v2 的 Update 参数对齐补 pageSize 空行、
    //   已填值不动，场景四顺带断言该对照值仍在
    const workspaceId = ((await invokeIpc(page, 'workspace.list')) as { currentId: string })
      .currentId
    const treeBefore = (await invokeIpc(page, 'tree.get', { workspaceId })) as {
      services: Array<{ id: string; name: string }>
    }
    const serviceId = treeBefore.services.find((s) => s.name === FIXTURE_TITLE)!.id
    await invokeIpc(page, 'user_data.upsert', {
      args: {
        serviceId,
        key: 'GET /users',
        body: null,
        params: JSON.stringify([
          {
            name: 'page',
            value: '9',
            enabled: true,
            type: 'integer',
            description: '页码（从 1 起）',
          },
        ]),
        headers: '[]',
        timeoutSeconds: null,
        auth: null,
        pathOverride: null,
        methodOverride: null,
      },
    })
    await invokeIpc(page, 'user_data.upsert', {
      args: {
        serviceId,
        key: 'POST /users',
        body: POST_BODY_RETAINED,
        params: '[]',
        headers: '[]',
        timeoutSeconds: null,
        auth: null,
        pathOverride: null,
        methodOverride: null,
      },
    })
    setFixtureVersion(2)
    await openWizardAndSyncAll(page)
    const wizard = page.getByTestId('sync-wizard')

    // 对比段：统计页签三组各计 1（symbol＋文案＋计数同元素拼接）；展开已移除行见「用户数据原地保留」卡
    await wizard.getByTestId('wizard-compare').waitFor()
    await expect(wizard.getByTestId('wizard-tab-added')).toHaveText(/＋新增1/)
    await expect(wizard.getByTestId('wizard-tab-changed')).toHaveText(/Δ变更1/)
    await expect(wizard.getByTestId('wizard-tab-removed')).toHaveText(/−已移除1/)
    // 清单一次一组：切到移除组，「创建用户」行才进清单（默认页签落新增组）
    await wizard.getByTestId('wizard-tab-removed').click()
    await wizard.getByRole('button', { name: /创建用户/ }).click()
    await expect(wizard.getByText('用户数据原地保留')).toBeVisible()
    await wizard.getByRole('button', { name: '确认应用 · 3 项变更' }).click()
    await expect(doneStat(wizard, 2)).toHaveText(/1\s*已移除/)
    await wizard.getByRole('button', { name: '完成', exact: true }).click()
    await expect(wizard).toBeHidden()

    // 接口树收敛：DELETE 新增、GET 变更；POST 已移除不进树。无变化的
    // 「用户详情」不进应用集（不可勾），徽标口径＝应用时无变化行清空
    // （不残留上轮标记），断言不存在的防误加回
    await navButton(page, '接口树').click()
    await expect(page.getByTestId('api-tree-counts')).toHaveText(/1 个服务 · 3 个接口/)
    await ensureTreeExpanded(page, '用户详情')
    await expect(treeRow(page, '删除用户').getByText('新增', { exact: true })).toBeVisible()
    await expect(treeRow(page, '用户列表').getByText('变更', { exact: true })).toBeVisible()
    const unchangedRow = treeRow(page, '用户详情')
    await expect(unchangedRow.getByText('新增', { exact: true })).toHaveCount(0)
    await expect(unchangedRow.getByText('变更', { exact: true })).toHaveCount(0)
    await expect(treeRow(page, '创建用户')).toHaveCount(0)
  })

  test('场景四：回归重导入——消失接口回归后普通新增且用户数据原地重接', async ({ appPage }) => {
    const page = appPage
    setFixtureVersion(3)
    await openWizardAndSyncAll(page)
    const wizard = page.getByTestId('sync-wizard')

    // 对比段：创建用户行是普通新增（回归走首次导入路径，无任何特殊标记；
    // 对比段行是 button 面板，非 treeitem）
    await wizard.getByTestId('wizard-compare').waitFor()
    await expect(wizard.getByRole('button', { name: /创建用户/ })).toBeVisible()
    await wizard.getByRole('button', { name: '确认应用 · 1 项变更' }).click()
    await expect(doneStat(wizard, 0)).toHaveText(/1\s*新增/)
    await wizard.getByRole('button', { name: '完成', exact: true }).click()
    await expect(wizard).toBeHidden()

    // 接口树：创建用户重现（重导入重打 new 徽标）
    await navButton(page, '接口树').click()
    await expect(page.getByTestId('api-tree-counts')).toHaveText(/1 个服务 · 4 个接口/)
    await ensureTreeExpanded(page, '用户详情')
    const readdedTreeRow = treeRow(page, '创建用户')
    await expect(readdedTreeRow).toBeVisible()
    await expect(readdedTreeRow.getByText('新增', { exact: true })).toBeVisible()

    // 用户数据原地重接（消失键 POST /users）：消失前播种的 XML 请求体经
    // 「删除定义行 → 重导入」全链后凭稳定键原样可读（XML 载体不走 JSON
    // 骨架合并，body 列零改写）——若删除被改成级联清用户数据，此断言必红
    const workspaceId = ((await invokeIpc(page, 'workspace.list')) as { currentId: string })
      .currentId
    const treeAfter = (await invokeIpc(page, 'tree.get', { workspaceId })) as {
      services: Array<{ id: string; name: string }>
    }
    const serviceId = treeAfter.services.find((s) => s.name === FIXTURE_TITLE)!.id
    const postDto = (await invokeIpc(page, 'user_data.get', { serviceId, key: 'POST /users' })) as {
      body: string | null
    } | null
    expect(postDto).not.toBeNull()
    expect(postDto!.body).toBe(POST_BODY_RETAINED)
    // 变更键对齐对照：GET /users 的 page=9 经场景三 Update 参数对齐仍保留
    // （pageSize 缺行照常补上、已填值不动），此处验证的是对齐不动已填值
    const dto = (await invokeIpc(page, 'user_data.get', { serviceId, key: 'GET /users' })) as {
      params: string
    } | null
    expect(dto).not.toBeNull()
    const rows = JSON.parse(dto!.params) as Array<{ name: string; value: string }>
    expect(rows.find((r) => r.name === 'page')?.value).toBe('9')
  })
})
