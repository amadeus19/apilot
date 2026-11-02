//! 工作空间 repo：最小表 CRUD 与工作现场会话无关的基础查询。

use sqlx::{Connection, Executor, Sqlite};

use crate::domain::workspace::{NewWorkspace, Workspace};
use crate::error::AppError;
use crate::error::codes;

/// 工作空间清单（用户排序序：sort_order 升序；同序按创建时间稳定）。
/// 「删当前切剩余第一个」与 resolve 回退均取此序首位。
pub async fn list(conn: impl Executor<'_, Database = Sqlite>) -> Result<Vec<Workspace>, AppError> {
    let rows = sqlx::query_as::<_, Workspace>(
        "SELECT id, name, base_url, auth, sort_order, created_at, updated_at \
         FROM workspaces ORDER BY sort_order, created_at, id",
    )
    .fetch_all(conn)
    .await?;
    Ok(rows)
}

/// 按 id 取工作空间；不存在返回 None（服务层转 WORKSPACE_NOT_FOUND）。
pub async fn get(
    conn: impl Executor<'_, Database = Sqlite>,
    id: &str,
) -> Result<Option<Workspace>, AppError> {
    let row = sqlx::query_as::<_, Workspace>(
        "SELECT id, name, base_url, auth, sort_order, created_at, updated_at \
         FROM workspaces WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(conn)
    .await?;
    Ok(row)
}

/// 工作空间总数（默认工作空间 seeding 判空用）。
pub async fn count(conn: impl Executor<'_, Database = Sqlite>) -> Result<i64, AppError> {
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM workspaces")
        .fetch_one(conn)
        .await?;
    Ok(count)
}

/// 新建工作空间（sort_order 追加末尾：现最大值 +1；auth 随输入可带创建默认值）。
pub async fn insert(
    conn: impl Executor<'_, Database = Sqlite>,
    input: &NewWorkspace,
) -> Result<Workspace, AppError> {
    sqlx::query_as::<_, Workspace>(
        "INSERT INTO workspaces (id, name, base_url, auth, sort_order, created_at, updated_at) \
         VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM workspaces), \
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) \
         RETURNING id, name, base_url, auth, sort_order, created_at, updated_at",
    )
    .bind(&input.id)
    .bind(&input.name)
    .bind(&input.base_url)
    .bind(&input.auth)
    .fetch_one(conn)
    .await
    .map_err(map_integrity("workspace insert"))
}

/// 更新名称与 BaseUrl（工作空间设置页整行编辑；updated_at 随写刷新）。
pub async fn update(
    conn: impl Executor<'_, Database = Sqlite>,
    id: &str,
    name: &str,
    base_url: Option<&str>,
) -> Result<Workspace, AppError> {
    sqlx::query_as::<_, Workspace>(
        "UPDATE workspaces SET name = ?, base_url = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
         WHERE id = ? \
         RETURNING id, name, base_url, auth, sort_order, created_at, updated_at",
    )
    .bind(name)
    .bind(base_url)
    .bind(id)
    .fetch_one(conn)
    .await
    .map_err(map_integrity("workspace update"))
}

/// 更新工作空间级认证配置（NULL＝清除配置；updated_at 随写刷新）。
pub async fn update_auth(
    conn: impl Executor<'_, Database = Sqlite>,
    id: &str,
    auth: Option<&str>,
) -> Result<Workspace, AppError> {
    sqlx::query_as::<_, Workspace>(
        "UPDATE workspaces SET auth = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
         WHERE id = ? \
         RETURNING id, name, base_url, auth, sort_order, created_at, updated_at",
    )
    .bind(auth)
    .bind(id)
    .fetch_one(conn)
    .await
    .map_err(map_integrity("workspace auth update"))
}

/// 整批重排（拖拽放落的落库原语）：按给定顺序重写 sort_order 为 0..n，
/// 单事务一次到位。id 集一致性校验归服务层（repo 不感知业务拒绝语义）。
pub async fn reorder(
    conn: &mut sqlx::SqliteConnection,
    ordered_ids: &[&str],
) -> Result<(), AppError> {
    let mut tx = conn.begin().await?;
    for (position, id) in ordered_ids.iter().enumerate() {
        sqlx::query("UPDATE workspaces SET sort_order = ? WHERE id = ?")
            .bind(position as i64)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// 删除工作空间。无外键关联的 endpoint_user_data 先于级联删除
/// （经 services 关联定位，级联链见 domain::endpoint::cascade_scope）。
pub async fn delete(conn: &mut sqlx::SqliteConnection, id: &str) -> Result<u64, AppError> {
    let mut tx = conn.begin().await?;
    sqlx::query(
        "DELETE FROM endpoint_user_data \
         WHERE service_id IN (SELECT id FROM services WHERE workspace_id = ?)",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    let result = sqlx::query("DELETE FROM workspaces WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(result.rows_affected())
}

/// 单行写操作主键未命中（RETURNING 空集）统一转「实体不存在」。
fn map_integrity(what: &'static str) -> impl Fn(sqlx::Error) -> AppError {
    move |err| match err {
        sqlx::Error::RowNotFound => AppError::new(
            codes::WORKSPACE_NOT_FOUND,
            format!("{what} matched no workspace"),
        ),
        other => AppError::from(other),
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// 测试装置：插入一个最简工作空间（领域校验由 services 层测试覆盖）。
    pub async fn seed_workspace(
        conn: impl Executor<'_, Database = Sqlite>,
        id: &str,
        name: &str,
    ) -> Workspace {
        insert(
            conn,
            &NewWorkspace {
                id: id.to_owned(),
                name: name.to_owned(),
                base_url: None,
                auth: None,
            },
        )
        .await
        .expect("seed workspace must insert")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use sqlx::SqlitePool;

    async fn memory_pool() -> SqlitePool {
        let pool = db::connect_in_memory().await;
        db::run_migrations(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn insert_returns_row_with_generated_timestamps() {
        let pool = memory_pool().await;
        let ws = insert(
            &pool,
            &NewWorkspace {
                id: "w1".into(),
                name: "默认工作空间".into(),
                base_url: None,
                auth: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(ws.id, "w1");
        assert_eq!(ws.name, "默认工作空间");
        assert!(
            ws.created_at.starts_with("20"),
            "timestamp must look like RFC3339: {}",
            ws.created_at
        );
        assert_eq!(ws.created_at, ws.updated_at);
    }

    #[tokio::test]
    async fn list_returns_all_workspaces_in_stable_order() {
        let pool = memory_pool().await;
        test_support::seed_workspace(&pool, "w2", "第二").await;
        test_support::seed_workspace(&pool, "w1", "第一").await;
        let rows = list(&pool).await.unwrap();
        // 清单序＝sort_order 序（新建追加末尾，插入序即初始序）；
        // 同序兜底按 (created_at, id) 稳定，毫秒级时钟同毫秒插入不打乱清单
        let ids: Vec<&str> = rows.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, vec!["w2", "w1"]);
        let orders: Vec<i64> = rows.iter().map(|w| w.sort_order).collect();
        assert_eq!(orders, vec![0, 1], "回填与插入必须产出连续 sort_order");
    }

    #[tokio::test]
    async fn reorder_rewrites_sort_order_in_given_sequence() {
        let pool = memory_pool().await;
        test_support::seed_workspace(&pool, "w1", "第一").await;
        test_support::seed_workspace(&pool, "w2", "第二").await;
        test_support::seed_workspace(&pool, "w3", "第三").await;

        reorder(&mut pool.acquire().await.unwrap(), &["w3", "w1", "w2"])
            .await
            .unwrap();

        let rows = list(&pool).await.unwrap();
        let ids: Vec<&str> = rows.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, vec!["w3", "w1", "w2"]);
        let orders: Vec<i64> = rows.iter().map(|w| w.sort_order).collect();
        assert_eq!(orders, vec![0, 1, 2], "落序必须归一为连续 0..n");
    }

    #[tokio::test]
    async fn get_returns_none_for_missing() {
        let pool = memory_pool().await;
        assert!(get(&pool, "nope").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn count_counts_workspaces() {
        let pool = memory_pool().await;
        assert_eq!(count(&pool).await.unwrap(), 0);
        test_support::seed_workspace(&pool, "w1", "第一").await;
        assert_eq!(count(&pool).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn update_changes_name_and_base_url_and_bumps_updated_at() {
        let pool = memory_pool().await;
        test_support::seed_workspace(&pool, "w1", "旧名").await;
        let updated = update(&pool, "w1", "新名", Some("https://api.example.com"))
            .await
            .unwrap();
        assert_eq!(updated.name, "新名");
        assert_eq!(updated.base_url.as_deref(), Some("https://api.example.com"));
        // 单连接内存库写入足够快，时间戳可能同毫秒：仅断言不早于 created
        assert!(updated.updated_at >= updated.created_at);
    }

    #[tokio::test]
    async fn update_missing_workspace_reports_not_found() {
        let pool = memory_pool().await;
        let err = update(&pool, "nope", "新名", None).await.unwrap_err();
        assert_eq!(err.code, codes::WORKSPACE_NOT_FOUND);
    }

    /// 按静态语句分派计数的测试助手（sqlx 对动态 SQL 字符串做注入审计）
    async fn count_table(pool: &sqlx::SqlitePool, table: &str) -> i64 {
        let (count,): (i64,) = match table {
            "workspaces" => sqlx::query_as("SELECT COUNT(*) FROM workspaces")
                .fetch_one(pool)
                .await
                .unwrap(),
            "services" => sqlx::query_as("SELECT COUNT(*) FROM services")
                .fetch_one(pool)
                .await
                .unwrap(),
            "categories" => sqlx::query_as("SELECT COUNT(*) FROM categories")
                .fetch_one(pool)
                .await
                .unwrap(),
            "endpoints" => sqlx::query_as("SELECT COUNT(*) FROM endpoints")
                .fetch_one(pool)
                .await
                .unwrap(),
            "endpoint_user_data" => sqlx::query_as("SELECT COUNT(*) FROM endpoint_user_data")
                .fetch_one(pool)
                .await
                .unwrap(),
            "pinned_endpoints" => sqlx::query_as("SELECT COUNT(*) FROM pinned_endpoints")
                .fetch_one(pool)
                .await
                .unwrap(),
            "workspace_sessions" => sqlx::query_as("SELECT COUNT(*) FROM workspace_sessions")
                .fetch_one(pool)
                .await
                .unwrap(),
            _ => panic!("unexpected table: {table}"),
        };
        count
    }

    #[tokio::test]
    async fn migration_creates_all_seven_domain_tables() {
        let pool = memory_pool().await;
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
                .fetch_all(&pool)
                .await
                .unwrap();
        let names: Vec<&str> = rows.iter().map(|(name,)| name.as_str()).collect();
        for table in [
            "workspaces",
            "services",
            "categories",
            "endpoints",
            "endpoint_user_data",
            "pinned_endpoints",
            "workspace_sessions",
        ] {
            assert!(names.contains(&table), "missing table: {table}");
        }
    }

    #[tokio::test]
    async fn delete_workspace_cascades_full_chain() {
        let pool = memory_pool().await;
        test_support::seed_workspace(&pool, "w1", "一").await;
        crate::infrastructure::service_repo::test_support::seed_service(&pool, "s1", "w1", "服务A")
            .await;
        crate::infrastructure::category_repo::test_support::seed_category(
            &pool, "c1", "s1", "分类",
        )
        .await;
        crate::infrastructure::endpoint_repo::test_support::seed_endpoint_in_category(
            &pool,
            "s1",
            "e1",
            Some("c1"),
            "接口",
        )
        .await;
        crate::infrastructure::user_data_repo::test_support::seed_user_data(&pool, "s1", "e1")
            .await;
        sqlx::query("INSERT INTO pinned_endpoints (service_id, key) VALUES ('s1', 'e1')")
            .execute(&pool)
            .await
            .unwrap();
        crate::infrastructure::session_repo::upsert(
            &pool,
            "w1",
            &crate::domain::session::SessionInput {
                tabs: "[]".into(),
                tree_expanded: "[]".into(),
            },
        )
        .await
        .unwrap();

        delete(&mut pool.acquire().await.unwrap(), "w1")
            .await
            .unwrap();

        for table in [
            "workspaces",
            "services",
            "categories",
            "endpoints",
            "endpoint_user_data",
            "pinned_endpoints",
            "workspace_sessions",
        ] {
            let remaining = count_table(&pool, table).await;
            assert_eq!(
                remaining, 0,
                "table {table} must be empty after workspace delete"
            );
        }
    }

    #[tokio::test]
    async fn delete_missing_workspace_affects_no_rows() {
        let pool = memory_pool().await;
        let mut conn = pool.acquire().await.unwrap();
        let affected = delete(&mut conn, "nope").await.unwrap();
        assert_eq!(affected, 0);
    }
}
