//! 工作空间应用服务：seeding、删除切换与当前空间键编排。
//!
//! 「无工作空间」态从代码消灭：首启动与删光后走同一条 seeding 路径
//! 自动建「默认工作空间」；删除当前空间自动切到剩余第一个。
//! 「当前工作空间」是 settings 键（不进表），经 settings 服务写穿。

use serde::Serialize;
use sqlx::SqlitePool;

use crate::constants::DEFAULT_WORKSPACE_NAME;
use crate::domain::endpoint::new_manual_identity;
use crate::domain::validate::{normalize_base_url, normalize_name};
use crate::domain::workspace::{NewWorkspace, Workspace};
use crate::error::AppError;
use crate::error::codes;
use crate::infrastructure::workspace_repo;
use crate::services::settings::{self, EffectHost, SettingsCache};

/// 当前工作空间的 settings 键。
pub const CURRENT_KEY: &str = "workspace.current";

/// 工作空间 DTO（camelCase；isCurrent 供前端直渲染）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDto {
    pub id: String,
    pub name: String,
    pub base_url: Option<String>,
    /// 工作空间级认证配置 JSON（认证继承链根；null＝未配置）
    pub auth: Option<String>,
    pub is_current: bool,
}

/// 工作空间清单 DTO。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceListDto {
    pub items: Vec<WorkspaceDto>,
    pub current_id: Option<String>,
}

/// 首启动 / 删光后自动建「默认工作空间」（单一 seeding 路径）：
/// 已有工作空间时不动作，返回 None；刚建的返回实体。
pub async fn ensure_default(pool: &SqlitePool) -> Result<Option<Workspace>, AppError> {
    if workspace_repo::count(pool).await? > 0 {
        return Ok(None);
    }
    let created = workspace_repo::insert(
        pool,
        &NewWorkspace {
            id: new_manual_identity(),
            name: DEFAULT_WORKSPACE_NAME.to_owned(),
            base_url: None,
            auth: None,
        },
    )
    .await?;
    tracing::info!(workspace_id = %created.id, "seeded default workspace");
    Ok(Some(created))
}

/// 从 settings 缓存读当前工作空间 id（未设置 / 形态异常按未设置处理）。
fn current_from_cache(cache: &SettingsCache) -> Option<String> {
    cache
        .snapshot()
        .get(CURRENT_KEY)
        .and_then(|value| value.as_str())
        .map(str::to_owned)
}

/// 解析当前工作空间：settings 键有效（空间仍存在）则用之；
/// 键缺失或指向已删空间时回退清单首位；清单为空（seeding 前的边界）返回 None。
/// 只读不改键： stale 键由下一次 set_current 或删除切换路径自然校正。
pub async fn resolve_current_id(
    pool: &SqlitePool,
    cache: &SettingsCache,
) -> Result<Option<String>, AppError> {
    let from_settings = current_from_cache(cache);
    if let Some(id) = from_settings
        && workspace_repo::get(pool, &id).await?.is_some()
    {
        return Ok(Some(id));
    }
    Ok(workspace_repo::list(pool)
        .await?
        .into_iter()
        .next()
        .map(|ws| ws.id))
}

/// 按引用（id 或名称精确匹配）解析工作空间（CLI `--workspace` 参数的
/// 解析单点）：id 精确命中优先，未命中再按名称精确匹配。名称命中多行＝
/// 歧义、零命中＝不存在，均报 `INVALID_ARGUMENT`；错误消息只回显输入值，
/// 不枚举现存空间（不泄露其他空间存在性）。只读定位：不改当前空间键。
pub async fn resolve_by_reference(pool: &SqlitePool, spec: &str) -> Result<Workspace, AppError> {
    if let Some(by_id) = workspace_repo::get(pool, spec).await? {
        return Ok(by_id);
    }
    let by_name: Vec<Workspace> = workspace_repo::list(pool)
        .await?
        .into_iter()
        .filter(|ws| ws.name == spec)
        .collect();
    match by_name.as_slice() {
        [only] => Ok(only.clone()),
        [] => Err(AppError::new(
            codes::INVALID_ARGUMENT,
            format!("workspace not found: {spec}"),
        )),
        _ => Err(AppError::new(
            codes::INVALID_ARGUMENT,
            format!("workspace name is ambiguous: {spec}"),
        )),
    }
}

