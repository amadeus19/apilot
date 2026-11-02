import { expect, invokeIpc, test } from './cdp'

/**
 * 首组 E2E：启动出壳、主题切换、语言切换、设置模态开合。
 * 走真实 Tauri 实例（CDP），偏好键测试后统一还原（见 cdp.ts 数据独立协议）。
 */

test.describe('Phase 1 App Shell E2E', () => {
  test('场景一：启动出壳——App Shell 骨架可见（标题栏/图标栏/状态栏）', async ({ appPage }) => {
    const page = appPage
    // 标题栏：应用 logo ＋ 常驻的面板收展钮 ＋ 窗口控制三键
    const banner = page.getByRole('banner')
    await expect(banner.getByRole('img', { name: 'APilot' })).toBeVisible()
    await expect(banner.getByRole('button', { name: '最小化' })).toBeVisible()
    await expect(banner.getByRole('button', { name: '关闭' })).toBeVisible()
    // 收展钮常驻，不依赖悬浮替换（对鼠标用户恒定可见）
    const panelToggle = banner.getByRole('button', { name: '收展左栏面板' })
    // 冷启动（cargo/vite 首次编译）时交互就绪可能越过默认 5s，放宽此断言窗口
    await expect(panelToggle).toBeVisible({ timeout: 15_000 })
    // 点击收展钮收起面板，Ctrl+B 恢复；图标栏常驻不受影响
    await panelToggle.click()
    // 收起实现 = 容器 width:0 + overflow-hidden（视觉裁剪；内容 rect 仍非空，
    // Playwright toBeHidden 对裁剪态误判可见）。宽度有 150ms 过渡动画，轮询至终值
    await expect
      .poll(() => page.getByTestId('left-panel').evaluate((el) => el.getBoundingClientRect().width))
      .toBe(0)
    await expect(page.getByRole('navigation', { name: '左栏视图' })).toBeVisible()
    await page.keyboard.press('Control+b')
    // Ctrl+B 恢复后左栏内容可见（树视图搜索框任何状态下都渲染；
    // 树空态细节由 workbench 场景一在受控 E2E 空间断言，此处库中有真实数据不假设为空）
    await expect(page.getByRole('searchbox', { name: '搜索接口' })).toBeVisible()
    // 左栏四视图（图标栏 nav：接口树 / 请求历史 / 变量树 / 工作空间清单）
    const nav = page.getByRole('navigation', { name: '左栏视图' })
    await expect(nav.getByRole('button', { name: '接口树' })).toBeVisible()
    await expect(nav.getByRole('button', { name: '请求历史' })).toBeVisible()
    // 回收站视图不入图标栏；计数为零防误加回（断言不存在，而非仅隐藏）
    await expect(nav.getByRole('button', { name: '回收站' })).toHaveCount(0)
    await expect(nav.getByRole('button', { name: '变量树' })).toBeVisible()
    await expect(nav.getByRole('button', { name: '工作空间清单' })).toBeVisible()
    // 状态栏回显（工作空间段随当前空间联动非空；版本号真实渲染）。同步段
    // 无会话不渲染、任务段已废弃不渲染（恒 0 的无信息占位）——均断言不存
    // 在而非仅隐藏，防误加回
    await expect(page.getByTestId('statusbar-workspace')).toContainText(/\S/)
    await expect(page.getByTestId('statusbar-sync')).toHaveCount(0)
    await expect(page.getByTestId('statusbar-tasks')).toHaveCount(0)
    await expect(page.getByTestId('statusbar-version')).toContainText(/^v\d+\.\d+\.\d+$/)
    // 标签栏空态
    await expect(page.getByRole('tablist', { name: '标签栏' })).toBeVisible()
  })

  test('场景二：主题切换——明暗快捷钮即时生效（html.dark 单点）', async ({ appPage }) => {
    const page = appPage
    const isDark = () => page.evaluate(() => document.documentElement.classList.contains('dark'))

    // 明暗快捷钮：单击在 light ↔ dark 间切换（写偏好落库）
    const before = await isDark()
    await page.getByRole('button', { name: before ? '切换到浅色' : '切换到深色' }).click()
    await expect.poll(isDark, { timeout: 5000 }).toBe(!before)
    // html class 单点：全局主题只挂 documentElement；React Flow 的 colorMode
    // 会在自己的容器上加 scoped `.dark`（库内配色入口），不计入散落类
    expect(await isDark()).toBe(!before)
    expect(await page.evaluate(() => document.body.classList.contains('dark'))).toBe(false)
    const strayDark = await page.evaluate(
      () =>
        [...document.querySelectorAll('.dark')].filter(
          (el) => el !== document.documentElement && !el.classList.contains('react-flow'),
        ).length,
    )
    expect(strayDark).toBe(0)

    // 还原为点击前状态（避免污染后续场景断言）
    await page.getByRole('button', { name: before ? '切换到深色' : '切换到浅色' }).click()
    await expect.poll(isDark, { timeout: 5000 }).toBe(before)
  })

  test('场景三：语言切换——设置面板下拉，界面文案即时切换', async ({ appPage }) => {
    const page = appPage
    // Ctrl+, 打开设置 → 语言组 → 切 English
    await page.keyboard.press('Control+,')
    await page.getByRole('button', { name: /语言/ }).click()
    await page.getByLabel('界面语言').click()
    await page.getByRole('option', { name: 'English' }).click()

    // 即时生效：设置面板标题切英文（无重启）。状态栏已无随语言变化的文案
    // （任务段废弃），任务段恒不存在顺带断言
    await expect(page.getByRole('dialog')).toContainText('Settings')
    await expect(page.getByTestId('statusbar-tasks')).toHaveCount(0)

    // 切回中文
    await page.getByLabel('UI language').click()
    await page.getByRole('option', { name: '中文' }).click()
    await expect(page.getByRole('dialog')).toContainText('设置')

    // Esc 关闭（Base UI 默认）
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
  })

  test('场景四：设置模态开合——7 组导航齐备 + 搜索过滤', async ({ appPage }) => {
    const page = appPage
    // 语言兜底重置：场景三失败残留英文会击穿本场景的中文断言（重试也无法自愈）；
    // 写库 + reload 让 boot 重读（测试写入最终由 teardown 快照还原兜底）
    await invokeIpc(page, 'set_setting', { key: 'locale', value: { preference: 'system' } })
    await page.reload()
    await page.waitForSelector('[data-testid="statusbar-workspace"]')

    // 标题栏设置按钮打开（与 Ctrl+, 双入口之一）
    // 精确匹配：避免与「接口设置」按钮（aria-label 含「设置」子串）歧义
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // 7 组导航可见（外观/语言/快捷键/HTTP/备份/开发者/关于）；
    // 已删的编辑器 / 同步组与其「快照」关键词不再可达
    for (const name of ['外观', '语言', '快捷键', 'HTTP', '备份', '开发者', '关于']) {
      await expect(dialog.getByRole('button', { name: new RegExp(name) })).toBeVisible()
    }

    // 备份组转实：导出 / 恢复两动作在场（动作文案不带尾部省略号）
    await dialog.getByRole('button', { name: /备份/ }).click()
    await expect(dialog.getByRole('button', { name: '导出备份', exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: '恢复备份', exact: true })).toBeVisible()

    // 搜索过滤：命中「诊断」仅开发者组可见
    await page.getByRole('searchbox', { name: '搜索设置…' }).fill('诊断')
    await expect(dialog.getByRole('button', { name: /开发者/ })).toBeVisible()
    await expect(dialog.getByRole('button', { name: /外观/ })).toBeHidden()

    // Esc 关闭后焦点归还，工作区恢复可交互
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
  })
})
