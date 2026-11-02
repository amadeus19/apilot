//! 分类域 IPC 命令（category.*）：新建 / 重命名 / 删除（接口上移散层）/ 移动。

use tauri::State;

use crate::AppState;
use crate::domain::service::MoveDirection;
use crate::error::AppError;
use crate::services::category::{self, CategoryDto};

/// category.create：服务下新建分类（名称）。
#[tauri::command(rename = "category.create")]
pub async fn category_create(
    state: State<'_, AppState>,
    service_id: String,
    name: String,
) -> Result<CategoryDto, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    category::create(&db.pool, &service_id, &name).await
}

/// category.rename：重命名分类。
#[tauri::command(rename = "category.rename")]
pub async fn category_rename(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<CategoryDto, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    category::rename(&db.pool, &id, &name).await
}

/// category.delete：删除分类（其下接口上移散层）。
#[tauri::command(rename = "category.delete")]
pub async fn category_delete(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    category::delete(&db.pool, &id).await
}

/// category.move：相邻交换排序（上移 / 下移）。
#[tauri::command(rename = "category.move")]
pub async fn category_move(
    state: State<'_, AppState>,
    id: String,
    direction: MoveDirection,
) -> Result<(), AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    category::move_category(&db.pool, &id, direction).await
}

/// category.move_to：移动分类到目标服务分类序列的目标位置（拖拽排序通道，
/// 支持跨服务；index 为摘除自身后的插入位，越界钳制到末尾）。
#[tauri::command(rename = "category.move_to")]
pub async fn category_move_to(
    state: State<'_, AppState>,
    id: String,
    target_service_id: String,
    index: i64,
) -> Result<(), AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    category::move_category_to(&db.pool, &id, &target_service_id, index).await
}
