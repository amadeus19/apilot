//! 工作流域 repo：workflows / workflow_groups 表的全部 SQL。
//!
//! 约定（沿 infrastructure 层风格）：单语句函数收 `impl Executor`；
//! 时间戳由 SQL 侧 strftime 生成（RFC3339 UTC）；写路径用 RETURNING 回读。
//! graph 列为 JSON 文本（内含 schemaVersion），解析归 domain 层单点。
//! SQL 恒字面量（sqlx 0.9 SqlSafeStr 门槛；列集演进随语句逐条改）。

use sqlx::{Connection, Executor, Sqlite};

use crate::domain::workflow::{NewWorkflow, NewWorkflowGroup, Workflow, WorkflowGroup};
use crate::error::AppError;
use crate::error::codes;

/// 工作空间内工作流清单（树内呈现序：sort_order 升序、同序按 id 稳定）。
pub async fn list_by_workspace(
    conn: impl Executor<'_, Database = Sqlite>,
    workspace_id: &str,
) -> Result<Vec<Workflow>, AppError> {
    let rows = sqlx::query_as::<_, Workflow>(
        "SELECT id, workspace_id, name, graph, group_id, sort_order, created_at, updated_at \
         FROM workflows WHERE workspace_id = ? ORDER BY sort_order, id",
    )
    .bind(workspace_id)
    .fetch_all(conn)
    .await?;
    Ok(rows)
}

/// 清单行：工作流行＋最近一次执行状态词（清单元数据面；无记录＝None）。
/// 执行记录表 workflow_id UNIQUE（每工作流恒至多一行），子查询无序即确定。
#[derive(Debug, sqlx::FromRow)]
pub struct WorkflowListRow {
    #[sqlx(flatten)]
    pub workflow: Workflow,
    pub last_status: Option<String>,
}

/// 工作空间内工作流清单（含最近一次执行状态；呈现序同 [`list_by_workspace`]）。
pub async fn list_with_last_status(
    conn: impl Executor<'_, Database = Sqlite>,
    workspace_id: &str,
) -> Result<Vec<WorkflowListRow>, AppError> {
    let rows = sqlx::query_as::<_, WorkflowListRow>(
        "SELECT w.id, w.workspace_id, w.name, w.graph, w.group_id, w.sort_order, w.created_at, w.updated_at, \
         (SELECT e.status FROM workflow_executions e WHERE e.workflow_id = w.id) AS last_status \
         FROM workflows w WHERE w.workspace_id = ? ORDER BY w.sort_order, w.id",
    )
    .bind(workspace_id)
    .fetch_all(conn)
    .await?;
    Ok(rows)
}

/// 工作空间工作流总数（CLI `project info` 计数用）。
pub async fn count_by_workspace(
    conn: impl Executor<'_, Database = Sqlite>,
    workspace_id: &str,
) -> Result<i64, AppError> {
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM workflows WHERE workspace_id = ?")
        .bind(workspace_id)
        .fetch_one(conn)
        .await?;
    Ok(count)
}

