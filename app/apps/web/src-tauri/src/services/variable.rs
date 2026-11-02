//! 变量域应用服务：分类 CRUD 与激活链校验、变量 CRUD、兜底链合成、
//! BaseUrl 候选清单编排。
//!
//! 激活链纪律：激活切换原子（单列指针单条 UPDATE）；全局分类
//! （workspace_id NULL）不可激活；跨空间分类不可激活；NULL＝全不激活。
//! Secret 是变量级标记，值恒明文（掩码 / 脱敏由展示与发送链消费端负责）。

use serde::Serialize;
use sqlx::SqlitePool;

use crate::domain::endpoint::new_manual_identity;
use crate::domain::validate::normalize_name;
use crate::domain::variable::{VariableSource, compose_effective, normalize_variable_key};
use crate::error::AppError;
use crate::error::codes;
use crate::infrastructure::variable_repo;

/// 变量分类 DTO（camelCase；isGlobal 供前端区分全局行）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VariableCategoryDto {
    pub id: String,
    pub name: String,
    pub is_global: bool,
    pub sort_order: i64,
}

/// 分类清单 DTO（本空间分类在前、全局分类在后；激活指针随包返回）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VariableCategoriesDto {
    pub items: Vec<VariableCategoryDto>,
    pub active_category_id: Option<String>,
}

/// 变量 DTO（value 恒明文；secret 由前端按标记掩码）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VariableDto {
    pub key: String,
    pub value: String,
    pub secret: bool,
}

/// 变量清单 DTO（单分类内）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VariableListDto {
    pub items: Vec<VariableDto>,
}

/// 生效变量 DTO（兜底链合成结果；source 供前端渲染来源徽标）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveVariableDto {
    pub key: String,
    pub value: String,
    pub secret: bool,
    /// 来源层：active / global / builtin
    pub source: &'static str,
}

/// 生效集 DTO（GUI 生效集右栏；secret 行展示端恒掩码）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveSetDto {
    pub items: Vec<EffectiveVariableDto>,
}

/// BaseUrl 候选 DTO。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseUrlCandidateDto {
    pub id: String,
    pub url: String,
}

/// 候选清单 DTO。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseUrlListDto {
    pub items: Vec<BaseUrlCandidateDto>,
}

/// 分类存在性校验：不存在转 VARIABLE_CATEGORY_NOT_FOUND。
fn require_category(
    category: Option<crate::domain::variable::VariableCategory>,
) -> Result<crate::domain::variable::VariableCategory, AppError> {
    category.ok_or_else(|| {
        AppError::new(
            codes::VARIABLE_CATEGORY_NOT_FOUND,
            "variable category not found",
        )
    })
}

/// 工作空间存在性校验。
async fn require_workspace(pool: &SqlitePool, workspace_id: &str) -> Result<(), AppError> {
    crate::infrastructure::workspace_repo::get(pool, workspace_id)
        .await?
        .map(|_| ())
        .ok_or_else(|| {
            AppError::new(
                codes::WORKSPACE_NOT_FOUND,
                format!("workspace not found: {workspace_id}"),
            )
        })
}

/// 分类归属校验：分类要么是全局行、要么属于给定工作空间；
/// 否则按「不存在」处理（对调用方上下文不可见的分类等价于不存在）。
fn require_category_visible_in(
    category: &crate::domain::variable::VariableCategory,
    workspace_id: &str,
) -> Result<(), AppError> {
    match &category.workspace_id {
        None => Ok(()),
        Some(owner) if owner == workspace_id => Ok(()),
        Some(_) => Err(AppError::new(
            codes::VARIABLE_CATEGORY_NOT_FOUND,
            format!(
                "variable category not found in this workspace: {}",
                category.id
            ),
        )),
    }
}

/// 拉分类清单视图（本空间＋全局，全局排后）＋激活指针。
async fn categories_view(
    pool: &SqlitePool,
    workspace_id: &str,
) -> Result<VariableCategoriesDto, AppError> {
    let active = variable_repo::get_active_category_id(pool, workspace_id).await?;
    let mut items: Vec<VariableCategoryDto> =
        variable_repo::list_workspace_categories(pool, workspace_id)
            .await?
            .into_iter()
            .map(|c| to_category_dto(&c))
            .collect();
    items.extend(
        variable_repo::list_global_categories(pool)
            .await?
            .into_iter()
            .map(|c| to_category_dto(&c)),
    );
    Ok(VariableCategoriesDto {
        items,
        active_category_id: active,
    })
}

fn to_category_dto(category: &crate::domain::variable::VariableCategory) -> VariableCategoryDto {
    VariableCategoryDto {
        id: category.id.clone(),
        name: category.name.clone(),
        is_global: category.workspace_id.is_none(),
        sort_order: category.sort_order,
    }
}

