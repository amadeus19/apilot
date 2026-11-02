import { expect, invokeIpc, ensureAppPage, restartApp, currentPage, test } from './cdp'
import type { Page } from '@playwright/test'

/**
 * Phase 3 工作台 E2E（spec §8.3 七场景）：领域树与编辑、Tab 生命周期、
 * 分栏、命令面板、资源清理。真实 Tauri 实例（CDP）。
 *
 * 数据独立（领域承诺）：全部测试数据收敛在「E2E 测试工作空间」内——
 * beforeAll 建立并切换，afterAll 删除（级联全清）并切回原空间，
 * 真实用户空间零接触。重启走真实退出链（标题栏关闭钮 → flush 草稿
 * 与 Tab 会话 → 进程退出 → 重新拉起）。
 */

const E2E_WORKSPACE = 'E2E 测试工作空间'
const E2E_SERVICE = 'E2E 演示服务'

/** 场景二/四的草稿正文与其落库形态（user_data.body 列存信封 JSON，kind=text 携带原文） */
const E2E_BODY_TEXT = '{"page":1}'
const E2E_BODY_ENVELOPE = '{"kind":"text","text":"{\\"page\\":1}"}'

/** beforeAll 记录的原始当前空间（afterAll 切回） */
let originalWorkspaceId: string | null = null

/** 标签栏 Tab（accessible 文本含标题） */
function tabByTitle(page: Page, title: string) {
  return page.getByTestId('tabbar-tab').filter({ hasText: title })
}

/** 接口树行（treeitem，文本含节点名） */
function treeRow(page: Page, name: string) {
  return page.getByRole('treeitem').filter({ hasText: name })
}

/** 左栏当前宽度（分栏断言用；布局动画经 expect.poll 轮询至终值） */
function leftPanelWidth(page: Page): Promise<number> {
  return page.getByTestId('left-panel').evaluate((el) => el.getBoundingClientRect().width)
}

/** 工作台诊断计数（开发者组「工作台诊断」行描述）；先断言可见，行缺失时留快照证据而非无限等待 */
async function readDiagnostics(page: Page): Promise<{ tabs: number; commands: number }> {
  const line = page.getByText(/当前打开标签页数：\d+，注册命令数：\d+/)
  await expect(line).toBeVisible({ timeout: 10_000 })
  const match = (await line.textContent())!.match(/标签页数：(\d+)，注册命令数：(\d+)/)!
  return { tabs: Number(match[1]), commands: Number(match[2]) }
}

