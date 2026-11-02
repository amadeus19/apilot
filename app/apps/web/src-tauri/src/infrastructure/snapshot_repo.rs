//! 快照 repo：每服务双代快照（当前＋上一代）的读写。
//!
//! 快照是服务从属数据（FK CASCADE，删服务连带清）且**不是用户数据**：
//! 清空、重建、跳代均为同步内部行为。新代写入由 [`roll_forward`] 滚动完成
//! （新代 = 当前最大 generation + 1，两代之外删除）；滚动语义供拉取侧与
//! 应用事务同一入口复用。

// lib.rs 的 invoke_handler 注册行由调度者验收时统一挂载，挂载前拉取命令
// 链路无引用面（infrastructure 模块私有）；挂载后本属性无害。
#![allow(dead_code)]

use sqlx::FromRow;
use sqlx::{Connection, Executor, Sqlite, SqlitePool};

use crate::error::AppError;

/// 一代快照（swagger.json 原文整体存储）。
#[derive(Debug, Clone, FromRow)]
pub struct Snapshot {
    pub service_id: String,
    pub generation: i64,
    pub content: String,
    pub sha256: String,
    pub fetched_at: String,
}

/// 当前两代快照（generation 降序：`[当前, 上一代]`；不足两代按实有返回）。
pub async fn list_two(
    conn: impl Executor<'_, Database = Sqlite>,
    service_id: &str,
) -> Result<Vec<Snapshot>, AppError> {
    let rows = sqlx::query_as::<_, Snapshot>(
        "SELECT service_id, generation, content, sha256, fetched_at \
         FROM snapshots WHERE service_id = ? ORDER BY generation DESC LIMIT 2",
    )
    .bind(service_id)
    .fetch_all(conn)
    .await?;
    Ok(rows)
}

/// 当前代（diff 基准与「回看上次同步变化」的数据源；无快照＝None）。
pub async fn current(
    conn: impl Executor<'_, Database = Sqlite>,
    service_id: &str,
) -> Result<Option<Snapshot>, AppError> {
    let row = sqlx::query_as::<_, Snapshot>(
        "SELECT service_id, generation, content, sha256, fetched_at \
         FROM snapshots WHERE service_id = ? ORDER BY generation DESC LIMIT 1",
    )
    .bind(service_id)
    .fetch_optional(conn)
    .await?;
    Ok(row)
}

/// 滚动写入：新代 = 当前最大 generation + 1（首写为 1），两代之外删除。
/// 单事务完成（新代写入与旧代清理原子）；收 `&mut SqliteConnection` 供调用方
/// 组合进更大事务（应用事务同入口复用）。
pub async fn roll_forward(
    conn: &mut sqlx::SqliteConnection,
    service_id: &str,
    content: &str,
    sha256: &str,
) -> Result<Snapshot, AppError> {
    let mut tx = conn.begin().await?;
    let written = sqlx::query_as::<_, Snapshot>(
        "INSERT INTO snapshots (service_id, generation, content, sha256, fetched_at) \
         VALUES (?, (SELECT COALESCE(MAX(generation), 0) + 1 FROM snapshots WHERE service_id = ?), \
                 ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) \
         RETURNING service_id, generation, content, sha256, fetched_at",
    )
    .bind(service_id)
    .bind(service_id)
    .bind(content)
    .bind(sha256)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "DELETE FROM snapshots \
         WHERE service_id = ? AND generation <= ? - 2",
    )
    .bind(service_id)
    .bind(written.generation)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(written)
}

/// 待应用拉取（拉取成功暂存、不推进快照代；全量应用转正后清除）。
#[derive(Debug, Clone, FromRow)]
pub struct PendingFetch {
    pub service_id: String,
    pub content: String,
    pub sha256: String,
    pub fetched_at: String,
}

/// 读待应用拉取（无＝该服务拉取结果已被全量应用消费，或从未拉取）。
pub async fn pending_get(
    conn: impl Executor<'_, Database = Sqlite>,
    service_id: &str,
) -> Result<Option<PendingFetch>, AppError> {
    let row = sqlx::query_as::<_, PendingFetch>(
        "SELECT service_id, content, sha256, fetched_at \
         FROM pending_fetches WHERE service_id = ?",
    )
    .bind(service_id)
    .fetch_optional(conn)
    .await?;
    Ok(row)
}

/// 写待应用拉取（每服务一行，重复拉取覆盖）。收 `&mut SqliteConnection`
/// 供调用方组合进更大事务；fetched_at 由本函数盖戳。
pub async fn pending_upsert(
    conn: &mut sqlx::SqliteConnection,
    service_id: &str,
    content: &str,
    sha256: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO pending_fetches (service_id, content, sha256, fetched_at) \
         VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) \
         ON CONFLICT(service_id) DO UPDATE SET \
           content = excluded.content, sha256 = excluded.sha256, \
           fetched_at = excluded.fetched_at",
    )
    .bind(service_id)
    .bind(content)
    .bind(sha256)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// 清除待应用拉取（全量应用转正后调用；与滚动同事务）。
