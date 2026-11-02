//! 手工接口应用服务：新建 / 编辑（UUID 身份不变）、硬删除与置顶。
//!
//! 撞车允许并存：手工 UUID 与同步稳定键值域物理不撞；手工接口之间同
//! （方法, 路径）允许重复（标题区分），同步流程不被手工内容阻塞。

use serde::Serialize;
use sqlx::SqlitePool;

use crate::domain::endpoint::{
    Definition, Endpoint, HttpMethod, ManualEndpointInput, new_manual_identity,
};
use crate::domain::validate::normalize_name;
use crate::error::AppError;
use crate::error::codes;
use crate::infrastructure::{category_repo, endpoint_repo};

/// 接口 DTO（badge 仅同步域消费，不外发）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointDto {
    pub service_id: String,
    pub key: String,
    pub title: String,
    pub category_id: Option<String>,
    pub definition: DefinitionDto,
}

/// 定义 DTO：方法 + 路径模板。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionDto {
    pub method: String,
    pub path_template: String,
}

fn to_dto(endpoint: Endpoint) -> Result<EndpointDto, AppError> {
    // 库中 definition 为本服务写入的 JSON；形态异常按脏数据处理（跳过由树组装层负责，
    // 单实体路径报数据错误）
    let definition: Definition = serde_json::from_str(&endpoint.definition).map_err(|err| {
        AppError::new(
            codes::DB_QUERY_FAILED,
            format!("corrupt endpoint definition: {err}"),
        )
    })?;
    Ok(EndpointDto {
        service_id: endpoint.service_id,
        key: endpoint.key,
        title: endpoint.title,
        category_id: endpoint.category_id,
        definition: DefinitionDto {
            method: definition.method.as_str().to_owned(),
            path_template: definition.path_template,
        },
    })
}

/// 新建手工接口（服务必选；分类可选且必须属于同一服务；身份＝UUID）。
pub async fn create_manual(
    pool: &SqlitePool,
    service_id: &str,
    method: &str,
    path_template: &str,
    title: &str,
    category_id: Option<&str>,
) -> Result<EndpointDto, AppError> {
    crate::services::service::require_service(pool, service_id).await?;
    let category_id = require_category_in_service(pool, service_id, category_id).await?;
    let title = normalize_name(title)?;
    let definition = Definition::new(HttpMethod::parse(method)?, path_template)?;
    let created = endpoint_repo::insert_manual(
        pool,
        &ManualEndpointInput {
            service_id: service_id.to_owned(),
            key: new_manual_identity(),
            title,
            category_id,
            definition,
        },
    )
    .await?;
    to_dto(created)
}

/// 编辑手工接口的结构字段（标题 / 方法 / 路径 / 分类），UUID 身份不变。
pub async fn update_manual(
    pool: &SqlitePool,
    service_id: &str,
    key: &str,
    method: &str,
    path_template: &str,
    title: &str,
    category_id: Option<&str>,
) -> Result<EndpointDto, AppError> {
    require_endpoint(pool, service_id, key).await?;
    let category_id = require_category_in_service(pool, service_id, category_id).await?;
    let title = normalize_name(title)?;
    let definition = Definition::new(HttpMethod::parse(method)?, path_template)?;
    let updated = endpoint_repo::update_manual(
        pool,
        service_id,
        key,
        &title,
        &definition,
        category_id.as_deref(),
    )
    .await?;
    to_dto(updated)
}

/// 硬删除接口并连带清除用户数据与置顶（同事务；确认弹窗语义在前端）。
pub async fn delete(pool: &SqlitePool, service_id: &str, key: &str) -> Result<(), AppError> {
    require_endpoint(pool, service_id, key).await?;
    endpoint_repo::delete_manual(&mut *pool.acquire().await?, service_id, key).await?;
    Ok(())
}

/// 接口定义侧文档元数据（文档抽屉数据源）。
///
/// `None` 语义＝该接口无文档数据（手工接口 definition 恒瘦形态；同步接口
/// 在首次同步应用前同样为瘦形态）——入口显隐由前端按稳定键判定，本函数
/// 不参与显隐决策，只负责有则给全。
pub async fn doc(
    pool: &SqlitePool,
    service_id: &str,
    key: &str,
) -> Result<Option<crate::domain::endpoint::EndpointDoc>, AppError> {
    let endpoint = endpoint_repo::get(pool, service_id, key)
        .await?
        .ok_or_else(|| AppError::new(codes::ENDPOINT_NOT_FOUND, format!("{service_id}/{key}")))?;
    let definition: Definition = serde_json::from_str(&endpoint.definition).map_err(|err| {
        AppError::new(
            codes::DB_QUERY_FAILED,
            format!("corrupt endpoint definition: {err}"),
        )
    })?;
    Ok(definition.doc)
}

