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
/// 暂存为待安装请求，并经退出闸门进入完整退出序列——安装器由退出序列
/// 末尾 spawn（应用完全释放文件锁之后，见 lib.rs begin_exit）。
///
/// 装更新必然走完整退出序列，此为不变量；旁路关窗决策层（closeBehavior
/// 三分派）落实：
/// - 不借 `window.close()`：会触发 CloseRequested 走三分派，tray 设置下
///   窗口被隐藏、更新永不安装；
/// - 不 emit `app://close-requested` 询问事件：该事件语义＝询问用户（仅
///   ask 分支），前端将弹出关闭确认弹窗，而弹窗决策无法改变「必然退出
///   装更新」的结局（选「最小化到托盘」会被超时退出覆盖，语义自相矛盾），
///   且装更新意向已在就绪对话框确认过；
/// - 与 exit 分支共用退出闸门入口（lib.rs exit_via_gate）：本命令成功
///   返回后前端全量收尾（会话保存 + 草稿 flush）并 ack（app.ready_to_exit），
///   退出序列立即进入；前端不可达时闸门超时兜底放行。
#[tauri::command]
pub fn install_update(
    app: AppHandle,
    state: State<'_, AppState>,
    version: String,
) -> Result<(), AppError> {
    let staged = crate::services::update_source::StagedUpdate::from_version(&version)?;
    staged.verify_launchable()?;
    *state
        .install_request
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(staged);
    // 校验失败在此前 return；暂存后无中途失败路径（闸门 arm / spawn 不可
    // 失败），无需回滚意向
    crate::exit_via_gate(app, "update_install");
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

/// app.confirm_exit：关闭确认弹窗「退出应用」路径（前端 flush 完成后调用，
/// ask 分支用户决策的放行出口）。Command 层只做转发，放行序列见 lib.rs
/// confirm_exit_now。
#[tauri::command(rename = "app.confirm_exit")]
pub fn app_confirm_exit(app: AppHandle) {
    crate::confirm_exit_now(app);
}

/// app.hide_to_tray：关闭确认弹窗「最小化到托盘」路径（ask 分支用户决策）。
/// Command 层只做转发与错误转换，窗口操作见 tray::hide_main_window。
#[tauri::command(rename = "app.hide_to_tray")]
pub fn app_hide_to_tray(app: AppHandle) -> Result<(), AppError> {
    crate::tray::hide_main_window(&app)
}
