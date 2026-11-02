//! 备份 IPC 命令：手动导出 / 恢复的一次性动作薄壳（非长任务，不进
//! TaskRegistry）。路径由前端系统对话框选定后传入，不落设置。

use serde::Serialize;
use tauri::State;

use crate::AppState;
use crate::error::AppError;
use crate::services::backup;

/// 导出结果 DTO：产物字节数（落盘路径调用方已知，不回带）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupExportResultDto {
    pub size_bytes: u64,
}

/// 恢复受理结果 DTO：暂存与标记已落盘，待重启生效。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRestoreResultDto {
    pub requires_restart: bool,
}

/// backup_export：导出一致性单库副本（易失三表清空）为单条目 zip。
#[tauri::command]
pub async fn backup_export(
    state: State<'_, AppState>,
    path: String,
) -> Result<BackupExportResultDto, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    let size_bytes = backup::export(&db.pool, std::path::Path::new(&path)).await?;
    Ok(BackupExportResultDto { size_bytes })
}

/// backup_validate：恢复预检——只校验所选备份包、无任何持久副作用；
/// 两段式确认的前段（确认后才执行 backup_restore 落盘暂存）。
#[tauri::command]
pub async fn backup_validate(state: State<'_, AppState>, path: String) -> Result<(), AppError> {
    backup::validate(std::path::Path::new(&path), &state.data_dir).await
}

/// backup_restore：校验所选备份包并把暂存库＋标记落盘；重启后启动序列
/// 在开库前原子替换。
#[tauri::command]
pub async fn backup_restore(
    state: State<'_, AppState>,
    path: String,
) -> Result<BackupRestoreResultDto, AppError> {
    backup::restore(std::path::Path::new(&path), &state.data_dir).await?;
    Ok(BackupRestoreResultDto {
        requires_restart: true,
    })
}
