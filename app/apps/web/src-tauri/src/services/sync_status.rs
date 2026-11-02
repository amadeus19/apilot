//! 同步状态查询（只读派生信息）：向导头部「上次同步」等状态面供数。
//!
//! 「上次同步」＝当前已应用代快照的写入时刻（快照盖戳时点＝全量应用），
//! 数据源单点在 [`snapshot_repo::last_synced_at`]；本层只做领域语义收口，
//! Command 仅做参数透传。

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::infrastructure::snapshot_repo;

/// 工作空间最近一次同步应用时刻（ISO 8601；无已应用快照＝None）。
pub async fn last_synced_at(
    pool: &SqlitePool,
    workspace_id: &str,
) -> Result<Option<String>, AppError> {
    snapshot_repo::last_synced_at(pool, workspace_id).await
}
