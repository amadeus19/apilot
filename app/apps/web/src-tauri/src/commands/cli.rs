//! CLI IPC 命令（设置「开发者 › 高级」）：PATH 注册 / 注销与状态探测。
//! 专门命令不走 `set_setting`——注册 / 注销是系统级副作用编排（注册表＋
//! 广播），开关显示态由 `get_cli_status` 的注册态镜像，settings 不持副本。

use crate::error::AppError;
use crate::services::cli::CliStatus;

/// 拨开弹窗 [注册]：本安装目录写入用户 PATH。失败 AppError 透传给弹窗原位
/// 停留＋[重试]；成功后前端失效重取 `get_cli_status`。
#[tauri::command]
pub async fn register_cli_path() -> Result<(), AppError> {
    crate::services::cli::register()
}

/// 拨关静默注销：从用户 PATH 移除本安装目录。失败 AppError 透传给 toast，
/// 开关随重取的注册态回弹。
#[tauri::command]
pub async fn unregister_cli_path() -> Result<(), AppError> {
    crate::services::cli::unregister()
}

/// 聚合探测：版本 / 路径 / 注册态 / 命令解析。打开设置对话框时查询一次，
/// 注册 / 注销后失效重取；版本探测至多 3 秒。
#[tauri::command]
pub async fn get_cli_status() -> Result<CliStatus, AppError> {
    crate::services::cli::status().await
}