/// 清单 + current 标记（resolve 语义与 set_current 同源）。
pub async fn list(pool: &SqlitePool, cache: &SettingsCache) -> Result<WorkspaceListDto, AppError> {
    let current_id = resolve_current_id(pool, cache).await?;
    let items = workspace_repo::list(pool)
        .await?
        .into_iter()
        .map(|ws| WorkspaceDto {
            is_current: current_id.as_deref() == Some(ws.id.as_str()),
            id: ws.id,
            name: ws.name,
            base_url: ws.base_url,
            auth: ws.auth,
        })
        .collect();
    Ok(WorkspaceListDto { items, current_id })
}

/// 新建工作空间（不自动切换；切换是显式动作）。`base_url` 与 `auth`
/// （认证配置 JSON，结构同 set_auth 写路径）可带创建默认值，缺省为空；
/// 默认值由调用方（GUI 产品预置）决定，本层不内置产品默认。
pub async fn create(
    pool: &SqlitePool,
    cache: &SettingsCache,
    name: &str,
    base_url: Option<&str>,
    auth: Option<&str>,
) -> Result<WorkspaceDto, AppError> {
    let name = normalize_name(name)?;
    let base_url = normalize_base_url(base_url)?;
    let created = workspace_repo::insert(
        pool,
        &NewWorkspace {
            id: new_manual_identity(),
            name,
            base_url,
            auth: auth.map(str::to_owned),
        },
    )
    .await?;
    let current_id = resolve_current_id(pool, cache).await?;
    Ok(WorkspaceDto {
        is_current: current_id.as_deref() == Some(created.id.as_str()),
        id: created.id,
        name: created.name,
        base_url: created.base_url,
        auth: created.auth,
    })
}

/// 更新名称与 BaseUrl（工作空间设置页整行编辑；BaseUrl 传空串＝清空）。
pub async fn rename(
    pool: &SqlitePool,
    cache: &SettingsCache,
    id: &str,
    name: &str,
    base_url: Option<&str>,
) -> Result<WorkspaceDto, AppError> {
    let name = normalize_name(name)?;
    let base_url = normalize_base_url(base_url)?;
    let updated = workspace_repo::update(pool, id, &name, base_url.as_deref()).await?;
    let current_id = resolve_current_id(pool, cache).await?;
    Ok(WorkspaceDto {
        is_current: current_id.as_deref() == Some(updated.id.as_str()),
        id: updated.id,
        name: updated.name,
        base_url: updated.base_url,
        auth: updated.auth,
    })
}

/// 更新工作空间级认证配置（认证继承链根）。`auth` 为前端组装 JSON
/// （写路径不感知语义，发送时由 services/http/auth 解析）；None＝清除配置。
pub async fn set_auth(
    pool: &SqlitePool,
    cache: &SettingsCache,
    id: &str,
    auth: Option<&str>,
) -> Result<WorkspaceDto, AppError> {
    let updated = workspace_repo::update_auth(pool, id, auth).await?;
    let current_id = resolve_current_id(pool, cache).await?;
    Ok(WorkspaceDto {
        is_current: current_id.as_deref() == Some(updated.id.as_str()),
        id: updated.id,
        name: updated.name,
        base_url: updated.base_url,
        auth: updated.auth,
    })
}