/// 置顶开关。
pub async fn set_pinned(
    pool: &SqlitePool,
    service_id: &str,
    key: &str,
    pinned: bool,
) -> Result<(), AppError> {
    require_endpoint(pool, service_id, key).await?;
    endpoint_repo::set_pinned(pool, service_id, key, pinned).await
}

/// 移动接口到目标分组（同服务）的目标位置（拖拽 / 上移下移共用通道）；
/// 目标分类可选且必须属于同一服务。
pub async fn move_endpoint(
    pool: &SqlitePool,
    service_id: &str,
    key: &str,
    target_category_id: Option<&str>,
    index: i64,
) -> Result<(), AppError> {
    require_endpoint(pool, service_id, key).await?;
    let target_category_id =
        require_category_in_service(pool, service_id, target_category_id).await?;
    endpoint_repo::move_endpoint(
        &mut *pool.acquire().await?,
        service_id,
        key,
        target_category_id.as_deref(),
        index,
    )
    .await
}

async fn require_endpoint(
    pool: &SqlitePool,
    service_id: &str,
    key: &str,
) -> Result<Endpoint, AppError> {
    endpoint_repo::get(pool, service_id, key)
        .await?
        .ok_or_else(|| {
            AppError::new(
                codes::ENDPOINT_NOT_FOUND,
                format!("endpoint not found: {service_id}/{key}"),
            )
        })
}

/// 分类可选；给定时必须存在且属于同一服务（跨服务挂载视为分类不存在）。
async fn require_category_in_service(
    pool: &SqlitePool,
    service_id: &str,
    category_id: Option<&str>,
) -> Result<Option<String>, AppError> {
    let Some(category_id) = category_id else {
        return Ok(None);
    };
    let category = category_repo::get(pool, category_id)
        .await?
        .ok_or_else(|| {
            AppError::new(
                codes::CATEGORY_NOT_FOUND,
                format!("category not found: {category_id}"),
            )
        })?;
    if category.service_id != service_id {
        return Err(AppError::new(
            codes::CATEGORY_NOT_FOUND,
            format!("category {category_id} does not belong to service {service_id}"),
        ));
    }
    Ok(Some(category_id.to_owned()))
}

