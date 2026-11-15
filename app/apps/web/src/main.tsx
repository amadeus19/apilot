import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { QueryClientProvider } from '@tanstack/react-query'

import '@workspace/ui/globals.css'
import { App } from './App.tsx'
import { BootErrorScreen } from './components/common/BootErrorScreen.tsx'
import { CloseConfirmDialog } from './features/settings'
import { UpdateReadyDialog } from './features/update'
import { SnapshotWindowApp, SNAPSHOT_WINDOW_LABEL } from './features/response-snapshot/index.ts'
import { ThemeProvider, UiTextBridge, DevtoolsF12, DevtoolsHotkeyGuard } from './app/providers.tsx'
import { setDevtoolsNative } from './services/devtools-flag.ts'
import { scheduleStartupUpdateSweep } from './services/update-check.ts'
import { applyDocumentLocale, applyDocumentTheme } from './lib/document-theme.ts'
import { resolveLocale, resolveTheme, type ThemeSetting } from './lib/settings-schema.ts'
import { THEME_CHANGED_EVENT, useSettingsStore } from './stores/settings.store.ts'
import { getBootSettings, isBlockingCode, toIpcError, type IpcError } from './services/ipc.ts'
import { withTimeout } from './lib/async.ts'
import { queryClient } from './app/query-client.ts'

// 启动载荷读取超时：本地 SQLite 读为毫秒级，3s 已属异常，按协议回退默认偏好
const BOOT_SETTINGS_TIMEOUT_MS = 3000
// 系统主题（原生窗口）查询超时：失败回退 light（resolveTheme 兜底）
const OS_THEME_TIMEOUT_MS = 1000

const root = createRoot(document.getElementById('root')!)

// boot（防闪协议）：
// 1) render 前 await 启动载荷 + 系统主题；2) Zod 解析灌 store（脏键回退默认并上报）；
// 3) 挂 .dark / data-accent / html lang；4) render；5) show()。
// 阻断性错误（DB_CORRUPTED）→ 全屏错误呈现；其余失败 → 回退默认偏好启动，不阻塞。
//
// 快照小窗与主窗共用本入口：按窗口 label 早期分流——快照窗走轻量根
// （bootSnapshotWindow），不挂主窗专属件（App Shell / 关闭与更新对话框 /
// 更新扫场）。
async function boot(): Promise<void> {
  if (getCurrentWindow().label === SNAPSHOT_WINDOW_LABEL) {
    await bootSnapshotWindow()
    return
  }
  const bootError = await hydrateBootPreferences()
  if (bootError) {
    if (isBlockingCode(bootError.code)) {
      // 库不可用读不到语言偏好：以系统语言兜底解析（zh→zh-CN / en→en，其余回落基准语言）；
      // html lang 与内容同轮（读屏发音正确）
      const fallbackLocale = resolveLocale('system', navigator.language)
      useSettingsStore.setState({ systemLocale: navigator.language })
      applyDocumentLocale(fallbackLocale)
      root.render(
        <StrictMode>
          <BootErrorScreen error={bootError} />
        </StrictMode>,
      )
      void getCurrentWindow().show()
      return
    }
    // 非阻断失败（超时 / 读库失败等）：按协议回退默认偏好（light + indigo + zh-CN）启动
    useSettingsStore.getState().hydrateFromBoot(null, null)
  }

  // render 前同步挂主题与语言（防闪关键：不依赖 Provider 的 useEffect 时机）
  const state = useSettingsStore.getState()
  applyDocumentTheme(resolveTheme(state.theme.preference, state.systemTheme), state.theme.accent)
  applyDocumentLocale(resolveLocale(state.locale.preference, state.systemLocale))

  root.render(
    <StrictMode>
      <ThemeProvider>
        <UiTextBridge>
          <DevtoolsHotkeyGuard />
          <DevtoolsF12 />
          <App />
          {/* 关闭确认对话框：exit-flush 收到 ask 询问事件后经 store 请求，根挂载宿主 */}
          <CloseConfirmDialog />
          {/* 更新就绪确认对话框：服务层经 store 请求，根挂载宿主 */}
          <UpdateReadyDialog />
        </UiTextBridge>
      </ThemeProvider>
    </StrictMode>,
  )
  void getCurrentWindow().show()
  // 更新扫场：就绪包续接 / 完成提示优先，无则回落自动检查（开关闸门）
  scheduleStartupUpdateSweep()
}

/** 启动偏好装载（两窗 boot 共用段）：启动载荷＋系统主题 → Zod 解析灌
 * store（脏键回退默认并上报），成功顺带落 F12 原生加速键旗标。失败返回
 * IpcError（失败面处置归各窗：主窗分阻断/回落，快照窗一律空态），不做
 * 内嵌回退 */
async function hydrateBootPreferences(): Promise<IpcError | null> {
  try {
    const payload = await withTimeout(
      getBootSettings(),
      BOOT_SETTINGS_TIMEOUT_MS,
      'get_boot_settings',
    )
    const osTheme = await withTimeout(
      getCurrentWindow().theme(),
      OS_THEME_TIMEOUT_MS,
      'theme',
    ).catch(() => null)
    useSettingsStore.getState().hydrateFromBoot(payload, osTheme)
    // F12 原生加速键是否在场（窗口创建时的 devtools 初值，会话内恒定）
    setDevtoolsNative(payload.devtoolsNative)
    return null
  } catch (raw) {
    return toIpcError(raw)
  }
}

// 快照小窗 boot：防闪协议照旧（先载荷后 render、主题与语言 class 先挂），
// 但失败面全部按默认偏好渲染空态——阻断性错误屏对小窗无意义（无 DB 交互
// 场景可言），定格内容拉取与首帧显示由 SnapshotWindowApp 自理（拉取完成后
// 才 show——窗口隐藏创建，加载期闪烁链不可见）
async function bootSnapshotWindow(): Promise<void> {
  if ((await hydrateBootPreferences()) !== null) {
    useSettingsStore.getState().hydrateFromBoot(null, null)
  }

  // 主题跟随主窗（跨窗广播）：主窗 setter 写库时发射，灌 store 后
  // ThemeProvider 既有双动作线（html class / 原生标题栏）自动收口。页面级
  // 常驻订阅（随窗口销毁，无卸载清理面）；订阅失败仅损失跟随，不影响启动
  void listen<ThemeSetting>(THEME_CHANGED_EVENT, (event) => {
    useSettingsStore.setState({ theme: event.payload })
  }).catch(() => {
    /* 事件订阅失败静默 */
  })

  const state = useSettingsStore.getState()
  applyDocumentTheme(resolveTheme(state.theme.preference, state.systemTheme), state.theme.accent)
  applyDocumentLocale(resolveLocale(state.locale.preference, state.systemLocale))

  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <UiTextBridge>
            <SnapshotWindowApp />
          </UiTextBridge>
        </ThemeProvider>
      </QueryClientProvider>
    </StrictMode>,
  )
}

void boot()