/// 工作空间整批重排（拖拽放落的一次到位原语）：入参为完整有序 id 表，
/// 必须与现有集合完全一致——缺、多、未知或重复 id 一律 INVALID_ARGUMENT
/// 拒绝（不静默补齐，调用方持旧清单重放即可）；事务内整批落序后返回
/// 刷新清单。
pub async fn reorder(
    pool: &SqlitePool,
    cache: &SettingsCache,
    ordered_ids: Vec<String>,
) -> Result<WorkspaceListDto, AppError> {
    let existing = workspace_repo::list(pool).await?;
    let existing_ids: std::collections::HashSet<&str> =
        existing.iter().map(|ws| ws.id.as_str()).collect();
    let input_ids: std::collections::HashSet<&str> =
        ordered_ids.iter().map(|id| id.as_str()).collect();
    // 三重判等缺一不可：去重集与现有集合等势（缺 / 多 / 未知）、入参长度与
    // 去重集等长（入参自身重复）、逐项存在于现有集合
    let same_set = input_ids.len() == existing_ids.len()
        && ordered_ids.len() == input_ids.len()
        && ordered_ids
            .iter()
            .all(|id| existing_ids.contains(id.as_str()));
    if !same_set {
        let existing_sorted: Vec<&str> =
            existing.iter().map(|ws| ws.id.as_str()).collect::<Vec<_>>();
        return Err(AppError::new(
            codes::INVALID_ARGUMENT,
            format!(
                "workspace reorder id set mismatch: expected {existing_sorted:?}, got {ordered_ids:?}"
            ),
        ));
    }
    let borrowed: Vec<&str> = ordered_ids.iter().map(|id| id.as_str()).collect();
    workspace_repo::reorder(
        &mut *pool.acquire().await.map_err(AppError::from)?,
        &borrowed,
    )
    .await?;
    list(pool, cache).await
}

/// 删除工作空间：级联（服务/分类/接口/user_data/置顶/会话）全清；
/// 删的是当前空间 → 切剩余第一个；无剩余 → seeding 默认空间并指向它。
pub async fn delete(
    host: &dyn EffectHost,
    pool: &SqlitePool,
    cache: &SettingsCache,
    id: &str,
) -> Result<(), AppError> {
    workspace_repo::get(pool, id).await?.ok_or_else(|| {
        AppError::new(
            codes::WORKSPACE_NOT_FOUND,
            format!("workspace not found: {id}"),
        )
    })?;
    workspace_repo::delete(&mut *pool.acquire().await.map_err(AppError::from)?, id).await?;

    if current_from_cache(cache).as_deref() == Some(id) {
        if let Some(next) = workspace_repo::list(pool).await?.into_iter().next() {
            set_current(host, pool, cache, &next.id).await?;
        } else {
            // 删光重建走同一条 seeding 路径，并让默认空间成为当前
            let seeded = ensure_default(pool)
                .await?
                .expect("empty table must seed a default workspace");
            set_current(host, pool, cache, &seeded.id).await?;
        }
    }
    Ok(())
}