fn source_label(source: VariableSource) -> &'static str {
    match source {
        VariableSource::Active => "active",
        VariableSource::Global => "global",
        VariableSource::Builtin => "builtin",
    }
}

/// 分类清单（本空间＋全局，全局排后；激活指针随包）。
pub async fn list_categories(
    pool: &SqlitePool,
    workspace_id: &str,
) -> Result<VariableCategoriesDto, AppError> {
    require_workspace(pool, workspace_id).await?;
    categories_view(pool, workspace_id).await
}

/// 新建分类：`global = true` 建全局行（workspace_id NULL），否则挂给定工作空间。
/// 返回值恒为给定工作空间视角的清单视图（全局行在该视角可见）。
pub async fn create_category(
    pool: &SqlitePool,
    workspace_id: &str,
    global: bool,
    name: &str,
) -> Result<VariableCategoriesDto, AppError> {
    require_workspace(pool, workspace_id).await?;
    let name = normalize_name(name)?;
    variable_repo::insert_category(
        pool,
        &crate::domain::variable::NewVariableCategory {
            id: new_manual_identity(),
            workspace_id: if global {
                None
            } else {
                Some(workspace_id.to_owned())
            },
            name,
        },
    )
    .await?;
    categories_view(pool, workspace_id).await
}

/// 重命名分类（全局行或本空间分类；跨空间分类按不存在拒绝）。
pub async fn rename_category(
    pool: &SqlitePool,
    workspace_id: &str,
    id: &str,
    name: &str,
) -> Result<VariableCategoriesDto, AppError> {
    require_workspace(pool, workspace_id).await?;
    let name = normalize_name(name)?;
    let category = require_category(variable_repo::get_category(pool, id).await?)?;
    require_category_visible_in(&category, workspace_id)?;
    variable_repo::rename_category(pool, id, &name).await?;
    categories_view(pool, workspace_id).await
}

/// 删除分类：其下变量级联全删；删的是激活分类时 FK SET NULL 自动回落
/// 「全不激活」（兜底链只剩全局＋内置）。
pub async fn delete_category(
    pool: &SqlitePool,
    workspace_id: &str,
    id: &str,
) -> Result<VariableCategoriesDto, AppError> {
    require_workspace(pool, workspace_id).await?;
    let category = require_category(variable_repo::get_category(pool, id).await?)?;
    require_category_visible_in(&category, workspace_id)?;
    variable_repo::delete_category(pool, id).await?;
    categories_view(pool, workspace_id).await
}

/// 移动分类到同层 `index` 位（全局组与本空间组各自成层、不相混——树上的
/// 两个固定区；拖拽排序通道，index 越界钳制到末尾）。跨空间分类按不存在
/// 拒绝；返回给定工作空间视角的清单视图。
pub async fn move_category(
    pool: &SqlitePool,
    workspace_id: &str,
    id: &str,
    index: i64,
) -> Result<VariableCategoriesDto, AppError> {
    require_workspace(pool, workspace_id).await?;
    let category = require_category(variable_repo::get_category(pool, id).await?)?;
    require_category_visible_in(&category, workspace_id)?;
    variable_repo::move_category(&mut *pool.acquire().await?, id, index).await?;
    categories_view(pool, workspace_id).await
}

/// 激活链切换：category_id None＝取消激活；Some 时三重校验
/// （存在 / 归属本空间 / 非全局行），全部通过才落指针（单条 UPDATE 原子）。
pub async fn set_active_category(
    pool: &SqlitePool,
    workspace_id: &str,
    category_id: Option<&str>,
) -> Result<VariableCategoriesDto, AppError> {
    require_workspace(pool, workspace_id).await?;
    if let Some(category_id) = category_id {
        let category = require_category(variable_repo::get_category(pool, category_id).await?)?;
        if category.workspace_id.is_none() {
            return Err(AppError::new(
                codes::VARIABLE_CATEGORY_NOT_ACTIVATABLE,
                "global variable category cannot be activated",
            ));
        }
        require_category_visible_in(&category, workspace_id)?;
    }
    variable_repo::set_active_category(pool, workspace_id, category_id).await?;
    categories_view(pool, workspace_id).await
}

/// 分类内变量清单。
pub async fn list_variables(
    pool: &SqlitePool,
    category_id: &str,
) -> Result<VariableListDto, AppError> {
    require_category(variable_repo::get_category(pool, category_id).await?)?;
    let items = variable_repo::list_variables(pool, category_id)
        .await?
        .into_iter()
        .map(|v| VariableDto {
            key: v.key,
            value: v.value,
            secret: v.secret,
        })
        .collect();
    Ok(VariableListDto { items })
}

