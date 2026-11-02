import { expect, invokeIpc, ensureAppPage, currentPage, test } from './cdp'
import type { Page } from '@playwright/test'
import * as http from 'node:http'
import * as net from 'node:net'

/**
 * Phase 6 工作流 E2E 全链路：批量导入 → 同步入树 → 新建工作流（节点拖入＋
 * 接口树拖入＋连线）→ 参数提取与存变量写回（掩码呈现）→ 断言链
 * （F5 passed → 改坏断言失败定位 → 恢复）→ 取消在途 → 删除接口失效
 * 呈现（确认框引用清单）→ 同步回归自动恢复 → 跨空间复制粘贴解析报告。
 *
 * 链形按引擎单链推进语义拆两条线性链：登录链＝请求 → 参数提取 → 存变量
 * （提取与存变量同链），断言链＝请求 → 断言（校验规则：参数提取与断言的
 * 直接上游必须是请求节点，分叉支不进主链会被 skipped）。
 *
 * 链路数据收敛在「E2E 工作流空间」「E2E 工作流目标空间」两个空间
 * （beforeAll 建立、afterAll 级联删除并切回原空间＋原空间工作流清单对账）
 * ——真实用户空间零接触。fixture＝测试内 node:http 随机端口服务（OpenAPI
 * 文档三态＋登录与列表端点），与 demo-server、sync.spec fixture 均无关。
 *
 * 拖拽口径：节点种类 / 接口树 → 画布是 HTML5 原生 dnd（自定义 MIME 载荷），
 * 本 spec 经合成 DragEvent＋DataTransfer 直达画布 onDrop——被测面＝画布
 * drop 端的载荷解码、落点路由（空白新建 / 占位绑定）与绑定动作（载荷编码
 * 另有 endpoint-dnd 单测）；浏览器原生 dnd 输入管线不属被测对象。画布连线
 * 是 React Flow 指针交互，用真实 mouse 序列从 source handle 拖到 target
 * handle。
 *
 * CLI 登录链子进程断言由 `src-tauri/tests/cli_e2e.rs` 承担（真实靶机＋
 * 子进程＋脱敏断言），归 cargo tests 统一执行，Playwright 侧不重复起
 * CLI 子进程。
 */

const E2E_WS = 'E2E 工作流空间'
const E2E_WS_TARGET = 'E2E 工作流目标空间'
const SERVICE_TITLE = 'E2E 工作流靶场'
const LOGIN_TITLE = '用户登录'
const LIST_TITLE = '用户列表'
const WF_LOGIN = 'E2E 登录链'
const WF_ASSERT = 'E2E 断言链'
const WF_SLOW = 'E2E 慢链'
/** 登录靶机响应体 token（断言执行面板只见掩码、不见此明文） */
const TOKEN_VALUE = 'e2e-jwt-token-9f8e7d6c5b4a3210'
const E2E_CATEGORY = 'E2E 登录'

/** beforeAll 记录的原始当前空间（afterAll 切回） */
let originalWorkspaceId: string | null = null
/** beforeAll 记录的原始空间工作流名快照（afterAll 对账＝用户数据零触碰） */
let originalWorkflowNames: string[] = []
/** OpenAPI fixture 服务（文档三态：v1 全量 / v2 远端移除登录 / v3 回归） */
let fixtureServer: http.Server | null = null
let fixtureBaseUrl = ''

/** 通用 JSON 响应骨架（200） */
const jsonResponse = (res: http.ServerResponse, body: unknown): void => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** OpenAPI 3.0 文档三态：
 *  v1＝POST /auth/login＋GET /api/users（2 接口全量）
 *  v2＝仅 GET /api/users（远端删除登录接口——同步「将删除」步）
 *  v3＝登录接口原样回归（远端重新提供——同步「新增」步落库，凭稳定键重接；
 *      直接切回 v1 全量会因快照与远端一致判「无变化」，删除过的接口
 *      不会重新落库） */
function openapiDoc(version: 1 | 2 | 3): Record<string, unknown> {
  const okJson = {
    200: {
      description: '成功',
      content: { 'application/json': { schema: { type: 'object' } } },
    },
  }
  const login = {
    tags: ['认证'],
    summary: LOGIN_TITLE,
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } },
    },
    responses: okJson,
  }
  const listUsers = { tags: ['认证'], summary: LIST_TITLE, responses: okJson }
  const paths: Record<string, Record<string, unknown>> = {
    '/api/users': { get: listUsers },
  }
  if (version !== 2) {
    paths['/auth/login'] = { post: login }
  }
  return {
    openapi: '3.0.1',
    info: { title: SERVICE_TITLE, version: `1.0.${version}` },
    paths,
  }
}

/** fixture 当前文档版本（场景内经 setFixtureVersion 切换，服务句柄读同一变量） */
let fixtureDocVersion: 1 | 2 | 3 = 1

