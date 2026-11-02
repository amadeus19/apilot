//! 服务（Service）应用服务：新建 / 编辑同语义、级联删除与相邻交换编排。

use serde::Serialize;
use sqlx::SqlitePool;

use crate::domain::endpoint::new_manual_identity;
use crate::domain::service::{DOC_TYPE_OPENAPI, MoveDirection, NewService, Service};
use crate::domain::validate::{normalize_base_url, normalize_name};
use crate::error::AppError;
use crate::error::codes;
use crate::infrastructure::{service_repo, workspace_repo};

/// 服务摘要 DTO（树视图之外的清单消费面）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDto {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub doc_url: Option<String>,
    pub doc_type: String,
    pub sort_order: i64,
}

pub(crate) fn to_dto(service: Service) -> ServiceDto {
    ServiceDto {
        id: service.id,
        workspace_id: service.workspace_id,
        name: service.name,
        doc_url: service.doc_url,
        doc_type: service.doc_type,
        sort_order: service.sort_order,
    }
}

/// 工作空间下的服务清单（排序序）。
pub async fn list_by_workspace(
    pool: &SqlitePool,
    workspace_id: &str,
) -> Result<Vec<ServiceDto>, AppError> {
    require_workspace(pool, workspace_id).await?;
    Ok(service_repo::list_by_workspace(pool, workspace_id)
        .await?
        .into_iter()
        .map(to_dto)
        .collect())
}

/// 新建服务：名称 + 可选文档地址（NULL＝纯手工容器）。
pub async fn create(
    pool: &SqlitePool,
    workspace_id: &str,
    name: &str,
    doc_url: Option<&str>,
) -> Result<ServiceDto, AppError> {
    require_workspace(pool, workspace_id).await?;
    let name = normalize_name(name)?;
    let doc_url = normalize_base_url(doc_url)?;
    let created = service_repo::insert(
        pool,
        &NewService {
            id: new_manual_identity(),
            workspace_id: workspace_id.to_owned(),
            name,
            doc_url,
            doc_type: DOC_TYPE_OPENAPI.to_owned(),
        },
    )
    .await?;
    Ok(to_dto(created))
}

/// 更新服务（名称 + 可选文档地址；补地址＝编辑即完成，探测与同步归同步域）。
pub async fn update(
    pool: &SqlitePool,
    id: &str,
    name: &str,
    doc_url: Option<&str>,
) -> Result<ServiceDto, AppError> {
    let name = normalize_name(name)?;
    let doc_url = normalize_base_url(doc_url)?;
    let updated = service_repo::update(pool, id, &name, doc_url.as_deref()).await?;
    Ok(to_dto(updated))
}

/// 删除服务（级联确认语义在前端；连带清除无外键的 user_data 见 repo）。
pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), AppError> {
    require_service(pool, id).await?;
    service_repo::delete(&mut *pool.acquire().await?, id).await?;
    Ok(())
}

/// 相邻交换排序（上移 / 下移）。
pub async fn move_service(
    pool: &SqlitePool,
    id: &str,
    direction: MoveDirection,
) -> Result<(), AppError> {
    service_repo::move_service(&mut *pool.acquire().await?, id, direction).await
}

/// 移动服务到工作空间服务序列的目标位置（拖拽排序通道；服务不跨工作空间）。
pub async fn move_service_to(pool: &SqlitePool, id: &str, index: i64) -> Result<(), AppError> {
    service_repo::move_service_to(&mut *pool.acquire().await?, id, index).await
}

async fn require_workspace(pool: &SqlitePool, id: &str) -> Result<(), AppError> {
    workspace_repo::get(pool, id).await?.ok_or_else(|| {
        AppError::new(
            codes::WORKSPACE_NOT_FOUND,
            format!("workspace not found: {id}"),
        )
    })?;
    Ok(())
}

pub(crate) async fn require_service(pool: &SqlitePool, id: &str) -> Result<Service, AppError> {
    service_repo::get(pool, id)
        .await?
        .ok_or_else(|| AppError::new(codes::SERVICE_NOT_FOUND, format!("service not found: {id}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::infrastructure::workspace_repo::test_support as ws_support;

    async fn memory_pool() -> SqlitePool {
        let pool = db::connect_in_memory().await;
        db::run_migrations(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn create_validates_workspace_and_name_and_normalizes_doc_url() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;

        let created = create(
            &pool,
            "w1",
            "  服务A  ",
            Some(" https://example.com/openapi.json "),
        )
        .await
        .unwrap();
        assert_eq!(created.name, "服务A");
        assert_eq!(
            created.doc_url.as_deref(),
            Some("https://example.com/openapi.json")
        );
        assert_eq!(created.doc_type, DOC_TYPE_OPENAPI);
        assert_eq!(created.sort_order, 0);

        let err = create(&pool, "nope", "服务B", None).await.unwrap_err();
        assert_eq!(err.code, codes::WORKSPACE_NOT_FOUND);
        let err = create(&pool, "w1", " ", None).await.unwrap_err();
        assert_eq!(err.code, codes::NAME_INVALID);
        // 文档地址只做形状级校验（非空 + 长度），语义可达性归同步域探测
        let plain = create(&pool, "w1", "服务C", Some("https://plain"))
            .await
            .unwrap();
        assert_eq!(plain.doc_url.as_deref(), Some("https://plain"));
    }

    #[tokio::test]
    async fn list_orders_by_sort_order() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        create(&pool, "w1", "服务A", None).await.unwrap();
        create(&pool, "w1", "服务B", None).await.unwrap();
        let list = list_by_workspace(&pool, "w1").await.unwrap();
        assert_eq!(
            list.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            vec!["服务A", "服务B"]
        );
        assert_eq!(
            list.iter().map(|s| s.sort_order).collect::<Vec<_>>(),
            vec![0, 1]
        );
    }

    #[tokio::test]
    async fn update_changes_fields_and_keeps_workspace() {
        let pool = memory_pool().await;
        ws_support::seed_workspace(&pool, "w1", "一").await;
        let created = create(&pool, "w1", "服务A", None).await.unwrap();
        let updated = update(&pool, &created.id, "服务A改", Some("https://x.example"))
            .await
            .unwrap();
        assert_eq!(updated.name, "服务A改");
        assert_eq!(updated.workspace_id, "w1");
        let err = update(&pool, "nope", "x", None).await.unwrap_err();
        assert_eq!(err.code, codes::SERVICE_NOT_FOUND);
    }

    #[tokio::test]
    async fn delete_and_move_require_existing_entity() {
        let pool = memory_pool().await;
        let err = delete(&pool, "nope").await.unwrap_err();
        assert_eq!(err.code, codes::SERVICE_NOT_FOUND);
        let err = move_service(&pool, "nope", MoveDirection::Up)
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::SERVICE_NOT_FOUND);
    }
}
