//! settings IPC 命令：
//! - `get_boot_settings`：启动批量读（缓存直出）+ 系统语言注入
//! - `set_setting`：单键写（白名单 + 长度上限，见 services/settings.rs）

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::AppState;
use crate::error::AppError;

/// 启动载荷：settings 全量 + 系统语言
/// + 主窗口创建时的 devtools 初值（F12 原生加速键是否在场）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootSettings {
    pub settings: HashMap<String, Value>,
    pub system_locale: Option<String>,
    pub devtools_native: bool,
}

#[tauri::command]
pub async fn get_boot_settings(state: State<'_, AppState>) -> Result<BootSettings, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    Ok(BootSettings {
        settings: db.cache.snapshot(),
        system_locale: tauri_plugin_os::locale(),
        devtools_native: state.devtools_native,
    })
}

#[tauri::command]
pub async fn set_setting(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    key: String,
    value: Value,
) -> Result<(), AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    // 生效编排收口在 settings 服务（键注册表单点）；Command 层只做宿主装配与转发
    let host = crate::services::settings::AppHost::new(&app);
    crate::services::settings::set(&host, &db.pool, &db.cache, &key, value).await
}
