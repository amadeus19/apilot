//! 历史 IPC 命令（run.*）：History 视图消费（GUI 与 CLI 记录同源同现）。
//! 查询与删除共用；删除为薄壳直调 repo——无编排业务（无级联资源、无事件
//! 推送），语义边界＝物理删除、无留痕。

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;
use crate::error::AppError;
use crate::infrastructure::run_repo::{self, RunListFilter};
use crate::services::workspace;

/// 单页容量上限（分页读取有界）
const HISTORY_PAGE_MAX: u32 = 200;

/// 历史行 DTO（列表行字段：方法徽标 / 路径 / 状态码 / 耗时 / 相对时间 /
/// source 芯片 / 接口名——接口已删时为 None，前端回落路径段）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunListItemDto {
    pub run_id: String,
    pub state: String,
    pub method: String,
    pub url: String,
    pub status_code: Option<i64>,
    pub duration_ms: Option<i64>,
    pub source: String,
    pub created_at: String,
    pub endpoint_name: Option<String>,
}

/// run.list：当前工作空间的执行历史（created_at 倒序分页；GUI 与 CLI 来源同现）。
#[tauri::command(rename = "run.list")]
pub async fn run_list(
    state: State<'_, AppState>,
    page: Option<u32>,
    page_size: Option<u32>,
) -> Result<Vec<RunListItemDto>, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    let workspace_id = workspace::resolve_current_id(&db.pool, &db.cache)
        .await?
        .ok_or_else(|| AppError::new(crate::error::codes::WORKSPACE_NOT_FOUND, "no workspace"))?;
    let page = page.unwrap_or(1).max(1);
    let page_size = page_size.unwrap_or(50).clamp(1, HISTORY_PAGE_MAX);
    let rows = run_repo::list(
        &db.pool,
        &RunListFilter {
            workspace_id: Some(workspace_id),
            states: Vec::new(),
            // OFFSET 分页基于倒序快照（封顶 1000 条量级，无键集分页需求）
            limit: page_size * page,
        },
    )
    .await?;
    let items = rows
        .into_iter()
        .skip(((page - 1) * page_size) as usize)
        .take(page_size as usize)
        .map(|r| RunListItemDto {
            run_id: r.record.id,
            state: r.record.state,
            method: r.record.method,
            url: r.record.url,
            status_code: r.record.status_code,
            duration_ms: r.record.duration_ms,
            source: r.record.source,
            created_at: r.record.created_at,
            endpoint_name: r.endpoint_title,
        })
        .collect();
    Ok(items)
}

/// run.get：单条历史详情（历史详情 Tab 的只读全量留痕；快照明文，展示脱敏由前端执行）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunGetArgs {
    pub run_id: String,
}

#[tauri::command(rename = "run.get")]
pub async fn run_get(
    state: State<'_, AppState>,
    args: RunGetArgs,
) -> Result<Option<serde_json::Value>, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    let Some(record) = run_repo::get(&db.pool, &args.run_id).await? else {
        return Ok(None);
    };
    let request: serde_json::Value =
        serde_json::from_str(&record.request_json).unwrap_or(serde_json::Value::Null);
    let response: Option<serde_json::Value> = record
        .response_json
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok());
    Ok(Some(serde_json::json!({
        "runId": record.id,
        "workspaceId": record.workspace_id,
        "serviceId": record.service_id,
        "endpointKey": record.endpoint_key,
        "method": record.method,
        "url": record.url,
        "statusCode": record.status_code,
        "durationMs": record.duration_ms,
        "state": record.state,
        "errorCode": record.error_code,
        "errorMessage": record.error_message,
        "source": record.source,
        "createdAt": record.created_at,
        "request": request,
        "response": response,
    })))
}

/// run.delete：按 id 批量删除历史（右键单删 / 多选批删共用）。
/// 返回实际删除数；不存在的 id 静默跳过（幂等，repo 层保证）。
/// 历史详情 Tab 若正展示被删记录：维持现状，下次 run.get 落 None 终态空态。
#[tauri::command(rename = "run.delete")]
pub async fn run_delete(state: State<'_, AppState>, ids: Vec<String>) -> Result<u64, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    run_repo::delete_many(&db.pool, &ids).await
}

/// run.clear：清空当前工作空间的全部历史（操作条「清空本工作空间历史」）。
/// workspace 边界由 repo 的 workspace 谓词在 SQL 层约束，不触碰他空间。
#[tauri::command(rename = "run.clear")]
pub async fn run_clear(state: State<'_, AppState>) -> Result<u64, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    let workspace_id = workspace::resolve_current_id(&db.pool, &db.cache)
        .await?
        .ok_or_else(|| AppError::new(crate::error::codes::WORKSPACE_NOT_FOUND, "no workspace"))?;
    run_repo::delete_all_in_workspace(&db.pool, &workspace_id).await
}