pub async fn pending_delete(
    conn: &mut sqlx::SqliteConnection,
    service_id: &str,
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM pending_fetches WHERE service_id = ?")
        .bind(service_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// 工作空间最近一次同步应用时刻（向导头部「上次同步」数据源）：当前
/// 已应用代快照 `fetched_at` 的最大值——滚动盖戳时点＝全量应用，旧代
/// 时间戳必不大于当前代，MAX 即当前代。工作空间无任何快照＝None。
pub async fn last_synced_at(
    pool: &SqlitePool,
    workspace_id: &str,
) -> Result<Option<String>, AppError> {
    let row: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT MAX(s.fetched_at) FROM snapshots s \
         JOIN services svc ON svc.id = s.service_id \
         WHERE svc.workspace_id = ?",
    )
    .bind(workspace_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.and_then(|(at,)| at).filter(|value| !value.is_empty()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::infrastructure::service_repo::test_support::seed_service;
    use crate::infrastructure::workspace_repo::test_support as ws_support;
    use sqlx::SqlitePool;

    async fn memory_pool() -> SqlitePool {
        let pool = db::connect_in_memory().await;
        db::run_migrations(&pool).await.unwrap();
        pool
    }

    fn content(generation: i64) -> String {
        format!("{{\"generation\": {generation}}}")
    }

    fn sha(generation: i64) -> String {
        format!("sha-{generation}")
    }

    #[tokio::test]
    async fn first_write_starts_at_generation_one() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        seed_service(&pool, "s1", "w1", "服务A").await;
        let written = roll_forward(
            &mut pool.acquire().await.unwrap(),
            "s1",
            &content(1),
            &sha(1),
        )
        .await
        .unwrap();
        assert_eq!(written.generation, 1);
        assert_eq!(written.content, content(1));
        assert!(written.fetched_at.starts_with("20"));
    }

    /// 「上次同步」数据源：有已应用代＝该代盖戳时间；无快照工作空间＝None。
    /// 滚动按秒级盖戳，两代连写同秒时同值也是合法结果（只判存在与格式）。
    #[tokio::test]
    async fn last_synced_at_reflects_applied_snapshots_only() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        ws_support::seed_workspace(&pool, "w2", "二").await;
        seed_service(&pool, "s1", "w1", "服务A").await;
        seed_service(&pool, "s2", "w1", "服务B").await;
        assert_eq!(last_synced_at(&pool, "w1").await.unwrap(), None);

        roll_forward(
            &mut pool.acquire().await.unwrap(),
            "s1",
            &content(1),
            &sha(1),
        )
        .await
        .unwrap();
        // 只写暂存不计数：待应用拉取不是「上次同步」（快照转正才算）。
        // 暂存盖戳取远期可判别值——若误计入，MAX 会带回它并破坏格式断言。
        sqlx::query(
            "INSERT INTO pending_fetches (service_id, content, sha256, fetched_at) \
                     VALUES ('s2', '{}', 'sha-p', '2999-01-01T00:00:00.000Z')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let synced = last_synced_at(&pool, "w1").await.unwrap();
        assert!(synced.as_deref().is_some_and(|at| at.starts_with("20")));
        // 跨工作空间隔离：w2 无快照
        assert_eq!(last_synced_at(&pool, "w2").await.unwrap(), None);
    }

    #[tokio::test]
    async fn rolling_keeps_latest_two_generations() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        seed_service(&pool, "s1", "w1", "服务A").await;
        {
            let mut conn = pool.acquire().await.unwrap();
            for generation in 1..=3 {
                roll_forward(&mut conn, "s1", &content(generation), &sha(generation))
                    .await
                    .unwrap();
            }
        }
        // 第三代写入后：保留第 2、3 代，第 1 代淘汰
        let two = list_two(&pool, "s1").await.unwrap();
        assert_eq!(
            two.iter().map(|s| s.generation).collect::<Vec<_>>(),
            vec![3, 2]
        );
        let (count,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM snapshots WHERE service_id = 's1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 2, "两代之外必须删除");
        // 当前代＝最新
        let current = current(&pool, "s1").await.unwrap().unwrap();
        assert_eq!((current.generation, current.sha256), (3, sha(3)));
    }

    #[tokio::test]
    async fn no_snapshot_reports_none() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        seed_service(&pool, "s1", "w1", "服务A").await;
        assert!(current(&pool, "s1").await.unwrap().is_none());
        assert!(list_two(&pool, "s1").await.unwrap().is_empty());
    }

    /// 快照是服务从属数据：删服务经 FK CASCADE 连带清快照。
    #[tokio::test]
    async fn deleting_service_cascades_snapshots() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        seed_service(&pool, "s1", "w1", "服务A").await;
        roll_forward(
            &mut pool.acquire().await.unwrap(),
            "s1",
            &content(1),
            &sha(1),
        )
        .await
        .unwrap();
        sqlx::query("DELETE FROM services WHERE id = 's1'")
            .execute(&pool)
            .await
            .unwrap();
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM snapshots")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0, "删除服务必须连带清快照");
    }

    /// 代次按服务隔离：两服务各自从 1 起滚、互不干扰。
    #[tokio::test]
    async fn generations_are_scoped_per_service() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        seed_service(&pool, "s1", "w1", "服务A").await;
        seed_service(&pool, "s2", "w1", "服务B").await;
        {
            let mut conn = pool.acquire().await.unwrap();
            roll_forward(&mut conn, "s1", &content(1), &sha(1))
                .await
                .unwrap();
            roll_forward(&mut conn, "s1", &content(2), &sha(2))
                .await
                .unwrap();
            roll_forward(&mut conn, "s2", &content(1), &sha(1))
                .await
                .unwrap();
        }
        let s2 = current(&pool, "s2").await.unwrap().unwrap();
        assert_eq!(s2.generation, 1, "s2 首写不受 s1 已有两代影响");
        let (s1_count,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM snapshots WHERE service_id = 's1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(s1_count, 2);
    }
}
