//! 系统托盘：构建、菜单与单击行为（tauri `tray-icon` feature）。
//!
//! 资源所有权：托盘与菜单由 AppHandle 持有、随进程退出释放；Explorer
//! 重启导致的托盘图标丢失接受现状（自动重建需要额外的进程间监听，超出
//! 当前范围），应用仍在运行，经二次启动唤起或任务管理器结束。
//!
//! 菜单文案：Rust 无 i18n 字典，中英字面量收敛在本模块常量区（单一常量
//! 模块），按设置 `locale` 键归档取舍；托盘在 setup 一次构建，文案随
//! 启动时设置固化，运行期改语言不重建菜单（热更需整体重建托盘，收益
//! 不抵复杂度）。

use tauri::AppHandle;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

use crate::error::AppError;

// —— 菜单文案字面量（收敛单点）——
// `locale.preference == "en"` → 英文；`zh-CN` / `system` / 缺失 / 脏值 → 中文。
// system 态不做 OS locale 探测（前端按 OS 归档，Rust 侧统一中文）：英文用户
// 通常显式选择 en，为托盘两个菜单项引入 OS 探测不值得。

const SHOW_LABEL_ZH: &str = "显示 APilot";
const SHOW_LABEL_EN: &str = "Show APilot";
const QUIT_LABEL_ZH: &str = "退出";
const QUIT_LABEL_EN: &str = "Quit";

/// 托盘 tooltip（产品名，不随语言切换）
const TRAY_TOOLTIP: &str = "APilot";

/// 菜单项 id（事件分发键）
const MENU_ID_SHOW: &str = "show";
const MENU_ID_QUIT: &str = "quit";

/// 菜单文案归档（纯函数，可测）：返回（显示、退出）两标签。
fn labels_for(preference: Option<&str>) -> (&'static str, &'static str) {
    match preference {
        Some("en") => (SHOW_LABEL_EN, QUIT_LABEL_EN),
        _ => (SHOW_LABEL_ZH, QUIT_LABEL_ZH),
    }
}

/// 构建系统托盘（setup 末尾调用一次）。构建失败留痕不阻断启动：托盘是
/// 增强能力，主窗口交互不依赖它；失败态下「最小化到托盘」行为仍可用
/// （隐藏后经二次启动唤起，single-instance 回调不依赖托盘）。
pub fn build_tray(app: &AppHandle) {
    if let Err(err) = build_tray_inner(app) {
        tracing::warn!(error = %err, "tray build failed, continuing without tray icon");
    }
}

fn build_tray_inner(app: &AppHandle) -> tauri::Result<()> {
    let (show_label, quit_label) = menu_labels(app);
    let show = MenuItem::with_id(app, MENU_ID_SHOW, show_label, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_ID_QUIT, quit_label, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip(TRAY_TOOLTIP)
        .menu(&menu)
        // 左键单击＝唤起主窗口，菜单仅右键弹出（Windows 默认左键也弹菜单，须显式关）
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            MENU_ID_SHOW => show_main_window(app),
            MENU_ID_QUIT => {
                // 完整退出序列（任务排空 + 响应临时文件清理 + 待装更新 +
                // cleanup），不裸 app.exit——与关窗决策层同一出口
                let app = app.clone();
                tauri::async_runtime::spawn(async move { crate::begin_exit(app).await });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击（按松开计数）：show + unminimize + set_focus——最小化
            // 与隐藏两态统一唤起
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    // 图标取应用默认窗口图标；缺失（配置异常）时交由系统默认图，不阻断托盘
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

/// 从设置缓存归档菜单文案（构建时固化）。DB 不可用 / 键缺失按中文回退。
fn menu_labels(app: &AppHandle) -> (&'static str, &'static str) {
    use tauri::Manager;

    let value = {
        let state: tauri::State<crate::AppState> = app.state();
        state
            .db
            .as_ref()
            .ok()
            .and_then(|db| db.cache.get(crate::services::settings::LOCALE_KEY))
    };
    let preference = value
        .as_ref()
        .and_then(|value| value.get("preference"))
        .and_then(|p| p.as_str())
        .map(str::to_owned);
    labels_for(preference.as_deref())
}

/// 主窗口唤起（托盘左键单击与 single-instance 二次启动回调共用）：
/// show + unminimize + set_focus，最小化 / 隐藏两态统一唤起。
pub fn show_main_window(app: &AppHandle) {
    use tauri::Manager;

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 主窗口隐藏（tray 分支与 `app.hide_to_tray` 命令共用单点）：Rust 侧
/// API 操作窗口，不开前端 capability。
pub fn hide_main_window(app: &AppHandle) -> Result<(), AppError> {
    use tauri::Manager;

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::internal("main window not available for hide"))?;
    window
        .hide()
        .map_err(|err| AppError::internal(format!("failed to hide main window: {err}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_labels_follow_locale_preference() {
        // en → 英文；zh-CN / system / 缺失 / 脏值 → 中文（回退口径与前端一致）
        assert_eq!(labels_for(Some("en")), (SHOW_LABEL_EN, QUIT_LABEL_EN));
        assert_eq!(labels_for(Some("zh-CN")), (SHOW_LABEL_ZH, QUIT_LABEL_ZH));
        assert_eq!(labels_for(Some("system")), (SHOW_LABEL_ZH, QUIT_LABEL_ZH));
        assert_eq!(labels_for(None), (SHOW_LABEL_ZH, QUIT_LABEL_ZH));
        assert_eq!(labels_for(Some("bogus")), (SHOW_LABEL_ZH, QUIT_LABEL_ZH));
    }
}
