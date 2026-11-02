//! 接口 repo：endpoints CRUD、手工级联删除与置顶开关。

use sqlx::{Connection, Executor, Sqlite};

use crate::domain::endpoint::ManualEndpointInput;
use crate::error::AppError;
use crate::error::codes;

/// 服务下的接口清单（散层与分类混排由前端 selector 组装；
/// 组内顺序＝sort_order 升序，未定制序时回退创建时间）。
pub async fn list_by_service(
    conn: impl Executor<'_, Database = Sqlite>,
    service_id: &str,
) -> Result<Vec<crate::domain::endpoint::Endpoint>, AppError> {
    let rows = sqlx::query_as::<_, crate::domain::endpoint::Endpoint>(
        "SELECT service_id, key, title, category_id, definition, created_at, badge, sort_order \
         FROM endpoints WHERE service_id = ? ORDER BY sort_order, created_at, key",
    )
    .bind(service_id)
    .fetch_all(conn)
    .await?;
    Ok(rows)
}

/// 工作空间接口总数（CLI `project info` 计数用）。
pub async fn count_by_workspace(
    conn: impl Executor<'_, Database = Sqlite>,
    workspace_id: &str,
) -> Result<i64, AppError> {
    let (count,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM endpoints e JOIN services s ON e.service_id = s.id WHERE s.workspace_id = ?",
    )
    .bind(workspace_id)
    .fetch_one(conn)
    .await?;
    Ok(count)
}

/// 按身份取接口。
pub async fn get(
    conn: impl Executor<'_, Database = Sqlite>,
    service_id: &str,
    key: &str,
) -> Result<Option<crate::domain::endpoint::Endpoint>, AppError> {
    let row = sqlx::query_as::<_, crate::domain::endpoint::Endpoint>(
        "SELECT service_id, key, title, category_id, definition, created_at, badge, sort_order \
         FROM endpoints WHERE service_id = ? AND key = ?",
    )
    .bind(service_id)
    .bind(key)
    .fetch_optional(conn)
    .await?;
    Ok(row)
}

/// 新建手工接口（key 恒 UUID；服务 / 分类存在性由 services 层先行校验；
/// sort_order 追加到目标分组末尾）。
pub async fn insert_manual(
    conn: impl Executor<'_, Database = Sqlite>,
    input: &ManualEndpointInput,
) -> Result<crate::domain::endpoint::Endpoint, AppError> {
    let definition = serde_json::to_string(&input.definition).map_err(|err| {
        AppError::internal(format!("endpoint definition is not serializable: {err}"))
    })?;
    sqlx::query_as::<_, crate::domain::endpoint::Endpoint>(
        "INSERT INTO endpoints (service_id, key, title, category_id, definition, created_at, badge, sort_order) \
         VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, \
         (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM endpoints \
          WHERE service_id = ? AND category_id IS ?)) \
         RETURNING service_id, key, title, category_id, definition, created_at, badge, sort_order",
    )
    .bind(&input.service_id)
    .bind(&input.key)
    .bind(&input.title)
    .bind(&input.category_id)
    .bind(&definition)
    .bind(&input.service_id)
    .bind(&input.category_id)
    .fetch_one(conn)
    .await
    .map_err(AppError::from)
}

/// 更新手工接口的结构字段（标题 / 方法 / 路径 / 分类），UUID 身份不变。
pub async fn update_manual(
    conn: impl Executor<'_, Database = Sqlite>,
    service_id: &str,
    key: &str,
    title: &str,
    definition: &crate::domain::endpoint::Definition,
    category_id: Option<&str>,
) -> Result<crate::domain::endpoint::Endpoint, AppError> {
    let definition_json = serde_json::to_string(definition).map_err(|err| {
        AppError::internal(format!("endpoint definition is not serializable: {err}"))
    })?;
    sqlx::query_as::<_, crate::domain::endpoint::Endpoint>(
        "UPDATE endpoints SET title = ?, category_id = ?, definition = ? \
         WHERE service_id = ? AND key = ? \
         RETURNING service_id, key, title, category_id, definition, created_at, badge, sort_order",
    )
    .bind(title)
    .bind(category_id)
    .bind(&definition_json)
    .bind(service_id)
    .bind(key)
    .fetch_one(conn)
    .await
    .map_err(|err| missing(err, "endpoint update matched no endpoint"))
}