/// 新建变量（同分类同 key 撞车转稳定错误码，不静默覆盖）。
pub async fn create_variable(
    pool: &SqlitePool,
    category_id: &str,
    key: &str,
    value: &str,
    secret: bool,
) -> Result<VariableListDto, AppError> {
    require_category(variable_repo::get_category(pool, category_id).await?)?;
    let key = normalize_variable_key(key)?;
    variable_repo::insert_variable(
        pool,
        &crate::domain::variable::NewVariable {
            category_id: category_id.to_owned(),
            key,
            value: value.to_owned(),
            secret,
        },
    )
    .await?;
    list_variables(pool, category_id).await
}

/// 更新变量值与敏感标记（身份 (category_id, key) 不动）。
pub async fn update_variable(
    pool: &SqlitePool,
    category_id: &str,
    key: &str,
    value: &str,
    secret: bool,
) -> Result<VariableListDto, AppError> {
    require_category(variable_repo::get_category(pool, category_id).await?)?;
    let key = normalize_variable_key(key)?;
    variable_repo::update_variable(pool, category_id, &key, value, secret).await?;
    list_variables(pool, category_id).await
}

/// 重命名变量：key 是身份的组成，UPDATE 复合主键列原子完成（值与 secret
/// 标记不动）；新 key 规范化后与原 key 同名＝无操作直接返回清单。
pub async fn rename_variable(
    pool: &SqlitePool,
    category_id: &str,
    key: &str,
    new_key: &str,
) -> Result<VariableListDto, AppError> {
    require_category(variable_repo::get_category(pool, category_id).await?)?;
    let new_key = normalize_variable_key(new_key)?;
    if new_key == key {
        return list_variables(pool, category_id).await;
    }
    variable_repo::rename_variable(pool, category_id, key, &new_key).await?;
    list_variables(pool, category_id).await
}

/// 删除变量。
pub async fn delete_variable(
    pool: &SqlitePool,
    category_id: &str,
    key: &str,
) -> Result<VariableListDto, AppError> {
    require_category(variable_repo::get_category(pool, category_id).await?)?;
    variable_repo::delete_variable(pool, category_id, key).await?;
    list_variables(pool, category_id).await
}

/// 工作流写回专用入口（存变量节点的分类写回面）：按分类名在本空间解析
/// （全局行不算命中），命中即写、未命中按名快照重建同名分类后写入；键
/// upsert（无键新建、有键覆盖），敏感标记随写回配置更新。分类解析＋写入
/// 同一事务内完成——任一步失败事务随 drop 整体回滚，不残留半成品分类。
/// 写回≠激活：不改激活指针（值生效仍走生效变量集兜底链）。
pub async fn writeback_to_category(
    pool: &SqlitePool,
    workspace_id: &str,
    category_name: &str,
    key: &str,
    value: &str,
    secret: bool,
) -> Result<(), AppError> {
    let category_name = normalize_name(category_name)?;
    let mut tx = pool.begin().await?;
    let category = match variable_repo::find_workspace_category_by_name(
        &mut *tx,
        workspace_id,
        &category_name,
    )
    .await?
    {
        Some(category) => category,
        None => {
            variable_repo::insert_category(
                &mut *tx,
                &crate::domain::variable::NewVariableCategory {
                    // 分类身份＝裸 UUID v4，与接口域的手工身份语义无关
                    id: uuid::Uuid::new_v4().to_string(),
                    workspace_id: Some(workspace_id.to_owned()),
                    name: category_name,
                },
            )
            .await?
        }
    };
    let key = normalize_variable_key(key)?;
    match variable_repo::insert_variable(
        &mut *tx,
        &crate::domain::variable::NewVariable {
            category_id: category.id.clone(),
            key: key.clone(),
            value: value.to_owned(),
            secret,
        },
    )
    .await
    {
        Ok(_) => {}
        // upsert 语义：键已存在即覆盖（不复用手动新建的撞车报错路径）
        Err(err) if err.code == codes::VARIABLE_KEY_DUPLICATE => {
            variable_repo::update_variable(&mut *tx, &category.id, &key, value, secret).await?;
        }
        Err(err) => return Err(err),
    }
    tx.commit().await?;
    Ok(())
}