/// 按 id 取工作流；不存在返回 None（服务层转 WORKFLOW_NOT_FOUND）。
pub async fn get(
    conn: impl Executor<'_, Database = Sqlite>,
    id: &str,
) -> Result<Option<Workflow>, AppError> {
    let row = sqlx::query_as::<_, Workflow>(
        "SELECT id, workspace_id, name, graph, group_id, sort_order, created_at, updated_at \
         FROM workflows WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(conn)
    .await?;
    Ok(row)
}

/// 新建工作流。工作空间存在性由 services 层先行校验（FK 仅兜底）；
/// sort_order 桶内尾插（归属桶的 MAX+1，新建恒未分组桶）。
pub async fn insert(
    conn: impl Executor<'_, Database = Sqlite>,
    input: &NewWorkflow,
) -> Result<Workflow, AppError> {
    sqlx::query_as::<_, Workflow>(
        "INSERT INTO workflows (id, workspace_id, name, graph, group_id, sort_order, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, \
         (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM workflows WHERE workspace_id = ? AND group_id IS ?), \
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) \
         RETURNING id, workspace_id, name, graph, group_id, sort_order, created_at, updated_at",
    )
    .bind(&input.id)
    .bind(&input.workspace_id)
    .bind(&input.name)
    .bind(&input.graph)
    .bind(&input.group_id)
    .bind(&input.workspace_id)
    .bind(&input.group_id)
    .fetch_one(conn)
    .await
    .map_err(AppError::from)
}

/// 重命名（updated_at 随写刷新）。
pub async fn rename(
    conn: impl Executor<'_, Database = Sqlite>,
    id: &str,
    name: &str,
) -> Result<Workflow, AppError> {
    sqlx::query_as::<_, Workflow>(
        "UPDATE workflows SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
         WHERE id = ? \
         RETURNING id, workspace_id, name, graph, group_id, sort_order, created_at, updated_at",
    )
    .bind(name)
    .bind(id)
    .fetch_one(conn)
    .await
    .map_err(AppError::from)
}

/// 设置所属分组（groupId None＝移出分组回落未分组；updated_at 不刷——
/// 归组是清单组织操作，不是编辑模型的图变更）。落位＝目标桶尾（与拖拽
/// 「移入分组」同一语义）：sort_order 取目标桶 MAX+1，不沿用源桶旧序，
/// 否则旧序值落入新桶会与成员排序冲突、呈现位置不可预期。
pub async fn set_group(
    conn: impl Executor<'_, Database = Sqlite>,
    id: &str,
    group_id: Option<&str>,
) -> Result<Workflow, AppError> {
    sqlx::query_as::<_, Workflow>(
        "UPDATE workflows SET group_id = ?, sort_order = (\
           SELECT COALESCE(MAX(w2.sort_order) + 1, 0) FROM workflows w2 \
           WHERE w2.workspace_id = workflows.workspace_id \
             AND w2.group_id IS ? AND w2.id != workflows.id\
         ) WHERE id = ? \
         RETURNING id, workspace_id, name, graph, group_id, sort_order, created_at, updated_at",
    )
    .bind(group_id)
    .bind(group_id)
    .bind(id)
    .fetch_one(conn)
    .await
    .map_err(AppError::from)
}

/// 保存图（编辑器整图落库单点；updated_at 随写刷新）。
pub async fn save_graph(
    conn: impl Executor<'_, Database = Sqlite>,
    id: &str,
    graph: &str,
) -> Result<Workflow, AppError> {
    sqlx::query_as::<_, Workflow>(
        "UPDATE workflows SET graph = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
         WHERE id = ? \
         RETURNING id, workspace_id, name, graph, group_id, sort_order, created_at, updated_at",
    )
    .bind(graph)
    .bind(id)
    .fetch_one(conn)
    .await
    .map_err(AppError::from)
}

/// 删除工作流（硬删除；执行记录表 FK CASCADE 级联，随执行引擎建表）。
/// 返回是否存在（服务层转 WORKFLOW_NOT_FOUND）。
pub async fn delete(
    conn: impl Executor<'_, Database = Sqlite>,
    id: &str,
) -> Result<bool, AppError> {
    let result = sqlx::query("DELETE FROM workflows WHERE id = ?")
        .bind(id)
        .execute(conn)
        .await?;
    Ok(result.rows_affected() > 0)
}

// —— workflow_groups（分组 CRUD） ——

/// 工作空间内分组清单（组间呈现序：sort_order 升序、同序按 id 稳定）。
pub async fn list_groups(
    conn: impl Executor<'_, Database = Sqlite>,
    workspace_id: &str,
) -> Result<Vec<WorkflowGroup>, AppError> {
    let rows = sqlx::query_as::<_, WorkflowGroup>(
        "SELECT id, workspace_id, name, sort_order, created_at FROM workflow_groups \
         WHERE workspace_id = ? ORDER BY sort_order, id",
    )
    .bind(workspace_id)
    .fetch_all(conn)
    .await?;
    Ok(rows)
}

/// 按 id 取分组；不存在返回 None（服务层转 WORKFLOW_NOT_FOUND）。
pub async fn get_group(
    conn: impl Executor<'_, Database = Sqlite>,
    id: &str,
) -> Result<Option<WorkflowGroup>, AppError> {
    let row = sqlx::query_as::<_, WorkflowGroup>(
        "SELECT id, workspace_id, name, sort_order, created_at FROM workflow_groups WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(conn)
    .await?;
    Ok(row)
}

/// 工作空间内组名是否已被占用（重名校验的查询单点；同空间唯一、跨空间互不影响）。
pub async fn group_name_exists(
    conn: impl Executor<'_, Database = Sqlite>,
    workspace_id: &str,
    name: &str,
    exclude_id: Option<&str>,
) -> Result<bool, AppError> {
    let (count,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM workflow_groups \
         WHERE workspace_id = ? AND name = ? AND (id != ? OR ? IS NULL)",
    )
    .bind(workspace_id)
    .bind(name)
    .bind(exclude_id.unwrap_or(""))
    .bind(exclude_id)
    .fetch_one(conn)
    .await?;
    Ok(count > 0)
}

/// 新建分组。工作空间存在性由 services 层先行校验（FK 仅兜底）；
/// sort_order 空间内尾插。
pub async fn insert_group(
    conn: impl Executor<'_, Database = Sqlite>,
    input: &NewWorkflowGroup,
) -> Result<WorkflowGroup, AppError> {
    sqlx::query_as::<_, WorkflowGroup>(
        "INSERT INTO workflow_groups (id, workspace_id, name, sort_order, created_at) \
         VALUES (?, ?, ?, \
         (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM workflow_groups WHERE workspace_id = ?), \
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) \
         RETURNING id, workspace_id, name, sort_order, created_at",
    )
    .bind(&input.id)
    .bind(&input.workspace_id)
    .bind(&input.name)
    .bind(&input.workspace_id)
    .fetch_one(conn)
    .await
    .map_err(AppError::from)
}

/// 分组重命名。
pub async fn rename_group(
    conn: impl Executor<'_, Database = Sqlite>,
    id: &str,
    name: &str,
) -> Result<WorkflowGroup, AppError> {
    sqlx::query_as::<_, WorkflowGroup>(
        "UPDATE workflow_groups SET name = ? WHERE id = ? \
         RETURNING id, workspace_id, name, sort_order, created_at",
    )
    .bind(name)
    .bind(id)
    .fetch_one(conn)
    .await
    .map_err(AppError::from)
}

/// 移动工作流到目标分组（None＝未分组）的目标位置（树拖拽通道）：先摘除
/// 再插入目标桶现序，跨桶连带改归属；单事务。目标分组存在性由服务层先行
/// 校验。sort_order 目标桶内重写为 0..n；源桶遗留空洞无碍（语义只看相对
/// 次序），next 拖拽会自然压实。
pub async fn move_workflow(
    conn: &mut sqlx::SqliteConnection,
    id: &str,
    target_group_id: Option<&str>,
    index: i64,
) -> Result<(), AppError> {
    let mut tx = conn.begin().await?;
    let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM workflows WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        return Err(AppError::new(
            codes::WORKFLOW_NOT_FOUND,
            format!("workflow move matched no workflow: {id}"),
        ));
    }
    // 目标桶现序（排除自身后即插入基线）；桶按空间限定——未分组行的
    // group_id 均为 NULL，不加空间过滤会把其他空间的未分组工作流混入
    // 同一序列，插入基线错位且整桶重写会越权改动他空间行。未分组与组内
    // 以 IS 匹配 NULL；排序口径与清单查询一致（sort_order, id）
    let mut order: Vec<String> = sqlx::query_as::<_, (String,)>(
        "SELECT id FROM workflows \
         WHERE workspace_id = (SELECT workspace_id FROM workflows WHERE id = ?) \
           AND group_id IS ? AND id != ? \
         ORDER BY sort_order, id",
    )
    .bind(id)
    .bind(target_group_id)
    .bind(id)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .map(|(id,)| id)
    .collect();
    crate::infrastructure::sort_move::insert_at_clamped(&mut order, id, index);
    for (position, workflow_id) in order.iter().enumerate() {
        sqlx::query("UPDATE workflows SET sort_order = ?, group_id = ? WHERE id = ?")
            .bind(position as i64)
            .bind(target_group_id)
            .bind(workflow_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// 移动分组到空间内分组序列的目标位置（树拖拽通道；单事务）。
pub async fn move_group(
    conn: &mut sqlx::SqliteConnection,
    id: &str,
    index: i64,
) -> Result<(), AppError> {
    let mut tx = conn.begin().await?;
    let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM workflow_groups WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        return Err(AppError::new(
            codes::WORKFLOW_NOT_FOUND,
            format!("workflow group move matched no group: {id}"),
        ));
    }
    let mut order: Vec<String> = sqlx::query_as::<_, (String,)>(
        "SELECT id FROM workflow_groups \
         WHERE workspace_id = (SELECT workspace_id FROM workflow_groups WHERE id = ?) AND id != ? \
         ORDER BY sort_order, id",
    )
    .bind(id)
    .bind(id)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .map(|(group_id,)| group_id)
    .collect();
    crate::infrastructure::sort_move::insert_at_clamped(&mut order, id, index);
    for (position, group_id) in order.iter().enumerate() {
        sqlx::query("UPDATE workflow_groups SET sort_order = ? WHERE id = ?")
            .bind(position as i64)
            .bind(group_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// 删除分组（组内工作流经 FK SET NULL 回落未分组）。返回是否存在。
pub async fn delete_group(
    conn: impl Executor<'_, Database = Sqlite>,
    id: &str,
) -> Result<bool, AppError> {
    let result = sqlx::query("DELETE FROM workflow_groups WHERE id = ?")
        .bind(id)
        .execute(conn)
        .await?;
    Ok(result.rows_affected() > 0)
}
