import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { getCurrentWindow } from '@tauri-apps/api/window'

import '@workspace/ui/globals.css'
import { App } from './App.tsx'
import { BootErrorScreen } from './components/common/BootErrorScreen.tsx'
import { UpdateReadyDialog } from './features/update'
import { ThemeProvider, UiTextBridge, DevtoolsF12, DevtoolsHotkeyGuard } from './app/providers.tsx'
import { setDevtoolsNative } from './services/devtools-flag.ts'
import { scheduleStartupUpdateSweep } from './services/update-check.ts'
import { applyDocumentLocale, applyDocumentTheme } from './lib/document-theme.ts'
import { resolveLocale, resolveTheme } from './lib/settings-schema.ts'
import { useSettingsStore } from './stores/settings.store.ts'
import { getBootSettings, isBlockingCode, toIpcError } from './services/ipc.ts'
import { withTimeout } from './lib/async.ts'

// 启动载荷读取超时：本地 SQLite 读为毫秒级，3s 已属异常，按协议回退默认偏好
const BOOT_SETTINGS_TIMEOUT_MS = 3000
// 系统主题（原生窗口）查询超时：失败回退 light（resolveTheme 兜底）
const OS_THEME_TIMEOUT_MS = 1000

const root = createRoot(document.getElementById('root')!)

// boot（防闪协议）：
// 1) render 前 await 启动载荷 + 系统主题；2) Zod 解析灌 store（脏键回退默认并上报）；
// 3) 挂 .dark / data-accent / html lang；4) render；5) show()。
// 阻断性错误（DB_CORRUPTED）→ 全屏错误呈现；其余失败 → 回退默认偏好启动，不阻塞。
async function boot(): Promise<void> {
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
    // F12 原生加速键是否在场（主窗口创建时的 devtools 初值，会话内恒定）
    setDevtoolsNative(payload.devtoolsNative)
  } catch (raw) {
    const error = toIpcError(raw)
    if (isBlockingCode(error.code)) {
      // 库不可用读不到语言偏好：以系统语言兜底解析（zh→zh-CN / en→en，其余回落基准语言）；
      // html lang 与内容同轮（读屏发音正确）
      const fallbackLocale = resolveLocale('system', navigator.language)
      useSettingsStore.setState({ systemLocale: navigator.language })
      applyDocumentLocale(fallbackLocale)
      root.render(
        <StrictMode>
          <BootErrorScreen error={error} />
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

void boot()