/// 拉取并合成生效变量集（激活分类 → 全局分类 → 内置 baseUrl；domain 纯函数
/// 形态）。GUI 生效集右栏（经 [`effective`] 转 DTO）与发送链 Resolver
/// （GUI 发送、Variable Preview、CLI `api run` 同一输入源）共用。
pub async fn load_effective(
    pool: &SqlitePool,
    workspace_id: &str,
) -> Result<Vec<crate::domain::variable::EffectiveVariable>, AppError> {
    require_workspace(pool, workspace_id).await?;
    let active_id = variable_repo::get_active_category_id(pool, workspace_id).await?;
    let active: Vec<_> = match active_id.as_deref() {
        Some(id) => variable_repo::list_variables(pool, id).await?,
        None => Vec::new(),
    };
    // 多全局分类按稳定序拼接：同名键 compose_effective 内先到先占
    let mut global = Vec::new();
    for category in variable_repo::list_global_categories(pool).await? {
        global.extend(variable_repo::list_variables(pool, &category.id).await?);
    }
    let base_url = crate::infrastructure::workspace_repo::get(pool, workspace_id)
        .await?
        .and_then(|ws| ws.base_url);
    Ok(compose_effective(&active, &global, base_url.as_deref()))
}

/// 兜底链合成：激活分类 → 全局分类 → 内置（baseUrl）。
/// 同名激活覆盖全局；无激活只用全局＋内置；base_url 为空则内置条目不出现。
pub async fn effective(pool: &SqlitePool, workspace_id: &str) -> Result<EffectiveSetDto, AppError> {
    let items = load_effective(pool, workspace_id)
        .await?
        .into_iter()
        .map(|v| EffectiveVariableDto {
            key: v.key,
            value: v.value,
            secret: v.secret,
            source: source_label(v.source),
        })
        .collect();
    Ok(EffectiveSetDto { items })
}

/// 候选清单。
pub async fn list_base_urls(
    pool: &SqlitePool,
    workspace_id: &str,
) -> Result<BaseUrlListDto, AppError> {
    require_workspace(pool, workspace_id).await?;
    let items = variable_repo::list_base_urls(pool, workspace_id)
        .await?
        .into_iter()
        .map(|c| BaseUrlCandidateDto {
            id: c.id,
            url: c.url,
        })
        .collect();
    Ok(BaseUrlListDto { items })
}

/// 新增候选（同空间同 URL 撞车转稳定错误码）。
/// 候选只进备选清单，不触碰 `workspaces.base_url` 生效值。
pub async fn add_base_url(
    pool: &SqlitePool,
    workspace_id: &str,
    url: &str,
) -> Result<BaseUrlListDto, AppError> {
    require_workspace(pool, workspace_id).await?;
    // 复用 BaseUrl 校验（去空白 / 长度上限）；候选必须非空
    let url = crate::domain::validate::normalize_base_url(Some(url))?
        .ok_or_else(|| AppError::new(codes::URL_INVALID, "base url candidate must not be empty"))?;
    variable_repo::insert_base_url(
        pool,
        &crate::domain::variable::NewBaseUrlCandidate {
            id: new_manual_identity(),
            workspace_id: workspace_id.to_owned(),
            url,
        },
    )
    .await?;
    list_base_urls(pool, workspace_id).await
}

