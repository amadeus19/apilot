//! 接口用户数据（草稿）repo：整包 upsert 与按身份读取。

use sqlx::{Executor, Sqlite};

use crate::domain::user_data::{EndpointUserData, UserDataInput};
use crate::error::AppError;

/// 按 (service_id, key) 读取草稿；无记录返回 None（Tab 挂载读一次）。
pub async fn get(
    conn: impl Executor<'_, Database = Sqlite>,
    service_id: &str,
    key: &str,
) -> Result<Option<EndpointUserData>, AppError> {
    let row = sqlx::query_as::<_, EndpointUserData>(
        "SELECT service_id, key, body, params, headers, timeout_seconds, auth, path_override, method_override, updated_at \
         FROM endpoint_user_data WHERE service_id = ? AND key = ?",
    )
    .bind(service_id)
    .bind(key)
    .fetch_optional(conn)
    .await?;
    Ok(row)
}

/// 整包写（body / params / headers / timeout_seconds / auth 一次 upsert，非增量
/// patch）；重复写同一身份幂等覆盖，updated_at 刷新。
pub async fn upsert(
    conn: impl Executor<'_, Database = Sqlite>,
    service_id: &str,
    key: &str,
    input: &UserDataInput,
) -> Result<EndpointUserData, AppError> {
    sqlx::query_as::<_, EndpointUserData>(
        "INSERT INTO endpoint_user_data (service_id, key, body, params, headers, timeout_seconds, auth, path_override, method_override, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) \
         ON CONFLICT(service_id, key) DO UPDATE SET \
           body = excluded.body, params = excluded.params, headers = excluded.headers, \
           timeout_seconds = excluded.timeout_seconds, auth = excluded.auth, \
           path_override = excluded.path_override, updated_at = excluded.updated_at \
         RETURNING service_id, key, body, params, headers, timeout_seconds, auth, path_override, method_override, updated_at",
    )
    .bind(service_id)
    .bind(key)
    .bind(&input.body)
    .bind(&input.params)
    .bind(&input.headers)
    .bind(input.timeout_seconds)
    .bind(&input.auth)
    .bind(&input.path_override)
    .bind(&input.method_override)
    .fetch_one(conn)
    .await
    .map_err(AppError::from)
}

/// 清除某服务下全部草稿（服务 / 工作空间删除的无外键级联）。
pub async fn delete_by_service(
    conn: impl Executor<'_, Database = Sqlite>,
    service_id: &str,
) -> Result<u64, AppError> {
    let result = sqlx::query("DELETE FROM endpoint_user_data WHERE service_id = ?")
        .bind(service_id)
        .execute(conn)
        .await?;
    Ok(result.rows_affected())
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// 测试装置：写入一份最简草稿。
    pub async fn seed_user_data(
        conn: impl Executor<'_, Database = Sqlite>,
        service_id: &str,
        key: &str,
    ) -> EndpointUserData {
        upsert(
            conn,
            service_id,
            key,
            &UserDataInput {
                body: None,
                params: "[]".into(),
                headers: "{}".into(),
                timeout_seconds: None,
                auth: None,
                path_override: None,
                method_override: None,
            },
        )
        .await
        .expect("seed user data must insert")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::infrastructure::endpoint_repo::test_support as endpoint_support;
    use crate::infrastructure::service_repo::test_support as service_support;
    use crate::infrastructure::workspace_repo::test_support as ws_support;
    use sqlx::SqlitePool;

    async fn memory_pool() -> SqlitePool {
        let pool = db::connect_in_memory().await;
        db::run_migrations(&pool).await.unwrap();
        pool
    }

    /// user_data 无外键：可直接对任意 (service_id, key) 写入（身份跨表语义）
    #[tokio::test]
    async fn get_returns_none_for_missing() {
        let pool = memory_pool().await;
        assert!(get(&pool, "s1", "e1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn upsert_writes_and_overwrites_whole_package() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        service_support::seed_service(&pool, "s1", "w1", "服务A").await;
        endpoint_support::seed_endpoint(&pool, "s1", "e1", "接口").await;

        let first = upsert(
            &pool,
            "s1",
            "e1",
            &UserDataInput {
                body: Some("v1".into()),
                params: "[]".into(),
                headers: "{}".into(),
                timeout_seconds: None,
                auth: None,
                path_override: None,
                method_override: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(first.body.as_deref(), Some("v1"));

        // 整包覆盖：新值三列全部生效（非增量 patch，未提供的列回到默认）
        let second = upsert(
            &pool,
            "s1",
            "e1",
            &UserDataInput {
                body: None,
                params: "[{\"k\":\"v\"}]".into(),
                headers: "{\"A\":\"1\"}".into(),
                timeout_seconds: None,
                auth: None,
                path_override: None,
                method_override: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(second.body, None);
        assert_eq!(second.params, "[{\"k\":\"v\"}]");
        assert_eq!(second.headers, "{\"A\":\"1\"}");
        assert!(second.updated_at >= first.updated_at);

        // 重读同一份（草稿归属接口实体，重开 Tab 读同一份数据）
        let reread = get(&pool, "s1", "e1").await.unwrap().unwrap();
        assert_eq!(reread.headers, "{\"A\":\"1\"}");
    }

    #[tokio::test]
    async fn delete_by_service_removes_only_that_service_rows() {
        let pool = memory_pool().await;
        test_support::seed_user_data(&pool, "s1", "e1").await;
        test_support::seed_user_data(&pool, "s1", "e2").await;
        test_support::seed_user_data(&pool, "s2", "e1").await;

        let deleted = delete_by_service(&pool, "s1").await.unwrap();
        assert_eq!(deleted, 2);
        assert!(get(&pool, "s2", "e1").await.unwrap().is_some());
    }
}
