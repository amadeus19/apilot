//! 工作空间会话 repo：一行一工作空间＝整个「工作现场」。

use sqlx::{Executor, Sqlite};

use crate::domain::session::{SessionInput, WorkspaceSession};
use crate::error::AppError;

/// 读取会话；从未保存过返回 None（启动恢复按无会话处理）。
pub async fn get(
    conn: impl Executor<'_, Database = Sqlite>,
    workspace_id: &str,
) -> Result<Option<WorkspaceSession>, AppError> {
    let row = sqlx::query_as::<_, WorkspaceSession>(
        "SELECT workspace_id, tabs, tree_expanded, updated_at \
         FROM workspace_sessions WHERE workspace_id = ?",
    )
    .bind(workspace_id)
    .fetch_optional(conn)
    .await?;
    Ok(row)
}

/// 整包保存（tabs + tree_expanded 一次 upsert；关/切 Tab、切换空间、退出时写）。
pub async fn upsert(
    conn: impl Executor<'_, Database = Sqlite>,
    workspace_id: &str,
    input: &SessionInput,
) -> Result<WorkspaceSession, AppError> {
    sqlx::query_as::<_, WorkspaceSession>(
        "INSERT INTO workspace_sessions (workspace_id, tabs, tree_expanded, updated_at) \
         VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) \
         ON CONFLICT(workspace_id) DO UPDATE SET \
           tabs = excluded.tabs, tree_expanded = excluded.tree_expanded, \
           updated_at = excluded.updated_at \
         RETURNING workspace_id, tabs, tree_expanded, updated_at",
    )
    .bind(workspace_id)
    .bind(&input.tabs)
    .bind(&input.tree_expanded)
    .fetch_one(conn)
    .await
    .map_err(AppError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::infrastructure::workspace_repo::test_support as ws_support;
    use sqlx::SqlitePool;

    async fn memory_pool() -> SqlitePool {
        let pool = db::connect_in_memory().await;
        db::run_migrations(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn get_returns_none_before_first_save() {
        let pool = memory_pool().await;
        assert!(get(&pool, "w1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn upsert_overwrites_whole_session_per_workspace() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        ws_support::seed_workspace(&pool, "w2", "二").await;

        upsert(
            &pool,
            "w1",
            &SessionInput {
                tabs: "[{\"id\":\"t1\"}]".into(),
                tree_expanded: "[\"s1\"]".into(),
            },
        )
        .await
        .unwrap();
        // 覆盖写：整包替换，按工作空间隔离
        upsert(
            &pool,
            "w1",
            &SessionInput {
                tabs: "[{\"id\":\"t1\"},{\"id\":\"t2\"}]".into(),
                tree_expanded: "[]".into(),
            },
        )
        .await
        .unwrap();
        upsert(
            &pool,
            "w2",
            &SessionInput {
                tabs: "[]".into(),
                tree_expanded: "[\"s9\"]".into(),
            },
        )
        .await
        .unwrap();

        let w1 = get(&pool, "w1").await.unwrap().unwrap();
        assert_eq!(w1.tabs, "[{\"id\":\"t1\"},{\"id\":\"t2\"}]");
        assert_eq!(w1.tree_expanded, "[]");
        let w2 = get(&pool, "w2").await.unwrap().unwrap();
        assert_eq!(w2.tree_expanded, "[\"s9\"]");
    }
}
