//! 接口树 IPC 命令：一条命令拉全树（服务 + 分类 + 接口 + 置顶标记）。

use tauri::State;

use crate::AppState;
use crate::error::AppError;
use crate::services::tree::{self, TreeDto};

/// tree.get：工作空间全树 DTO（api-tree selector 的唯一数据源）。
#[tauri::command(rename = "tree.get")]
pub async fn tree_get(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<TreeDto, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    tree::get_tree(&db.pool, &workspace_id).await
}
