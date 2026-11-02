//! 服务域 IPC 命令（service.*）：清单 / 新建 / 更新 / 删除 / 相邻移动 /
//! 拖拽排序通道 / 批量导入（Swashbuckle 入口页发现 + 批量建服务）。

use serde::Deserialize;
use tauri::State;

use crate::AppState;
use crate::domain::service::MoveDirection;
use crate::error::AppError;
use crate::services::service::{self, ServiceDto};
use crate::services::service_import::{self, ImportDiscoverDto, ImportServiceInput};

/// service.list_by_workspace：工作空间内服务清单（排序序）。
#[tauri::command(rename = "service.list_by_workspace")]
pub async fn service_list_by_workspace(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<ServiceDto>, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    service::list_by_workspace(&db.pool, &workspace_id).await
}

/// service.create：名称 + 可选文档地址（NULL＝纯手工容器）。文档地址建立
/// 后联动重探：芯片状态经 `probe://status` 事件回流，不等下一次刷新。
#[tauri::command(rename = "service.create")]
pub async fn service_create(
    state: State<'_, AppState>,
    workspace_id: String,
    name: String,
    doc_url: Option<String>,
) -> Result<ServiceDto, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    let created = service::create(&db.pool, &workspace_id, &name, doc_url.as_deref()).await?;
    state
        .probe
        .refresh_in_background(&state.tasks, &db.pool, &created.id);
    Ok(created)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceUpdateArgs {
    pub id: String,
    pub name: String,
    pub doc_url: Option<String>,
}

/// service.update：名称 + 可选文档地址（补地址＝编辑即完成，探测与同步归
/// 同步域）。文档地址变更后联动重探（同 create）。
#[tauri::command(rename = "service.update")]
pub async fn service_update(
    state: State<'_, AppState>,
    args: ServiceUpdateArgs,
) -> Result<ServiceDto, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    let updated = service::update(&db.pool, &args.id, &args.name, args.doc_url.as_deref()).await?;
    state
        .probe
        .refresh_in_background(&state.tasks, &db.pool, &updated.id);
    Ok(updated)
}

/// service.delete：级联删除（分类 + 接口 + 用户数据 + 置顶）。
#[tauri::command(rename = "service.delete")]
pub async fn service_delete(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    service::delete(&db.pool, &id).await
}

/// service.move：相邻交换排序（上移 / 下移）。
#[tauri::command(rename = "service.move")]
pub async fn service_move(
    state: State<'_, AppState>,
    id: String,
    direction: MoveDirection,
) -> Result<(), AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    service::move_service(&db.pool, &id, direction).await
}

/// service.move_to：移动服务到工作空间服务序列的目标位置（拖拽排序通道；
/// index 为摘除自身后的插入位，越界钳制到末尾）。
#[tauri::command(rename = "service.move_to")]
pub async fn service_move_to(
    state: State<'_, AppState>,
    id: String,
    index: i64,
) -> Result<(), AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    service::move_service_to(&db.pool, &id, index).await
}

/// service.import_discover：拉取 Swashbuckle 入口页并解析分组清单
/// （分组名 + 文档绝对地址；只发现不建服务，勾选落库走 import_create）。
#[tauri::command(rename = "service.import_discover")]
pub async fn service_import_discover(
    state: State<'_, AppState>,
    workspace_id: String,
    entry_url: String,
) -> Result<ImportDiscoverDto, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    service_import::discover(&db.pool, &workspace_id, &entry_url).await
}

/// service.import_create：勾选分组批量建服务（必有文档地址；重名自动
/// 追加序号；单事务全成或全败）。
#[tauri::command(rename = "service.import_create")]
pub async fn service_import_create(
    state: State<'_, AppState>,
    workspace_id: String,
    services: Vec<ImportServiceInput>,
) -> Result<Vec<ServiceDto>, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    service_import::import_create(&db.pool, &workspace_id, services).await
}
