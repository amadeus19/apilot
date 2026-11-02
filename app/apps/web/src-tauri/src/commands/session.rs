//! 会话域 IPC 命令（session.*）：工作现场（Tab + 树展开）的保存与恢复。

use serde::Deserialize;
use tauri::State;

use crate::AppState;
use crate::error::AppError;
use crate::services::session::{self, SessionDto};

/// session.get：恢复会话（被删服务的残留 Tab 在此按存在性过滤）。
#[tauri::command(rename = "session.get")]
pub async fn session_get(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<Option<SessionDto>, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    session::get(&db.pool, &workspace_id).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSaveArgs {
    pub workspace_id: String,
    /// 前端组装的 Tab 会话 JSON 字符串
    pub tabs: String,
    /// 树展开节点 id 数组的 JSON 字符串
    pub tree_expanded: String,
}

/// session.save：整包保存（关/切 Tab、切换空间、退出时写）。
#[tauri::command(rename = "session.save")]
pub async fn session_save(
    state: State<'_, AppState>,
    args: SessionSaveArgs,
) -> Result<(), AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    session::save(
        &db.pool,
        &args.workspace_id,
        &args.tabs,
        &args.tree_expanded,
    )
    .await
}