/// 硬删除接口并连带清除用户数据与置顶（两张表无外键，同事务显式清除；
/// 确认弹窗语义在 services 层）。
pub async fn delete_manual(
    conn: &mut sqlx::SqliteConnection,
    service_id: &str,
    key: &str,
) -> Result<u64, AppError> {
    let mut tx = conn.begin().await?;
    sqlx::query("DELETE FROM endpoint_user_data WHERE service_id = ? AND key = ?")
        .bind(service_id)
        .bind(key)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM pinned_endpoints WHERE service_id = ? AND key = ?")
        .bind(service_id)
        .bind(key)
        .execute(&mut *tx)
        .await?;
    let result = sqlx::query("DELETE FROM endpoints WHERE service_id = ? AND key = ?")
        .bind(service_id)
        .bind(key)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(result.rows_affected())
}

/// 置顶开关：true 写入（幂等），false 移除。
pub async fn set_pinned(
    conn: impl Executor<'_, Database = Sqlite>,
    service_id: &str,
    key: &str,
    pinned: bool,
) -> Result<(), AppError> {
    if pinned {
        sqlx::query("INSERT OR IGNORE INTO pinned_endpoints (service_id, key) VALUES (?, ?)")
            .bind(service_id)
            .bind(key)
            .execute(conn)
            .await?;
    } else {
        sqlx::query("DELETE FROM pinned_endpoints WHERE service_id = ? AND key = ?")
            .bind(service_id)
            .bind(key)
            .execute(conn)
            .await?;
    }
    Ok(())
}

/// 移动接口到目标分组（同服务）的目标位置：分类归属与整组 sort_order 在同一
/// 事务内重写。语义＝先从原分组摘除自身，再插入目标分组 `index` 位
/// （越界钳制到末尾）；目标分组含自身时即同组内重排。
pub async fn move_endpoint(
    conn: &mut sqlx::SqliteConnection,
    service_id: &str,
    key: &str,
    target_category_id: Option<&str>,
    index: i64,
) -> Result<(), AppError> {
    let mut tx = conn.begin().await?;
    let exists: Option<(String,)> =
        sqlx::query_as("SELECT key FROM endpoints WHERE service_id = ? AND key = ?")
            .bind(service_id)
            .bind(key)
            .fetch_optional(&mut *tx)
            .await?;
    if exists.is_none() {
        return Err(AppError::new(
            codes::ENDPOINT_NOT_FOUND,
            format!("endpoint move matched no endpoint: {service_id}/{key}"),
        ));
    }
    // 目标分组现序（排除自身后即插入基线）；散层与分类分组以 IS 匹配 NULL
    let mut order: Vec<String> = sqlx::query_as::<_, (String,)>(
        "SELECT key FROM endpoints \
         WHERE service_id = ? AND category_id IS ? AND key != ? \
         ORDER BY sort_order, created_at, key",
    )
    .bind(service_id)
    .bind(target_category_id)
    .bind(key)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .map(|(key,)| key)
    .collect();
    crate::infrastructure::sort_move::insert_at_clamped(&mut order, key, index);
    for (position, key) in order.iter().enumerate() {
        sqlx::query(
            "UPDATE endpoints SET sort_order = ?, category_id = ? WHERE service_id = ? AND key = ?",
        )
        .bind(position as i64)
        .bind(target_category_id)
        .bind(service_id)
        .bind(key)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// 服务下全部置顶身份（树 DTO 组装用）。置顶数据与接口行独立（无外键，
/// 定义行删除后置顶原地保留、回归重定义后恢复呈现）——JOIN 以 endpoints
/// 表存活集为准，悬空置顶（定义行不存在的身份）不进呈现。
pub async fn list_pinned(
    conn: impl Executor<'_, Database = Sqlite>,
    service_id: &str,
) -> Result<Vec<String>, AppError> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT p.key FROM pinned_endpoints p \
         JOIN endpoints e ON e.service_id = p.service_id AND e.key = p.key \
         WHERE p.service_id = ? ORDER BY p.key",
    )
    .bind(service_id)
    .fetch_all(conn)
    .await?;
    Ok(rows.into_iter().map(|(key,)| key).collect())
}

