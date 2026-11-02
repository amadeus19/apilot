import { expect, invokeIpc, ensureAppPage, currentPage, test } from './cdp'

/**
 * Monaco 变量联想 E2E：`{{` 触发字符补全与闭合引用 hover 解析两条真实
 * 路径的端到端回归（provider 注册 → 生效集上下文 → 命中 → 候选弹出 →
 * 回车插入 → 悬停解析）。
 *
 * 数据独立（领域承诺）：全部数据收敛在「E2E 变量联想空间」内——建仓带
 * baseUrl（内置层 baseUrl 进生效集）＋空间级激活分类一条明文变量（active 层），
 * afterAll 删除工作空间级联全清，真实用户空间零接触。
 */
const E2E_WORKSPACE = 'E2E 变量联想空间'
const E2E_SERVICE = 'E2E 变量服务'
const E2E_ENDPOINT = '变量联想接口'
const E2E_BASE_URL = 'https://vars.example.test'
const E2E_VAR_KEY = 'e2eToken'

/** beforeAll 记录的原始当前空间（afterAll 切回） */
let originalWorkspaceId: string | null = null

/** 当前空间 id（beforeAll 建立后各场景取用） */
async function currentWorkspaceId(page: Parameters<typeof invokeIpc>[0]): Promise<string> {
  const list = (await invokeIpc(page, 'workspace.list')) as { currentId: string | null }
  if (!list.currentId) throw new Error('无当前工作空间')
  return list.currentId
}