/// 删除候选（不影响 `workspaces.base_url` 生效值）。
/// 跨空间候选 id 与不存在等价拒绝（归属过滤在 repo 层 SQL 内联）。
pub async fn delete_base_url(
    pool: &SqlitePool,
    workspace_id: &str,
    id: &str,
) -> Result<BaseUrlListDto, AppError> {
    require_workspace(pool, workspace_id).await?;
    let removed = variable_repo::delete_base_url(pool, workspace_id, id).await?;
    if removed == 0 {
        return Err(AppError::new(
            codes::BASE_URL_CANDIDATE_NOT_FOUND,
            format!("base url candidate not found in this workspace: {id}"),
        ));
    }
    list_base_urls(pool, workspace_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::infrastructure::variable_repo::test_support as var_support;
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
        pool
    }

    #[tokio::test]
    async fn list_categories_merges_workspace_and_global_with_pointer() {
        let pool = seeded_pool().await;
        var_support::seed_category(&pool, "vc1", "w1", "空间一").await;
        var_support::seed_global_category(&pool, "g1", "全局一").await;
        set_active_category(&pool, "w1", Some("vc1")).await.unwrap();

        let view = list_categories(&pool, "w1").await.unwrap();
        // 空间分类在前、全局排后；激活指针随包
        assert_eq!(
            view.items.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            vec!["vc1", "g1"]
        );
        assert!(!view.items[0].is_global);
        assert!(view.items[1].is_global);
        assert_eq!(view.active_category_id.as_deref(), Some("vc1"));
    }

    #[tokio::test]
    async fn move_category_reorders_within_scope_and_rejects_foreign() {
        let pool = seeded_pool().await;
        var_support::seed_category(&pool, "vc1", "w1", "一").await;
        var_support::seed_category(&pool, "vc2", "w1", "二").await;
        var_support::seed_category(&pool, "vc3", "w1", "三").await;
        var_support::seed_global_category(&pool, "g1", "全局一").await;
        var_support::seed_global_category(&pool, "g2", "全局二").await;
        crate::infrastructure::workspace_repo::test_support::seed_workspace(&pool, "w2", "二")
            .await;
        var_support::seed_category(&pool, "foreign", "w2", "别人的").await;

        // 本空间组内移动：vc3 到 0 位（钳制前的正常位）
        let view = move_category(&pool, "w1", "vc3", 0).await.unwrap();
        let workspace_order: Vec<_> = view
            .items
            .iter()
            .filter(|c| !c.is_global)
            .map(|c| c.id.as_str())
            .collect();
        assert_eq!(workspace_order, vec!["vc3", "vc1", "vc2"]);

        // 全局组自成一层：g2 移到 0 位不动本空间组
        let view = move_category(&pool, "w1", "g2", 0).await.unwrap();
        let global_order: Vec<_> = view
            .items
            .iter()
            .filter(|c| c.is_global)
            .map(|c| c.id.as_str())
            .collect();
        assert_eq!(global_order, vec!["g2", "g1"]);

        // 越界钳制到末尾
        let view = move_category(&pool, "w1", "vc3", 99).await.unwrap();
        let workspace_order: Vec<_> = view
            .items
            .iter()
            .filter(|c| !c.is_global)
            .map(|c| c.id.as_str())
            .collect();
        assert_eq!(workspace_order, vec!["vc1", "vc2", "vc3"]);

        // 跨空间分类按不存在拒绝
        let err = move_category(&pool, "w1", "foreign", 0).await.unwrap_err();
        assert_eq!(err.code, codes::VARIABLE_CATEGORY_NOT_FOUND);
    }

    #[tokio::test]
    async fn create_category_validates_workspace_and_name() {
        let pool = seeded_pool().await;
        let err = create_category(&pool, "nope", false, "分类")
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::WORKSPACE_NOT_FOUND);
        let err = create_category(&pool, "w1", false, "  ").await.unwrap_err();
        assert_eq!(err.code, codes::NAME_INVALID);
        create_category(&pool, "w1", false, "  开发  ")
            .await
            .unwrap();
        // 全局行：同一视角视图里可见（排在本空间分类之后）
        create_category(&pool, "w1", true, "全局行").await.unwrap();
        let view = list_categories(&pool, "w1").await.unwrap();
        assert_eq!(view.items[0].name, "开发", "名称必须落规范化后的值");
        assert!(!view.items[0].is_global);
        assert_eq!(view.items[1].name, "全局行");
        assert!(view.items[1].is_global);
    }

    #[tokio::test]
    async fn rename_and_delete_reject_foreign_category() {
        let pool = seeded_pool().await;
        crate::infrastructure::workspace_repo::test_support::seed_workspace(&pool, "w2", "二")
            .await;
        var_support::seed_category(&pool, "foreign", "w2", "别人的").await;
        var_support::seed_global_category(&pool, "g1", "全局").await;

        // 跨空间分类按不存在拒绝
        let err = rename_category(&pool, "w1", "foreign", "新名")
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::VARIABLE_CATEGORY_NOT_FOUND);
        let err = delete_category(&pool, "w1", "foreign").await.unwrap_err();
        assert_eq!(err.code, codes::VARIABLE_CATEGORY_NOT_FOUND);

        // 全局行在本空间视角可见可改名
        rename_category(&pool, "w1", "g1", "全局改名")
            .await
            .unwrap();
        let view = list_categories(&pool, "w1").await.unwrap();
        assert_eq!(view.items[0].name, "全局改名");
    }

    #[tokio::test]
    async fn activation_rejects_global_and_missing_and_foreign() {
        let pool = seeded_pool().await;
        crate::infrastructure::workspace_repo::test_support::seed_workspace(&pool, "w2", "二")
            .await;
        var_support::seed_global_category(&pool, "g1", "全局").await;
        var_support::seed_category(&pool, "foreign", "w2", "别人的").await;

        // 全局分类不可激活：稳定错误码
        let err = set_active_category(&pool, "w1", Some("g1"))
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::VARIABLE_CATEGORY_NOT_ACTIVATABLE);
        // 不存在
        let err = set_active_category(&pool, "w1", Some("nope"))
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::VARIABLE_CATEGORY_NOT_FOUND);
        // 跨空间
        let err = set_active_category(&pool, "w1", Some("foreign"))
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::VARIABLE_CATEGORY_NOT_FOUND);
        // 工作空间本身不存在
        let err = set_active_category(&pool, "nope", None).await.unwrap_err();
        assert_eq!(err.code, codes::WORKSPACE_NOT_FOUND);

        // 三重校验全拒后指针保持未动
        let view = list_categories(&pool, "w1").await.unwrap();
        assert_eq!(view.active_category_id, None);
    }

    #[tokio::test]
    async fn variable_crud_validates_key_and_maps_duplicates() {
        let pool = seeded_pool().await;
        var_support::seed_category(&pool, "vc1", "w1", "一").await;

        create_variable(&pool, "vc1", "  token  ", "abc", true)
            .await
            .unwrap();
        let list = list_variables(&pool, "vc1").await.unwrap();
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.items[0].key, "token", "key 必须落规范化后的值");
        assert!(list.items[0].secret);

        // 同分类同 key：稳定错误码（复合主键冲突）
        let err = create_variable(&pool, "vc1", "token", "other", false)
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::VARIABLE_KEY_DUPLICATE);
        // 空 key 拒绝
        let err = create_variable(&pool, "vc1", "  ", "x", false)
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::NAME_INVALID);
        // 分类不存在
        let err = create_variable(&pool, "nope", "k", "x", false)
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::VARIABLE_CATEGORY_NOT_FOUND);

        // 更新与删除
        update_variable(&pool, "vc1", "token", "新值", false)
            .await
            .unwrap();
        let list = list_variables(&pool, "vc1").await.unwrap();
        assert_eq!(
            (list.items[0].value.as_str(), list.items[0].secret),
            ("新值", false)
        );
        delete_variable(&pool, "vc1", "token").await.unwrap();
        assert_eq!(list_variables(&pool, "vc1").await.unwrap().items.len(), 0);
        let err = update_variable(&pool, "vc1", "nope", "x", false)
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::VARIABLE_NOT_FOUND);
    }

    #[tokio::test]
    async fn rename_variable_moves_identity_and_keeps_value() {
        let pool = seeded_pool().await;
        var_support::seed_category(&pool, "vc1", "w1", "一").await;
        var_support::seed_variable(&pool, "vc1", "token", "abc", true).await;

        // 改名：值与 secret 标记不动，清单以新 key 呈现
        let list = rename_variable(&pool, "vc1", "token", "  auth_token  ")
            .await
            .unwrap();
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.items[0].key, "auth_token", "新 key 必须落规范化后的值");
        assert_eq!(
            (list.items[0].value.as_str(), list.items[0].secret),
            ("abc", true)
        );

        // 规范化后同名＝无操作（幂等返回清单，不触发主键写）
        rename_variable(&pool, "vc1", "auth_token", "auth_token")
            .await
            .unwrap();
        assert_eq!(list_variables(&pool, "vc1").await.unwrap().items.len(), 1);

        // 新 key 撞车：稳定错误码，原变量不受影响
        var_support::seed_variable(&pool, "vc1", "taken", "x", false).await;
        let err = rename_variable(&pool, "vc1", "auth_token", "taken")
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::VARIABLE_KEY_DUPLICATE);
        let keys = list_variables(&pool, "vc1").await.unwrap();
        assert_eq!(
            keys.items
                .iter()
                .map(|v| v.key.as_str())
                .collect::<Vec<_>>(),
            vec!["auth_token", "taken"]
        );

        // 原变量不存在；分类不存在
        let err = rename_variable(&pool, "vc1", "nope", "k")
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::VARIABLE_NOT_FOUND);
        let err = rename_variable(&pool, "nope", "k", "k2").await.unwrap_err();
        assert_eq!(err.code, codes::VARIABLE_CATEGORY_NOT_FOUND);
    }

    /// 端到端兜底链：激活分类 → 全局分类 → 内置（baseUrl）；
    /// 同名激活覆盖全局；无激活只用全局＋内置
    #[tokio::test]
    async fn effective_composes_fallback_chain_end_to_end() {
        let pool = seeded_pool().await;
        sqlx::query(
            "UPDATE workspaces SET base_url = 'https://builtin.example.com' WHERE id = 'w1'",
        )
        .execute(&pool)
        .await
        .unwrap();
        var_support::seed_category(&pool, "vc1", "w1", "开发").await;
        var_support::seed_global_category(&pool, "g1", "全局一").await;
        var_support::seed_global_category(&pool, "g2", "全局二").await;
        var_support::seed_variable(&pool, "vc1", "host", "https://active.example.com", false).await;
        var_support::seed_variable(&pool, "vc1", "onlyActive", "a", false).await;
        var_support::seed_variable(&pool, "g1", "host", "https://global.example.com", false).await;
        var_support::seed_variable(&pool, "g1", "token", "t", true).await;
        var_support::seed_variable(&pool, "g2", "host", "https://global2.example.com", false).await;
        var_support::seed_variable(&pool, "g2", "onlyGlobal2", "g2", false).await;

        // 无激活：全局（多分类按稳定序、同名先到先占）＋内置
        // 查找助手按参收集合，避免闭包捕获旧集合（shadow 后读到过期值）
        let find = |set: &EffectiveSetDto, k: &str| {
            set.items.iter().find(|v| v.key == k).cloned().unwrap()
        };
        let set = effective(&pool, "w1").await.unwrap();
        assert_eq!(set.items.len(), 4);
        assert_eq!(find(&set, "host").value, "https://global.example.com");
        assert_eq!(find(&set, "host").source, "global");
        assert!(find(&set, "token").secret);
        assert_eq!(find(&set, BUILTIN_KEY).value, "https://builtin.example.com");
        assert_eq!(find(&set, BUILTIN_KEY).source, "builtin");

        // 激活后：同名激活覆盖全局，非同名全局保留
        set_active_category(&pool, "w1", Some("vc1")).await.unwrap();
        let set = effective(&pool, "w1").await.unwrap();
        assert_eq!(set.items.len(), 5);
        assert_eq!(find(&set, "host").value, "https://active.example.com");
        assert_eq!(find(&set, "host").source, "active");
        assert_eq!(find(&set, "onlyActive").value, "a");
        assert_eq!(find(&set, "token").source, "global");
        assert_eq!(find(&set, "onlyGlobal2").value, "g2");
        assert_eq!(find(&set, BUILTIN_KEY).source, "builtin");

        let err = effective(&pool, "nope").await.unwrap_err();
        assert_eq!(err.code, codes::WORKSPACE_NOT_FOUND);
    }

    /// 无 base_url：内置条目不出现（只剩全局）
    #[tokio::test]
    async fn effective_omits_builtin_when_base_url_absent() {
        let pool = seeded_pool().await;
        var_support::seed_global_category(&pool, "g1", "全局").await;
        var_support::seed_variable(&pool, "g1", "token", "t", false).await;

        let set = effective(&pool, "w1").await.unwrap();
        assert_eq!(set.items.len(), 1);
        assert_eq!(set.items[0].key, "token");
    }

    #[tokio::test]
    async fn base_url_candidates_roundtrip_with_stable_duplicate_error() {
        let pool = seeded_pool().await;
        add_base_url(&pool, "w1", " https://a.example.com ")
            .await
            .unwrap();
        let list = list_base_urls(&pool, "w1").await.unwrap();
        assert_eq!(
            list.items[0].url, "https://a.example.com",
            "URL 必须落规范化后的值"
        );

        // 同空间同 URL：稳定错误码
        let err = add_base_url(&pool, "w1", "https://a.example.com")
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::BASE_URL_CANDIDATE_DUPLICATE);
        // 空串拒绝
        let err = add_base_url(&pool, "w1", "   ").await.unwrap_err();
        assert_eq!(err.code, codes::URL_INVALID);
        // 空间不存在
        let err = add_base_url(&pool, "nope", "https://x").await.unwrap_err();
        assert_eq!(err.code, codes::WORKSPACE_NOT_FOUND);

        // 删除候选不影响生效值
        sqlx::query("UPDATE workspaces SET base_url = 'https://a.example.com' WHERE id = 'w1'")
            .execute(&pool)
            .await
            .unwrap();
        delete_base_url(&pool, "w1", &list.items[0].id)
            .await
            .unwrap();
        assert_eq!(list_base_urls(&pool, "w1").await.unwrap().items.len(), 0);
        let ws = crate::infrastructure::workspace_repo::get(&pool, "w1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            ws.base_url.as_deref(),
            Some("https://a.example.com"),
            "删候选不得影响生效值"
        );
    }

    /// 跨空间越权删除拒绝：别空间候选 id 对本空间不可见，与不存在等价。
    #[tokio::test]
    async fn delete_base_url_rejects_cross_workspace_id() {
        let pool = seeded_pool().await;
        crate::infrastructure::workspace_repo::test_support::seed_workspace(&pool, "w2", "二")
            .await;
        add_base_url(&pool, "w1", "https://a.example.com")
            .await
            .unwrap();
        let list = list_base_urls(&pool, "w1").await.unwrap();

        let err = delete_base_url(&pool, "w2", &list.items[0].id)
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::BASE_URL_CANDIDATE_NOT_FOUND);
        // 原空间候选原样保留
        assert_eq!(list_base_urls(&pool, "w1").await.unwrap().items.len(), 1);
        // 本空间不存在的 id 同码
        let err = delete_base_url(&pool, "w1", "nope").await.unwrap_err();
        assert_eq!(err.code, codes::BASE_URL_CANDIDATE_NOT_FOUND);
    }

    /// 写回入口：未命中按名重建（裸 UUID 身份）、命中复用既有分类；键
    /// upsert 覆盖值与敏感标记；同名全局行不算命中（解析只认本空间行）。
    #[tokio::test]
    async fn writeback_resolves_by_name_and_upserts_key() {
        let pool = seeded_pool().await;
        // 同名全局行存在：写回不得命中它，必须另建本空间分类
        var_support::seed_global_category(&pool, "g1", "登录态").await;

        // 未命中：重建同名本空间分类并写入（分类名与键落规范化后的值）
        writeback_to_category(&pool, "w1", "  登录态  ", "  token  ", "t-1", true)
            .await
            .unwrap();
        let categories = variable_repo::list_workspace_categories(&pool, "w1")
            .await
            .unwrap();
        assert_eq!(categories.len(), 1, "全局同名行不算命中，另建本空间分类");
        assert_eq!(categories[0].name, "登录态");
        assert!(
            uuid::Uuid::parse_str(&categories[0].id).is_ok(),
            "重建分类身份＝裸 UUID"
        );
        let variables = variable_repo::list_variables(&pool, &categories[0].id)
            .await
            .unwrap();
        assert_eq!(variables.len(), 1);
        assert_eq!(variables[0].key, "token");
        assert_eq!(
            (variables[0].value.as_str(), variables[0].secret),
            ("t-1", true)
        );

        // 命中：复用既有分类，同键覆盖值与敏感标记（敏感 true→false 反向收敛）
        writeback_to_category(&pool, "w1", "登录态", "token", "t-2", false)
            .await
            .unwrap();
        let categories = variable_repo::list_workspace_categories(&pool, "w1")
            .await
            .unwrap();
        assert_eq!(categories.len(), 1, "命中即写，不得重复建分类");
        let variables = variable_repo::list_variables(&pool, &categories[0].id)
            .await
            .unwrap();
        assert_eq!(variables.len(), 1, "同键覆盖不新增行");
        assert_eq!(
            (variables[0].value.as_str(), variables[0].secret),
            ("t-2", false)
        );
    }

    /// 分类被删后按名自愈重建：写入新分类行（旧 id 不复用），变量随写回归位。
    #[tokio::test]
    async fn writeback_rebuilds_category_after_delete() {
        let pool = seeded_pool().await;
        writeback_to_category(&pool, "w1", "登录态", "token", "t-1", true)
            .await
            .unwrap();
        let first = &variable_repo::list_workspace_categories(&pool, "w1")
            .await
            .unwrap()[0];
        variable_repo::delete_category(&pool, &first.id)
            .await
            .unwrap();

        writeback_to_category(&pool, "w1", "登录态", "token", "t-2", true)
            .await
            .unwrap();
        let categories = variable_repo::list_workspace_categories(&pool, "w1")
            .await
            .unwrap();
        assert_eq!(categories.len(), 1);
        assert_ne!(categories[0].id, first.id, "重建为新分类行");
        let variables = variable_repo::list_variables(&pool, &categories[0].id)
            .await
            .unwrap();
        assert_eq!(variables.len(), 1);
        assert_eq!(variables[0].key, "token");
        assert_eq!(variables[0].value, "t-2");
    }

    /// 事务原子性：分类解析＋写入任一步失败整体回滚，错误路径零残留。
    #[tokio::test]
    async fn writeback_rolls_back_without_residue_on_failure() {
        let pool = seeded_pool().await;

        // 工作空间不存在：分类重建步外键失败，错误透传
        let err = writeback_to_category(&pool, "nope", "登录态", "token", "t", true)
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::DB_QUERY_FAILED);

        // 分类缺失＋键非法：键校验在分类重建之后失败，事务回滚已建分类
        // （无事务时此处会残留空分类——原子性的关键反例）
        let err = writeback_to_category(&pool, "w1", "登录态", "  ", "t", true)
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::NAME_INVALID);
        assert!(
            variable_repo::list_workspace_categories(&pool, "w1")
                .await
                .unwrap()
                .is_empty(),
            "失败路径不得残留半成品分类"
        );

        // 非法分类名：入口即拒，零写入
        let err = writeback_to_category(&pool, "w1", "  ", "token", "t", true)
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::NAME_INVALID);
        assert!(
            variable_repo::list_workspace_categories(&pool, "w1")
                .await
                .unwrap()
                .is_empty()
        );
    }

    /// 内置键常量（测试内引用避免魔法字符串）
    const BUILTIN_KEY: &str = crate::domain::variable::BUILTIN_BASE_URL_KEY;
}
