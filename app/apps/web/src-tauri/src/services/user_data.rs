//! 接口用户数据（草稿）应用服务：整包读写，大小上限校验。
//!
//! 写路径不校验接口存在性：草稿以身份为键，接口删除路径（硬删 / 级联）
//! 负责清除对应行；防抖写与删除竞速时多写一行会在下次级联中消失，
//! 不阻塞编辑主链路。

use serde::Serialize;
use sqlx::SqlitePool;

use crate::domain::user_data::{EndpointUserData, UserDataInput};
use crate::error::AppError;
use crate::infrastructure::user_data_repo;

/// 草稿 DTO。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserDataDto {
    pub service_id: String,
    pub key: String,
    pub body: Option<String>,
    pub params: String,
    pub headers: String,
    pub timeout_seconds: Option<i64>,
    pub auth: Option<String>,
    pub path_override: Option<String>,
    pub method_override: Option<String>,
    pub updated_at: String,
}

fn to_dto(data: EndpointUserData) -> UserDataDto {
    UserDataDto {
        service_id: data.service_id,
        key: data.key,
        body: data.body,
        params: data.params,
        headers: data.headers,
        timeout_seconds: data.timeout_seconds,
        auth: data.auth,
        path_override: data.path_override,
        method_override: data.method_override,
        updated_at: data.updated_at,
    }
}

/// 读草稿（Tab 挂载读一次；无记录返回 None）。
pub async fn get(
    pool: &SqlitePool,
    service_id: &str,
    key: &str,
) -> Result<Option<UserDataDto>, AppError> {
    Ok(user_data_repo::get(pool, service_id, key)
        .await?
        .map(to_dto))
}

