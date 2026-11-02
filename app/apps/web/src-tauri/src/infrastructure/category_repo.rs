//! 分类 repo：服务下的手工分组 CRUD 与相邻交换排序。

use sqlx::{Connection, Executor, Sqlite};

use crate::domain::category::{Category, NewCategory};
use crate::domain::service::MoveDirection;
use crate::error::AppError;
use crate::error::codes;

/// 分类清单（服务内按 sort_order 升序）。
pub async fn list_by_service(
    conn: impl Executor<'_, Database = Sqlite>,
    service_id: &str,
) -> Result<Vec<Category>, AppError> {
    let rows = sqlx::query_as::<_, Category>(
        "SELECT id, service_id, name, sort_order, created_at \
         FROM categories WHERE service_id = ? ORDER BY sort_order, created_at, id",
    )
    .bind(service_id)
    .fetch_all(conn)
    .await?;
    Ok(rows)
}

/// 按 id 取分类。
pub async fn get(
    conn: impl Executor<'_, Database = Sqlite>,
    id: &str,
) -> Result<Option<Category>, AppError> {
    let row = sqlx::query_as::<_, Category>(
        "SELECT id, service_id, name, sort_order, created_at FROM categories WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(conn)
    .await?;
    Ok(row)
}

/// 新建分类：sort_order 追加末尾。服务存在性由 services 层先行校验。
pub async fn insert(
    conn: impl Executor<'_, Database = Sqlite>,
    input: &NewCategory,
) -> Result<Category, AppError> {
    sqlx::query_as::<_, Category>(
        "INSERT INTO categories (id, service_id, name, sort_order, created_at) \
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM categories WHERE service_id = ?), \
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) \
         RETURNING id, service_id, name, sort_order, created_at",
    )
    .bind(&input.id)
    .bind(&input.service_id)
    .bind(&input.name)
    .bind(&input.service_id)
    .fetch_one(conn)
    .await
    .map_err(AppError::from)
}

/// 重命名分类。
pub async fn rename(
    conn: impl Executor<'_, Database = Sqlite>,
    id: &str,
    name: &str,
) -> Result<Category, AppError> {
    sqlx::query_as::<_, Category>(
        "UPDATE categories SET name = ? WHERE id = ? \
         RETURNING id, service_id, name, sort_order, created_at",
    )
    .bind(name)
    .bind(id)
    .fetch_one(conn)
    .await
    .map_err(|err| {
        missing(
            err,
            codes::CATEGORY_NOT_FOUND,
            "category rename matched no category",
        )
    })
}

/// 删除分类：其下接口经 FK SET NULL 上移散层，分类行本身删除。
pub async fn delete(conn: impl Executor<'_, Database = Sqlite>, id: &str) -> Result<u64, AppError> {
    let result = sqlx::query("DELETE FROM categories WHERE id = ?")
        .bind(id)
        .execute(conn)
        .await?;
    Ok(result.rows_affected())
}

/// 相邻交换排序（同服务内；边界幂等）。骨架共享自 sort_move（与服务同规则）。
pub async fn move_category(
    conn: &mut sqlx::SqliteConnection,
    id: &str,
    direction: MoveDirection,
) -> Result<(), AppError> {
    let mut tx = conn.begin().await?;
    crate::infrastructure::sort_move::swap_adjacent(
        &mut tx,
        crate::infrastructure::sort_move::AdjacentGroup {
            table: "categories",
            group_col: "service_id",
        },
        id,
        direction,
        AppError::new(
            codes::CATEGORY_NOT_FOUND,
            format!("category move matched no category: {id}"),
        ),
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

/// 移动分类到目标服务分类序列的 `index` 位（支持跨服务）：分类归属与整组
/// sort_order 在同一事务内重写。语义＝先从原序列摘除自身，再插入目标序列
/// `index` 位（越界钳制到末尾）；跨服务时其下接口随分类整体迁移——user_data
/// 与置顶以 (service_id, key) 为身份键，先于 endpoints 改写。手工键为
/// UUID 全局唯一，跨服务迁移无撞键；同步稳定键接入后跨服务拖拽的行级
/// 约束归同步域处理。
pub async fn move_category_to(
    conn: &mut sqlx::SqliteConnection,
    id: &str,
    target_service_id: &str,
    index: i64,
) -> Result<(), AppError> {
    let mut tx = conn.begin().await?;
    let source: Option<(String,)> =
        sqlx::query_as("SELECT service_id FROM categories WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((source_service_id,)) = source else {
        return Err(AppError::new(
            codes::CATEGORY_NOT_FOUND,
            format!("category move matched no category: {id}"),
        ));
    };
    let mut order: Vec<String> = sqlx::query_as::<_, (String,)>(
        "SELECT id FROM categories WHERE service_id = ? AND id != ? \
         ORDER BY sort_order, created_at, id",
    )
    .bind(target_service_id)
    .bind(id)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .map(|(id,)| id)
    .collect();
    crate::infrastructure::sort_move::insert_at_clamped(&mut order, id, index);
    for (position, category_id) in order.iter().enumerate() {
        sqlx::query("UPDATE categories SET sort_order = ?, service_id = ? WHERE id = ?")
            .bind(position as i64)
            .bind(target_service_id)
            .bind(category_id)
            .execute(&mut *tx)
            .await?;
    }
    // 身份键三表原子迁移（domain 级对账清单＝category::CROSS_SERVICE_KEY_TABLES，
    // 与 endpoints 改写同一事务）：任一步失败整事务回滚，用户数据不产生悬挂归属
    if source_service_id != target_service_id {
        sqlx::query(
            "UPDATE endpoint_user_data SET service_id = ? \
             WHERE service_id = ? AND key IN (SELECT key FROM endpoints WHERE category_id = ?)",
        )
        .bind(target_service_id)
        .bind(&source_service_id)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE pinned_endpoints SET service_id = ? \
             WHERE service_id = ? AND key IN (SELECT key FROM endpoints WHERE category_id = ?)",
        )
        .bind(target_service_id)
        .bind(&source_service_id)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE endpoints SET service_id = ? WHERE category_id = ?")
            .bind(target_service_id)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

fn missing(err: sqlx::Error, code: &'static str, message: &'static str) -> AppError {
    match err {
        sqlx::Error::RowNotFound => AppError::new(code, message),
        other => AppError::from(other),
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// 测试装置：插入最简分类（挂在既有服务下）。
    pub async fn seed_category(
        conn: impl Executor<'_, Database = Sqlite>,
        id: &str,
        service_id: &str,
        name: &str,
    ) -> Category {
        insert(
            conn,
            &NewCategory {
                id: id.to_owned(),
                service_id: service_id.to_owned(),
                name: name.to_owned(),
            },
        )
        .await
        .expect("seed category must insert")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::infrastructure::service_repo::test_support as service_support;
    use sqlx::SqlitePool;

    async fn memory_pool() -> SqlitePool {
        let pool = db::connect_in_memory().await;
        db::run_migrations(&pool).await.unwrap();
        pool
    }

    async fn seeded_pool() -> SqlitePool {
        let pool = memory_pool().await;
        crate::infrastructure::workspace_repo::test_support::seed_workspace(&pool, "w1", "一")
            .await;
        service_support::seed_service(&pool, "s1", "w1", "服务A").await;
        pool
    }

    #[tokio::test]
    async fn insert_appends_sort_order_per_service() {
        let pool = seeded_pool().await;
        let a = test_support::seed_category(&pool, "c1", "s1", "分类A").await;
        let b = test_support::seed_category(&pool, "c2", "s1", "分类B").await;
        assert_eq!((a.sort_order, b.sort_order), (0, 1));
    }

    #[tokio::test]
    async fn rename_updates_name() {
        let pool = seeded_pool().await;
        test_support::seed_category(&pool, "c1", "s1", "旧名").await;
        let renamed = rename(&pool, "c1", "新名").await.unwrap();
        assert_eq!(renamed.name, "新名");
        let err = rename(&pool, "nope", "x").await.unwrap_err();
        assert_eq!(err.code, codes::CATEGORY_NOT_FOUND);
    }

    #[tokio::test]
    async fn delete_moves_endpoints_to_service_scatter_level() {
        let pool = seeded_pool().await;
        test_support::seed_category(&pool, "c1", "s1", "分类A").await;
        crate::infrastructure::endpoint_repo::test_support::seed_endpoint_in_category(
            &pool,
            "s1",
            "e1",
            Some("c1"),
            "接口",
        )
        .await;

        delete(&pool, "c1").await.unwrap();

        let (in_category,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM endpoints WHERE category_id IS NOT NULL")
                .fetch_one(&pool)
                .await
                .unwrap();
        let (scatter,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM endpoints WHERE category_id IS NULL AND service_id = 's1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(in_category, 0);
        assert_eq!(scatter, 1, "分类删除后接口应上移散层");
    }

    #[tokio::test]
    async fn move_swaps_within_service_and_is_idempotent_at_boundary() {
        let pool = seeded_pool().await;
        test_support::seed_category(&pool, "c1", "s1", "分类A").await;
        test_support::seed_category(&pool, "c2", "s1", "分类B").await;

        move_category(
            &mut pool.acquire().await.unwrap(),
            "c1",
            MoveDirection::Down,
        )
        .await
        .unwrap();
        let list = list_by_service(&pool, "s1").await.unwrap();
        assert_eq!(
            list.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            vec!["c2", "c1"]
        );

        // c1 已在底部：再下移不动
        move_category(
            &mut pool.acquire().await.unwrap(),
            "c1",
            MoveDirection::Down,
        )
        .await
        .unwrap();
        let list = list_by_service(&pool, "s1").await.unwrap();
        assert_eq!(
            list.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            vec!["c2", "c1"]
        );
    }

    #[tokio::test]
    async fn move_missing_category_reports_not_found() {
        let pool = seeded_pool().await;
        let err = move_category(
            &mut pool.acquire().await.unwrap(),
            "nope",
            MoveDirection::Up,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, codes::CATEGORY_NOT_FOUND);
    }

    #[tokio::test]
    async fn cross_service_move_migrates_endpoints_with_user_data_and_pins() {
        let pool = seeded_pool().await;
        service_support::seed_service(&pool, "s2", "w1", "服务B").await;
        test_support::seed_category(&pool, "c1", "s1", "分类A").await;
        crate::infrastructure::endpoint_repo::test_support::seed_endpoint_in_category(
            &pool,
            "s1",
            "e1",
            Some("c1"),
            "随迁接口",
        )
        .await;
        crate::infrastructure::endpoint_repo::test_support::seed_endpoint(
            &pool,
            "s1",
            "e2",
            "散层留守",
        )
        .await;
        crate::infrastructure::user_data_repo::test_support::seed_user_data(&pool, "s1", "e1")
            .await;
        crate::infrastructure::endpoint_repo::set_pinned(&pool, "s1", "e1", true)
            .await
            .unwrap();

        move_category_to(&mut pool.acquire().await.unwrap(), "c1", "s2", 0)
            .await
            .unwrap();

        // 分类与接口归属迁移
        let (category_service,): (String,) =
            sqlx::query_as("SELECT service_id FROM categories WHERE id = 'c1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(category_service, "s2");
        let (endpoint_service,): (String,) =
            sqlx::query_as("SELECT service_id FROM endpoints WHERE key = 'e1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(endpoint_service, "s2", "分类下接口应随分类迁移");
        // 身份键三表同步：user_data / 置顶跟随，散层接口不动
        let (ud_service,): (String,) =
            sqlx::query_as("SELECT service_id FROM endpoint_user_data WHERE key = 'e1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(ud_service, "s2", "用户数据应随接口迁移不悬挂");
        let (pin_service,): (String,) =
            sqlx::query_as("SELECT service_id FROM pinned_endpoints WHERE key = 'e1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(pin_service, "s2");
        let (scatter_service,): (String,) =
            sqlx::query_as("SELECT service_id FROM endpoints WHERE key = 'e2'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(scatter_service, "s1", "散层接口不随分类迁移");
    }

    #[tokio::test]
    async fn same_service_move_keeps_endpoint_service_id() {
        let pool = seeded_pool().await;
        test_support::seed_category(&pool, "c1", "s1", "分类A").await;
        test_support::seed_category(&pool, "c2", "s1", "分类B").await;
        crate::infrastructure::endpoint_repo::test_support::seed_endpoint_in_category(
            &pool,
            "s1",
            "e1",
            Some("c1"),
            "接口",
        )
        .await;

        move_category_to(&mut pool.acquire().await.unwrap(), "c1", "s1", 1)
            .await
            .unwrap();

        let (service_id,): (String,) =
            sqlx::query_as("SELECT service_id FROM endpoints WHERE key = 'e1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(service_id, "s1");
    }
}
