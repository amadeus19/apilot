//! 工作空间会话应用服务：保存与恢复（含被删服务残留 Tab 的存在性过滤）。
//!
//! 会话容错：Tab 会话 JSON 里的残留条目不即时清洗——保存路径不做校验，
//! 恢复路径按存在性过滤跳过。tabs JSON 结构归前端所有，Rust 只按约定键
//! `serviceId` / `key` 读取过滤所需字段，其余结构原样保留。

use serde::Serialize;
use sqlx::SqlitePool;

use crate::domain::session::{SessionInput, WorkspaceSession};
use crate::error::AppError;
use crate::error::codes;
use crate::infrastructure::{endpoint_repo, session_repo, workspace_repo};

/// 会话 DTO（tabs / treeExpanded 为前端 JSON 字符串，原样透传）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDto {
    pub tabs: String,
    pub tree_expanded: String,
}

/// 读取会话：残留过滤后返回；从未保存过（或空间不存在）返回 None。
/// 过滤规则：条目含 `serviceId` + `key`（接口 Tab）时要求该接口仍存在；
/// 其余类型（工作空间设置 Tab 等）无身份键，原样保留。
pub async fn get(pool: &SqlitePool, workspace_id: &str) -> Result<Option<SessionDto>, AppError> {
    let Some(session) = session_repo::get(pool, workspace_id).await? else {
        return Ok(None);
    };
    let tabs = filter_stale_tabs(pool, &session).await?;
    Ok(Some(SessionDto {
        tabs,
        tree_expanded: session.tree_expanded,
    }))
}

/// 保存会话（整包 upsert）；工作空间必须存在，载荷大小沿领域校验。
pub async fn save(
    pool: &SqlitePool,
    workspace_id: &str,
    tabs: &str,
    tree_expanded: &str,
) -> Result<(), AppError> {
    workspace_repo::get(pool, workspace_id)
        .await?
        .ok_or_else(|| {
            AppError::new(
                codes::WORKSPACE_NOT_FOUND,
                format!("workspace not found: {workspace_id}"),
            )
        })?;
    let input = SessionInput {
        tabs: tabs.to_owned(),
        tree_expanded: tree_expanded.to_owned(),
    };
    input.validate_size()?;
    session_repo::upsert(pool, workspace_id, &input).await?;
    Ok(())
}

/// 残留 Tab 过滤：tabs JSON 的 `tabs` 数组内逐条按存在性校验，其余字段原样保留。
/// 前端契约：tabs JSON＝对象 `{ "tabs": [...], "activeTabId": ... }`；数组形态
/// （兼容）直接过滤顶层数组。脏数据（非法 JSON / 皆非对象数组）按空会话处理
/// （容错恢复，不炸启动）。
async fn filter_stale_tabs(
    pool: &SqlitePool,
    session: &WorkspaceSession,
) -> Result<String, AppError> {
    let parsed: serde_json::Value = match serde_json::from_str(&session.tabs) {
        Ok(value) => value,
        Err(_) => {
            tracing::warn!(workspace_id = %session.workspace_id, "session tabs is not valid JSON, treating as empty");
            return Ok("[]".to_owned());
        }
    };
    let (items, mut payload) = match parsed {
        serde_json::Value::Array(items) => (items, serde_json::Map::new()),
        serde_json::Value::Object(map) => {
            let items = map
                .get("tabs")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default();
            (items, map)
        }
        _ => {
            tracing::warn!(workspace_id = %session.workspace_id, "session tabs has unexpected shape, treating as empty");
            return Ok("[]".to_owned());
        }
    };
    let mut kept = Vec::with_capacity(items.len());
    for item in items {
        if keep(pool, &item).await {
            kept.push(item);
        }
    }
    payload.insert("tabs".to_owned(), serde_json::Value::Array(kept));
    serde_json::to_string(&payload)
        .map_err(|err| AppError::internal(format!("reserialized session tabs failed: {err}")))
}

