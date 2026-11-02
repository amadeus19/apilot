//! 工作流执行记录 repo：workflow_executions 表的全部 SQL。
//!
//! 约定（沿 infrastructure 层风格）：时间戳由调用方生成（RFC3339 UTC）
//! 后整行 bind；每工作流恒一条记录由 workflow_id UNIQUE 约束保证，
//! 新执行覆盖＝UPSERT 单语句（取消与失败同留痕，覆盖不残留旧节点记录）。

use sqlx::Executor;
use sqlx::Sqlite;

use crate::domain::workflow_execution::{NodeExecutionRecord, WorkflowExecution};
use crate::error::AppError;

/// 节点记录集 ↔ `nodes_json` 列（序列化失败＝内部错误，执行记录写路径不容损坏）。
pub fn encode_nodes(nodes: &[NodeExecutionRecord]) -> Result<String, AppError> {
    serde_json::to_string(nodes)
        .map_err(|err| AppError::internal(format!("workflow execution nodes encode failed: {err}")))
}

pub fn decode_nodes(raw: &str) -> Result<Vec<NodeExecutionRecord>, AppError> {
    serde_json::from_str(raw)
        .map_err(|err| AppError::internal(format!("workflow execution nodes decode failed: {err}")))
}

/// 存储行（nodes_json 列为 JSON 文本；解析归 [`decode_nodes`] 单点）。
#[derive(Debug, sqlx::FromRow)]
pub struct WorkflowExecutionRow {
    pub id: String,
    pub workflow_id: String,
    pub status: String,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub nodes_json: String,
}

impl WorkflowExecutionRow {
    /// 存储行 → 领域记录（nodes_json 解析单点）。
    pub fn into_domain(self) -> Result<WorkflowExecution, AppError> {
        Ok(WorkflowExecution {
            id: self.id,
            workflow_id: self.workflow_id,
            status: self.status,
            started_at: self.started_at,
            completed_at: self.completed_at,
            duration_ms: self.duration_ms,
            error_code: self.error_code,
            error_message: self.error_message,
            nodes: decode_nodes(&self.nodes_json)?,
        })
    }
}

/// 写入执行记录（终态单次写入；已存在记录被整行覆盖——「每工作流仅最近
/// 一次」的物理落点）。
pub async fn upsert(
    conn: impl Executor<'_, Database = Sqlite>,
    exec: &WorkflowExecution,
) -> Result<(), AppError> {
    let nodes_json = encode_nodes(&exec.nodes)?;
    sqlx::query(
        "INSERT INTO workflow_executions \
           (id, workflow_id, status, started_at, completed_at, duration_ms, error_code, error_message, nodes_json) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(workflow_id) DO UPDATE SET \
           id = excluded.id, status = excluded.status, started_at = excluded.started_at, \
           completed_at = excluded.completed_at, duration_ms = excluded.duration_ms, \
           error_code = excluded.error_code, error_message = excluded.error_message, \
           nodes_json = excluded.nodes_json",
    )
    .bind(&exec.id)
    .bind(&exec.workflow_id)
    .bind(&exec.status)
    .bind(&exec.started_at)
    .bind(&exec.completed_at)
    .bind(exec.duration_ms)
    .bind(&exec.error_code)
    .bind(&exec.error_message)
    .bind(nodes_json)
    .execute(conn)
    .await?;
    Ok(())
}

/// 按工作流取最近一次执行记录（无记录＝None）。
pub async fn get_by_workflow(
    conn: impl Executor<'_, Database = Sqlite>,
    workflow_id: &str,
) -> Result<Option<WorkflowExecution>, AppError> {
    let row = sqlx::query_as::<_, WorkflowExecutionRow>(
        "SELECT id, workflow_id, status, started_at, completed_at, duration_ms, \
                error_code, error_message, nodes_json \
         FROM workflow_executions WHERE workflow_id = ?",
    )
    .bind(workflow_id)
    .fetch_optional(conn)
    .await?;
    row.map(WorkflowExecutionRow::into_domain).transpose()
}

/// 按执行 id 取记录并限定工作空间（CLI `run status` 查询面）：JOIN workflows
/// 过滤空间外记录（跨空间 id 与不存在同语义，不泄露存在性）。无记录＝None。
pub async fn get_by_id_in_workspace(
    conn: impl Executor<'_, Database = Sqlite>,
    id: &str,
    workspace_id: &str,
) -> Result<Option<WorkflowExecution>, AppError> {
    let row = sqlx::query_as::<_, WorkflowExecutionRow>(
        "SELECT e.id, e.workflow_id, e.status, e.started_at, e.completed_at, e.duration_ms, \
                e.error_code, e.error_message, e.nodes_json \
         FROM workflow_executions e JOIN workflows w ON e.workflow_id = w.id \
         WHERE e.id = ? AND w.workspace_id = ?",
    )
    .bind(id)
    .bind(workspace_id)
    .fetch_optional(conn)
    .await?;
    row.map(WorkflowExecutionRow::into_domain).transpose()
}