/// 整包写（body / params / headers / timeout_seconds / auth / path_override
/// 一次 upsert）；大小与超时值域沿领域校验（auth 为前端组装 JSON，写路径
/// 不感知语义）。路径覆写空白串归一为 None（＝跟随定义），非空值过定义
/// 路径同一校验器。
#[allow(clippy::too_many_arguments)] // 整包写的列级参数面＝用户数据写路径契约
pub async fn upsert(
    pool: &SqlitePool,
    service_id: &str,
    key: &str,
    body: Option<String>,
    params: String,
    headers: String,
    timeout_seconds: Option<i64>,
    auth: Option<String>,
    path_override: Option<String>,
    method_override: Option<String>,
) -> Result<UserDataDto, AppError> {
    let path_override = path_override
        .map(|p| p.trim().to_owned())
        .filter(|p| !p.is_empty());
    let method_override = method_override
        .map(|m| m.trim().to_ascii_uppercase())
        .filter(|m| !m.is_empty());
    let input = UserDataInput {
        body,
        params,
        headers,
        timeout_seconds,
        auth,
        path_override,
        method_override,
    };
    input.validate_size()?;
    input.validate_timeout()?;
    input.validate_path_override()?;
    input.validate_method_override()?;
    let saved = user_data_repo::upsert(pool, service_id, key, &input).await?;
    Ok(to_dto(saved))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::infrastructure::endpoint_repo::test_support as endpoint_support;
    use crate::infrastructure::service_repo::test_support as service_support;
    use crate::infrastructure::workspace_repo::test_support as ws_support;

    async fn seeded_pool() -> SqlitePool {
        let pool = db::connect_in_memory().await;
        db::run_migrations(&pool).await.unwrap();
        ws_support::seed_workspace(&pool, "w1", "一").await;
        service_support::seed_service(&pool, "s1", "w1", "服务").await;
        endpoint_support::seed_endpoint(&pool, "s1", "e1", "接口").await;
        pool
    }

    #[tokio::test]
    async fn get_returns_none_then_written_value() {
        let pool = seeded_pool().await;
        assert!(get(&pool, "s1", "e1").await.unwrap().is_none());
        upsert(
            &pool,
            "s1",
            "e1",
            Some("body".into()),
            "[1]".into(),
            "{}".into(),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let draft = get(&pool, "s1", "e1").await.unwrap().unwrap();
        assert_eq!(draft.body.as_deref(), Some("body"));
        assert_eq!(draft.params, "[1]");
        assert_eq!(draft.timeout_seconds, None);
    }

    #[tokio::test]
    async fn upsert_is_whole_package_idempotent() {
        let pool = seeded_pool().await;
        for _ in 0..3 {
            upsert(
                &pool,
                "s1",
                "e1",
                Some("final".into()),
                "[]".into(),
                "{}".into(),
                Some(30),
                None,
                None,
                None,
            )
            .await
            .unwrap();
        }
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT body FROM endpoint_user_data WHERE service_id = 's1' AND key = 'e1'",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(rows.len(), 1, "重复整包写不产生多行");
        assert_eq!(rows[0].0, "final");
        // 超时覆写随整包持久化
        let draft = get(&pool, "s1", "e1").await.unwrap().unwrap();
        assert_eq!(draft.timeout_seconds, Some(30));
    }

    #[tokio::test]
    async fn upsert_rejects_oversized_payload() {
        let pool = seeded_pool().await;
        let big = "x".repeat(crate::constants::MAX_USER_DATA_BYTES / 2 + 16);
        let err = upsert(
            &pool,
            "s1",
            "e1",
            Some(big.clone()),
            big.clone(),
            big,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "USER_DATA_TOO_LARGE");
    }

    #[tokio::test]
    async fn upsert_rejects_invalid_timeout_range() {
        let pool = seeded_pool().await;
        let err = upsert(
            &pool,
            "s1",
            "e1",
            None,
            "[]".into(),
            "{}".into(),
            Some(-1),
            None,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "INVALID_ARGUMENT");
        let too_big = crate::domain::user_data::MAX_ENDPOINT_TIMEOUT_SECONDS + 1;
        let err = upsert(
            &pool,
            "s1",
            "e1",
            None,
            "[]".into(),
            "{}".into(),
            Some(too_big),
            None,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "INVALID_ARGUMENT");
        // 值域内三态均合法
        for ok in [None, Some(0), Some(45)] {
            upsert(
                &pool,
                "s1",
                "e1",
                None,
                "[]".into(),
                "{}".into(),
                ok,
                None,
                None,
                None,
            )
            .await
            .unwrap();
        }
    }

    /// 路径覆写：空白串归一为 None、合法值原样落库、非法形状拒绝
    #[tokio::test]
    async fn upsert_normalizes_and_validates_path_override() {
        let pool = seeded_pool().await;
        // 空白串＝清除覆写（归一为 None）
        let saved = upsert(
            &pool,
            "s1",
            "e1",
            None,
            "[]".into(),
            "{}".into(),
            None,
            None,
            Some("   ".into()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(saved.path_override, None, "空白覆写归一为跟随定义");
        // 合法覆写落库
        let saved = upsert(
            &pool,
            "s1",
            "e1",
            None,
            "[]".into(),
            "{}".into(),
            None,
            None,
            Some("/users/{id}/orders".into()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(saved.path_override.as_deref(), Some("/users/{id}/orders"));
        // 非法形状（含空格）拒绝——与接口定义路径同一校验器
        let err = upsert(
            &pool,
            "s1",
            "e1",
            None,
            "[]".into(),
            "{}".into(),
            None,
            None,
            Some("/bad path".into()),
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "INVALID_PATH_TEMPLATE");
    }

    /// 方法覆写：空白串归一为 None、合法七选落库（大小写规范化）、非法值拒绝
    #[tokio::test]
    async fn upsert_normalizes_and_validates_method_override() {
        let pool = seeded_pool().await;
        let saved = upsert(
            &pool,
            "s1",
            "e1",
            None,
            "[]".into(),
            "{}".into(),
            None,
            None,
            None,
            Some(" post ".into()),
        )
        .await
        .unwrap();
        assert_eq!(
            saved.method_override.as_deref(),
            Some("POST"),
            "方法规范化大写落库"
        );
        let err = upsert(
            &pool,
            "s1",
            "e1",
            None,
            "[]".into(),
            "{}".into(),
            None,
            None,
            None,
            Some("TRACE".into()),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "INVALID_HTTP_METHOD", "七选之外拒绝");
    }

    /// 连接池=1 下并发防抖写：全部成功、不丢最终值、不产生多行
    #[tokio::test]
    async fn concurrent_debounced_writes_keep_final_value() {
        let pool = std::sync::Arc::new(seeded_pool().await);
        let mut handles = Vec::new();
        for i in 0..12 {
            let pool = pool.clone();
            handles.push(tokio::spawn(async move {
                // 交错延迟制造真实并发交错；串行连接逐个排队执行
                tokio::time::sleep(std::time::Duration::from_millis(i * 5)).await;
                upsert(
                    &pool,
                    "s1",
                    "e1",
                    Some(format!("v{i}")),
                    "[]".into(),
                    "{}".into(),
                    None,
                    None,
                    None,
                    None,
                )
                .await
            }));
        }
        for handle in handles {
            handle.await.unwrap().unwrap();
        }
        let final_draft = get(&pool, "s1", "e1").await.unwrap().unwrap();
        let written: Vec<String> = (0..12).map(|i| format!("v{i}")).collect();
        assert!(
            written
                .iter()
                .any(|value| Some(value.as_str()) == final_draft.body.as_deref()),
            "最终值必须是某一次写入（不丢不损）：{:?}",
            final_draft.body
        );
        let (rows,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM endpoint_user_data")
            .fetch_one(pool.as_ref())
            .await
            .unwrap();
        assert_eq!(rows, 1);
    }
}
