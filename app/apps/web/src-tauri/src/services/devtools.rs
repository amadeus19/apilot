//! DevTools 门控服务：开发者开关是 F12 的唯一闸门。
//!
//! 实测结论（2026-09-28）：WebView2 的 F12 加速键只在 **webview 创建时**绑定
//! 一次——`SetAreDevToolsEnabled` 运行时切换（COM 调用成功）也不会复活/杀死
//! 加速键。因此门控落点是**创建值**：主窗口由 setup 手动创建（conf 里
//! `create = false`），`WebviewWindowBuilder::devtools()` 按 devMode 初值给出。
//!
//! 通道分工：
//! - F12：创建时开启 → WebView2 原生加速键（开/关切换完整）；创建时关闭 →
//!   加速键死，mid-session 开启后由前端 F12 → `internal_toggle_devtools` 打开
//!   （`OpenDevToolsWindow` 无视 AreDevToolsEnabled，见前端 DevtoolsF12）；
//! - Ctrl+Shift+I：tauri debug 注入脚本走 `internal_toggle_devtools`，关闭态
//!   由前端 DevtoolsHotkeyGuard 在捕获层拦截；
//! - `apply_enabled`（运行时 set_setting 触发）：尽力而为地切上下文菜单等
//!   UI 面，不承诺加速键行为；**关闭时额外关闭已打开的 DevTools
//!   窗口**（wry close_devtools 为空操作，只能 Win32 按标题定位本进程窗口发
//!   WM_CLOSE）。

use serde_json::Value;
use tauri::{AppHandle, Manager};

/// devMode 设置值（`{ enabled: bool }`，settings-schema 同源）→ 门控布尔。
/// 形态异常按关闭处理（门控默认从紧）。
pub fn enabled_from_value(value: &Value) -> bool {
    value
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// DevTools 窗口标题判定：WebView2 弹出的 DevTools 窗口标题为
/// `DevTools - <url>`（实证），前缀 `DevTools` 即命中。
/// 纯函数可单测；配合「仅当前进程」过滤避免误伤其他应用同名窗口。
fn is_devtools_title(title: &str) -> bool {
    title.starts_with("DevTools")
}

/// 关闭当前应用的 DevTools 窗口：EnumWindows 按标题前缀 +
/// 「本进程的 WebView2 子树进程」双条件过滤（**DevTools 窗口 HWND 属于
/// msedgewebview2.exe 子进程而非 app.exe**——实机验证发现的第一版按当前
/// PID 过滤永远 closed=0），命中后逐个发 WM_CLOSE。返回关闭数。
/// 无 DevTools 时返回 0（幂等安全）；失败仅记日志不传播（旁路效应语义）。
#[cfg(windows)]
pub fn close_devtools_windows() -> usize {
    use std::collections::HashSet;
    use std::sync::Mutex;

    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextW, GetWindowThreadProcessId, SendMessageW, WM_CLOSE,
    };

    /// 当前进程的 WebView2 进程子树（浏览器主进程及其后代）：DevTools 窗口
    /// 属于这棵树。进程树经 Toolhelp 快照 + 从 msedgewebview2.exe（父为当前
    /// 进程）起 BFS 后代构建。
    fn webview2_descendant_pids() -> HashSet<u32> {
        struct Entry {
            pid: u32,
            parent: u32,
            name: String,
        }
        let mut entries = Vec::new();
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            // INVALID_HANDLE_VALUE = -1
            if snapshot as isize == -1 {
                return HashSet::new();
            }
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                cntUsage: 0,
                th32ProcessID: 0,
                th32DefaultHeapID: 0,
                th32ModuleID: 0,
                cntThreads: 0,
                th32ParentProcessID: 0,
                pcPriClassBase: 0,
                dwFlags: 0,
                szExeFile: [0; 260],
            };
            if Process32FirstW(snapshot, &mut entry) != 0 {
                loop {
                    entries.push(Entry {
                        pid: entry.th32ProcessID,
                        parent: entry.th32ParentProcessID,
                        name: String::from_utf16_lossy(
                            &entry.szExeFile
                                [..entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(0)],
                        ),
                    });
                    if Process32NextW(snapshot, &mut entry) == 0 {
                        break;
                    }
                }
            }
            windows_sys::Win32::Foundation::CloseHandle(snapshot);
        }
        let me = unsafe { GetCurrentProcessId() };
        let mut result: HashSet<u32> = HashSet::new();
        let mut queue: Vec<u32> = entries
            .iter()
            .filter(|e| e.parent == me && e.name.eq_ignore_ascii_case("msedgewebview2.exe"))
            .map(|e| e.pid)
            .collect();
        while let Some(pid) = queue.pop() {
            if result.insert(pid) {
                queue.extend(entries.iter().filter(|e| e.parent == pid).map(|e| e.pid));
            }
        }
        result
    }

    // 回调与调用方通过模块级缓冲传递（HWND 为裸指针非 Send，以 isize 存地址；
    // 归属集合随调用注入）——单调用点串行使用，锁仅防并发重入
    static FOUND: Mutex<Vec<isize>> = Mutex::new(Vec::new());

    unsafe extern "system" fn enum_callback(hwnd: HWND, _lparam: isize) -> i32 {
        unsafe {
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            let mut buf = [0u16; 256];
            let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) as usize;
            let title = String::from_utf16_lossy(&buf[..len.min(buf.len())]);
            if is_devtools_title(&title)
                && let Ok(mut guard) = FOUND.lock()
            {
                guard.push(hwnd as isize);
            }
        }
        1 // 恒继续枚举
    }

    let related = webview2_descendant_pids();
    tracing::info!(related = related.len(), "devtools close scan start");

    FOUND
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clear();
    unsafe { EnumWindows(Some(enum_callback), 0isize) };
    let targets = std::mem::take(
        &mut *FOUND
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
    );
    let mut closed = 0;
    for hwnd_addr in targets {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd_addr as HWND, &mut pid) };
        if !related.contains(&pid) {
            continue; // 其他应用的 DevTools 窗口不触碰
        }
        // WM_CLOSE 触发 DevTools 窗口自身的关闭流程（与点 ✕ 等价）
        unsafe { SendMessageW(hwnd_addr as HWND, WM_CLOSE, 0usize, 0isize) };
        closed += 1;
    }
    tracing::info!(closed, "devtools windows close requested");
    closed
}