test.describe('Phase 3 工作台 E2E', () => {
  // 场景间存在数据依赖链（空间 → 服务 → 接口 → Tab），串行执行
  test.describe.configure({ mode: 'serial' })
  // 含两次真实重启（关窗 → 进程退出 → 重新拉起），单场景放宽预算
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    // 钩子预算覆盖冷编译（Rust 侧任何改动都会触发 tauri dev 重建）；
    // test.setTimeout 在钩子体内才作用于钩子（describe 层只作用测试）
    test.setTimeout(240_000)
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

  test('场景一：新建工作空间后树空态与引导齐备', async ({ appPage }) => {
    const page = appPage
    // 切换器显示 E2E 空间（boot 读 workspace.current）
    await expect(page.getByRole('button', { name: `工作空间: ${E2E_WORKSPACE}` })).toBeVisible()
    // 树空态与引导（首启动 seeding 语义由 cargo test 佐证，此处验证空空间形态；
    // 计数行仅在非空态渲染，建服务后的计数断言见场景二）
    await expect(page.getByText('尚无服务')).toBeVisible()
    await expect(page.getByRole('button', { name: '新建服务' })).toBeVisible()
    // 标签栏空态
    await expect(page.getByRole('tablist', { name: '标签栏' })).toContainText('无打开的标签页')
  })

  test('场景二：建服务建接口编辑草稿，重启后 Tab 会话/树展开/预览标记/草稿全恢复', async ({
    appPage,
  }) => {
    const page = appPage
    // 建服务（树空态引导按钮入口）
    await page.getByRole('button', { name: '新建服务' }).click()
    const serviceDialog = page.getByRole('dialog')
    await serviceDialog.getByLabel('服务名称').fill(E2E_SERVICE)
    await serviceDialog.getByRole('button', { name: '保存' }).click()
    const serviceRow = treeRow(page, E2E_SERVICE)
    await expect(serviceRow).toBeVisible()
    await expect(page.getByTestId('api-tree-counts')).toHaveText(/1 个服务 · 0 个接口/)

    // 建手工接口（服务行右键菜单三通道之一）；保存成功自动打开常驻 Tab（产品语义）
    await serviceRow.click({ button: 'right' })
    await page.getByRole('menuitem', { name: '新建接口' }).click()
    const endpointDialog = page.getByRole('dialog')
    await endpointDialog.getByLabel('路径模板').fill('/users/{id}')
    await endpointDialog.getByLabel('接口标题').fill('用户列表')
    await endpointDialog.getByRole('button', { name: '保存' }).click()
    const persistentTab = tabByTitle(page, '用户列表')
    await expect(persistentTab).toBeVisible()
    await expect(persistentTab).toHaveAttribute('aria-selected', 'true')
    await expect(persistentTab).not.toHaveAttribute('data-preview', 'true')

    // 新建即打开常驻 Tab：激活 Tab 的树定位语义自动展开其祖先链，接口行直接可见（计数同步增长）
    const endpointRow = treeRow(page, '用户列表')
    await expect(endpointRow).toBeVisible()
    await expect(page.getByTestId('api-tree-counts')).toHaveText(/1 个服务 · 1 个接口/)

    // 编辑器形态与发送钮（Phase 4 起发送已接线；按钮 testid 定位——
    // 「发送请求」空态钮同名前缀会撞 role+name 查询）
    await expect(page.getByTestId('endpoint-editor')).toBeVisible()
    await expect(page.getByTestId('editor-send-button')).toBeVisible()
    // Body 段（三形态）：新建接口默认 none 空态，经类型行切 Text 后 Monaco
    // 同步挂载——编辑器没有可 fill 的 input，草稿经键盘输入
    await page.getByRole('tab', { name: 'Body' }).click()
    const bodyTypeRow = page.getByTestId('editor-body-type-row')
    await expect(bodyTypeRow).toBeVisible()
    await expect(page.getByTestId('editor-body-empty')).toBeVisible()
    await bodyTypeRow.getByRole('tab', { name: 'Text' }).click()
    await expect(bodyTypeRow.getByRole('tab', { name: 'Text' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    const bodyEditor = page.getByTestId('editor-form').locator('.monaco-editor')
    await expect(bodyEditor).toBeVisible()
    await bodyEditor.click()
    // insertText＝IME 提交同路径的单次插入：逐键 type 在 WebView2 CDP 链路
    // 会被布局/修饰键竞态变形（实测 `"` 落成 `}`），组合式插入不经过该通道
    await page.keyboard.insertText(E2E_BODY_TEXT)

    // 轮询 IPC 直到防抖写落库（写路径实证；500ms 防抖 + 余量）。
    // 身份从树 DTO 现取（与编辑器消费同源）
    const tree = (await invokeIpc(page, 'tree.get', {
      workspaceId: ((await invokeIpc(page, 'workspace.list')) as { currentId: string }).currentId,
    })) as {
      services: Array<{
        id: string
        name: string
        endpoints: Array<{ key: string; title: string }>
      }>
    }
    const e2eService = tree.services.find((s) => s.name === E2E_SERVICE)!
    const e2eEndpoint = e2eService.endpoints.find((e) => e.title === '用户列表')!
    await expect
      .poll(
        () =>
          invokeIpc(page, 'user_data.get', {
            serviceId: e2eService.id,
            key: e2eEndpoint.key,
          }).then((dto) => (dto as { body: string | null } | null)?.body ?? null),
        { timeout: 15_000 },
      )
      .toBe(E2E_BODY_ENVELOPE)

    // 关 Tab 后单击接口行重开 = 预览：草稿不丢（重开读同一份 user_data）
    await persistentTab.getByRole('button', { name: /关闭 用户列表/ }).click()
    await expect(tabByTitle(page, '用户列表')).toHaveCount(0)
    await endpointRow.click()
    const previewTab = tabByTitle(page, '用户列表')
    await expect(previewTab).toHaveAttribute('data-preview', 'true')
    await page.getByRole('tab', { name: 'Body' }).click()
    // Monaco 已渲染行视图即草稿在编辑面恢复（信封 kind=text 直读）
    await expect(page.getByTestId('editor-form').locator('.view-lines')).toContainText(
      E2E_BODY_TEXT,
    )

    // 真实重启：关窗触发退出链（flush + 会话保存）
    const restored = await restartApp()
    const restoredTab = tabByTitle(restored, '用户列表')
    await expect(restoredTab).toBeVisible()
    await expect(restoredTab).toHaveAttribute('aria-selected', 'true')
    await expect(restoredTab).toHaveAttribute('data-preview', 'true')
    // 树展开状态恢复（接口行可见即服务行展开）
    await expect(treeRow(restored, '用户列表')).toBeVisible()
    // 草稿内容恢复
    await expect(restored.getByTestId('endpoint-editor')).toBeVisible()
    await restored.getByRole('tab', { name: 'Body' }).click()
    await expect(restored.getByTestId('editor-form').locator('.view-lines')).toContainText(
      E2E_BODY_TEXT,
    )
  })

  test('场景三：树搜索过滤 / 无结果空态 / 清除恢复展开快照', async ({ appPage }) => {
    const page = appPage
    const search = page.getByRole('searchbox', { name: '搜索接口' })

    // 无结果空态
    await search.fill('不存在xyz')
    await expect(page.getByText('无匹配接口')).toBeVisible()
    await page.getByRole('button', { name: '清除搜索' }).click()
    // 清除恢复搜索前展开态（接口行可见）
    await expect(treeRow(page, '用户列表')).toBeVisible()

    // 标题字段过滤（服务名 / 接口标题）
    await search.fill('用户')
    await expect(treeRow(page, '用户列表')).toBeVisible()
    // 方法字段过滤
    await search.fill('GET')
    await expect(treeRow(page, '用户列表')).toBeVisible()
    await search.fill('POST')
    await expect(page.getByText('无匹配接口')).toBeVisible()

    // 清除恢复展开快照：搜索前折叠态被快照，清除后回到折叠而非过滤展开态
    await page.getByRole('button', { name: '清除搜索' }).click()
    await expect(treeRow(page, '用户列表')).toBeVisible()
    await treeRow(page, E2E_SERVICE).click()
    await expect(treeRow(page, '用户列表')).toHaveCount(0)
    await search.fill('GET')
    await expect(treeRow(page, '用户列表')).toBeVisible()
    // 有结果态无「清除搜索」按钮（该按钮只在无结果空态渲染），清除＝清空输入框
    await search.fill('')
    await expect(treeRow(page, '用户列表')).toHaveCount(0)
    // 重新展开，为后续场景准备
    await treeRow(page, E2E_SERVICE).click()
    await expect(treeRow(page, '用户列表')).toBeVisible()
  })

  test('场景四：预览/常驻转换（单击复用 / 双击转正 / 已开常驻仅激活 / 编辑转正）', async ({
    appPage,
  }) => {
    const page = appPage
    // 建第二个接口
    await treeRow(page, E2E_SERVICE).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '新建接口' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('路径模板').fill('/users/{id}/profile')
    await dialog.getByLabel('接口标题').fill('用户详情')
    await dialog.getByRole('button', { name: '保存' }).click()
    const detailRow = treeRow(page, '用户详情')
    await expect(detailRow).toBeVisible()
    // 保存成功自动打开「用户详情」常驻 Tab（场景二同款产品语义）
    const detailTab = tabByTitle(page, '用户详情')
    await expect(detailTab).toBeVisible()
    await expect(detailTab).not.toHaveAttribute('data-preview', 'true')

    // 已开常驻仅激活：单击树行只激活，不动「用户列表」预览（openTab 单实例契约）
    await detailRow.click()
    await expect(detailTab).toHaveAttribute('aria-selected', 'true')
    await expect(detailTab).not.toHaveAttribute('data-preview', 'true')
    const listTab = tabByTitle(page, '用户列表')
    await expect(listTab).toHaveAttribute('data-preview', 'true')

    // 关闭常驻「用户详情」后单击树行 = 预览替换（全局唯一预览，「用户列表」被顶掉）
    await detailTab.getByRole('button', { name: /关闭 用户详情/ }).click()
    await expect(detailTab).toHaveCount(0)
    await detailRow.click()
    await expect(tabByTitle(page, '用户列表')).toHaveCount(0)
    await expect(detailTab).toHaveAttribute('data-preview', 'true')

    // 双击 = 转常驻
    await detailTab.dblclick()
    await expect(detailTab).not.toHaveAttribute('data-preview', 'true')

    // 单击「用户列表」→ 新预览；「用户详情」常驻不受影响
    await treeRow(page, '用户列表').click()
    await expect(listTab).toHaveAttribute('data-preview', 'true')
    await expect(detailTab).toBeVisible()

    // 预览内开始编辑 = 自动转正（此时「用户列表」为预览且激活）；Body 已是
    // 文本系（场景二遗留信封 kind=text），Monaco 全选替换插入触发脏写
    await page.getByRole('tab', { name: 'Body' }).click()
    const editor = page.getByTestId('editor-form').locator('.monaco-editor')
    await expect(editor).toBeVisible()
    await editor.click()
    await page.keyboard.press('Control+a')
    await page.keyboard.insertText('{"page":2}')
    await expect(listTab).not.toHaveAttribute('data-preview', 'true')
  })

  test('场景五：分栏拖宽/收起恢复/重启持久化；响应区折叠展开；重启回默认', async ({ appPage }) => {
    const page = appPage
    // 左栏拖宽（默认 288 → 视口 45%；50% 是规格上限，取 45% 避开钳制区）。
    // CDP 连接的页面 viewportSize 返回 null，视口尺寸走 window.innerWidth
    const viewportWidth = await page.evaluate(() => window.innerWidth)
    const viewportHeight = await page.evaluate(() => window.innerHeight)
    const targetX = Math.floor(viewportWidth * 0.45)
    const handle = page.getByRole('separator', { name: '调整左栏宽度' })
    const box = (await handle.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(targetX, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    // 拖后宽度以实测为基准（落点受分栏库内部映射影响，不假设精确到 targetX）；
    // 默认 288，未拖动则此断言失败
    let draggedWidth = 0
    await expect
      .poll(async () => {
        draggedWidth = await leftPanelWidth(page)
        return draggedWidth
      })
      .toBeGreaterThan(300)

    // Ctrl+B 收起 → 展开：一律回默认宽度 288（收起即重置，拖动宽是会话内临时调整）
    await page.keyboard.press('Control+b')
    await expect.poll(leftPanelWidth.bind(null, page)).toBe(0)
    await page.keyboard.press('Control+b')
    await expect.poll(leftPanelWidth.bind(null, page)).toBeGreaterThan(288 - 25)
    await expect.poll(leftPanelWidth.bind(null, page)).toBeLessThan(288 + 25)

    // 响应区拖过折叠带（minSize 以下）→ 自动折叠为条带 → 点击展开恢复
    const responseHandle = page.getByRole('separator', { name: '调整响应区高度' })
    const responseBox = (await responseHandle.boundingBox())!
    await page.mouse.move(
      responseBox.x + responseBox.width / 2,
      responseBox.y + responseBox.height / 2,
    )
    await page.mouse.down()
    await page.mouse.move(viewportWidth / 2, viewportHeight - 4, { steps: 8 })
    await page.mouse.up()
    const collapsedLabel = page.getByRole('button', { name: '展开响应区' })
    await expect(collapsedLabel).toBeVisible()
    await collapsedLabel.click()
    await expect(collapsedLabel).toHaveCount(0)

    // 重启：左栏宽度持久化恢复（展开回默认宽已被持久化覆盖）；响应区折叠为会话态回默认；常驻 Tab 会话恢复
    const restored = await restartApp()
    await expect.poll(leftPanelWidth.bind(null, restored)).toBeGreaterThan(288 - 25)
    await expect.poll(leftPanelWidth.bind(null, restored)).toBeLessThan(288 + 25)
    await expect(restored.getByRole('button', { name: '展开响应区' })).toHaveCount(0)
    await expect(restored.getByText('响应', { exact: true })).toBeVisible()
    await expect(tabByTitle(restored, '用户列表')).toBeVisible()
    await expect(tabByTitle(restored, '用户详情')).toBeVisible()
  })

  test('场景六：命令面板开关与命令执行；快捷键自定义与冲突阻止', async ({ appPage }) => {
    const page = appPage
    const isDark = () => page.evaluate(() => document.documentElement.classList.contains('dark'))

    // Ctrl+Shift+P 开关
    await page.keyboard.press('Control+Shift+p')
    const paletteInput = page.getByRole('combobox')
    await expect(paletteInput).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('command-palette-list')).toHaveCount(0)

    // 命令执行：切换明暗主题
    const darkBefore = await isDark()
    await page.keyboard.press('Control+Shift+p')
    await page.getByRole('option', { name: '切换明暗主题' }).click()
    await expect.poll(isDark).toBe(!darkBefore)
    await page.keyboard.press('Control+Shift+p')
    await page.getByRole('option', { name: '切换明暗主题' }).click()
    await expect.poll(isDark).toBe(darkBefore)

    // 命令执行：打开设置
    await page.keyboard.press('Control+Shift+p')
    await page.getByRole('option', { name: '打开设置' }).click()
    const settingsDialog = page.getByRole('dialog')
    await expect(settingsDialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(settingsDialog).toHaveCount(0)

    // 命令执行：切换到标签 1（动态段＝tabs[0]；场景四结束态打开顺序为
    // 用户详情在前、用户列表在后，故标签 1＝用户详情）
    await tabByTitle(page, '用户列表').click()
    await page.keyboard.press('Control+Shift+p')
    await page.getByRole('option', { name: /切换到标签 1/ }).click()
    await expect(tabByTitle(page, '用户详情')).toHaveAttribute('aria-selected', 'true')

    // 快捷键自定义：改绑「聚焦左栏搜索」→ Ctrl+Alt+E
    await page.keyboard.press('Control+,')
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: '快捷键' }).click()
    const searchRow = page.getByTestId('keybinding-row-focus.search')
    await searchRow.getByRole('button', { name: '修改' }).click()
    await page.keyboard.press('Control+Alt+e')
    await expect(searchRow.locator('kbd')).toHaveText(/Ctrl\+Alt\+E/)

    // 冲突检测：把「关闭当前标签」也录到 Ctrl+Alt+E → 提示归属并阻止
    const closeRow = page.getByTestId('keybinding-row-tab.close')
    await closeRow.getByRole('button', { name: '修改' }).click()
    await page.keyboard.press('Control+Alt+e')
    await expect(page.getByText(/已绑定给「聚焦左栏搜索」/)).toBeVisible()
    await page.keyboard.press('Escape')

    // 生效验证：新键位聚焦搜索框、原键位失效；随后恢复默认
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await page.getByTestId('endpoint-editor').click()
    await page.keyboard.press('Control+k')
    await expect(page.getByRole('searchbox', { name: '搜索接口' })).not.toBeFocused()
    await page.keyboard.press('Control+Alt+e')
    await expect(page.getByRole('searchbox', { name: '搜索接口' })).toBeFocused()
    // 恢复默认键位（Ctrl+K 语义不变；恢复默认收在行尾「···」菜单里）
    await page.keyboard.press('Control+,')
    await page.getByRole('dialog').getByRole('button', { name: '快捷键' }).click()
    await page
      .getByTestId('keybinding-row-focus.search')
      .getByRole('button', { name: '更多操作' })
      .click()
    await page.getByRole('menuitem', { name: '恢复默认' }).click()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.keyboard.press('Control+k')
    await expect(page.getByRole('searchbox', { name: '搜索接口' })).toBeFocused()
  })

  test('场景七：关 Tab 清理——诊断计数不随开关循环增长', async ({ appPage }) => {
    const page = appPage
    // 开发者组：开 devMode 才有工作台诊断行（devMode 落库持久，起点可能已开——
    // 无条件点击会把已开状态切成关；只还原由本场景打开的开关）
    await page.keyboard.press('Control+,')
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: '开发者' }).click()
    const devModeSwitch = dialog.getByRole('switch', { name: '开发者模式' })
    let devModeToggledByTest = false
    if ((await devModeSwitch.getAttribute('aria-checked')) !== 'true') {
      await devModeSwitch.click()
      await expect(devModeSwitch).toHaveAttribute('aria-checked', 'true')
      devModeToggledByTest = true
    }

    const initial = await readDiagnostics(page)
    expect(initial.tabs).toBe(2)
    // 命令注册表全量计数（发送与环境快切换命令入册后为 13 条，期望随注册表演进同步）
    expect(initial.commands).toBe(13)

    // 开关 Tab 循环：Ctrl+W 关一个 → 双击树行重开（常驻）→ 面板「关闭全部」→ 重开一个
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+w')
    await treeRow(page, '用户详情').dblclick()
    await page.keyboard.press('Control+Shift+p')
    await page.getByRole('option', { name: '关闭全部标签' }).click()
    await expect(page.getByRole('tablist', { name: '标签栏' })).toContainText('无打开的标签页')
    await treeRow(page, '用户列表').dblclick()

    await page.keyboard.press('Control+,')
    // 对话框每次打开重置回首分区（模态回到起点），需重新进入开发者分区
    await dialog.getByRole('button', { name: '开发者' }).click()
    const after = await readDiagnostics(page)
    expect(after.tabs).toBe(1)
    expect(after.commands).toBe(initial.commands)

    // 还原 devMode：只关掉本场景打开的开关（起点已开的存量状态不动，
    // 测试前快照由 cdp teardown 统一还原）
    if (devModeToggledByTest) {
      await dialog.getByRole('switch', { name: '开发者模式' }).click()
    }
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
})