/// 设置当前工作空间：空间必须存在；经 settings 服务写穿（键校验 / 上限 /
/// 缓存同步收口单点）。
pub async fn set_current(
    host: &dyn EffectHost,
    pool: &SqlitePool,
    cache: &SettingsCache,
    id: &str,
) -> Result<(), AppError> {
    workspace_repo::get(pool, id).await?.ok_or_else(|| {
        AppError::new(
            codes::WORKSPACE_NOT_FOUND,
            format!("workspace not found: {id}"),
        )
    })?;
    settings::set(host, pool, cache, CURRENT_KEY, serde_json::json!(id)).await
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// 测试宿主：工作空间域的 settings 副作用为空，实现留痕即够。
    pub struct NoopHost;

    impl EffectHost for NoopHost {
        fn apply_log_level(&self, _value: &serde_json::Value) {}
        fn apply_dev_mode(&self, _enabled: bool) {}
        fn apply_http(&self, _value: &serde_json::Value) {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use test_support::NoopHost;

    async fn memory_pool() -> SqlitePool {
        let pool = db::connect_in_memory().await;
        db::run_migrations(&pool).await.unwrap();
        pool
    }

    async fn fresh_state() -> (SqlitePool, SettingsCache) {
        let pool = memory_pool().await;
        let cache = SettingsCache::default();
        (pool, cache)
    }

    #[tokio::test]
    async fn ensure_default_seeds_when_empty_and_skips_when_not() {
        let (pool, _) = fresh_state().await;
        assert!(ensure_default(&pool).await.unwrap().is_some());
        assert_eq!(workspace_repo::count(&pool).await.unwrap(), 1);
        // 已有空间：不动作（幂等）
        assert!(ensure_default(&pool).await.unwrap().is_none());
        assert_eq!(workspace_repo::count(&pool).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn first_boot_seeds_and_list_marks_it_current() {
        let (pool, cache) = fresh_state().await;
        ensure_default(&pool).await.unwrap();
        let list = list(&pool, &cache).await.unwrap();
        assert_eq!(list.items.len(), 1);
        // settings 未设置时回退清单首位
        assert!(list.items[0].is_current);
        assert_eq!(list.current_id, Some(list.items[0].id.clone()));
    }

    #[tokio::test]
    async fn set_current_persists_through_settings_key() {
        let (pool, cache) = fresh_state().await;
        let host = NoopHost;
        ensure_default(&pool).await.unwrap();
        let second = create(&pool, &cache, "第二空间", None, None).await.unwrap();
        set_current(&host, &pool, &cache, &second.id).await.unwrap();

        // 缓存直出与重启恢复（load_all）两侧都拿到该键
        assert_eq!(
            cache.snapshot().get(CURRENT_KEY),
            Some(&serde_json::json!(second.id))
        );
        let fresh_cache = SettingsCache::default();
        crate::services::settings::load_all(&pool, &fresh_cache)
            .await
            .unwrap();
        assert_eq!(current_from_cache(&fresh_cache), Some(second.id.clone()));

        let list = list(&pool, &fresh_cache).await.unwrap();
        assert!(
            list.items
                .iter()
                .find(|w| w.id == second.id)
                .unwrap()
                .is_current
        );
        assert!(
            !list
                .items
                .iter()
                .find(|w| w.id != second.id)
                .unwrap()
                .is_current
        );
    }

    #[tokio::test]
    async fn set_current_rejects_missing_workspace() {
        let (pool, cache) = fresh_state().await;
        let host = NoopHost;
        ensure_default(&pool).await.unwrap();
        let err = set_current(&host, &pool, &cache, "nope").await.unwrap_err();
        assert_eq!(err.code, codes::WORKSPACE_NOT_FOUND);
    }

    #[tokio::test]
    async fn create_validates_name_and_does_not_switch() {
        let (pool, cache) = fresh_state().await;
        ensure_default(&pool).await.unwrap();
        // 时间戳毫秒精度：留出间隔，让「清单首位」判定不依赖同毫秒 id 序
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        let created = create(&pool, &cache, "  新空间  ", None, None)
            .await
            .unwrap();
        assert_eq!(created.name, "新空间");
        assert!(!created.is_current, "新建不自动切换");
        assert_eq!(created.base_url, None);
        assert_eq!(created.auth, None);
        let err = create(&pool, &cache, "  ", None, None).await.unwrap_err();
        assert_eq!(err.code, codes::NAME_INVALID);
    }

    /// 创建默认值（GUI 产品预置经可选参数携带）：base_url 走与 rename 同一
    /// 归一（trim、空串清空），auth 按写路径口径原样整包落库。
    #[tokio::test]
    async fn create_persists_base_url_and_auth_defaults() {
        let (pool, cache) = fresh_state().await;
        ensure_default(&pool).await.unwrap();
        let auth = r#"{"type":"bearer","token":"{{access_token}}"}"#;
        let created = create(
            &pool,
            &cache,
            "预置空间",
            Some(" http://127.0.0.1:5000 "),
            Some(auth),
        )
        .await
        .unwrap();
        assert_eq!(created.base_url.as_deref(), Some("http://127.0.0.1:5000"));
        assert_eq!(created.auth.as_deref(), Some(auth));
    }

    #[tokio::test]
    async fn rename_updates_name_and_base_url() {
        let (pool, cache) = fresh_state().await;
        let ws = ensure_default(&pool).await.unwrap().unwrap();
        let renamed = rename(
            &pool,
            &cache,
            &ws.id,
            "改名",
            Some(" https://api.example.com "),
        )
        .await
        .unwrap();
        assert_eq!(renamed.name, "改名");
        assert_eq!(renamed.base_url.as_deref(), Some("https://api.example.com"));
        // 空串 = 清空 BaseUrl
        let cleared = rename(&pool, &cache, &ws.id, "改名", Some("  "))
            .await
            .unwrap();
        assert_eq!(cleared.base_url, None);
        let err = rename(&pool, &cache, &ws.id, "", None).await.unwrap_err();
        assert_eq!(err.code, codes::NAME_INVALID);
    }

    #[tokio::test]
    async fn reorder_persists_sequence_and_returns_refreshed_list() {
        let (pool, cache) = fresh_state().await;
        let first = ensure_default(&pool).await.unwrap().unwrap();
        let second = create(&pool, &cache, "第二", None, None).await.unwrap();
        let third = create(&pool, &cache, "第三", None, None).await.unwrap();

        let list = reorder(
            &pool,
            &cache,
            vec![third.id.clone(), first.id.clone(), second.id.clone()],
        )
        .await
        .unwrap();

        // 契约面用序列化后 JSON 断言（防 serde 形态漂移）
        let json = serde_json::to_value(&list).unwrap();
        let ids: Vec<&str> = json["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            ids,
            vec![third.id.as_str(), first.id.as_str(), second.id.as_str()]
        );
        // 落库序持久：重开缓存直读 repo 序一致
        let fresh = workspace_repo::list(&pool).await.unwrap();
        let persisted: Vec<&str> = fresh.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(
            persisted,
            vec![third.id.as_str(), first.id.as_str(), second.id.as_str()]
        );
    }

    #[tokio::test]
    async fn reorder_rejects_mismatched_id_sets() {
        let (pool, cache) = fresh_state().await;
        let first = ensure_default(&pool).await.unwrap().unwrap();
        let second = create(&pool, &cache, "第二", None, None).await.unwrap();

        // 缺 id
        let err = reorder(&pool, &cache, vec![first.id.clone()])
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::INVALID_ARGUMENT);
        // 多未知 id
        let err = reorder(
            &pool,
            &cache,
            vec![first.id.clone(), second.id.clone(), "ghost".into()],
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, codes::INVALID_ARGUMENT);
        // 重复 id（集合相等但数量不等）
        let err = reorder(&pool, &cache, vec![first.id.clone(), first.id.clone()])
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::INVALID_ARGUMENT);
        // 拒绝后原序保持
        let list = list(&pool, &cache).await.unwrap();
        let ids: Vec<&str> = list.items.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, vec![first.id.as_str(), second.id.as_str()]);
    }

    #[tokio::test]
    async fn delete_current_switches_to_remaining_first() {
        let (pool, cache) = fresh_state().await;
        let host = NoopHost;
        let first = ensure_default(&pool).await.unwrap().unwrap();
        let second = create(&pool, &cache, "第二", None, None).await.unwrap();
        set_current(&host, &pool, &cache, &second.id).await.unwrap();

        delete(&host, &pool, &cache, &second.id).await.unwrap();

        let list = list(&pool, &cache).await.unwrap();
        assert_eq!(list.items.len(), 1);
        assert_eq!(
            list.current_id,
            Some(first.id),
            "删当前空间应切到剩余第一个"
        );
        assert!(list.items[0].is_current);
    }

    #[tokio::test]
    async fn delete_last_workspace_reseeds_default_and_points_to_it() {
        let (pool, cache) = fresh_state().await;
        let host = NoopHost;
        let only = ensure_default(&pool).await.unwrap().unwrap();
        set_current(&host, &pool, &cache, &only.id).await.unwrap();

        delete(&host, &pool, &cache, &only.id).await.unwrap();

        let list = list(&pool, &cache).await.unwrap();
        assert_eq!(list.items.len(), 1, "删光后应自动重建默认工作空间");
        assert_eq!(list.items[0].name, DEFAULT_WORKSPACE_NAME);
        assert!(list.items[0].is_current);
        assert_ne!(list.items[0].id, only.id, "重建的是新实体");
    }

    #[tokio::test]
    async fn delete_keeps_current_when_deleting_other_workspace() {
        let (pool, cache) = fresh_state().await;
        let host = NoopHost;
        let first = ensure_default(&pool).await.unwrap().unwrap();
        let second = create(&pool, &cache, "第二", None, None).await.unwrap();
        set_current(&host, &pool, &cache, &first.id).await.unwrap();

        delete(&host, &pool, &cache, &second.id).await.unwrap();
        assert_eq!(
            resolve_current_id(&pool, &cache).await.unwrap(),
            Some(first.id)
        );
    }

    /// 按引用解析：id 精确命中优先、名称精确命中次之；歧义与不存在均
    /// `INVALID_ARGUMENT`，且错误消息不携带任何现存空间的 id / 名称
    /// （不泄露存在性）。
    #[tokio::test]
    async fn resolve_by_reference_matches_id_then_name_and_hides_existing_set() {
        let (pool, cache) = fresh_state().await;
        let first = ensure_default(&pool).await.unwrap().unwrap();
        let second = create(&pool, &cache, "流水线空间", None, None)
            .await
            .unwrap();
        // 同名第二行（歧义靶）：与 second 同名、id 不同
        crate::infrastructure::workspace_repo::test_support::seed_workspace(
            &pool,
            "w-dup",
            "流水线空间",
        )
        .await;

        // id 精确命中（同 id 也是某空间名称时 id 优先，不做名称回退）
        let hit = resolve_by_reference(&pool, &second.id).await.unwrap();
        assert_eq!(hit.id, second.id);
        // 名称精确命中
        let hit = resolve_by_reference(&pool, "默认工作空间").await.unwrap();
        assert_eq!(hit.id, first.id);
        // 名称大小写与空白不归一：精确匹配口径（与 --service 消歧一致）
        let err = resolve_by_reference(&pool, " 默认工作空间")
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::INVALID_ARGUMENT);

        // 名称多行命中＝歧义：INVALID_ARGUMENT，消息不枚举候选
        let err = resolve_by_reference(&pool, "流水线空间").await.unwrap_err();
        assert_eq!(err.code, codes::INVALID_ARGUMENT);
        assert!(!err.message.contains(&second.id), "不得泄露空间 id");
        assert!(!err.message.contains("w-dup"), "不得泄露空间 id");
        assert!(err.details.is_none(), "歧义不带候选清单（不泄露存在性）");

        // 不存在＝INVALID_ARGUMENT：消息只回显输入，不枚举现存空间
        let err = resolve_by_reference(&pool, "不存在的空间")
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::INVALID_ARGUMENT);
        assert!(
            !err.message.contains("默认工作空间")
                && !err.message.contains("流水线空间")
                && !err.message.contains(&first.id),
            "不得泄露其他空间存在性: {}",
            err.message
        );
    }

    #[tokio::test]
    async fn resolve_falls_back_to_first_when_settings_point_to_deleted() {
        let (pool, cache) = fresh_state().await;
        let host = NoopHost;
        let first = ensure_default(&pool).await.unwrap().unwrap();
        let second = create(&pool, &cache, "第二", None, None).await.unwrap();
        set_current(&host, &pool, &cache, &second.id).await.unwrap();
        // 模拟会话容错边界：键指向的空间被库外删除
        crate::infrastructure::workspace_repo::delete(
            &mut pool.acquire().await.unwrap(),
            &second.id,
        )
        .await
        .unwrap();
        assert_eq!(
            resolve_current_id(&pool, &cache).await.unwrap(),
            Some(first.id)
        );
    }

    #[tokio::test]
    async fn delete_cascades_full_chain_and_cleans_user_data() {
        let (pool, cache) = fresh_state().await;
        let host = NoopHost;
        let ws = ensure_default(&pool).await.unwrap().unwrap();
        set_current(&host, &pool, &cache, &ws.id).await.unwrap();
        // 造全链数据：服务→分类→接口→user_data→置顶→会话
        crate::infrastructure::service_repo::test_support::seed_service(
            &pool, "s1", &ws.id, "服务",
        )
        .await;
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
        crate::infrastructure::endpoint_repo::set_pinned(&pool, "s1", "e1", true)
            .await
            .unwrap();
        crate::infrastructure::session_repo::upsert(
            &pool,
            &ws.id,
            &crate::domain::session::SessionInput {
                tabs: "[]".into(),
                tree_expanded: "[]".into(),
            },
        )
        .await
        .unwrap();

        delete(&host, &pool, &cache, &ws.id).await.unwrap();

        let (user_data,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM endpoint_user_data")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(user_data, 0, "无外键的 user_data 必须随删除显式清除");
        let (sessions,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM workspace_sessions")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(sessions, 0);
    }
}
