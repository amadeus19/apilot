//! 分类应用服务：服务下的手工分组 CRUD 与相邻交换。

use serde::Serialize;
use sqlx::SqlitePool;

use crate::domain::category::{Category, NewCategory};
use crate::domain::endpoint::new_manual_identity;
use crate::domain::service::MoveDirection;
use crate::domain::validate::normalize_name;
use crate::error::AppError;
use crate::error::codes;
use crate::infrastructure::category_repo;

/// 分类 DTO。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryDto {
    pub id: String,
    pub service_id: String,
    pub name: String,
    pub sort_order: i64,
}

fn to_dto(category: Category) -> CategoryDto {
    CategoryDto {
        id: category.id,
        service_id: category.service_id,
        name: category.name,
        sort_order: category.sort_order,
    }
}

/// 新建分类（服务必已存在；名称校验共用规则）。
pub async fn create(
    pool: &SqlitePool,
    service_id: &str,
    name: &str,
) -> Result<CategoryDto, AppError> {
    crate::services::service::require_service(pool, service_id).await?;
    let name = normalize_name(name)?;
    let created = category_repo::insert(
        pool,
        &NewCategory {
            id: new_manual_identity(),
            service_id: service_id.to_owned(),
            name,
        },
    )
    .await?;
    Ok(to_dto(created))
}

/// 重命名分类。
pub async fn rename(pool: &SqlitePool, id: &str, name: &str) -> Result<CategoryDto, AppError> {
    let name = normalize_name(name)?;
    let renamed = category_repo::rename(pool, id, &name).await?;
    Ok(to_dto(renamed))
}

/// 删除分类：其下接口上移散层（FK SET NULL），无行级联。
pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), AppError> {
    category_repo::get(pool, id).await?.ok_or_else(|| {
        AppError::new(
            codes::CATEGORY_NOT_FOUND,
            format!("category not found: {id}"),
        )
    })?;
    category_repo::delete(pool, id).await?;
    Ok(())
}

/// 相邻交换排序（上移 / 下移）。
pub async fn move_category(
    pool: &SqlitePool,
    id: &str,
    direction: MoveDirection,
) -> Result<(), AppError> {
    category_repo::move_category(&mut *pool.acquire().await?, id, direction).await
}

/// 移动分类到目标服务分类序列的目标位置（拖拽排序通道，支持跨服务；
/// 目标服务必已存在——跨服务拖动的归属变更在此校验）。
pub async fn move_category_to(
    pool: &SqlitePool,
    id: &str,
    target_service_id: &str,
    index: i64,
) -> Result<(), AppError> {
    crate::services::service::require_service(pool, target_service_id).await?;
    category_repo::move_category_to(&mut *pool.acquire().await?, id, target_service_id, index).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::infrastructure::service_repo::test_support as service_support;
    use crate::infrastructure::workspace_repo::test_support as ws_support;

    async fn memory_pool() -> SqlitePool {
        let pool = db::connect_in_memory().await;
        db::run_migrations(&pool).await.unwrap();
        pool
    }

    async fn seeded_pool() -> SqlitePool {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        service_support::seed_service(&pool, "s1", "w1", "服务").await;
        pool
    }

    #[tokio::test]
    async fn create_requires_existing_service_and_valid_name() {
        let pool = seeded_pool().await;
        let created = create(&pool, "s1", "  分类A  ").await.unwrap();
        assert_eq!(created.name, "分类A");
        let err = create(&pool, "nope", "分类B").await.unwrap_err();
        assert_eq!(err.code, codes::SERVICE_NOT_FOUND);
        let err = create(&pool, "s1", "").await.unwrap_err();
        assert_eq!(err.code, codes::NAME_INVALID);
    }

    #[tokio::test]
    async fn rename_and_delete_require_existing_category() {
        let pool = seeded_pool().await;
        let created = create(&pool, "s1", "分类A").await.unwrap();
        let renamed = rename(&pool, &created.id, "分类A改").await.unwrap();
        assert_eq!(renamed.name, "分类A改");

        delete(&pool, &created.id).await.unwrap();
        let err = rename(&pool, &created.id, "再来").await.unwrap_err();
        assert_eq!(err.code, codes::CATEGORY_NOT_FOUND);
        let err = delete(&pool, &created.id).await.unwrap_err();
        assert_eq!(err.code, codes::CATEGORY_NOT_FOUND);
    }

    #[tokio::test]
    async fn move_requires_existing_category() {
        let pool = seeded_pool().await;
        let err = move_category(&pool, "nope", MoveDirection::Up)
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::CATEGORY_NOT_FOUND);
    }
}
