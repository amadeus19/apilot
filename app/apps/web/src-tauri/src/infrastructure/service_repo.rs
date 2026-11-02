//! 服务 repo：工作空间下的服务 CRUD 与相邻交换排序。

use sqlx::{Connection, Executor, Sqlite};

use crate::domain::service::{MoveDirection, NewService, Service};
use crate::error::AppError;
use crate::error::codes;

/// 服务清单（工作空间内按 sort_order 升序；同序按创建时间稳定）。
pub async fn list_by_workspace(
    conn: impl Executor<'_, Database = Sqlite>,
    workspace_id: &str,
) -> Result<Vec<Service>, AppError> {
    let rows = sqlx::query_as::<_, Service>(
        "SELECT id, workspace_id, name, doc_url, doc_type, sort_order, created_at, updated_at \
         FROM services WHERE workspace_id = ? ORDER BY sort_order, created_at, id",
    )
    .bind(workspace_id)
    .fetch_all(conn)
    .await?;
    Ok(rows)
}

/// 全部服务（跨工作空间；可达性探测启动轮的消费面）。
pub async fn list_all(
    conn: impl Executor<'_, Database = Sqlite>,
) -> Result<Vec<Service>, AppError> {
    let rows = sqlx::query_as::<_, Service>(
        "SELECT id, workspace_id, name, doc_url, doc_type, sort_order, created_at, updated_at \
         FROM services ORDER BY workspace_id, sort_order, created_at, id",
    )
    .fetch_all(conn)
    .await?;
    Ok(rows)
}