/// 删除级联范围（供测试与未来确认弹窗数据面复用；表清单为对账基准）。
#[cfg(test)]
pub(crate) fn endpoint_cascade_tables() -> &'static [&'static str] {
    crate::domain::endpoint::cascade_scope(crate::domain::endpoint::CascadeEntity::Endpoint).tables
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::infrastructure::category_repo::test_support as category_support;
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

    /// 文档元数据读取：瘦 definition（手工接口与未应用同步的接口）→ None；
    /// 扩容形态 → Some 且往返保真；接口不存在 → ENDPOINT_NOT_FOUND。
    #[tokio::test]
    async fn doc_reads_none_for_thin_and_some_for_expanded() {
        let pool = seeded_pool().await;
        // 瘦形态（既有手工路径写入的形态）
        sqlx::query(
            "INSERT INTO endpoints (service_id, key, title, definition, created_at) \
             VALUES ('s1', '019aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '手工', '{\"method\":\"GET\",\"path_template\":\"/a\"}', '2026-01-01T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert!(
            doc(&pool, "s1", "019aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
                .await
                .unwrap()
                .is_none()
        );

        // 扩容形态（应用事务写入）：doc 元数据往返保真
        let expanded = Definition {
            method: crate::domain::endpoint::HttpMethod::GET,
            path_template: "/users".into(),
            doc: Some(crate::domain::endpoint::EndpointDoc {
                title: "用户列表".into(),
                category: Some("用户".into()),
                description: Some("分页返回全部用户".into()),
                parameters: vec![],
                request_body: None,
                responses: vec![],
            }),
        };
        sqlx::query(
            "INSERT INTO endpoints (service_id, key, title, definition, created_at) \
             VALUES ('s1', 'GET /users', '用户列表', ?, '2026-01-01T00:00:00Z')",
        )
        .bind(serde_json::to_string(&expanded).unwrap())
        .execute(&pool)
        .await
        .unwrap();
        let got = doc(&pool, "s1", "GET /users")
            .await
            .unwrap()
            .expect("expanded doc");
        assert_eq!(got.title, "用户列表");
        assert_eq!(got.category.as_deref(), Some("用户"));

        let err = doc(&pool, "s1", "GET /missing").await.unwrap_err();
        assert_eq!(err.code, codes::ENDPOINT_NOT_FOUND);
    }

    #[tokio::test]
    async fn create_manual_assigns_uuid_identity_and_validates() {
        let pool = seeded_pool().await;
        let a = create_manual(&pool, "s1", "get", "/users", "查询用户", None)
            .await
            .unwrap();
        assert_ne!(a.key, "", "手工身份必须由服务端生成 UUID");
        assert_eq!(a.key.len(), 36);
        assert_eq!(a.definition.method, "GET");
        assert_eq!(a.definition.path_template, "/users");

        // 同（方法, 路径）撞车允许并存（标题区分）
        let b = create_manual(&pool, "s1", "GET", "/users", "查询用户二", None)
            .await
            .unwrap();
        assert_ne!(a.key, b.key);

        let err = create_manual(&pool, "nope", "GET", "/x", "t", None)
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::SERVICE_NOT_FOUND);
        let err = create_manual(&pool, "s1", "BREW", "/x", "t", None)
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::INVALID_HTTP_METHOD);
        let err = create_manual(&pool, "s1", "GET", "no-slash", "t", None)
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::INVALID_PATH_TEMPLATE);
        let err = create_manual(&pool, "s1", "GET", "/x", "  ", None)
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::NAME_INVALID);
    }

    #[tokio::test]
    async fn create_manual_requires_category_within_same_service() {
        let pool = seeded_pool().await;
        category_support::seed_category(&pool, "c1", "s1", "分类").await;
        let with_category = create_manual(&pool, "s1", "GET", "/x", "t", Some("c1"))
            .await
            .unwrap();
        assert_eq!(with_category.category_id.as_deref(), Some("c1"));

        // 跨服务分类视为不存在
        service_support::seed_service(&pool, "s2", "w1", "服务二").await;
        category_support::seed_category(&pool, "c2", "s2", "他服务分类").await;
        let err = create_manual(&pool, "s1", "GET", "/x", "t", Some("c2"))
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::CATEGORY_NOT_FOUND);
        let err = create_manual(&pool, "s1", "GET", "/x", "t", Some("nope"))
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::CATEGORY_NOT_FOUND);
    }

    #[tokio::test]
    async fn update_manual_keeps_uuid_and_changes_structure() {
        let pool = seeded_pool().await;
        category_support::seed_category(&pool, "c1", "s1", "分类").await;
        let created = create_manual(&pool, "s1", "GET", "/x", "旧", None)
            .await
            .unwrap();

        let updated = update_manual(&pool, "s1", &created.key, "POST", "/v2/y", "新", Some("c1"))
            .await
            .unwrap();
        assert_eq!(updated.key, created.key, "UUID 身份不变");
        assert_eq!(updated.title, "新");
        assert_eq!(updated.definition.method, "POST");
        assert_eq!(updated.category_id.as_deref(), Some("c1"));

        let err = update_manual(&pool, "s1", "nope", "GET", "/x", "t", None)
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::ENDPOINT_NOT_FOUND);
    }

    #[tokio::test]
    async fn delete_hard_removes_endpoint_with_user_data_and_pin() {
        let pool = seeded_pool().await;
        let created = create_manual(&pool, "s1", "GET", "/x", "接口", None)
            .await
            .unwrap();
        crate::infrastructure::user_data_repo::test_support::seed_user_data(
            &pool,
            "s1",
            &created.key,
        )
        .await;
        endpoint_repo::set_pinned(&pool, "s1", &created.key, true)
            .await
            .unwrap();

        delete(&pool, "s1", &created.key).await.unwrap();

        let (rows,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM endpoints")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(rows, 0);
        let (user_data,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM endpoint_user_data")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(user_data, 0, "硬删除必须连带清除用户数据");
        let (pinned,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pinned_endpoints")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(pinned, 0);

        let err = delete(&pool, "s1", &created.key).await.unwrap_err();
        assert_eq!(err.code, codes::ENDPOINT_NOT_FOUND);
    }

    #[tokio::test]
    async fn set_pinned_toggles() {
        let pool = seeded_pool().await;
        let created = create_manual(&pool, "s1", "GET", "/x", "接口", None)
            .await
            .unwrap();
        set_pinned(&pool, "s1", &created.key, true).await.unwrap();
        assert_eq!(
            endpoint_repo::list_pinned(&pool, "s1").await.unwrap(),
            vec![created.key.clone()]
        );
        set_pinned(&pool, "s1", &created.key, false).await.unwrap();
        assert!(
            endpoint_repo::list_pinned(&pool, "s1")
                .await
                .unwrap()
                .is_empty()
        );
        let err = set_pinned(&pool, "s1", "nope", true).await.unwrap_err();
        assert_eq!(err.code, codes::ENDPOINT_NOT_FOUND);
    }

    #[test]
    fn cascade_tables_cover_manual_tables() {
        // 级联范围对账：接口删除的三张表里，user_data 与置顶为无外键手工清除面
        let tables = endpoint_cascade_tables();
        assert_eq!(tables.len(), 3);
    }
}
