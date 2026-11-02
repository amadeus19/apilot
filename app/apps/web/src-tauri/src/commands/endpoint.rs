//! 手工接口域 IPC 命令（endpoint.*）：新建 / 编辑（UUID 不变）/ 硬删除 / 置顶。

use serde::Deserialize;
use tauri::State;

use crate::AppState;
use crate::error::AppError;
use crate::services::endpoint::{self, EndpointDto};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualEndpointArgs {
    pub service_id: String,
    pub method: String,
    pub path_template: String,
    pub title: String,
    pub category_id: Option<String>,
}

/// endpoint.create_manual：新建手工接口（身份＝服务端生成的 UUID）。
#[tauri::command(rename = "endpoint.create_manual")]
pub async fn endpoint_create_manual(
    state: State<'_, AppState>,
    args: ManualEndpointArgs,
) -> Result<EndpointDto, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    endpoint::create_manual(
        &db.pool,
        &args.service_id,
        &args.method,
        &args.path_template,
        &args.title,
        args.category_id.as_deref(),
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualEndpointUpdateArgs {
    pub service_id: String,
    pub key: String,
    pub method: String,
    pub path_template: String,
    pub title: String,
    pub category_id: Option<String>,
}

/// endpoint.update_manual：编辑结构字段（标题 / 方法 / 路径 / 分类），UUID 不变。
#[tauri::command(rename = "endpoint.update_manual")]
pub async fn endpoint_update_manual(
    state: State<'_, AppState>,
    args: ManualEndpointUpdateArgs,
) -> Result<EndpointDto, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    endpoint::update_manual(
        &db.pool,
        &args.service_id,
        &args.key,
        &args.method,
        &args.path_template,
        &args.title,
        args.category_id.as_deref(),
    )
    .await
}

/// endpoint.delete：硬删除（连带用户数据与置顶，同事务）。
#[tauri::command(rename = "endpoint.delete")]
pub async fn endpoint_delete(
    state: State<'_, AppState>,
    service_id: String,
    key: String,
) -> Result<(), AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    endpoint::delete(&db.pool, &service_id, &key).await
}

/// endpoint.set_pinned：置顶开关。
#[tauri::command(rename = "endpoint.set_pinned")]
pub async fn endpoint_set_pinned(
    state: State<'_, AppState>,
    service_id: String,
    key: String,
    pinned: bool,
) -> Result<(), AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    endpoint::set_pinned(&db.pool, &service_id, &key, pinned).await
}

/// endpoint.move：移动接口到目标分组的目标位置（拖拽 / 上移下移共用通道；
/// category_id 缺省＝服务散层，index 为摘除自身后的插入位，越界钳制到末尾）。
#[tauri::command(rename = "endpoint.move")]
pub async fn endpoint_move(
    state: State<'_, AppState>,
    service_id: String,
    key: String,
    category_id: Option<String>,
    index: i64,
) -> Result<(), AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    endpoint::move_endpoint(&db.pool, &service_id, &key, category_id.as_deref(), index).await
}

/// endpoint.doc：接口定义侧文档元数据（文档抽屉数据源）。
/// None＝无文档数据（手工接口 / 同步接口尚未经首次同步应用）。
#[tauri::command(rename = "endpoint.doc")]
pub async fn endpoint_doc(
    state: State<'_, AppState>,
    service_id: String,
    key: String,
) -> Result<Option<crate::domain::endpoint::EndpointDoc>, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    endpoint::doc(&db.pool, &service_id, &key).await
}