test.describe('Monaco 变量联想 E2E', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    // 钩子预算覆盖冷编译（Rust 侧改动触发 tauri dev 重建）
    test.setTimeout(360_000)
    const page = await ensureAppPage()
    const list = (await invokeIpc(page, 'workspace.list')) as {
      items: Array<{ id: string; name: string }>
      currentId: string | null
    }
    originalWorkspaceId = list.currentId
    // 上次运行残留先清（测试可重复）
    const stale = list.items.find((item) => item.name === E2E_WORKSPACE)
    if (stale) await invokeIpc(page, 'workspace.delete', { id: stale.id })
    // 建仓带 baseUrl：内置层 baseUrl 进生效集
    const created = (await invokeIpc(page, 'workspace.create', {
      name: E2E_WORKSPACE,
      baseUrl: E2E_BASE_URL,
    })) as { items: Array<{ id: string; name: string }> }
    const createdId = created.items.find((item) => item.name === E2E_WORKSPACE)!.id
    // 空间级分类激活＋一条明文变量（active 来源层；级联随空间删除）
    const categories = (await invokeIpc(page, 'variable.create_category', {
      workspaceId: createdId,
      global: false,
      name: 'E2E 分类',
    })) as { items: Array<{ id: string; name: string; isGlobal: boolean }> }
    const category = categories.items.find((item) => item.name === 'E2E 分类')!
    await invokeIpc(page, 'variable.set_active_category', {
      workspaceId: createdId,
      categoryId: category.id,
    })
    await invokeIpc(page, 'variable.create_variable', {
      categoryId: category.id,
      key: E2E_VAR_KEY,
      value: 'tok-123',
      secret: false,
    })
    // 数据面前置断言：生效集两层齐备（IPC 与查询数据面本身正确，后续
    // 场景失败即锁定在 Monaco 触发/注册链路）。全局层跨空间共享（真实库
    // 存量会漏入，E2E 不建也不清全局数据——精确等值断言不可行，取包含）
    const effective = (await invokeIpc(page, 'variable.effective', {
      workspaceId: createdId,
    })) as { items: Array<{ key: string; source: string }> }
    const sources = effective.items.map((item) => `${item.source}:${item.key}`)
    expect(sources).toContain(`active:${E2E_VAR_KEY}`)
    expect(sources).toContain('builtin:baseUrl')
    await invokeIpc(page, 'workspace.set_current', { id: createdId })
    // IPC 直调不触发前端状态，重载让 boot 读到新的当前空间
    await page.reload()
    await page.waitForSelector('[data-testid="statusbar-workspace"]')
  })

  test.afterAll(async () => {
    const page = currentPage()
    if (!page) return
    try {
      const list = (await invokeIpc(page, 'workspace.list')) as {
        items: Array<{ id: string; name: string }>
      }
      const e2e = list.items.find((item) => item.name === E2E_WORKSPACE)
      if (!e2e) return
      if (originalWorkspaceId && list.items.some((item) => item.id === originalWorkspaceId)) {
        await invokeIpc(page, 'workspace.set_current', { id: originalWorkspaceId })
      }
      await invokeIpc(page, 'workspace.delete', { id: e2e.id })
    } catch (error) {
      // 清理失败不阻塞收尾，但必须可观察（数据独立承诺失败的追责线索）
      console.warn('[e2e] E2E 工作空间清理失败，可能残留测试数据：', error)
    }
  })

  test('JSON 字符串值内连击 {{ 弹候选，回车插入完整引用', async ({ appPage }) => {
    const page = appPage
    // 建服务＋接口（树空态引导按钮与右键菜单入口），保存自动打开常驻 Tab
    await page.getByRole('button', { name: '新建服务' }).click()
    const serviceDialog = page.getByRole('dialog')
    await serviceDialog.getByLabel('服务名称').fill(E2E_SERVICE)
    await serviceDialog.getByRole('button', { name: '保存' }).click()
    const serviceRow = page.getByRole('treeitem').filter({ hasText: E2E_SERVICE })
    await expect(serviceRow).toBeVisible()
    await serviceRow.click({ button: 'right' })
    await page.getByRole('menuitem', { name: '新建接口' }).click()
    const endpointDialog = page.getByRole('dialog')
    await endpointDialog.getByLabel('路径模板').fill('/vars')
    await endpointDialog.getByLabel('接口标题').fill(E2E_ENDPOINT)
    await endpointDialog.getByRole('button', { name: '保存' }).click()
    await expect(page.getByTestId('endpoint-editor')).toBeVisible()

    // Body → JSON，Monaco 挂载
    await page.getByRole('tab', { name: 'Body' }).click()
    await page
      .getByTestId('editor-body-type-row')
      .getByRole('tab', { name: 'JSON', exact: true })
      .click()
    const editor = page.getByTestId('editor-form').locator('.monaco-editor')
    await expect(editor).toBeVisible()
    await editor.click()

    // 基底文本走 insertText（逐键 type 在 WebView2 CDP 链路有变形风险，
    // 与 workbench spec 同口径）；用户报告的上下文＝JSON 字符串值内
    await page.keyboard.insertText('{"key":"')
    // 触发字符路径：真实按键连击 {{（每个 { 都是 provider trigger character）
    await page.keyboard.type('{{', { delay: 50 })
    // 键入保真前置断言（变形即本场景不可信，失败先查输入链路）
    await expect(editor.locator('.view-lines')).toContainText('{{')

    // 候选面板弹出：active 层变量与内置 baseUrl 两行齐备
    const widget = page.locator('.suggest-widget.visible')
    await expect(widget).toBeVisible()
    await expect(widget.locator('.monaco-list-row').filter({ hasText: E2E_VAR_KEY })).toBeVisible()
    await expect(widget.locator('.monaco-list-row').filter({ hasText: 'baseUrl' })).toBeVisible()

    // 回车接受首行（active 层排序在前）：替换范围＝光标前 `{{` 整段，
    // 一次成型 `{{键}}`，不残留连击花括号
    await page.keyboard.press('Enter')
    await expect(editor.locator('.view-lines')).toContainText(`{{${E2E_VAR_KEY}}}`)
  })

  test('面板开启后继续键入查询词：过滤到命中键并整段替换', async ({ appPage }) => {
    const page = appPage
    const editor = page.getByTestId('editor-form').locator('.monaco-editor')
    await expect(editor).toBeVisible()
    await editor.click()
    // 基底文本（逐键 type 在 WebView2 CDP 链路有变形风险，与场景一同口径）
    await page.keyboard.press('Control+a')
    await page.keyboard.insertText('{"key":"')
    // 触发字符弹出面板
    await page.keyboard.type('{{', { delay: 50 })
    const widget = page.locator('.suggest-widget.visible')
    await expect(widget).toBeVisible()
    // 面板开启下继续真实键入查询词（refilter 过滤路径；查询词取字母 o——
    // e2eToken 含 o、baseUrl 不含，过滤断言决定性）
    await page.keyboard.type('o', { delay: 50 })

    // 查询词过滤生效：e2eToken 命中、baseUrl 被滤除（filterText＝`{{＋键名
    // 与过滤词 `{{o` 模糊命中；键名不含 o 的候选被筛掉）
    await expect(widget.locator('.monaco-list-row').filter({ hasText: E2E_VAR_KEY })).toBeVisible()
    await expect(widget.locator('.monaco-list-row').filter({ hasText: 'baseUrl' })).toHaveCount(0)

    // 回车接受：替换范围含查询词整段 `{{o`，落成完整引用
    await page.keyboard.press('Enter')
    await expect(editor.locator('.view-lines')).toContainText(`{"key":"{{${E2E_VAR_KEY}}}`)
  })

  test('闭合引用上悬停：hover 解析出生效值与来源层', async ({ appPage }) => {
    const page = appPage
    const editor = page.getByTestId('editor-form').locator('.monaco-editor')
    await expect(editor).toBeVisible()
    // 前一场景回车插入的完整引用仍在正文中（serial 依赖，保真前置断言）
    await expect(editor.locator('.view-lines')).toContainText(`{{${E2E_VAR_KEY}}}`)
    // 悬停到引用所在的 token span（JSON 字符串值 token 含键名），hover 卡片
    // 弹出：解析值（明文变量直出）＋ active 来源层文案
    const referenceSpan = editor.locator('.view-line span', { hasText: E2E_VAR_KEY }).first()
    await referenceSpan.hover()
    // DOM 有两个 .monaco-hover（内容卡片＋glyph margin tooltip），内容卡片
    // 显示时移除 hidden class——:not(.hidden) 唯一定位到它
    const hover = page.locator('.monaco-hover:not(.hidden)')
    await expect(hover).toBeVisible()
    await expect(hover).toContainText('tok-123')
    await expect(hover).toContainText('激活分类')
  })
})