/// 将开发者开关同步到 WebView2。窗口缺失 / 派发失败只记日志不传播：
/// 调试通道不可用不影响应用主功能（与 logLevel 热更同级的旁路效应）。
pub fn apply_enabled(app: &AppHandle, enabled: bool) {
    // 关闭 = 摘 UI 面 + 关闭已打开的 DevTools 窗口
    if !enabled {
        #[cfg(windows)]
        close_devtools_windows();
    }
    let Some(window) = app.get_webview_window("main") else {
        tracing::warn!("devtools gate skipped: main window not found");
        return;
    };
    let result = window.with_webview(move |webview| {
        // webview2-com 的接口方法为 unsafe COM 调用；with_webview 保证闭包
        // 在主线程执行，满足 WebView2 COM 的线程亲和要求
        let controller = webview.controller();
        if let Ok(core) = unsafe { controller.CoreWebView2() } {
            match unsafe { core.Settings() } {
                Ok(settings) => {
                    let applied = unsafe { settings.SetAreDevToolsEnabled(enabled) };
                    tracing::info!(enabled, ok = applied.is_ok(), "devtools gate apply");
                }
                Err(err) => tracing::warn!(error = %err, "webview settings unavailable"),
            }
        } else {
            tracing::warn!("webview core unavailable for devtools gate");
        }
    });
    if let Err(err) = result {
        tracing::warn!(error = %err, "devtools gate dispatch failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devtools_title_prefix_matches() {
        assert!(is_devtools_title("DevTools - http://localhost:5173/"));
        assert!(is_devtools_title("DevTools"));
        // 前缀匹配语义：任何以 DevTools 开头的本进程窗口都算命中
        assert!(is_devtools_title("DevToolsX"));
        assert!(!is_devtools_title("APilot"));
        // 前缀之外的「我的 DevTools 笔记」类窗口不命中
        assert!(!is_devtools_title("我的 DevTools 笔记"));
    }

    #[cfg(windows)]
    #[test]
    fn close_devtools_windows_is_idempotent_without_devtools() {
        // 无 DevTools 打开时返回 0（不 panic 即幂等）
        assert_eq!(close_devtools_windows(), 0);
    }
}
