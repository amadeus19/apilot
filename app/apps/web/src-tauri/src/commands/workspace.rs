//! 工作空间 IPC 命令（点分域前缀）：清单含 current 标记、
//! 新建 / 更新 / 删除 / 切换，业务编排全部在 services 层。

use serde::Deserialize;
use tauri::State;

use crate::AppState;
use crate::error::AppError;
use crate::services::settings::AppHost;
use crate::services::workspace::{self, WorkspaceListDto};

/// workspace.list：清单 + current 标记。
#[tauri::command(rename = "workspace.list")]
pub async fn workspace_list(state: State<'_, AppState>) -> Result<WorkspaceListDto, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    workspace::list(&db.pool, &db.cache).await
}

/// workspace.create：新建工作空间（不自动切换）。可选 base_url / auth
/// 携带创建默认值（GUI 产品预置；缺省＝不设），一次 IPC 落库。
#[tauri::command(rename = "workspace.create")]
pub async fn workspace_create(
    state: State<'_, AppState>,
    name: String,
    base_url: Option<String>,
    auth: Option<String>,
) -> Result<WorkspaceListDto, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    workspace::create(
        &db.pool,
        &db.cache,
        &name,
        base_url.as_deref(),
        auth.as_deref(),
    )
    .await?;
    workspace::list(&db.pool, &db.cache).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRenameArgs {
    pub id: String,
    pub name: String,
    /// 空串＝清空 BaseUrl
    pub base_url: Option<String>,
}

/// workspace.rename：名称与 BaseUrl 整行更新（工作空间设置页）。
#[tauri::command(rename = "workspace.rename")]
pub async fn workspace_rename(
    state: State<'_, AppState>,
    args: WorkspaceRenameArgs,
) -> Result<WorkspaceListDto, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    workspace::rename(
        &db.pool,
        &db.cache,
        &args.id,
        &args.name,
        args.base_url.as_deref(),
    )
    .await?;
    workspace::list(&db.pool, &db.cache).await
}

/// workspace.reorder：工作空间整批重排（拖拽放落落库；有序 id 表须与现有
/// 集合完全一致），返回刷新清单。
#[tauri::command(rename = "workspace.reorder")]
pub async fn workspace_reorder(
    state: State<'_, AppState>,
    ordered_ids: Vec<String>,
) -> Result<WorkspaceListDto, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    workspace::reorder(&db.pool, &db.cache, ordered_ids).await
}

/// workspace.delete：级联删除；删当前空间自动切换（无剩余则 seeding 重建）。
#[tauri::command(rename = "workspace.delete")]
pub async fn workspace_delete(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    id: String,
) -> Result<WorkspaceListDto, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    let host = AppHost::new(&app);
    workspace::delete(&host, &db.pool, &db.cache, &id).await?;
    workspace::list(&db.pool, &db.cache).await
}

/// workspace.set_current：切换当前工作空间（前端随后失效并重拉新空间数据）。
#[tauri::command(rename = "workspace.set_current")]
pub async fn workspace_set_current(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    let host = AppHost::new(&app);
    workspace::set_current(&host, &db.pool, &db.cache, &id).await
}

/// workspace.set_auth：更新工作空间级认证配置（认证继承链根；null＝清除）。
#[tauri::command(rename = "workspace.set_auth")]
pub async fn workspace_set_auth(
    state: State<'_, AppState>,
    id: String,
    auth: Option<String>,
) -> Result<crate::services::workspace::WorkspaceDto, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    workspace::set_auth(&db.pool, &db.cache, &id, auth.as_deref()).await
}
