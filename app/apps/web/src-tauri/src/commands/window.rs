//! 快照窗 IPC 命令：定格快照的暂存 + 建窗 / 复用聚焦，与暂存读取。
//! 业务逻辑在 services/snapshot_window（建窗编排与生命周期注释同源）。

use tauri::State;

use crate::error::AppError;
use crate::services::snapshot_window::ResponseSnapshotPayload;
use crate::AppState;

/// 暂存 payload 并打开快照窗（已有同 label 窗时替换暂存并聚焦，不重建）。
/// payload 形态在反序列化层收口：字段缺失 / 类型错 / contentType 非法值
/// 直接失败，不进业务层。
///
/// 必须是 async command：同步 command 在主线程执行，而 Windows 上
/// `WebviewWindowBuilder::build` 的 WebView2 初始化需要主线程事件循环
/// 转消息——主线程被占住即死锁（窗半残弹出＋应用无响应）。async command
/// 在线程池执行，build 内部转发主线程完成初始化。
#[tauri::command]
pub async fn open_response_snapshot(
    app: tauri::AppHandle,
    payload: ResponseSnapshotPayload,
) -> Result<(), AppError> {
    crate::services::snapshot_window::open(&app, payload)
}

/// 读取最近一次暂存的快照 payload（未 open 过返回 null）。
#[tauri::command]
pub fn get_response_snapshot(
    state: State<'_, AppState>,
) -> Result<Option<ResponseSnapshotPayload>, AppError> {
    Ok(crate::services::snapshot_window::current_payload(
        &state.response_snapshot,
    ))
}