/** 起随机端口 fixture 服务（文档按 version 响应；登录端点回固定 token） */
async function startFixture(): Promise<void> {
  fixtureDocVersion = 1
  fixtureServer = http.createServer((req, res) => {
    if (req.url === '/openapi.json') {
      jsonResponse(res, openapiDoc(fixtureDocVersion))
      return
    }
    if (req.url === '/auth/login' && req.method === 'POST') {
      jsonResponse(res, { token: TOKEN_VALUE, tokenType: 'Bearer', expiresIn: 3600 })
      return
    }
    if (req.url === '/api/users' && req.method === 'GET') {
      jsonResponse(res, { page: 1, total: 0, items: [] })
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

function setFixtureVersion(version: 1 | 2 | 3): void {
  fixtureDocVersion = version
}

/** 左栏视图切换（图标栏 nav） */
function navButton(page: Page, name: string) {
  return page.getByRole('navigation', { name: '左栏视图' }).getByRole('button', { name })
}

/** 接口树行（treeitem，文本含节点名） */
function treeRow(page: Page, name: string) {
  return page.getByRole('treeitem').filter({ hasText: name })
}

/** 工作流视图行（第五视图 treeitem） */
function workflowRow(page: Page, name: string) {
  return page.getByTestId('workflows-view').getByRole('treeitem').filter({ hasText: name })
}

/** 标签栏 Tab（文本含标签名；accessible name 含子树按钮文案，用 filter） */
function editorTab(page: Page, name: string) {
  return page.getByRole('tab').filter({ hasText: name })
}

/** 画布节点卡片（每种 kind 在画布内至多一个的场景下按 kind 定位） */
function nodeCard(page: Page, kind: string) {
  return page.locator(`[data-testid="workflow-node-${kind}"]`)
}

/** 画布节点卡片上的连线锚点（React Flow handle） */
function nodeHandle(page: Page, kind: string, side: 'source' | 'target') {
  return nodeCard(page, kind).locator(`.react-flow__handle.${side}`)
}

/**
 * 向画布合成一次 HTML5 drop（mime＋载荷直达 onDrop）：落点按 index 横向
 * 排开（间距须大于节点卡片宽度——重叠时相邻卡片盖住 target handle，
 * 后续真实 mouse 连线的抬起落点会命中邻居卡片 body 而连不上）。
 * dragover 先行（与浏览器事件序列一致，容器 onDragOver 放行后 drop
 * 才可达）。
 */
async function dropOnCanvas(page: Page, mime: string, payload: string, index = 0): Promise<void> {
  const box = await page.getByTestId('workflow-canvas').boundingBox()
  if (!box) throw new Error('画布不可见')
  const clientX = box.x + 140 + index * 340
  const clientY = box.y + box.height / 2
  await page.evaluate(
    ([mime, payload, cx, cy]) => {
      const transfer = new DataTransfer()
      transfer.setData(mime, payload)
      const canvas = document.querySelector('[data-testid="workflow-canvas"]')!
      canvas.dispatchEvent(
        new DragEvent('dragover', {
          dataTransfer: transfer,
          bubbles: true,
          clientX: cx,
          clientY: cy,
        }),
      )
      canvas.dispatchEvent(
        new DragEvent('drop', { dataTransfer: transfer, bubbles: true, clientX: cx, clientY: cy }),
      )
    },
    [mime, payload, clientX, clientY] as [string, string, number, number],
  )
}

/** 节点拖入：载荷＝kind（与拖放通道写入一致，落点由画布 drop 端解码建节点） */
async function dropNodeOnCanvas(page: Page, kind: string, index: number): Promise<void> {
  await dropOnCanvas(page, 'application/x-apilot-workflow-node', kind, index)
}

/**
 * 接口树拖接口进画布：载荷与树行 onDragStart 写入同构（serviceId 取树
 * 现查，稳定键 / 方法 / 路径 / 名称同拖出契约）。落空白处＝创建已绑定
 * 请求节点。
 */
async function dropEndpointOnCanvas(
  page: Page,
  serviceId: string,
  key: string,
  method: string,
  pathTemplate: string,
  name: string,
  index: number,
): Promise<void> {
  await dropOnCanvas(
    page,
    'application/x-apilot-workflow-endpoint',
    JSON.stringify({ serviceId, key, method, pathTemplate, name }),
    index,
  )
}

/**
 * 连线：真实 mouse 序列从 source handle 拖到 target handle（React Flow
 * 指针交互，鼠标事件有效）；多步移动保证中间 pointermove 被采集。连线
 * 完成后即时验证边数＋1（失败当场报出是哪条边，不拖到校验清零才暴露）；
 * 尾部等待越过编辑器 800ms 校验防抖——图变更触发的重渲若撞上下一条连线
 * 中段，handle 交互会被打断（实测的间歇失败）。
 */
async function connectNodes(page: Page, sourceKind: string, targetKind: string): Promise<void> {
  const before = await page.locator('.react-flow__edge').count()
  const source = await nodeHandle(page, sourceKind, 'source').boundingBox()
  const target = await nodeHandle(page, targetKind, 'target').boundingBox()
  if (!source || !target) throw new Error(`连线锚点不可见：${sourceKind} → ${targetKind}`)
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 })
  await page.mouse.up()
  await expect(page.locator('.react-flow__edge')).toHaveCount(before + 1, { timeout: 5_000 })
  await page.waitForTimeout(1000)
}

/** 适配视图并等视口动画结束（后续 boundingBox / handle 命中按稳定视口） */
async function fitCanvas(page: Page): Promise<void> {
  await page.getByTestId('workflow-fit-view').click()
  await page.waitForTimeout(600)
}

/**
 * 自动布局＋适配视图：节点间距由 ELK 布局保证——拖放落点排开仍可能
 * 卡片重叠（卡片宽于落点间距），重叠的邻居卡片盖住 target handle 后
 * 真实 mouse 连线抬起落点命中的是卡片 body，边连不上。布局属图变更，
 * 返回前等越过校验防抖窗口，避免重渲打断第一条连线中段。
 */
async function arrangeCanvas(page: Page): Promise<void> {
  await page.getByTestId('workflow-auto-layout').click()
  await page.waitForTimeout(1000)
  await fitCanvas(page)
}

/**
 * 连线热区放大（fit view 小缩放下 handle 仅 1-2 物理像素，CDP 鼠标命中
 * 是二值事件，坐标像素舍入即脱靶）。只放大热区不改交互语义，属测试辅助
 * 设施；注入的 style 元素随页面 reload 失效，reload 之后需重新注入。
 */
async function enlargeHandleHitArea(page: Page): Promise<void> {
  await page.addStyleTag({
    content: '.react-flow__handle { min-width: 12px !important; min-height: 12px !important; }',
  })
}

/** 校验清零（残留错误码随失败消息输出，失败可定位到具体边 / 配置项） */
async function expectValidationCleared(page: Page): Promise<void> {
  try {
    await expect(page.getByTestId('workflow-validation-panel')).toBeHidden({ timeout: 10_000 })
  } catch {
    const codes = await page
      .getByTestId('workflow-validation-row')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-code')))
    throw new Error(
      `校验未清零，残留错误码：${codes.join(', ') || '(校验行不可见——控制台可能停在执行视图)'}`,
    )
  }
}

/** 第五视图新建工作流（新建 ▾ 菜单 → 命名 → 创建后编辑 Tab 自动打开） */
async function createWorkflow(page: Page, name: string): Promise<void> {
  await page.getByTestId('workflows-new-menu').click()
  await page.getByTestId('workflows-menu-create').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('名称').fill(name)
  await page.getByTestId('workflow-create-confirm').click()
  await expect(page.getByTestId('workflow-editor-toolbar')).toBeVisible()
}

/** 工具栏保存并等脏态清除（保存钮 disabled＝已保存） */
async function saveWorkflow(page: Page): Promise<void> {
  const save = page.getByTestId('workflow-save')
  await expect(save).toBeEnabled()
  await save.click()
  await expect(save).toBeDisabled()
}

/** F5 运行并等整流终态（执行面板 data-status） */
async function runAndWaitStatus(page: Page, status: string): Promise<void> {
  await page.keyboard.press('F5')
  await expect(page.getByTestId('workflow-execution-panel')).toHaveAttribute(
    'data-status',
    status,
    { timeout: 30_000 },
  )
}

/** 执行面板单节点行（按节点展示名过滤） */
function executionRow(page: Page, name: string) {
  return page.getByTestId('workflow-execution-row').filter({ hasText: name })
}

/** 接口树服务行未展开时逐级展开到接口行可见（服务行 → 「认证」分类行） */
async function ensureTreeExpanded(page: Page, endpointTitle: string): Promise<void> {
  const isVisible = () =>
    treeRow(page, endpointTitle)
      .isVisible()
      .catch(() => false)
  if (!(await isVisible())) {
    await treeRow(page, SERVICE_TITLE).click()
    if (!(await isVisible())) {
      await page.getByRole('treeitem', { name: '认证', exact: true }).click()
    }
  }
  await expect(treeRow(page, endpointTitle)).toBeVisible()
}

/** 打开同步向导并勾选 fixture 服务同步（返回向导定位器供对比段断言） */
async function openWizardAndSyncAll(page: Page) {
  await page.getByRole('banner').getByRole('button', { name: '同步', exact: true }).click()
  const wizard = page.getByTestId('sync-wizard')
  await expect(wizard).toBeVisible()
  await wizard.getByRole('checkbox', { name: SERVICE_TITLE }).click()
  await wizard.getByRole('button', { name: '开始同步 · 1 服务' }).click()
  return wizard
}

test.describe('Phase 6 工作流 E2E 全链路', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    // 钩子预算覆盖冷编译（Rust 侧改动触发 tauri dev 重建）
    test.setTimeout(360_000)
    await startFixture()
    const page = await ensureAppPage()
    const list = (await invokeIpc(page, 'workspace.list')) as {
      items: Array<{ id: string; name: string }>
      currentId: string | null
    }
    originalWorkspaceId = list.currentId
    // 上次运行残留的 E2E 空间先清（测试可重复）
    for (const name of [E2E_WS, E2E_WS_TARGET]) {
      const stale = list.items.find((item) => item.name === name)
      if (stale) await invokeIpc(page, 'workspace.delete', { id: stale.id })
    }
    // 原空间工作流名快照（afterAll 对账：E2E 全程不得触碰原空间数据）
    if (originalWorkspaceId) {
      const flows = (await invokeIpc(page, 'workflow.list', {
        workspaceId: originalWorkspaceId,
      })) as { items: Array<{ name: string }> }
      originalWorkflowNames = flows.items.map((item) => item.name)
    }
    // 两个 E2E 空间（base_url 指向 fixture：工作流请求节点按空间 BaseUrl 组合）
    for (const name of [E2E_WS, E2E_WS_TARGET]) {
      await invokeIpc(page, 'workspace.create', { name, baseUrl: fixtureBaseUrl })
    }
    const after = (await invokeIpc(page, 'workspace.list')) as {
      items: Array<{ id: string; name: string }>
    }
    const createdId = after.items.find((item) => item.name === E2E_WS)!.id
    await invokeIpc(page, 'workspace.set_current', { id: createdId })
    // IPC 直调不触发前端状态，重载让 boot 读到新的当前空间
    await page.reload()
    await page.waitForSelector('[data-testid="statusbar-workspace"]')
    await enlargeHandleHitArea(page)
  })

  test.afterAll(async () => {
    const page = currentPage()
    if (page) {
      try {
        const list = (await invokeIpc(page, 'workspace.list')) as {
          items: Array<{ id: string; name: string }>
        }
        for (const name of [E2E_WS, E2E_WS_TARGET]) {
          const e2e = list.items.find((item) => item.name === name)
          if (e2e) await invokeIpc(page, 'workspace.delete', { id: e2e.id })
        }
        if (originalWorkspaceId && list.items.some((item) => item.id === originalWorkspaceId)) {
          await invokeIpc(page, 'workspace.set_current', { id: originalWorkspaceId })
        }
      } catch (error) {
        // 清理失败不阻塞收尾，但必须可观察（数据独立承诺失败的追责线索）
        console.warn('[e2e] E2E 工作流空间清理失败，可能残留测试数据：', error)
      }
      // 用户数据零触碰对账（在清理 try 之外：断言失败必须让收尾红——
      // 原空间工作流清单与测试前快照逐名相等是可执行的验收而非观察项）
      if (originalWorkspaceId) {
        const flows = (await invokeIpc(page, 'workflow.list', {
          workspaceId: originalWorkspaceId,
        })) as { items: Array<{ name: string }> }
        expect(flows.items.map((item) => item.name)).toEqual(originalWorkflowNames)
      }
    }
    await new Promise<void>((resolve) => fixtureServer?.close(() => resolve()))
  })

  test('场景一：批量导入并同步入树——登录与列表两个接口可见', async ({ appPage }) => {
    const page = appPage
    // 左栏工作空间清单 → E2E 空间详情页 → 批量导入（sync.spec 同款协议）
    await navButton(page, '工作空间清单').click()
    await treeRow(page, E2E_WS).click()
    await expect(editorTab(page, E2E_WS)).toBeVisible()
    await page.getByTestId('workspace-service-import').click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('入口页地址').fill(`${fixtureBaseUrl}/openapi.json`)
    await dialog.getByRole('button', { name: '发现服务' }).click()
    await dialog.getByText('发现 1 个分组').waitFor()
    await dialog.getByRole('button', { name: '导入 1 个服务' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByTestId('workspace-service-list')).toContainText(SERVICE_TITLE)

    // 同步入树：2 接口全新增
    const wizard = await openWizardAndSyncAll(page)
    await wizard.getByTestId('wizard-compare').waitFor()
    await expect(wizard.getByTestId('wizard-tab-added')).toHaveText(/＋新增2/)
    await wizard.getByRole('button', { name: '确认应用 · 2 项变更' }).click()
    await wizard.getByRole('button', { name: '完成', exact: true }).click()
    await expect(wizard).toBeHidden()

    await navButton(page, '接口树').click()
    await expect(page.getByTestId('api-tree-counts')).toHaveText(/1 个服务 · 2 个接口/)
    await ensureTreeExpanded(page, LOGIN_TITLE)
    await expect(treeRow(page, LIST_TITLE)).toBeVisible()
  })

  test('场景二：新建工作流搭链——节点拖入、接口树拖入绑定、连线与配置', async ({ appPage }) => {
    const page = appPage
    await navButton(page, '工作流').click()
    await expect(page.getByTestId('workflows-view')).toBeVisible()

    // 剪贴板为空时「粘贴工作流」置灰（应用内剪贴板会话态的空态面）
    await page.getByTestId('workflows-new-menu').click()
    await expect(page.getByTestId('workflows-menu-paste')).toBeDisabled()
    await page.getByTestId('workflows-menu-create').click()
    const createDialog = page.getByRole('dialog')
    await createDialog.getByLabel('名称').fill(WF_LOGIN)
    await page.getByTestId('workflow-create-confirm').click()
    await expect(page.getByTestId('workflow-editor-toolbar')).toBeVisible()
    await expect(editorTab(page, WF_LOGIN)).toContainText(WF_LOGIN)
    // 打开工作流不联动切换左栏视图（接口树经左栏导航手动切换）：保持工作流清单
    await expect(page.getByTestId('workflows-view')).toBeVisible()

    // 接口树拖入登录接口：空白处落点＝创建已绑定请求节点（稳定键引用）
    const workspaceId = ((await invokeIpc(page, 'workspace.list')) as { currentId: string })
      .currentId
    const tree = (await invokeIpc(page, 'tree.get', { workspaceId })) as {
      services: Array<{ id: string; name: string }>
    }
    const serviceId = tree.services.find((service) => service.name === SERVICE_TITLE)!.id
    await dropEndpointOnCanvas(
      page,
      serviceId,
      'POST /auth/login',
      'POST',
      '/auth/login',
      LOGIN_TITLE,
      1,
    )
    const request = nodeCard(page, 'request')
    await expect(request).toHaveAttribute('data-bound', 'true')
    await expect(request).toContainText(LOGIN_TITLE)
    await expect(request).toContainText('POST')
    await expect(request).toContainText('/auth/login')

    // 节点拖入：开始 / 参数提取 / 结束（横向落点排开；存变量已并入提取节点写回分支）
    await dropNodeOnCanvas(page, 'start', 0)
    await dropNodeOnCanvas(page, 'extract', 2)
    await dropNodeOnCanvas(page, 'end', 3)
    await expect(page.getByTestId('workflow-canvas-empty')).toHaveCount(0)
    for (const kind of ['start', 'extract', 'end']) {
      await expect(nodeCard(page, kind)).toBeVisible()
    }

    // 自动布局拉开节点间距，适配视图后连线（handle 进视口，boundingBox 含视口变换）
    await arrangeCanvas(page)
    await connectNodes(page, 'start', 'request')
    await connectNodes(page, 'request', 'extract')
    await connectNodes(page, 'extract', 'end')

    // 参数提取：Body 源默认，首条规则取值路径 $.token（产物名尾键联动为
    // token；配置面常驻节点卡内）
    const extractPanel = page.getByTestId('workflow-extract-editor')
    await expect(extractPanel).toBeVisible()
    await extractPanel.getByLabel('取值路径').fill('$.token')

    // 多规则形态：添加第二条规则并填路径（产物名尾键联动轻量断言）
    await extractPanel.getByTestId('workflow-extract-rule-add').click()
    const secondRule = extractPanel.getByTestId('workflow-extract-rule').nth(1)
    await secondRule.getByLabel('取值路径').fill('$.tokenType')
    await expect(secondRule.getByLabel('产物名')).toHaveValue('tokenType')

    // 写回分支控件在卡片下部：自动布局落位后卡片下缘可能贴底部悬浮工具栏
    // （点击被工具栏截走），加完规则后点一次自适应视图把整图收进可视区
    await fitCanvas(page)

    // 存变量写回分支：目标分类为既有分类下拉（引擎自愈重建覆盖「配置后被删」
    // 场景，E2E 先经 IPC 建分类再选择）；值来源选产物 token（变量键自动随值
    // 尾段落模型，UI 不再展示键字段）；
    // Base UI Switch 渲染为 span（非 labelable），必须点开关本体而非包裹 label
    await invokeIpc(page, 'variable.create_category', {
      workspaceId,
      global: false,
      name: E2E_CATEGORY,
    })
    const writebackSwitch = extractPanel.getByTestId('workflow-extract-writeback-switch')
    await writebackSwitch.click()
    await expect(writebackSwitch).toHaveAttribute('aria-checked', 'true')
    // 写回分支展开使卡片向下长出一截：再收一次图，目标分类回到可视区
    await fitCanvas(page)
    await extractPanel.getByTestId('workflow-extract-writeback-product').click()
    // 两个产物都在下拉里：token 须全串匹配（默认子串匹配会同时命中 tokenType）
    await page.getByRole('option', { name: 'token', exact: true }).click()
    await extractPanel.getByTestId('workflow-extract-writeback-category').click()
    await page.getByRole('option', { name: E2E_CATEGORY }).click()
    const secretSwitch = extractPanel.locator('[data-slot="switch"]').nth(1)
    await expect(secretSwitch).toHaveAttribute('aria-checked', 'true')

    // 请求节点 Body 覆写（叠加在引用接口用户数据之上，不改接口本体）
    await page
      .getByTestId('workflow-request-editor')
      .getByPlaceholder('请求体原文，留空跟随接口')
      .fill('{"username":"e2e","password":"e2e"}')

    // 全链就绪：校验面板消失（缺 Start / 孤立节点等问题随搭链清零）
    await expectValidationCleared(page)
    await saveWorkflow(page)
  })

  test('场景三：F5 运行 passed——执行面板逐节点通过、写回落库且掩码呈现', async ({ appPage }) => {
    const page = appPage
    await runAndWaitStatus(page, 'passed')
    // 完成反馈＝右下角 toast（清单行不设历史结果徽标）
    await expect(page.getByText(`工作流「${WF_LOGIN}」执行通过`)).toBeVisible()
    for (const name of ['开始', LOGIN_TITLE, '参数提取', '结束']) {
      await expect(executionRow(page, name)).toHaveAttribute('data-status', 'passed')
    }
    // 提取产物摘要逐行掩码占位（敏感口径；明文不进执行面板）
    await expect(executionRow(page, '参数提取')).toContainText('***')
    await expect(page.getByTestId('workflow-execution-panel')).not.toContainText(TOKEN_VALUE)
    // 两条规则的两个产物都进摘要（第二条点名断言；token 是 tokenType 的
    // 子串，不再单独断言）
    await expect(executionRow(page, '参数提取')).toContainText('tokenType')

    // 第五视图行＝干净行（名称＋行内运行钮；历史结果不落行）
    await navButton(page, '工作流').click()
    const loginRow = workflowRow(page, WF_LOGIN)
    await expect(loginRow).toBeVisible()
    await expect(loginRow.getByText('已通过', { exact: true })).toHaveCount(0)

    // 变量视图：写回分类「E2E 登录」落库，token 变量可见且敏感。
    // 数据面前置断言先行（写回落库与树渲染两类失败在此分离——IPC 直查
    // 不命中即写回链路问题，命中而树无行才是前端呈现问题）
    const workspaceId = ((await invokeIpc(page, 'workspace.list')) as { currentId: string })
      .currentId
    const categories = (await invokeIpc(page, 'variable.list_categories', {
      workspaceId,
    })) as { items: Array<{ id: string; name: string; isGlobal: boolean }> }
    expect(categories.items.map((category) => category.name)).toContain(E2E_CATEGORY)
    await navButton(page, '变量树').click()
    const categoryRow = treeRow(page, E2E_CATEGORY)
    await expect(categoryRow).toBeVisible()
    await categoryRow.click()
    await expect(page.getByTestId('variable-config-page')).toBeVisible()
    const valueInput = page.getByTestId('variable-value-token')
    await expect(valueInput).toHaveAttribute('type', 'password')
    // 敏感值全路径脱敏：变量视图同样只见掩码，明文不出现
    await expect(page.getByTestId('variable-config-page')).not.toContainText(TOKEN_VALUE)
  })

  test('场景四：断言链——改坏断言 failed，期望实际并列、失败定位、改回恢复 passed', async ({
    appPage,
  }) => {
    const page = appPage
    // 场景三结束在变量配置页，先回第五视图
    await navButton(page, '工作流').click()
    await expect(page.getByTestId('workflows-view')).toBeVisible()
    // 断言链单链：开始 → 请求 → 断言 → 结束（断言的直接上游必须是请求节点，
    // 与登录链分离成两条线性工作流——引擎主链只沿首条出边推进，分叉支会被跳过）
    await createWorkflow(page, WF_ASSERT)
    const workspaceId = ((await invokeIpc(page, 'workspace.list')) as { currentId: string })
      .currentId
    const tree = (await invokeIpc(page, 'tree.get', { workspaceId })) as {
      services: Array<{ id: string; name: string }>
    }
    const serviceId = tree.services.find((service) => service.name === SERVICE_TITLE)!.id
    await dropEndpointOnCanvas(
      page,
      serviceId,
      'POST /auth/login',
      'POST',
      '/auth/login',
      LOGIN_TITLE,
      1,
    )
    await dropNodeOnCanvas(page, 'start', 0)
    await dropNodeOnCanvas(page, 'assert', 2)
    await dropNodeOnCanvas(page, 'end', 3)
    await arrangeCanvas(page)
    await connectNodes(page, 'start', 'request')
    await connectNodes(page, 'request', 'assert')
    await connectNodes(page, 'assert', 'end')

    // 断言：空规则集起步，添加一条「状态码等于 200」
    const assertPanel = page.getByTestId('workflow-assert-editor')
    await expect(assertPanel).toBeVisible()
    await assertPanel.getByRole('button', { name: '添加规则' }).click()
    await page.getByTestId('workflow-assert-rule-row').getByPlaceholder('如 200').fill('200')
    await expectValidationCleared(page)
    await saveWorkflow(page)
    await runAndWaitStatus(page, 'passed')

    // 改坏：断言期望改 418（故意失败）
    await page.getByTestId('workflow-assert-rule-row').getByPlaceholder('如 200').fill('418')
    await saveWorkflow(page)
    await runAndWaitStatus(page, 'failed')

    // 断言行失败并可展开「期望 vs 实际」并列；下游结束节点被中断为跳过
    const assertRow = executionRow(page, '断言')
    await expect(assertRow).toHaveAttribute('data-status', 'failed')
    await expect(executionRow(page, '结束')).toHaveAttribute('data-status', 'skipped')
    await assertRow.click()
    await expect(page.getByTestId('workflow-execution-row-detail')).toBeVisible()
    await expect(page.getByTestId('workflow-execution-assertions')).toContainText(
      '期望 418 · 实际 200',
    )

    // 第五视图行点击＝打开编辑 Tab；执行面板回看最近失败记录
    await navButton(page, '工作流').click()
    await workflowRow(page, WF_ASSERT).click()
    await expect(executionRow(page, '断言')).toHaveAttribute('data-status', 'failed')
    // 面板失败行点击＝定位节点＋行内展开错误详情
    await executionRow(page, '断言').click()
    // 定位生效：断言节点选中（React Flow selected 态）
    await expect(
      page
        .locator('.react-flow__node.selected')
        .filter({ has: page.locator('[data-testid="workflow-node-assert"]') }),
    ).toBeVisible()
    await expect(page.getByTestId('workflow-assert-editor')).toBeVisible()

    // 改回 200，恢复 passed
    await page.getByTestId('workflow-assert-rule-row').getByPlaceholder('如 200').fill('200')
    await saveWorkflow(page)
    await runAndWaitStatus(page, 'passed')
  })

  test('场景五：行内一键运行与取消在途——慢链停止后留 cancelled 痕', async ({ appPage }) => {
    const page = appPage
    // 场景四结束在断言链编辑器，先回第五视图
    await navButton(page, '工作流').click()
    await expect(page.getByTestId('workflows-view')).toBeVisible()
    // 搭一条慢链：开始 → 延时 30s → 结束（取消语义不打真实慢请求）
    await createWorkflow(page, WF_SLOW)
    await dropNodeOnCanvas(page, 'start', 0)
    await dropNodeOnCanvas(page, 'delay', 1)
    await dropNodeOnCanvas(page, 'end', 2)
    await arrangeCanvas(page)
    await connectNodes(page, 'start', 'delay')
    await connectNodes(page, 'delay', 'end')
    await page.getByTestId('workflow-delay-editor').getByLabel('等待时长（毫秒）').fill('30000')
    await expectValidationCleared(page)
    await saveWorkflow(page)

    // 行内一键运行（不开编辑器）→ 在途切停止钮 → 停止留 cancelled
    await navButton(page, '工作流').click()
    const slowRow = workflowRow(page, WF_SLOW)
    await slowRow.getByTestId('workflows-row-run').click()
    // 行内运行在途即现进度徽标：乐观态即出现（/^执行中/ 同时覆盖事件计数
    // 到达前后的两种形态，零时序依赖）
    await expect(slowRow.getByText(/^执行中/)).toBeVisible()
    // 计数断言（慢链窗口内稳定值）：引擎逐节点即时发 node.queued / 终态
    // 事件，开始节点毫秒级通过（N=1）、延时节点排队运行（M=2）、结束节点
    // 在 30s 延时结束前不排队——「执行中 · 1/2」在 30s 窗口内恒稳，10s 超时
    // 有三个数量级余量，无 flake
    await expect(slowRow.getByText('执行中 · 1/2', { exact: true })).toBeVisible({
      timeout: 10_000,
    })
    await slowRow.getByTestId('workflows-row-stop').click()
    // 行内回到干净行形态：进度徽标消失、运行钮恢复（并发闸已释放）
    await expect(slowRow.getByTestId('workflows-row-run')).toBeVisible({ timeout: 15_000 })
    await expect(slowRow.getByText(/^执行中/)).toHaveCount(0)
    // 取消留痕：终态记录落 cancelled（清单行不呈现历史结果，留痕在记录层）
    const slowWorkspaceId = ((await invokeIpc(page, 'workspace.list')) as { currentId: string })
      .currentId
    const slowList = (await invokeIpc(page, 'workflow.list', {
      workspaceId: slowWorkspaceId,
    })) as { items: Array<{ id: string; name: string }> }
    const slowId = slowList.items.find((wf) => wf.name === WF_SLOW)!.id
    const slowLast = (await invokeIpc(page, 'workflow.last_execution', { id: slowId })) as {
      status: string
    }
    expect(slowLast.status).toBe('cancelled')
  })

  test('场景六：删除被引用接口——确认框引用清单、失效节点警示留痕', async ({ appPage }) => {
    const page = appPage
    await navButton(page, '接口树').click()
    await ensureTreeExpanded(page, LOGIN_TITLE)
    await treeRow(page, LOGIN_TITLE).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '删除', exact: true }).click()

    // 确认框列出引用工作流清单（登录链与断言链都引用此接口；提示不阻断：知情后照删）
    const dialog = page.getByRole('dialog')
    const usage = dialog.getByTestId('delete-endpoint-usage')
    await expect(usage).toContainText('被 2 个工作流引用：')
    await expect(usage).toContainText(WF_LOGIN)
    await expect(usage).toContainText(WF_ASSERT)
    await dialog.getByRole('button', { name: '删除', exact: true }).click()
    await expect(dialog).toBeHidden()

    // 编辑器内失效呈现：校验清单可定位、节点警示态、方法与路径留痕恒可见
    await editorTab(page, WF_LOGIN).click()
    // 活跃 tab 此前停在执行视图（最近一次执行记录在）：校验错误到达后校验
    // tab 带计数徽标，点开查看（双 tab 控制台的非活跃侧内容不常驻 DOM）
    await page.getByRole('tab', { name: /校验/ }).click()
    const validation = page.getByTestId('workflow-validation-panel')
    await expect(validation).toBeVisible({ timeout: 10_000 })
    await expect(validation.locator('[data-testid="workflow-validation-row"]')).toHaveAttribute(
      'data-code',
      'requestInvalidRef',
    )
    await expect(validation).toContainText('引用的接口不存在')
    const request = nodeCard(page, 'request')
    await expect(request).toHaveAttribute('data-invalid', 'true')
    await expect(request).toContainText('POST')
    await expect(request).toContainText('/auth/login')
    // 失效提示与重接引导常驻节点卡内（无需选中）
    await expect(page.getByTestId('workflow-request-invalid-hint')).toContainText(
      '引用的接口已不存在。',
    )
  })

  test('场景七：同步回归自动恢复——远端删除再回归，失效消解并再跑 passed', async ({ appPage }) => {
    const page = appPage
    // 第一步：远端移除登录接口（fixture v2）——「将移除」明细行附引用工作流计数
    setFixtureVersion(2)
    const removal = await openWizardAndSyncAll(page)
    await removal.getByTestId('wizard-compare').waitFor()
    await expect(removal.getByTestId('wizard-tab-removed')).toHaveText(/−已移除1/)
    await expect(removal.getByTestId('wizard-removed-usage')).toHaveText(/2 个工作流引用/)
    await removal.getByRole('button', { name: '确认应用 · 1 项变更' }).click()
    await removal.getByRole('button', { name: '完成', exact: true }).click()
    await expect(removal).toBeHidden()

    // 第二步：远端重新提供登录接口（fixture v3）——「新增」落库，凭稳定键重接
    setFixtureVersion(3)
    const wizard = await openWizardAndSyncAll(page)
    await wizard.getByTestId('wizard-compare').waitFor()
    await expect(wizard.getByTestId('wizard-tab-added')).toHaveText(/＋新增1/)
    await wizard.getByRole('button', { name: '确认应用 · 1 项变更' }).click()
    await wizard.getByRole('button', { name: '完成', exact: true }).click()
    await expect(wizard).toBeHidden()

    // 编辑 Tab 仍在：树回归触发重校验（防抖），失效自动消解
    await expect(page.getByTestId('workflow-validation-panel')).toBeHidden({ timeout: 10_000 })
    await expect(nodeCard(page, 'request')).toHaveAttribute('data-invalid', 'false')
    await runAndWaitStatus(page, 'passed')
  })

  test('场景八：跨空间复制粘贴——未命中失效落地、全命中解析后同构可跑', async ({ appPage }) => {
    const page = appPage
    // 原空间：行右键复制（应用内剪贴板，不碰系统剪贴板）
    await navButton(page, '工作流').click()
    await workflowRow(page, WF_LOGIN).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '复制', exact: true }).click()
    await expect(page.getByText(`已复制工作流「${WF_LOGIN}」`)).toBeVisible()

    // 标题栏切换器经 UI 切目标空间（内存剪贴板跨空间存续，不 reload）
    await page.getByRole('button', { name: `工作空间: ${E2E_WS}` }).click()
    await page.getByRole('menuitem', { name: E2E_WS_TARGET }).click()
    await expect(page.getByTestId('statusbar-workspace')).toContainText(E2E_WS_TARGET)
    await expect(page.getByTestId('workflows-view')).toBeVisible()

    // 粘贴一：目标空间无接口——未命中 1，工作流照常落地
    await page.getByTestId('workflows-new-menu').click()
    await expect(page.getByTestId('workflows-menu-paste')).toBeEnabled()
    await page.getByTestId('workflows-menu-paste').click()
    const pasteDialog = page.getByRole('dialog')
    await expect(pasteDialog.getByTestId('workflows-paste-name')).toHaveValue(`${WF_LOGIN} - 副本`)
    await pasteDialog.getByTestId('workflows-paste-confirm').click()
    const report = pasteDialog.getByTestId('workflows-paste-report')
    await expect(report).toContainText('命中 0 个接口引用 · 未命中 1 个')
    await expect(report).toContainText('目标工作空间无此接口')
    await pasteDialog.getByRole('button', { name: '完成', exact: true }).click()
    await expect(pasteDialog).toBeHidden()

    // 副本行落地并打开：未命中节点保留稳定键并标失效
    const copyRow = workflowRow(page, `${WF_LOGIN} - 副本`)
    await expect(copyRow).toBeVisible()
    await copyRow.click()
    await expect(page.getByTestId('workflow-validation-panel')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('workflow-validation-panel')).toContainText('引用的接口不存在')

    // 目标空间导入并同步同一文档（接口定义行落库＝解析源）
    await navButton(page, '工作空间清单').click()
    await treeRow(page, E2E_WS_TARGET).click()
    await expect(editorTab(page, E2E_WS_TARGET)).toBeVisible()
    await page.getByTestId('workspace-service-import').click()
    const importDialog = page.getByRole('dialog')
    await importDialog.getByLabel('入口页地址').fill(`${fixtureBaseUrl}/openapi.json`)
    await importDialog.getByRole('button', { name: '发现服务' }).click()
    await importDialog.getByText('发现 1 个分组').waitFor()
    await importDialog.getByRole('button', { name: '导入 1 个服务' }).click()
    await expect(importDialog).toBeHidden()
    const wizard = await openWizardAndSyncAll(page)
    await wizard.getByTestId('wizard-compare').waitFor()
    await wizard.getByRole('button', { name: '确认应用 · 2 项变更' }).click()
    await wizard.getByRole('button', { name: '完成', exact: true }).click()
    await expect(wizard).toBeHidden()

    // 粘贴二：全命中解析——同构登录流一处搭好、处处粘贴
    await navButton(page, '工作流').click()
    await page.getByTestId('workflows-new-menu').click()
    await page.getByTestId('workflows-menu-paste').click()
    const pasteAgain = page.getByRole('dialog')
    await pasteAgain.getByTestId('workflows-paste-name').fill(`${WF_LOGIN} - 副本 2`)
    await pasteAgain.getByTestId('workflows-paste-confirm').click()
    const reportAgain = pasteAgain.getByTestId('workflows-paste-report')
    await expect(reportAgain).toContainText('命中 1 个接口引用 · 未命中 0 个')
    await pasteAgain.getByRole('button', { name: '打开', exact: true }).click()
    await expect(editorTab(page, `${WF_LOGIN} - 副本 2`)).toContainText(`${WF_LOGIN} - 副本 2`)
    await runAndWaitStatus(page, 'passed')
  })

  test('场景九：画布右键菜单——节点复制粘贴删除、边删除、空白面全选与 Esc 关闭', async ({
    appPage,
  }) => {
    const page = appPage
    // 前接场景八：副本 2 编辑器已打开（四节点全链三边），先适配视图稳定坐标
    await fitCanvas(page)
    const canvas = page.getByTestId('workflow-canvas')

    // —— 空白面右键：节点选择面板（搜索＋分组节点清单）＋底部空白面动作
    // （粘贴 / 全选 / 自动布局）；Esc 关闭后重开执行全选，四节点全部入选 ——
    await canvas.click({ button: 'right', position: { x: 60, y: 60 } })
    const picker = page.getByTestId('workflow-node-picker')
    await expect(picker).toBeVisible()
    await expect(picker.getByTestId('workflow-picker-search')).toBeVisible()
    await expect(picker.getByRole('button', { name: '粘贴' })).toBeVisible()
    await expect(picker.getByRole('button', { name: '全选' })).toBeVisible()
    await expect(picker.getByRole('button', { name: '自动布局' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(picker).toBeHidden()
    await canvas.click({ button: 'right', position: { x: 60, y: 60 } })
    await picker.getByRole('button', { name: '全选' }).click()
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(4)

    // —— 节点右键：复制（Ctrl+C）/ 粘贴（Ctrl+V）/ 删除（Delete）键位提示；
    // 复制后菜单粘贴出全新节点实例（同 kind 卡片 +1） ——
    await nodeCard(page, 'start').click({ button: 'right' })
    await expect(page.getByRole('menuitem').filter({ hasText: 'Ctrl+C' })).toBeVisible()
    await expect(page.getByRole('menuitem').filter({ hasText: 'Ctrl+V' })).toBeVisible()
    await expect(page.getByRole('menuitem').filter({ hasText: 'Delete' })).toBeVisible()
    await page.getByRole('menuitem').filter({ hasText: 'Ctrl+C' }).click()
    await nodeCard(page, 'start').click({ button: 'right' })
    await page.getByRole('menuitem').filter({ hasText: 'Ctrl+V' }).click()
    await expect(nodeCard(page, 'start')).toHaveCount(2)

    // 粘贴物整体选中：右键命中节点在选中集内，删除作用于整个选中集
    await nodeCard(page, 'start').nth(1).click({ button: 'right' })
    await page.getByRole('menuitem').filter({ hasText: 'Delete' }).click()
    await expect(nodeCard(page, 'start')).toHaveCount(1)

    // —— 边右键：仅删除一项，删除后边数减一（场景就此收尾，脏图不保存） ——
    // 边的连线视觉路径可能被节点卡片层遮挡（React Flow 边层在节点层下），
    // 真实鼠标命中依赖布局形态；本场景断言面是菜单行为（仅一项＋删除生效），
    // 边的可点性属 React Flow 框架职责，故用事件派发直达元素
    const edgeCount = await page.locator('.react-flow__edge').count()
    await page.locator('.react-flow__edge').last().dispatchEvent('contextmenu', {
      button: 2,
      bubbles: true,
      cancelable: true,
      clientX: 400,
      clientY: 300,
    })
    await expect(page.getByRole('menuitem')).toHaveCount(1)
    await page.getByRole('menuitem').click()
    await expect(page.locator('.react-flow__edge')).toHaveCount(edgeCount - 1)
  })
})
