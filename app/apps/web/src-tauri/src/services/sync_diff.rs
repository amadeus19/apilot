//! 同步·对比编排与同步管线公共装配。
//!
//! [`compute_plan`] 是对比与应用两个服务共同消费的装配入口：一次待应用
//! 读＋一次已应用代读＋双份归一＋一次端点读（存量行集）→ [`SyncPlan`]。
//! 库为事实源，plan 按需计算即弃——不引入跨命令会话状态。
//! 删除 / 插入 / 手工身份的对账谓词单点收敛在 domain::sync::plan，
//! 服务层不再各自编码。
//!
//! 基准口径：incoming＝待应用拉取（拉取成功写入暂存、不推进快照代），
//! base＝当前已应用代（快照最新代＝上次**全量**应用的拉取产物；2026-10-21
//! 定案——未采用的变更不得刷新快照）。首次同步无已应用代 → 全量 Added。
//!
//! 本服务不产生任何写入（对比是只读段，「未确认零副作用」）。

use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::HashSet;

use crate::domain::sync::diff::{DiffSummary, EndpointDiff};
use crate::domain::sync::normalize::normalize;
use crate::domain::sync::plan::{SyncPlan, plan_sync};
use crate::error::AppError;
use crate::infrastructure::{endpoint_repo, snapshot_repo};

/// 单服务对比结果（`sync.diff` IPC 载荷）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffOutcome {
    pub service_id: String,
    /// 对比所基于的待转正代次（当前已应用最大代 + 1；前端「第 N 次同步」呈现）
    pub generation: i64,
    pub summary: DiffSummary,
    pub diffs: Vec<EndpointDiff>,
}

/// 装配同步计划：读待应用拉取与当前已应用代 → 归一 → 读端点存量行集 →
/// 计划。无待应用拉取＝服务尚未拉取过（或上次拉取已被全量应用消费），
/// 稳定报错（对比与应用都恒跟在拉取段之后）。
pub(crate) async fn compute_plan(
    pool: &SqlitePool,
    service_id: &str,
) -> Result<(i64, SyncPlan), AppError> {
    let pending = snapshot_repo::pending_get(pool, service_id)
        .await?
        .ok_or_else(|| {
            AppError::new(
                crate::error::codes::SYNC_NO_SNAPSHOT,
                "服务尚无待应用拉取，请先执行同步拉取",
            )
        })?;
    let incoming = normalize(&pending.content)?;
    // 基准＝当前已应用代（无＝首次同步，新文档全量 Added）。未采用的
    // 变更不刷新快照——部分应用后待应用拉取保留，未勾选行仍在计划内
    let applied = snapshot_repo::current(pool, service_id).await?;
    let base = match &applied {
        Some(applied) => Some(normalize(&applied.content)?),
        None => None,
    };
    // 存量投影（对账只看键集——行内容随待应用 / 已应用两代 diff 比对）
    let endpoints = endpoint_repo::list_by_service(pool, service_id).await?;
    let existing_keys: HashSet<String> = endpoints.iter().map(|e| e.key.clone()).collect();
    let plan = plan_sync(base.as_ref(), &incoming, &existing_keys);
    let generation = applied.map(|s| s.generation).unwrap_or(0) + 1;
    Ok((generation, plan))
}