/// 单条 Tab 的保留判定（接口身份存在＝保留）。
async fn keep(pool: &SqlitePool, item: &serde_json::Value) -> bool {
    let (Some(service_id), Some(key)) = (
        item.get("serviceId").and_then(serde_json::Value::as_str),
        item.get("key").and_then(serde_json::Value::as_str),
    ) else {
        // 非接口 Tab（无身份键）原样保留
        return true;
    };
    match endpoint_repo::get(pool, service_id, key).await {
        Ok(Some(_)) => true,
        Ok(None) => false,
        Err(err) => {
            // 查询失败从宽保留（容错恢复优先于精确清洗，失败已留痕）
            tracing::warn!(code = %err.code, service_id, key, "session tab existence check failed, keeping");
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::infrastructure::endpoint_repo::test_support as endpoint_support;
    use crate::infrastructure::service_repo::test_support as service_support;
    use crate::infrastructure::workspace_repo::test_support as ws_support;

    fn tab(id: &str, service_id: &str, key: &str, preview: bool) -> serde_json::Value {
        serde_json::json!({
            "kind": "endpoint",
            "title": id,
            "serviceId": service_id,
            "key": key,
            "preview": preview,
        })
    }

    /// 前端会话 JSON 契约形态：对象 { tabs, activeTabId }
    fn tabs_payload(tabs: Vec<serde_json::Value>, active_tab_id: &str) -> String {
        serde_json::json!({ "tabs": tabs, "activeTabId": active_tab_id }).to_string()
    }

    async fn seeded_pool() -> SqlitePool {
        let pool = db::connect_in_memory().await;
        db::run_migrations(&pool).await.unwrap();
        ws_support::seed_workspace(&pool, "w1", "一").await;
        service_support::seed_service(&pool, "s1", "w1", "服务").await;
        endpoint_support::seed_endpoint(&pool, "s1", "e1", "接口一").await;
        endpoint_support::seed_endpoint(&pool, "s1", "e2", "接口二").await;
        pool
    }

    #[tokio::test]
    async fn save_then_get_roundtrips() {
        let pool = seeded_pool().await;
        let tabs = tabs_payload(
            vec![tab("t1", "s1", "e1", false), tab("t2", "s1", "e2", true)],
            "t2",
        );
        save(&pool, "w1", &tabs, "[\"s1\"]").await.unwrap();
        let restored = get(&pool, "w1").await.unwrap().unwrap();
        let payload: serde_json::Value = serde_json::from_str(&restored.tabs).unwrap();
        let items = payload["tabs"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(payload["activeTabId"], "t2", "激活态随会话透传");
        assert_eq!(items[0]["kind"], "endpoint");
        assert_eq!(items[1]["preview"], true, "预览标记随会话透传");
        assert_eq!(restored.tree_expanded, "[\"s1\"]");
    }

    #[tokio::test]
    async fn get_filters_tabs_of_deleted_services_without_saving_back() {
        let pool = seeded_pool().await;
        // t1 指向将被删除的服务；t2 正常；t3 为无身份键的设置 Tab
        let tabs = tabs_payload(
            vec![
                tab("t1", "sX", "eX", false),
                tab("t2", "s1", "e2", false),
                serde_json::json!({ "kind": "workspaceSettings", "title": "工作空间设置" }),
            ],
            "t2",
        );
        save(&pool, "w1", &tabs, "[]").await.unwrap();
        // 删服务（连带 e1/e2 之外？eX 本就不存在——改用真删服务验证整组过滤）
        service_support::seed_service(&pool, "s2", "w1", "服务二").await;
        endpoint_support::seed_endpoint(&pool, "s2", "e9", "接口九").await;
        let tabs2 = tabs_payload(
            vec![
                tab("t2", "s1", "e2", false),
                tab("t4", "s2", "e9", false),
                serde_json::json!({ "kind": "workspaceSettings", "title": "工作空间设置" }),
            ],
            "t2",
        );
        save(&pool, "w1", &tabs2, "[]").await.unwrap();

        // 库外级联删除 s2（走 repo 事务路径，连带其 user_data/置顶）
        crate::infrastructure::service_repo::delete(&mut pool.acquire().await.unwrap(), "s2")
            .await
            .unwrap();

        let restored = get(&pool, "w1").await.unwrap().unwrap();
        let payload: serde_json::Value = serde_json::from_str(&restored.tabs).unwrap();
        let kinds_or_titles: Vec<String> = payload["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| {
                v["serviceId"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| v["kind"].as_str().unwrap().to_owned())
            })
            .collect();
        assert_eq!(
            kinds_or_titles,
            vec!["s1".to_owned(), "workspaceSettings".to_owned()],
            "被删服务的残留 Tab 恢复时过滤跳过"
        );

        // 不即时清洗：库中会话 JSON 原样保留
        let raw = session_repo::get(&pool, "w1").await.unwrap().unwrap();
        assert!(
            raw.tabs.contains("s2"),
            "残留条目不回写清洗（会话容错语义）"
        );
    }

    #[tokio::test]
    async fn save_rejects_missing_workspace_and_oversized_payload() {
        let pool = seeded_pool().await;
        let err = save(&pool, "nope", "[]", "[]").await.unwrap_err();
        assert_eq!(err.code, codes::WORKSPACE_NOT_FOUND);
        let big = "x".repeat(crate::constants::MAX_SESSION_BYTES + 1);
        let err = save(&pool, "w1", &big, "[]").await.unwrap_err();
        assert_eq!(err.code, codes::SESSION_TOO_LARGE);
    }

    #[tokio::test]
    async fn get_tolerates_corrupt_tabs_json() {
        let pool = seeded_pool().await;
        session_repo::upsert(
            &pool,
            "w1",
            &SessionInput {
                tabs: "not-json".into(),
                tree_expanded: "[]".into(),
            },
        )
        .await
        .unwrap();
        let restored = get(&pool, "w1").await.unwrap().unwrap();
        assert_eq!(restored.tabs, "[]", "脏会话按无 Tab 恢复，不炸启动");
    }
}