/// 按 id 取服务。
pub async fn get(
    conn: impl Executor<'_, Database = Sqlite>,
    id: &str,
) -> Result<Option<Service>, AppError> {
    let row = sqlx::query_as::<_, Service>(
        "SELECT id, workspace_id, name, doc_url, doc_type, sort_order, created_at, updated_at \
         FROM services WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(conn)
    .await?;
    Ok(row)
}

/// 新建服务：sort_order 追加末尾（同工作空间现最大值 +1）。
/// 工作空间存在性由 services 层先行校验（外键违例不在此转译）。
pub async fn insert(
    conn: impl Executor<'_, Database = Sqlite>,
    input: &NewService,
) -> Result<Service, AppError> {
    sqlx::query_as::<_, Service>(
        "INSERT INTO services (id, workspace_id, name, doc_url, doc_type, sort_order, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM services WHERE workspace_id = ?), \
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) \
         RETURNING id, workspace_id, name, doc_url, doc_type, sort_order, created_at, updated_at",
    )
    .bind(&input.id)
    .bind(&input.workspace_id)
    .bind(&input.name)
    .bind(&input.doc_url)
    .bind(&input.doc_type)
    .bind(&input.workspace_id)
    .fetch_one(conn)
    .await
    .map_err(AppError::from)
}

/// 更新名称与文档地址（新建 / 编辑同语义：补地址即编辑完成，探测与同步归同步域）。
pub async fn update(
    conn: impl Executor<'_, Database = Sqlite>,
    id: &str,
    name: &str,
    doc_url: Option<&str>,
) -> Result<Service, AppError> {
    sqlx::query_as::<_, Service>(
        "UPDATE services SET name = ?, doc_url = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
         WHERE id = ? \
         RETURNING id, workspace_id, name, doc_url, doc_type, sort_order, created_at, updated_at",
    )
    .bind(name)
    .bind(doc_url)
    .bind(id)
    .fetch_one(conn)
    .await
    .map_err(|err| missing(err, codes::SERVICE_NOT_FOUND, "service update matched no service"))
}

/// 删除服务（无外键的 endpoint_user_data 先清，其余走 FK CASCADE）。
pub async fn delete(conn: &mut sqlx::SqliteConnection, id: &str) -> Result<u64, AppError> {
    let mut tx = conn.begin().await?;
    crate::infrastructure::user_data_repo::delete_by_service(&mut *tx, id).await?;
    let result = sqlx::query("DELETE FROM services WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(result.rows_affected())
}

/// 相邻交换排序：与上/下相邻服务互换 sort_order；已是边界时不动（幂等）。
/// 骨架（邻位选取 / 互换）共享自 sort_move，此处只声明表与组列。
pub async fn move_service(
    conn: &mut sqlx::SqliteConnection,
    id: &str,
    direction: MoveDirection,
) -> Result<(), AppError> {
    let mut tx = conn.begin().await?;
    crate::infrastructure::sort_move::swap_adjacent(
        &mut tx,
        crate::infrastructure::sort_move::AdjacentGroup {
            table: "services",
            group_col: "workspace_id",
        },
        id,
        direction,
        AppError::new(
            codes::SERVICE_NOT_FOUND,
            format!("service move matched no service: {id}"),
        ),
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

/// 移动服务到工作空间服务序列的 `index` 位（拖拽排序通道；服务不跨工作空间）：
/// 整组 sort_order 同事务重写。语义＝先从原序列摘除自身，再插入 `index` 位
/// （越界钳制到末尾）。
pub async fn move_service_to(
    conn: &mut sqlx::SqliteConnection,
    id: &str,
    index: i64,
) -> Result<(), AppError> {
    let mut tx = conn.begin().await?;
    let current: Option<(i64, String)> =
        sqlx::query_as("SELECT sort_order, workspace_id FROM services WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((_, workspace_id)) = current else {
        return Err(AppError::new(
            codes::SERVICE_NOT_FOUND,
            format!("service move matched no service: {id}"),
        ));
    };
    let mut order: Vec<String> = sqlx::query_as::<_, (String,)>(
        "SELECT id FROM services WHERE workspace_id = ? AND id != ? \
         ORDER BY sort_order, created_at, id",
    )
    .bind(&workspace_id)
    .bind(id)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .map(|(id,)| id)
    .collect();
    crate::infrastructure::sort_move::insert_at_clamped(&mut order, id, index);
    for (position, service_id) in order.iter().enumerate() {
        sqlx::query("UPDATE services SET sort_order = ? WHERE id = ?")
            .bind(position as i64)
            .bind(service_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// UPDATE...RETURNING 空集＝目标实体不存在，统一转对应 NOT_FOUND 码。
fn missing(err: sqlx::Error, code: &'static str, message: &'static str) -> AppError {
    match err {
        sqlx::Error::RowNotFound => AppError::new(code, message),
        other => AppError::from(other),
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// 测试装置：插入最简服务（挂在既有工作空间下）。
    pub async fn seed_service(
        conn: impl Executor<'_, Database = Sqlite>,
        id: &str,
        workspace_id: &str,
        name: &str,
    ) -> Service {
        seed_service_with_doc_url(conn, id, workspace_id, name, None).await
    }

    /// 测试装置：带文档地址的服务（可达性探测 / 同步拉取链路测试用）。
    pub async fn seed_service_with_doc_url(
        conn: impl Executor<'_, Database = Sqlite>,
        id: &str,
        workspace_id: &str,
        name: &str,
        doc_url: Option<&str>,
    ) -> Service {
        insert(
            conn,
            &NewService {
                id: id.to_owned(),
                workspace_id: workspace_id.to_owned(),
                name: name.to_owned(),
                doc_url: doc_url.map(str::to_owned),
                doc_type: crate::domain::service::DOC_TYPE_OPENAPI.to_owned(),
            },
        )
        .await
        .expect("seed service must insert")
    }
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
    async fn insert_appends_sort_order_in_workspace_sequence() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "默认工作空间").await;
        let a = test_support::seed_service(&pool, "s1", "w1", "服务A").await;
        let b = test_support::seed_service(&pool, "s2", "w1", "服务B").await;
        assert_eq!((a.sort_order, b.sort_order), (0, 1));
    }

    #[tokio::test]
    async fn update_changes_name_and_doc_url() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "默认工作空间").await;
        test_support::seed_service(&pool, "s1", "w1", "服务A").await;
        let updated = update(
            &pool,
            "s1",
            "服务A改",
            Some("https://example.com/openapi.json"),
        )
        .await
        .unwrap();
        assert_eq!(updated.name, "服务A改");
        assert_eq!(
            updated.doc_url.as_deref(),
            Some("https://example.com/openapi.json")
        );
        assert!(updated.updated_at >= updated.created_at);
        let err = update(&pool, "nope", "x", None).await.unwrap_err();
        assert_eq!(err.code, codes::SERVICE_NOT_FOUND);
    }

    #[tokio::test]
    async fn move_swaps_with_neighbor_and_is_idempotent_at_boundary() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "默认工作空间").await;
        test_support::seed_service(&pool, "s1", "w1", "服务A").await;
        test_support::seed_service(&pool, "s2", "w1", "服务B").await;
        test_support::seed_service(&pool, "s3", "w1", "服务C").await;

        move_service(&mut pool.acquire().await.unwrap(), "s2", MoveDirection::Up)
            .await
            .unwrap();
        assert_eq!(
            orders(&pool).await,
            vec![
                ("s2".to_owned(), 0),
                ("s1".to_owned(), 1),
                ("s3".to_owned(), 2)
            ]
        );

        // 已在顶部：再上移不动（幂等）
        move_service(&mut pool.acquire().await.unwrap(), "s2", MoveDirection::Up)
            .await
            .unwrap();
        assert_eq!(
            orders(&pool).await,
            vec![
                ("s2".to_owned(), 0),
                ("s1".to_owned(), 1),
                ("s3".to_owned(), 2)
            ]
        );

        move_service(
            &mut pool.acquire().await.unwrap(),
            "s2",
            MoveDirection::Down,
        )
        .await
        .unwrap();
        assert_eq!(
            orders(&pool).await,
            vec![
                ("s1".to_owned(), 0),
                ("s2".to_owned(), 1),
                ("s3".to_owned(), 2)
            ]
        );
    }

    #[tokio::test]
    async fn move_is_scoped_to_own_workspace() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        ws_support::seed_workspace(&pool, "w2", "二").await;
        test_support::seed_service(&pool, "s1", "w1", "一A").await;
        test_support::seed_service(&pool, "s2", "w2", "二A").await;
        // 两个工作空间各自从 0 起排：上移无邻者不动（不跨空间换位）
        move_service(&mut pool.acquire().await.unwrap(), "s2", MoveDirection::Up)
            .await
            .unwrap();
        let list = list_by_workspace(&pool, "w2").await.unwrap();
        assert_eq!(list[0].sort_order, 0);
    }

    #[tokio::test]
    async fn move_missing_service_reports_not_found() {
        let pool = memory_pool().await;
        let err = move_service(
            &mut pool.acquire().await.unwrap(),
            "nope",
            MoveDirection::Up,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, codes::SERVICE_NOT_FOUND);
    }

    #[tokio::test]
    async fn delete_removes_service_and_cascades_children() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        test_support::seed_service(&pool, "s1", "w1", "服务A").await;
        crate::infrastructure::category_repo::test_support::seed_category(
            &pool, "c1", "s1", "分类",
        )
        .await;
        crate::infrastructure::endpoint_repo::test_support::seed_endpoint(
            &pool, "s1", "e1", "接口",
        )
        .await;
        crate::infrastructure::user_data_repo::test_support::seed_user_data(&pool, "s1", "e1")
            .await;
        sqlx::query("INSERT INTO pinned_endpoints (service_id, key) VALUES ('s1', 'e1')")
            .execute(&pool)
            .await
            .unwrap();

        delete(&mut pool.acquire().await.unwrap(), "s1")
            .await
            .unwrap();

        assert_eq!(count_of(&pool, "categories").await, 0);
        assert_eq!(count_of(&pool, "endpoints").await, 0);
        assert_eq!(count_of(&pool, "endpoint_user_data").await, 0);
        assert_eq!(count_of(&pool, "pinned_endpoints").await, 0);
    }

    async fn orders(pool: &SqlitePool) -> Vec<(String, i64)> {
        sqlx::query_as("SELECT id, sort_order FROM services ORDER BY sort_order")
            .fetch_all(pool)
            .await
            .unwrap()
    }

    /// 按静态语句分派计数的测试助手（sqlx 对动态 SQL 字符串做注入审计）
    async fn count_of(pool: &SqlitePool, table: &str) -> i64 {
        let (count,): (i64,) = match table {
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
            _ => panic!("unexpected table: {table}"),
        };
        count
    }
}