fn missing(err: sqlx::Error, message: &'static str) -> AppError {
    match err {
        sqlx::Error::RowNotFound => AppError::new(codes::ENDPOINT_NOT_FOUND, message),
        other => AppError::from(other),
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use crate::domain::endpoint::{Definition, HttpMethod};

    /// 测试装置：插入最简手工接口（散层直挂服务）。
    pub async fn seed_endpoint(
        conn: impl Executor<'_, Database = Sqlite>,
        service_id: &str,
        key: &str,
        title: &str,
    ) -> crate::domain::endpoint::Endpoint {
        seed_endpoint_in_category(conn, service_id, key, None, title).await
    }

    /// 测试装置：插入指定分类下的手工接口。
    pub async fn seed_endpoint_in_category(
        conn: impl Executor<'_, Database = Sqlite>,
        service_id: &str,
        key: &str,
        category_id: Option<&str>,
        title: &str,
    ) -> crate::domain::endpoint::Endpoint {
        let input = ManualEndpointInput {
            service_id: service_id.to_owned(),
            key: key.to_owned(),
            title: title.to_owned(),
            category_id: category_id.map(str::to_owned),
            definition: Definition {
                method: HttpMethod::GET,
                path_template: format!("/{key}"),
                doc: None,
            },
        };
        insert_manual(conn, &input)
            .await
            .expect("seed endpoint must insert")
    }

    /// 测试装置：插入显式定义的接口（发送编排等需要真实方法 / 路径模板的场景）。
    pub async fn seed_endpoint_with_definition(
        conn: impl Executor<'_, Database = Sqlite>,
        service_id: &str,
        key: &str,
        definition: Definition,
        title: &str,
    ) -> crate::domain::endpoint::Endpoint {
        let input = ManualEndpointInput {
            service_id: service_id.to_owned(),
            key: key.to_owned(),
            title: title.to_owned(),
            category_id: None,
            definition,
        };
        insert_manual(conn, &input)
            .await
            .expect("seed endpoint must insert")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::domain::endpoint::{Definition, HttpMethod};
    use crate::infrastructure::service_repo::test_support as service_support;
    use crate::infrastructure::workspace_repo::test_support as ws_support;
    use sqlx::SqlitePool;

    async fn memory_pool() -> SqlitePool {
        let pool = db::connect_in_memory().await;
        db::run_migrations(&pool).await.unwrap();
        pool
    }

    async fn seeded_pool() -> SqlitePool {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        service_support::seed_service(&pool, "s1", "w1", "服务A").await;
        pool
    }

    #[tokio::test]
    async fn insert_manual_roundtrips_definition_json() {
        let pool = seeded_pool().await;
        let endpoint = test_support::seed_endpoint(&pool, "s1", "e1", "查询用户").await;
        assert_eq!(endpoint.title, "查询用户");
        assert_eq!(endpoint.badge, None);
        let definition: Definition = serde_json::from_str(&endpoint.definition).unwrap();
        assert_eq!(definition.method, HttpMethod::GET);
        assert_eq!(definition.path_template, "/e1");
    }

    #[tokio::test]
    async fn update_manual_keeps_identity_and_changes_structure() {
        let pool = seeded_pool().await;
        crate::infrastructure::category_repo::test_support::seed_category(
            &pool, "c1", "s1", "分类",
        )
        .await;
        test_support::seed_endpoint(&pool, "s1", "e1", "旧标题").await;

        let updated = update_manual(
            &pool,
            "s1",
            "e1",
            "新标题",
            &Definition {
                method: HttpMethod::POST,
                path_template: "/v2/items".into(),
                doc: None,
            },
            Some("c1"),
        )
        .await
        .unwrap();
        assert_eq!(updated.key, "e1");
        assert_eq!(updated.title, "新标题");
        assert_eq!(updated.category_id.as_deref(), Some("c1"));
        let definition: Definition = serde_json::from_str(&updated.definition).unwrap();
        assert_eq!(definition.method, HttpMethod::POST);

        let err = update_manual(&pool, "s1", "nope", "x", &definition, None)
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::ENDPOINT_NOT_FOUND);
    }

    #[tokio::test]
    async fn delete_manual_clears_user_data_and_pin_in_one_go() {
        let pool = seeded_pool().await;
        test_support::seed_endpoint(&pool, "s1", "e1", "接口").await;
        crate::infrastructure::user_data_repo::test_support::seed_user_data(&pool, "s1", "e1")
            .await;
        set_pinned(&pool, "s1", "e1", true).await.unwrap();

        let affected = delete_manual(&mut pool.acquire().await.unwrap(), "s1", "e1")
            .await
            .unwrap();
        assert_eq!(affected, 1);
        assert_eq!(count(&pool, "endpoint_user_data").await, 0);
        assert_eq!(count(&pool, "pinned_endpoints").await, 0);
        assert_eq!(count(&pool, "endpoints").await, 0);
        // 重复删除幂等（0 行受影响）
        let again = delete_manual(&mut pool.acquire().await.unwrap(), "s1", "e1")
            .await
            .unwrap();
        assert_eq!(again, 0);
    }

    #[tokio::test]
    async fn set_pinned_toggles_idempotently() {
        let pool = seeded_pool().await;
        test_support::seed_endpoint(&pool, "s1", "e1", "接口").await;
        set_pinned(&pool, "s1", "e1", true).await.unwrap();
        set_pinned(&pool, "s1", "e1", true).await.unwrap();
        assert_eq!(
            list_pinned(&pool, "s1").await.unwrap(),
            vec!["e1".to_owned()]
        );
        set_pinned(&pool, "s1", "e1", false).await.unwrap();
        set_pinned(&pool, "s1", "e1", false).await.unwrap();
        assert!(list_pinned(&pool, "s1").await.unwrap().is_empty());
    }

    /// 清单按组内序号升序返回（迁移回填与移动重写后应与手动排序一致）。
    #[tokio::test]
    async fn list_by_service_respects_sort_order() {
        let pool = seeded_pool().await;
        test_support::seed_endpoint(&pool, "s1", "e1", "先建").await;
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        test_support::seed_endpoint(&pool, "s1", "e2", "后建").await;
        // 手动把 e2 排到 e1 之前（整组重排为 0/1）
        move_endpoint(&mut pool.acquire().await.unwrap(), "s1", "e2", None, 0)
            .await
            .unwrap();

        let rows = list_by_service(&pool, "s1").await.unwrap();
        let keys: Vec<&str> = rows.iter().map(|e| e.key.as_str()).collect();
        assert_eq!(keys, vec!["e2", "e1"]);
    }

    /// 移动语义＝先摘除再按 index 插入目标分组；跨分类移动连带改归属。
    #[tokio::test]
    async fn move_endpoint_reorders_within_group_and_moves_across() {
        let pool = seeded_pool().await;
        crate::infrastructure::category_repo::test_support::seed_category(
            &pool, "c1", "s1", "分类",
        )
        .await;
        test_support::seed_endpoint(&pool, "s1", "e1", "一").await;
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        test_support::seed_endpoint(&pool, "s1", "e2", "二").await;
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        test_support::seed_endpoint(&pool, "s1", "e3", "三").await;

        // 散层 [e1,e2,e3]：e3 移到 index 1 → [e1,e3,e2]
        move_endpoint(&mut pool.acquire().await.unwrap(), "s1", "e3", None, 1)
            .await
            .unwrap();
        let keys: Vec<String> = list_by_service(&pool, "s1")
            .await
            .unwrap()
            .into_iter()
            .map(|e| e.key)
            .collect();
        assert_eq!(keys, vec!["e1", "e3", "e2"]);

        // e1 移入分类 c1（跨分组），落分类组末尾
        move_endpoint(
            &mut pool.acquire().await.unwrap(),
            "s1",
            "e1",
            Some("c1"),
            99,
        )
        .await
        .unwrap();
        let rows = list_by_service(&pool, "s1").await.unwrap();
        let in_category: Vec<&str> = rows
            .iter()
            .filter(|e| e.category_id.as_deref() == Some("c1"))
            .map(|e| e.key.as_str())
            .collect();
        assert_eq!(in_category, vec!["e1"]);
        let scatter: Vec<&str> = rows
            .iter()
            .filter(|e| e.category_id.is_none())
            .map(|e| e.key.as_str())
            .collect();
        assert_eq!(scatter, vec!["e3", "e2"]);

        // 不存在接口报 NOT_FOUND
        let err = move_endpoint(&mut pool.acquire().await.unwrap(), "s1", "nope", None, 0)
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::ENDPOINT_NOT_FOUND);
    }

    /// 清单按创建时间升序返回（同毫秒以 key 定序），与 key 字典序无关。
    #[tokio::test]
    async fn list_by_service_orders_by_creation_time() {
        let pool = seeded_pool().await;
        test_support::seed_endpoint(&pool, "s1", "z-first", "先建").await;
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        test_support::seed_endpoint(&pool, "s1", "a-second", "后建").await;

        let rows = list_by_service(&pool, "s1").await.unwrap();
        let keys: Vec<&str> = rows.iter().map(|e| e.key.as_str()).collect();
        assert_eq!(keys, vec!["z-first", "a-second"]);
    }

    /// 按静态语句分派计数的测试助手（sqlx 对动态 SQL 字符串做注入审计）
    async fn count(pool: &SqlitePool, table: &str) -> i64 {
        let (count,): (i64,) = match table {
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
            _ => panic!("unexpected table: {table}"),
        };
        count
    }
}
