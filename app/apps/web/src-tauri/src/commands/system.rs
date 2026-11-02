//! 系统能力命令：文件系统 / 桌面集成能力的收口面（架构铁律：前端不直接
//! 执行系统能力，一切经由明确的 Tauri IPC API）。业务逻辑在 Service 层。

use serde_json::Value;
use tauri::{AppHandle, State};

use crate::AppState;
use crate::error::AppError;

/// 打开日志目录：Rust 侧 canonicalize 后直调 opener 插件，
/// 绕开前端 ACL 对 Windows 路径形态的 scope 匹配不确定性。
#[tauri::command]
pub fn open_log_dir(app: AppHandle) -> Result<(), AppError> {
    use tauri::Manager;

    let dir = app
        .path()
        .app_log_dir()
        .map_err(|err| AppError::internal(format!("app log dir unavailable: {err}")))?;
    crate::services::log_dir::open(&dir)
}

/// 更新源保存前可达性校验：本机 / UNC 路径存在且为目录；
/// UNC 阻塞由服务层 spawn_blocking + 超时兜底。
#[tauri::command]
pub async fn check_update_source(path: String) -> Result<(), AppError> {
    crate::services::update_source::check_reachable(&path).await
}

/// 检查更新：读 `updateSource` 设置指向的清单（本机文件夹 / 云端
/// GitHub Release，按 `kind` 分流）并与当前版本比较，按状态返回
/// （not_configured / unreachable / invalid_manifest / up_to_date /
/// newer_available / downgrade_available）。只读清单不下载。
#[tauri::command]
pub async fn check_updates(state: State<'_, AppState>) -> Result<Value, AppError> {
    let update_source = state
        .db
        .as_ref()
        .ok()
        .and_then(|db| db.cache.snapshot().get("updateSource").cloned());
    let result = crate::services::update_source::check_for_update(update_source.as_ref()).await?;
    serde_json::to_value(result)
        .map_err(|err| AppError::internal(format!("serialize check result: {err}")))
}

/// 下载更新包（两段式之一）：按 `kind` 分流——本机源复制清单 `file`，
/// 云端源经 HTTPS 拉取（镜像前缀同套）；两者统一做 sha256 / minisign
/// 签名校验，全过返回暂存信息；任一失败拒绝安装。
#[tauri::command]
pub async fn download_update(state: State<'_, AppState>) -> Result<Value, AppError> {
    let update_source = state
        .db
        .as_ref()
        .ok()
        .and_then(|db| db.cache.snapshot().get("updateSource").cloned());
    let result = crate::services::update_source::download_update(update_source.as_ref()).await?;
    serde_json::to_value(result)
        .map_err(|err| AppError::internal(format!("serialize prepared update: {err}")))
}

/// 启动静默安装器（两段式之二）：以版本号重构暂存包（IPC 不接受路径——
/// StagedUpdate 构造即校验，任意路径无法进入执行面），通过存在性校验后
/// 暂存为待安装请求并触发关窗——安装器由退出序列末尾 spawn（应用完全
/// 释放文件锁之后，见 lib.rs shutdown_and_exit），不再由前端盲等关窗。
#[tauri::command]
pub fn install_update(
    app: AppHandle,
    state: State<'_, AppState>,
    version: String,
) -> Result<(), AppError> {
    use tauri::Manager;

    let staged = crate::services::update_source::StagedUpdate::from_version(&version)?;
    staged.verify_launchable()?;
    *state
        .install_request
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(staged);
    // 关窗失败必须回滚意向（资源四问：取消 / 失败路径）——残留的请求会让
    // 此后任意一次正常退出在 shutdown 末尾意外 spawn 安装器
    let closed = (|| {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| AppError::internal("main window not available for update close"))?;
        window
            .close()
            .map_err(|err| AppError::internal(format!("failed to close window for update: {err}")))
    })();
    if let Err(err) = closed {
        *state
            .install_request
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        return Err(err);
    }
    Ok(())
}

/// 扫描临时目录就绪包：ready = 上次「稍后」留下的可安装包（boot
/// 续接弹确认对话框）；finished = 版本等于当前的残留（覆盖安装完成标志）。
/// 只读扫描（陈旧残留与 .part 中态残留顺手清理），不触碰更新源配置。
#[tauri::command]
pub fn list_staged_updates() -> Result<Value, AppError> {
    let result = crate::services::update_source::list_staged_updates();
    serde_json::to_value(result)
        .map_err(|err| AppError::internal(format!("serialize staged updates: {err}")))
}

/// 删除指定就绪包（完成提示后调用）：以版本号重构暂存包（路径不越过
/// IPC 边界），文件不存在幂等成功。
#[tauri::command]
pub fn discard_staged_update(version: String) -> Result<(), AppError> {
    crate::services::update_source::discard_staged_update(&version)
}

/// app.ready_to_exit：前端收尾完成（会话保存 + 草稿 flush），放行退出。
/// 前端不可达时由退出闸门超时兜底（见 services/exit_gate）。
#[tauri::command(rename = "app.ready_to_exit")]
pub async fn app_ready_to_exit(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    state.exit_gate.ack();
    Ok(())
}