/// 对指定服务执行对比（只读）。复用管线装配，徽标 / 计数与应用事务同源。
pub async fn diff_service(pool: &SqlitePool, service_id: &str) -> Result<DiffOutcome, AppError> {
    let (generation, plan) = compute_plan(pool, service_id).await?;
    Ok(DiffOutcome {
        service_id: service_id.to_string(),
        generation,
        summary: plan.summary,
        diffs: plan.diffs,
    })
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

    /// 极简 Swagger 2.0 文档：paths 只含指定路由模板。
    fn mini_swagger(path: &str) -> String {
        format!(
            r#"{{
        "swagger": "2.0",
        "info": {{"title": "t", "version": "1"}},
        "paths": {{
            "{path}": {{
                "get": {{"tags": ["默认"], "summary": "查", "responses": {{"200": {{"description": "ok"}}}}}}
            }}
        }}
    }}"#
        )
    }

    fn sha(payload: &str) -> String {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(payload.as_bytes());
        format!("{:x}", h.finalize())
    }

    /// 模拟一次拉取落待应用暂存（不滚代；滚动只随全量应用）。
    async fn fetch_seed(pool: &SqlitePool, service_id: &str, content: &str) {
        snapshot_repo::pending_upsert(
            &mut pool.acquire().await.unwrap(),
            service_id,
            content,
            &sha(content),
        )
        .await
        .unwrap();
    }

    async fn seeded(pool: &SqlitePool) {
        ws_support::seed_workspace(pool, "w1", "一").await;
        seed_service(pool, "s1", "w1", "服务A").await;
    }

    #[tokio::test]
    async fn no_snapshot_is_stable_error() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        let err = diff_service(&pool, "s1").await.unwrap_err();
        assert_eq!(err.code, crate::error::codes::SYNC_NO_SNAPSHOT);
    }

    #[tokio::test]
    async fn single_generation_is_all_added() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        let doc = mini_swagger("/users");
        fetch_seed(&pool, "s1", &doc).await;
        let outcome = diff_service(&pool, "s1").await.unwrap();
        assert_eq!(outcome.generation, 1);
        assert_eq!(outcome.summary.added, 1);
        assert_eq!(outcome.diffs[0].key, "GET /users");
    }

    #[tokio::test]
    async fn second_generation_removed_endpoint_detected() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        // 手工拼接两路由版与单路由版（mini_swagger 一次一路由，用 JSON 合并）
        let two_paths = mini_swagger("/users").replace(
            "\"paths\": {",
            "\"paths\": {\n\"/orders\": {\"get\": {\"tags\": [\"默认\"], \"summary\": \"单\", \"responses\": {\"200\": {\"description\": \"ok\"}}}},",
        );
        // 两路由版全量应用（已应用代＝两路由），单路由版作为新拉取暂存
        fetch_seed(&pool, "s1", &two_paths).await;
        crate::services::sync_apply::apply(&pool, "s1", None)
            .await
            .unwrap();
        fetch_seed(&pool, "s1", &mini_swagger("/users")).await;
        let outcome = diff_service(&pool, "s1").await.unwrap();
        assert_eq!(outcome.generation, 2);
        assert_eq!(outcome.summary.removed, 1);
        assert_eq!(outcome.diffs[0].key, "GET /orders");
        assert_eq!(outcome.summary.added, 0);
    }

    /// 未应用的变更不刷新快照（回归锚）：拉取产生变更但
    /// 不应用 → 再次拉取同一文档 → diff 仍基于已应用代，变更重现（曾因
    /// 「拉取即滚动」把未应用变更永久遮蔽成「无变化」）。
    #[tokio::test]
    async fn unapplied_changes_reappear_on_next_sync() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        // 第一轮：v1 全量应用（已应用代＝v1）
        fetch_seed(&pool, "s1", &mini_swagger("/users")).await;
        crate::services::sync_apply::apply(&pool, "s1", None)
            .await
            .unwrap();
        // v2＝users 加 query 参数（定义侧变化计入 Changed）
        let v2 = mini_swagger("/users").replace(
            "\"get\": {\"tags\": [\"默认\"], \"summary\": \"查\"",
            "\"get\": {\"parameters\": [{\"name\": \"page\", \"in\": \"query\", \"type\": \"integer\"}], \"tags\": [\"默认\"], \"summary\": \"查\"",
        );
        // 第二轮：拉取 v2 看到变更但不应用；第三轮重新拉取同一 v2——变更
        // 仍在（快照未被未采用的拉取刷新）
        fetch_seed(&pool, "s1", &v2).await;
        let once = diff_service(&pool, "s1").await.unwrap();
        assert_eq!(once.summary.changed, 1);
        fetch_seed(&pool, "s1", &v2).await;
        let again = diff_service(&pool, "s1").await.unwrap();
        assert_eq!(again.summary.changed, 1, "未应用的变更不被遮蔽");
        assert_eq!(again.generation, 2, "待转正代次不动（已应用代仍是 1）");
    }

    /// 消失键定义行已删（表内无行）、用户数据行遗留原地：回归键对账＝
    /// 库内无行＝普通 Added，Insert 落库时凭稳定键重接该遗留行。
    #[tokio::test]
    async fn reappearing_key_without_definition_row_is_plain_added() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        sqlx::query(
            "INSERT INTO endpoint_user_data (service_id, key, body, params, headers, updated_at) \
             VALUES ('s1', 'GET /users', '留存', '[]', '[]', '2026-01-01T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();
        fetch_seed(&pool, "s1", &mini_swagger("/users")).await;
        let outcome = diff_service(&pool, "s1").await.unwrap();
        assert_eq!(outcome.summary.added, 1);
        assert_eq!(
            outcome.diffs[0].kind,
            crate::domain::sync::diff::DiffKind::Added,
            "回归键在确认面就是普通新增"
        );
        // 确认面＝应用面：同一装配下的动作集对该键给 Insert（落库凭稳定键
        // 重接遗留用户数据行），而非 Update / Unchanged
        let (_generation, plan) = compute_plan(&pool, "s1").await.unwrap();
        assert!(
            plan.actions.iter().any(|action| action.key == "GET /users"
                && action.kind == crate::domain::sync::plan::SyncActionKind::Insert),
            "回归键在应用面是 Insert"
        );
    }

    /// 库内存量手工键不进同步对账面：不产生删除动作，回归键照常 Insert。
    #[tokio::test]
    async fn manual_uuid_rows_are_outside_reconciliation() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        sqlx::query(
            "INSERT INTO endpoints (service_id, key, title, definition, created_at, sort_order) \
             VALUES ('s1', '019aaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', '手工', '{}', '2026-01-01T00:00:00Z', 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        fetch_seed(&pool, "s1", &mini_swagger("/users")).await;
        let outcome = diff_service(&pool, "s1").await.unwrap();
        assert_eq!(outcome.summary.added, 1);
        assert_eq!(outcome.summary.removed, 0, "手工键不进删除");
    }
}
