//! 同步·应用事务（向导确认段的落库通道）。
//!
//! 单事务完成（快照滚动时点在**全量应用**——拉取只写待应用暂存，未采用
//! 的变更不得刷新快照）：
//! 1. 徽标重打：本服务同步接口旧徽标先清（应用是徽标的唯一写入方——
//!    无变化行不残留上轮标记）；
//! 2. 遍历 [`SyncPlan`] 动作集（每稳定键一个动作，删除 / 手工身份的对账
//!    判定单点在 domain::sync::plan）：Insert 新键 INSERT（含定义侧元数据
//!    扩容 doc；消失后回归同走此路径，用户数据与置顶凭稳定键原地重接）；
//!    Update 既有键更新 definition 打 `changed`；Unchanged 无变化行徽标
//!    清空；Delete 库内存量键不在新文档 → 定义行直接删除（用户数据 /
//!    置顶 / 历史不动）；
//! 3. 参数与请求体静默对齐：params 行对齐文档参数集（补缺删多、已填值
//!    不动），body 对齐文档 JSON 骨架（补缺键、删骨架外键，已有值永不被
//!    覆盖）——对齐不进 diff 三组、不打徽标（变更判定只归快照比对）；
//!    **这是同步对用户数据表的唯一写入路径**；
//! 4. 快照转正（仅全量应用＝无勾选集，或勾选集覆盖全部变更动作）：待
//!    应用拉取滚动写入新代并清除暂存——与本事务同提交；部分应用不转正
//!    （未勾选行的变更保持待应用，下次同步仍在清单）。
//!
//! 不变式：
//! - **用户已填值永不被覆盖**：params 对齐只增删行、不改保留行的任何
//!   字段；body 装配层护栏保证骨架内用户已有值恒 Keep；
//! - **取消零副作用**：应用是快速本地事务（无网络 await 点），未提交即
//!   回滚；任一步失败（含对齐结果超限）整体回滚；
//! - 分类映射：tag（`UnifiedOperation.category`）→ 服务内同名分类复用、
//!   缺则建（追加末尾），无 tag＝散层（category_id NULL）。

use serde::Serialize;
use sqlx::{SqliteConnection, SqlitePool};

use crate::domain::endpoint::{Definition, EndpointDoc, HttpMethod};
use crate::domain::sync::merge;
use crate::domain::sync::model::{UnifiedOperation, UnifiedParamLocation, UnifiedParameter};
use crate::domain::sync::plan::{SyncAction, SyncActionKind};
use crate::domain::user_data::UserDataInput;
use crate::domain::user_data_codec::{
    BodyEnvelopeKind, empty_object_as_empty_rows, parse_body_envelope, parse_kv_rows,
    scaffold_kv_row, serialize_kv_rows, write_json_envelope,
};
use crate::error::AppError;
use crate::infrastructure::{category_repo, snapshot_repo, user_data_repo};
use crate::services::sync_diff::compute_plan;

/// 应用结果（向导完成段消费）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    /// 新增入树（badge=new）
    pub added: usize,
    /// 定义侧有变化并更新
    pub changed: usize,
    /// 消失键定义行直接删除（用户数据 / 置顶 / 历史原地保留）
    pub removed: usize,
    /// 键匹配但定义面零变化（徽标清空）
    pub unchanged: usize,
}

/// 对指定服务执行应用事务。前置＝已有快照（拉取先行）；计划在库内重算
/// （库为事实源，不收前端载荷），与对比服务共用同一装配 [`compute_plan`]
/// ——确认面与应用结果同源不分叉。参数与请求体在应用内静默对齐（无需
/// 前端裁决载荷）。
///
/// `keys`＝确认段接口粒度勾选集（稳定键）：`None` 全量应用（向后兼容）；
/// `Some` 只落勾选行——动作集按键过滤，徽标重打同口径只清勾选集（未勾选
/// 行的定义与徽标一律不动，留待后续勾选或全量应用）。
pub async fn apply(
    pool: &SqlitePool,
    service_id: &str,
    keys: Option<&[String]>,
) -> Result<ApplyOutcome, AppError> {
    let (_generation, mut plan) = compute_plan(pool, service_id).await?;
    // 全量应用判定（快照转正门槛）：无勾选集＝全量；有勾选集时须覆盖全部
    // 变更动作（Insert / Update / Delete——Unchanged 行不含变更，不构成
    // 「未采用的变更」）。部分应用不转正：未勾选行的变更保持待应用
    let full_apply = match keys {
        None => true,
        Some(selected) => plan.actions.iter().all(|action| {
            action.kind == SyncActionKind::Unchanged || selected.contains(&action.key)
        }),
    };
    // 无变化计数在勾选过滤前按全量计划取得：无变化行不在确认清单里、永不
    // 被勾选，完成段需要「本次同步有多少接口与快照一致」的完整口径
    let unchanged_count = plan
        .actions
        .iter()
        .filter(|action| action.kind == SyncActionKind::Unchanged)
        .count();
    if let Some(selected) = keys {
        plan.actions.retain(|action| selected.contains(&action.key));
    }

    let mut tx = pool.begin().await?;
    let mut outcome = ApplyOutcome {
        added: 0,
        changed: 0,
        removed: 0,
        unchanged: 0,
    };

    // 1) 徽标重打：本服务同步接口旧徽标先清（badge 仅同步接口消费）。
    //    全量应用（含勾选集覆盖全部变更动作）清全部旧标——无变化行不在
    //    确认清单里，不能因未被勾选而残留上一轮标记；部分应用只清勾选行，
    //    未勾选行留待其应用。
    if full_apply {
        sqlx::query("UPDATE endpoints SET badge = NULL WHERE service_id = ?")
            .bind(service_id)
            .execute(&mut *tx)
            .await?;
    } else if let Some(selected) = keys
        && !selected.is_empty()
    {
        // 稳定键经 QueryBuilder 绑定传参（不拼值）；动态键集的 IN 子句
        let mut builder =
            sqlx::QueryBuilder::new("UPDATE endpoints SET badge = NULL WHERE service_id = ");
        builder.push_bind(service_id).push(" AND key IN (");
        let mut separated = builder.separated(", ");
        for key in selected {
            separated.push_bind(key);
        }
        builder.push(")");
        builder.build().execute(&mut *tx).await?;
    }

    // 分类映射缓存（tag → category_id；事务内建类立即可见）
    let mut category_cache: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    // 2) 遍历计划动作集：每稳定键一个动作，按 kind 分流落库——Delete
    //    无当前代操作（无 op），其余三类恒有 op（plan 构造单点保证，经
    //    current_op 取用）；对账判定单点在 domain::sync::plan
    for action in &plan.actions {
        match action.kind {
            // 消失键删除：只删定义行（用户数据 / 置顶 / 历史原地保留，
            // 同键回归凭稳定键 INSERT 重接）
            SyncActionKind::Delete => {
                sqlx::query("DELETE FROM endpoints WHERE service_id = ? AND key = ?")
                    .bind(service_id)
                    .bind(&action.key)
                    .execute(&mut *tx)
                    .await?;
                outcome.removed += 1;
            }
            // 新键插入（badge 随入树打 new）
            SyncActionKind::Insert => {
                let op = current_op(action);
                let (category_id, definition_json) =
                    upsert_inputs(&mut tx, service_id, op, &mut category_cache).await?;
                insert_sync(&mut tx, service_id, op, category_id, &definition_json).await?;
                outcome.added += 1;
            }
            // 既有键定义面有变化 → 更新 definition 打 changed
            SyncActionKind::Update => {
                let op = current_op(action);
                let (category_id, definition_json) =
                    upsert_inputs(&mut tx, service_id, op, &mut category_cache).await?;
                update_sync(
                    &mut tx,
                    service_id,
                    op,
                    category_id,
                    &definition_json,
                    Some("changed"),
                )
                .await?;
                outcome.changed += 1;
            }
            // 既有键定义面零变化 → 更新身份字段、徽标清空
            SyncActionKind::Unchanged => {
                let op = current_op(action);
                let (category_id, definition_json) =
                    upsert_inputs(&mut tx, service_id, op, &mut category_cache).await?;
                update_sync(
                    &mut tx,
                    service_id,
                    op,
                    category_id,
                    &definition_json,
                    NULL_BADGE,
                )
                .await?;
            }
        }
    }
    // 无变化计数取自勾选过滤前的全量计划（被过滤掉的 Unchanged 动作也计入）
    outcome.unchanged = unchanged_count;

    // 3) 参数与请求体对齐（静默、不算变更）：对计划内每个带当前代操作的
    //    接口（覆盖 Insert / Update / Unchanged 全集），文档
    //    参数按位置分流——header 参数对齐 headers 列，其余（query / path /
    //    formData）对齐用户数据 params 行（补缺＝空值行、删多、已填值/启停/
    //    标注不动）；body 与文档 JSON 骨架对齐（补缺键、删骨架外键、已有值
    //    永不被覆盖——装配层护栏）。对齐不进 diff 三组、不打徽标——变更
    //    判定只归快照比对；这是同步对用户数据表的唯一写入路径。
    for action in &plan.actions {
        let Some(op) = &action.op else {
            continue;
        };
        let existing_row = user_data_repo::get(&mut *tx, service_id, &op.key).await?;
        let (row_params, header_params): (Vec<&UnifiedParameter>, Vec<&UnifiedParameter>) = op
            .parameters
            .iter()
            .partition(|p| p.location != UnifiedParamLocation::Header);
        let params_aligned = align_kv_rows(
            existing_row
                .as_ref()
                .map(|d| d.params.as_str())
                .unwrap_or("[]"),
            &row_params,
        );
        let headers_aligned = align_kv_rows(
            existing_row
                .as_ref()
                .map(|d| empty_object_as_empty_rows(&d.headers))
                .unwrap_or("[]"),
            &header_params,
        );
        let body_aligned =
            align_body_value(existing_row.as_ref().and_then(|d| d.body.as_deref()), op);
        let (params_final, headers_final, body_final) = match &existing_row {
            Some(ud) => (
                params_aligned.unwrap_or_else(|| ud.params.clone()),
                headers_aligned.unwrap_or_else(|| ud.headers.clone()),
                body_aligned.unwrap_or_else(|| ud.body.clone()),
            ),
            // 无用户数据行（首次同步 / 从未编辑）：铺初始行——文档参数全集
            // 空值行 + 请求体骨架示例（无骨架不建 body）；headers 无 header
            // 参数时铺空行数组 "[]"（与 params 同构，行数组才是可对齐形态）
            None => (
                params_aligned.unwrap_or_else(|| "[]".to_string()),
                headers_aligned.unwrap_or_else(|| "[]".to_string()),
                body_aligned.unwrap_or(None),
            ),
        };
        let changed = match &existing_row {
            Some(ud) => {
                params_final != ud.params || headers_final != ud.headers || body_final != ud.body
            }
            None => params_final != "[]" || headers_final != "[]" || body_final.is_some(),
        };
        if !changed {
            continue;
        }
        let input = match &existing_row {
            Some(ud) => UserDataInput {
                body: body_final,
                params: params_final,
                headers: headers_final,
                timeout_seconds: ud.timeout_seconds,
                auth: ud.auth.clone(),
                path_override: ud.path_override.clone(),
                method_override: ud.method_override.clone(),
            },
            None => UserDataInput {
                body: body_final,
                params: params_final,
                headers: headers_final,
                timeout_seconds: None,
                auth: None,
                path_override: None,
                method_override: None,
            },
        };
        input.validate_size()?;
        user_data_repo::upsert(&mut *tx, service_id, &op.key, &input).await?;
    }

    // 快照转正（滚动时点在全量应用）：待应用拉取写入新代（两代之外淘汰）
    // 并清除暂存——与应用同一事务提交；部分应用保留暂存与旧基准
    if full_apply && let Some(pending) = snapshot_repo::pending_get(&mut *tx, service_id).await? {
        snapshot_repo::roll_forward(&mut tx, service_id, &pending.content, &pending.sha256).await?;
        snapshot_repo::pending_delete(&mut tx, service_id).await?;
    }

    tx.commit().await?;
    Ok(outcome)
}

/// 未变化行徽标置 NULL 的哨兵（与 SQL 字面 NULL 绑定区分：bind Option）。
const NULL_BADGE: Option<&str> = None;

/// 非删除动作的当前代操作。plan 构造单点保证「每稳定键一个动作」：
/// Delete 之外的 kind 都由新文档操作派生（op 恒在场）——主循环按
/// kind 分流后经此取用；不变量违反＝plan 构造缺陷，fail-fast。
fn current_op(action: &SyncAction) -> &UnifiedOperation {
    action
        .op
        .as_ref()
        .expect("non-delete action carries its current op")
}

/// 非删除动作的公共落库前置：分类归属（tag → category_id，事务内建类
/// 立即可见）＋扩容定义序列化。
async fn upsert_inputs(
    tx: &mut SqliteConnection,
    service_id: &str,
    op: &UnifiedOperation,
    category_cache: &mut std::collections::HashMap<String, String>,
) -> Result<(Option<String>, String), AppError> {
    let category_id = match &op.category {
        Some(tag) => Some(ensure_category(tx, service_id, tag, category_cache).await?),
        None => None,
    };
    let definition = expanded_definition(op)?;
    let definition_json = serde_json::to_string(&definition).map_err(|err| {
        AppError::internal(format!("expanded definition not serializable: {err}"))
    })?;
    Ok((category_id, definition_json))
}

/// 用户 KV 行（params / headers 列共用）与文档参数集对齐（补缺删多、已填
/// 值/启停/标注不动；调用方按参数位置先行分流，headers 列的空对象输入由
/// 调用方先归一为空行集）。返回 `None`＝无需写回：原串不是 `{name, value}`
/// 行数组（原文保真模式，不改写不可解析的用户数据——headers 列的非空
/// 对象形态同此边界）或补删后无变化。补行经 codec 铺行单点构造（值恒空、
/// 默认启用，type/description 取文档定义，此后文档更新不再触碰既有行）。
fn align_kv_rows(user_rows: &str, params: &[&UnifiedParameter]) -> Option<String> {
    let rows = parse_kv_rows(user_rows)?;
    let defined: std::collections::HashSet<&str> = params.iter().map(|p| p.name.as_str()).collect();
    let mut kept: Vec<serde_json::Value> = Vec::with_capacity(rows.len());
    let mut removed = 0usize;
    for row in rows {
        match row.get("name").and_then(serde_json::Value::as_str) {
            Some(name) if defined.contains(name) => kept.push(row),
            // 文档外行（含无名行）删除；无名行不是合法参数行
            _ => removed += 1,
        }
    }
    let present: std::collections::HashSet<String> = kept
        .iter()
        .filter_map(|r| r.get("name").and_then(serde_json::Value::as_str))
        .map(str::to_owned)
        .collect();
    let mut added = 0usize;
    for param in params {
        if present.contains(&param.name) {
            continue;
        }
        kept.push(scaffold_kv_row(
            &param.name,
            &param.param_type,
            param.description.as_deref(),
        ));
        added += 1;
    }
    if added == 0 && removed == 0 {
        return None;
    }
    Some(serialize_kv_rows(kept))
}

/// JSON 家族媒体类型判定（对齐面的适用范围）：精确 application/json／
/// `+json` 后缀变体／text/json 同为 JSON 键结构。
fn is_json_family_media_type(content_type: &str) -> bool {
    let lowered = content_type.to_ascii_lowercase();
    lowered == "application/json" || lowered.ends_with("+json") || lowered == "text/json"
}

/// 用户 body 与文档请求体骨架对齐（补缺键、删骨架外键、已有值永不被覆盖
/// ——装配层护栏）。外层 `None`＝不写回：文档无 JSON 请求体、用户体不可
/// 合并（原文保真）或对齐后无变化；`Some(None)`＝骨架无内容可铺（保持空）。
/// 骨架铺底（用户无 body）时全量 Fill 文档示例值，写回为 json 信封。
fn align_body_value(user_body: Option<&str>, op: &UnifiedOperation) -> Option<Option<String>> {
    // 仅 JSON 家族请求体有对齐面（normalize 择优后通常已是精确
    // application/json；+json 变体与 text/json 同为键结构，家族判定作保底）
    let body = op.request_body.as_ref()?;
    if !is_json_family_media_type(&body.content_type) {
        return None;
    }
    // 读侧先解信封（与发送面 parse_body_envelope 同一契约）：json / xml /
    // text 信封取 text 载体参与合并；none / form 系（rows 载体）＝用户有意
    // 选择，body 整列不触碰；非信封 legacy 纯文本照旧当裸 JSON
    let user_text: Option<String> = match user_body {
        None => None,
        Some(text) => match parse_body_envelope(text) {
            Some(envelope) => match envelope.kind {
                BodyEnvelopeKind::None
                | BodyEnvelopeKind::FormUrlEncoded
                | BodyEnvelopeKind::FormData => return None,
                // text 载体缺失或空白＝无有效内容，视同无 body 铺骨架
                BodyEnvelopeKind::Json | BodyEnvelopeKind::Xml | BodyEnvelopeKind::Text => {
                    envelope.text.filter(|t| !t.trim().is_empty())
                }
            },
            None => Some(text.to_owned()),
        },
    };
    match user_text.as_deref() {
        None => {
            let merged = merge::align(None, &body.schema);
            if merged.is_null() || merged.as_object().is_some_and(|o| o.is_empty()) {
                return None;
            }
            Some(Some(write_json_envelope(
                &serde_json::to_string_pretty(&merged).ok()?,
            )))
        }
        Some(text) => {
            let user_value: serde_json::Value = serde_json::from_str(text).ok()?;
            let merged = merge::align(Some(&user_value), &body.schema);
            // 等价判定在 text 载体层面（骨架内用户值语义不变＝不写回，用户
            // 排版与信封 kind 原样保留）
            if user_value == merged {
                return None;
            }
            Some(Some(write_json_envelope(
                &serde_json::to_string_pretty(&merged).ok()?,
            )))
        }
    }
}

/// 扩容 definition：身份字段 + 定义侧元数据 doc。
fn expanded_definition(op: &UnifiedOperation) -> Result<Definition, AppError> {
    let method = HttpMethod::parse(&op.method)?;
    Ok(Definition {
        method,
        path_template: op.path.clone(),
        doc: Some(EndpointDoc {
            title: op.title.clone(),
            category: op.category.clone(),
            description: op.description.clone(),
            parameters: op.parameters.clone(),
            request_body: op.request_body.clone(),
            responses: op.responses.clone(),
        }),
    })
}

/// tag → 分类 id（服务内同名复用、缺则建；追加末尾）。
async fn ensure_category(
    tx: &mut SqliteConnection,
    service_id: &str,
    tag: &str,
    cache: &mut std::collections::HashMap<String, String>,
) -> Result<String, AppError> {
    if let Some(id) = cache.get(tag) {
        return Ok(id.clone());
    }
    let categories = category_repo::list_by_service(&mut *tx, service_id).await?;
    if let Some(hit) = categories.iter().find(|c| c.name == *tag) {
        cache.insert(tag.to_string(), hit.id.clone());
        return Ok(hit.id.clone());
    }
    let id = crate::domain::endpoint::new_manual_identity();
    category_repo::insert(
        &mut *tx,
        &crate::domain::category::NewCategory {
            id: id.clone(),
            service_id: service_id.to_string(),
            name: tag.to_string(),
        },
    )
    .await?;
    cache.insert(tag.to_string(), id.clone());
    Ok(id)
}

/// 同步接口插入（稳定键身份；badge 随入树打 `new`；消失后回归即普通
/// INSERT，既有用户数据与置顶凭稳定键原地重接）。
async fn insert_sync(
    tx: &mut SqliteConnection,
    service_id: &str,
    op: &UnifiedOperation,
    category_id: Option<String>,
    definition_json: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO endpoints (service_id, key, title, category_id, definition, created_at, badge, sort_order) \
         VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'new', \
         (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM endpoints \
          WHERE service_id = ? AND category_id IS ?))",
    )
    .bind(service_id)
    .bind(&op.key)
    .bind(&op.title)
    .bind(&category_id)
    .bind(definition_json)
    .bind(service_id)
    .bind(&category_id)
    .execute(&mut *tx)
    .await?;
    Ok(())
}

/// 同步接口更新（definition 全量替换；badge 按行分类重打或清空）。
async fn update_sync(
    tx: &mut SqliteConnection,
    service_id: &str,
    op: &UnifiedOperation,
    category_id: Option<String>,
    definition_json: &str,
    badge: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE endpoints SET title = ?, category_id = ?, definition = ?, badge = ? \
                 WHERE service_id = ? AND key = ?",
    )
    .bind(&op.title)
    .bind(category_id)
    .bind(definition_json)
    .bind(badge)
    .bind(service_id)
    .bind(&op.key)
    .execute(&mut *tx)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::error::codes;
    use crate::infrastructure::service_repo::test_support::seed_service_with_doc_url;
    use crate::infrastructure::workspace_repo::test_support as ws_support;
    use crate::infrastructure::{endpoint_repo, snapshot_repo};
    use sqlx::SqlitePool;

    async fn memory_pool() -> SqlitePool {
        let pool = db::connect_in_memory().await;
        db::run_migrations(&pool).await.unwrap();
        pool
    }

    async fn seeded(pool: &SqlitePool) {
        ws_support::seed_workspace(pool, "w1", "一").await;
        seed_service_with_doc_url(pool, "s1", "w1", "服务A", Some("http://127.0.0.1:1/doc")).await;
    }

    fn sha(payload: &str) -> String {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(payload.as_bytes());
        format!("{:x}", h.finalize())
    }

    /// 极简 Swagger 2.0：指定路由模板集（summary 恒「查」）。
    fn swagger(paths: &[(&str, &str)]) -> String {
        let body: Vec<String> = paths
            .iter()
            .map(|(p, summary)| {
                format!(
                    "\"{p}\": {{\"get\": {{\"tags\": [\"用户\"], \"summary\": \"{summary}\", \
                     \"responses\": {{\"200\": {{\"description\": \"ok\"}}}}}}}}"
                )
            })
            .collect();
        format!(
            "{{\"swagger\": \"2.0\", \"info\": {{\"title\": \"t\", \"version\": \"1\"}}, \"paths\": {{{}}}}}",
            body.join(",")
        )
    }

    /// 模拟一次拉取落待应用暂存（不滚代；滚动只随全量应用）。
    async fn fetch_seed(pool: &SqlitePool, content: &str) {
        snapshot_repo::pending_upsert(
            &mut pool.acquire().await.unwrap(),
            "s1",
            content,
            &sha(content),
        )
        .await
        .unwrap();
    }

    async fn badges(pool: &SqlitePool) -> Vec<(String, Option<String>)> {
        sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT key, badge FROM endpoints WHERE service_id = 's1' ORDER BY key",
        )
        .fetch_all(pool)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn no_snapshot_is_stable_error() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        let err = apply(&pool, "s1", None).await.unwrap_err();
        assert_eq!(err.code, codes::SYNC_NO_SNAPSHOT);
    }

    #[tokio::test]
    async fn first_apply_inserts_with_category_and_new_badge() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        fetch_seed(
            &pool,
            &swagger(&[("/users", "查"), ("/users/{id}", "单查")]),
        )
        .await;

        let outcome = apply(&pool, "s1", None).await.unwrap();
        assert_eq!(outcome.added, 2);
        assert_eq!(outcome.changed, 0);

        let rows = badges(&pool).await;
        assert_eq!(rows.len(), 2);
        assert!(
            rows.iter()
                .all(|(_, badge)| badge.as_deref() == Some("new"))
        );

        // tag → 同名分类建类归属（两接口同 tag「用户」进同一分类）
        let categories = category_repo::list_by_service(&pool, "s1").await.unwrap();
        assert_eq!(categories.len(), 1);
        assert_eq!(categories[0].name, "用户");
        let rows_in_category: Vec<String> = endpoint_repo::list_by_service(&pool, "s1")
            .await
            .unwrap()
            .into_iter()
            .map(|e| e.key)
            .collect();
        assert_eq!(rows_in_category.len(), 2);

        // definition 扩容：doc 元数据可读回（文档抽屉数据源）
        let doc = endpoint_repo::get(&pool, "s1", "GET /users")
            .await
            .unwrap()
            .unwrap();
        let definition: Definition = serde_json::from_str(&doc.definition).unwrap();
        assert!(definition.doc.is_some());
        assert_eq!(definition.doc.unwrap().title, "查");
    }

    #[tokio::test]
    async fn second_apply_changed_badge_and_unchanged_clears() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        fetch_seed(&pool, &swagger(&[("/users", "查"), ("/orders", "订单")])).await;
        apply(&pool, "s1", None).await.unwrap();

        // 二代：orders 的 summary 变（title 变不算 changed——换 description 面：
        // 加 query 参数使定义侧变化），users 不动
        let changed = swagger2_with_param(&swagger(&[("/users", "查"), ("/orders", "订单")]));
        fetch_seed(&pool, &changed).await;
        let outcome = apply(&pool, "s1", None).await.unwrap();
        assert_eq!(outcome.changed, 1);
        assert_eq!(outcome.unchanged, 1);

        let rows = badges(&pool).await;
        let orders = rows.iter().find(|(k, _)| k == "GET /orders").unwrap();
        assert_eq!(orders.1.as_deref(), Some("changed"));
        let users = rows.iter().find(|(k, _)| k == "GET /users").unwrap();
        assert_eq!(users.1, None, "无变化行徽标清空（不残留上一轮 new）");
    }

    fn swagger2_with_param(base: &str) -> String {
        base.replace(
            "\"/orders\": {\"get\": {\"tags\":",
            "\"/orders\": {\"get\": {\"parameters\": [{\"name\": \"page\", \"in\": \"query\", \"type\": \"integer\"}], \"tags\":",
        )
    }

    /// 用户数据不变式（跨表）：消失键应用后定义行物理删除，用户数据 /
    /// 置顶 / 历史三表原地保留（零触碰）；文档回归后同键走首次导入路径以
    /// Insert 重现，既有用户数据与置顶凭稳定键原地重接、历史行原地保留。
    #[tokio::test]
    async fn disappeared_endpoint_deleted_definition_only_and_reimport_reconnects_user_data() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        fetch_seed(&pool, &swagger(&[("/users", "查"), ("/gone", "将删")])).await;
        apply(&pool, "s1", None).await.unwrap();
        // 用户数据 / 置顶 / 历史（用户数据不变式的三张对照表）
        sqlx::query(
            "INSERT INTO endpoint_user_data (service_id, key, body, params, headers, updated_at) \
                     VALUES ('s1', 'GET /gone', '留存', '[]', '[]', '2026-01-01T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO pinned_endpoints (service_id, key) VALUES ('s1', 'GET /gone')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO run_records (id, workspace_id, service_id, endpoint_key, method, url, state, request_json, source, created_at) \
             VALUES ('run_seed_gone', 'w1', 's1', 'GET /gone', 'GET', 'http://127.0.0.1:1/gone', 'passed', '{}', 'gui', '2026-01-01T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // 二代：gone 消失 → 定义行直接删除（三表原地保留）
        fetch_seed(&pool, &swagger(&[("/users", "查")])).await;
        let outcome = apply(&pool, "s1", None).await.unwrap();
        assert_eq!(outcome.removed, 1);
        assert!(
            badges(&pool).await.iter().all(|(k, _)| k != "GET /gone"),
            "定义行物理删除"
        );
        let user_data_kept: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM endpoint_user_data WHERE key = 'GET /gone'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(user_data_kept, 1, "删除定义行不触碰用户数据");
        let pin_kept: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pinned_endpoints WHERE key = 'GET /gone'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(pin_kept, 1, "删除定义行不触碰置顶");
        let history_kept: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM run_records WHERE endpoint_key = 'GET /gone'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(history_kept, 1, "删除定义行不触碰历史");
        assert!(
            endpoint_repo::get(&pool, "s1", "GET /gone")
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            endpoint_repo::list_by_service(&pool, "s1")
                .await
                .unwrap()
                .iter()
                .all(|e| e.key != "GET /gone")
        );

        // 三代：gone 回来 → 同键走首次导入路径（Insert 重现，用户数据与
        // 置顶凭稳定键原地重接、历史行原地保留，三表内容零改动）
        fetch_seed(&pool, &swagger(&[("/users", "查"), ("/gone", "回归")])).await;
        let outcome = apply(&pool, "s1", None).await.unwrap();
        assert_eq!(outcome.added, 1);
        assert_eq!(outcome.removed, 0);
        let rows = badges(&pool).await;
        let gone = rows.iter().find(|(k, _)| k == "GET /gone").unwrap();
        assert_eq!(gone.1.as_deref(), Some("new"));
        let (body, params): (String, String) =
            sqlx::query_as("SELECT body, params FROM endpoint_user_data WHERE key = 'GET /gone'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(body, "留存", "重接后用户数据原样");
        assert_eq!(params, "[]");
        assert_eq!(
            endpoint_repo::list_pinned(&pool, "s1").await.unwrap(),
            vec!["GET /gone".to_owned()],
            "重接后置顶原样恢复呈现"
        );
        let history_kept: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM run_records WHERE endpoint_key = 'GET /gone'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(history_kept, 1, "重接后历史行原地保留");
    }

    /// 手工接口与同步接口并存：手工行不受应用事务影响（不进删除、不改内容）。
    #[tokio::test]
    async fn manual_endpoints_untouched_by_apply() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        endpoint_repo::insert_manual(
            &pool,
            &crate::domain::endpoint::ManualEndpointInput {
                service_id: "s1".into(),
                key: "uuid-manual-1".into(),
                title: "手工".into(),
                category_id: None,
                definition: Definition::new(HttpMethod::GET, "/manual").unwrap(),
            },
        )
        .await
        .unwrap();

        fetch_seed(&pool, &swagger(&[("/users", "查")])).await;
        let outcome = apply(&pool, "s1", None).await.unwrap();
        assert_eq!(outcome.removed, 0, "手工接口不进删除");
        let manual = endpoint_repo::get(&pool, "s1", "uuid-manual-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(manual.title, "手工");
        assert_eq!(manual.badge, None);
    }

    /// 确认面与应用结果一致性：同一库状态下先对比后应用，计数必须
    /// 同源吻合——对账决策单点在 plan 的行为回归，删除 / 插入两套编码
    /// 一旦分叉此测试立红。
    #[tokio::test]
    async fn confirmation_and_apply_agree() {
        let pool = memory_pool().await;
        seeded(&pool).await;

        // 第一轮：三接口入树（库进入已应用态）
        fetch_seed(
            &pool,
            &swagger(&[("/users", "查"), ("/orders", "单"), ("/gone", "将删")]),
        )
        .await;
        apply(&pool, "s1", None).await.unwrap();

        // 第二轮：orders / gone 消失 → 定义行删除
        fetch_seed(&pool, &swagger(&[("/users", "查")])).await;
        apply(&pool, "s1", None).await.unwrap();

        // 第三轮：users 定义变化（加 query 参数）、orders 回归（Insert
        // 重现）、new 新增
        let gen3 = with_users_param(&swagger(&[
            ("/users", "查"),
            ("/orders", "单"),
            ("/new", "新"),
        ]));
        fetch_seed(&pool, &gen3).await;

        let diff = crate::services::sync_diff::diff_service(&pool, "s1")
            .await
            .unwrap();
        let outcome = apply(&pool, "s1", None).await.unwrap();

        // 计数面逐字段一致（确认面计数与应用结果不分叉）
        assert_eq!(diff.summary.added, outcome.added);
        assert_eq!(diff.summary.changed, outcome.changed);
        assert_eq!(diff.summary.removed, outcome.removed);
        assert_eq!(diff.summary.unchanged, outcome.unchanged);
        assert_eq!(
            (
                outcome.added,
                outcome.changed,
                outcome.removed,
                outcome.unchanged
            ),
            (2, 1, 0, 0)
        );

        // 回归键确认面是 Added、应用落地也是 Insert：重新入树打 new 徽标
        let rows = badges(&pool).await;
        let orders = rows.iter().find(|(k, _)| k == "GET /orders").unwrap();
        assert_eq!(orders.1.as_deref(), Some("new"));
        let users = rows.iter().find(|(k, _)| k == "GET /users").unwrap();
        assert_eq!(users.1.as_deref(), Some("changed"));
        let new_ep = rows.iter().find(|(k, _)| k == "GET /new").unwrap();
        assert_eq!(new_ep.1.as_deref(), Some("new"));
        assert!(
            rows.iter().all(|(k, _)| k != "GET /gone"),
            "文档外键定义行已删除"
        );
    }

    fn with_users_param(base: &str) -> String {
        base.replace(
            "\"/users\": {\"get\": {\"tags\":",
            "\"/users\": {\"get\": {\"parameters\": [{\"name\": \"page\", \"in\": \"query\", \"type\": \"integer\"}], \"tags\":",
        )
    }

    // —— 接口粒度勾选（keys 过滤：只落勾选行）——

    /// 勾选集过滤动作面：未勾选的新键不插入、未勾选的消失键不删除，勾选
    /// 行照常落库。
    #[tokio::test]
    async fn partial_apply_touches_only_selected_keys() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        fetch_seed(
            &pool,
            &swagger(&[("/users", "查"), ("/orders", "单"), ("/gone", "将删")]),
        )
        .await;
        apply(&pool, "s1", None).await.unwrap();

        // 二代：fresh 新增、gone 消失；users / orders 不动
        fetch_seed(
            &pool,
            &swagger(&[("/users", "查"), ("/orders", "单"), ("/fresh", "新")]),
        )
        .await;

        // 只勾选新键：fresh 插入，gone 不删除
        let selected = vec!["GET /fresh".to_string()];
        let outcome = apply(&pool, "s1", Some(&selected)).await.unwrap();
        assert_eq!(outcome.added, 1);
        assert_eq!(outcome.removed, 0, "未勾选的消失键不删除");
        assert_eq!(
            outcome.unchanged, 2,
            "无变化计数取勾选过滤前的全量计划（完成段四格卡口径）"
        );
        let rows = badges(&pool).await;
        assert!(
            rows.iter().any(|(k, _)| k == "GET /gone"),
            "未勾选行保持入树态"
        );
        let fresh = rows.iter().find(|(k, _)| k == "GET /fresh").unwrap();
        assert_eq!(fresh.1.as_deref(), Some("new"), "勾选行照常插入打徽标");

        // 只勾选消失键：只有它的定义行被删除
        let selected = vec!["GET /gone".to_string()];
        let outcome = apply(&pool, "s1", Some(&selected)).await.unwrap();
        assert_eq!(outcome.removed, 1);
        assert_eq!(outcome.added, 0);
        let rows = badges(&pool).await;
        assert!(rows.iter().all(|(k, _)| k != "GET /gone"));
    }

    /// 全量应用转正快照（滚动时点在全量应用）：待应用
    /// 拉取写入新代（两代之外淘汰）并清除暂存。
    #[tokio::test]
    async fn full_apply_promotes_pending_to_snapshot() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        let doc = swagger(&[("/users", "查")]);
        fetch_seed(&pool, &doc).await;
        apply(&pool, "s1", None).await.unwrap();

        let current = snapshot_repo::current(&pool, "s1").await.unwrap().unwrap();
        assert_eq!(current.generation, 1);
        assert_eq!(current.content, doc);
        assert!(
            snapshot_repo::pending_get(&pool, "s1")
                .await
                .unwrap()
                .is_none(),
            "转正后暂存清除"
        );
    }

    /// 部分应用不转正：已应用代不动、暂存保留——未勾选行的变更下次同步
    /// 仍在清单（未采用的变更不得刷新快照；曾因「拉取即滚动」被永久
    /// 遮蔽）；随后全量应用才转正到下一代。
    #[tokio::test]
    async fn partial_apply_keeps_pending_until_full() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        fetch_seed(&pool, &swagger(&[("/users", "查"), ("/orders", "单")])).await;
        apply(&pool, "s1", None).await.unwrap();

        // 二代：fresh 新增、orders 定义变化（加参数）；只勾选 fresh
        let changed = swagger2_with_param(&swagger(&[
            ("/users", "查"),
            ("/orders", "单"),
            ("/fresh", "新"),
        ]));
        fetch_seed(&pool, &changed).await;
        let selected = vec!["GET /fresh".to_string()];
        let outcome = apply(&pool, "s1", Some(&selected)).await.unwrap();
        assert_eq!(outcome.added, 1);

        // 未转正：快照仍是代 1、暂存保留；diff 仍呈现全部变更（未勾选的
        // orders 变化不遮蔽——用户报告缺陷的回归锚）
        let current = snapshot_repo::current(&pool, "s1").await.unwrap().unwrap();
        assert_eq!(current.generation, 1, "部分应用不滚代");
        assert!(
            snapshot_repo::pending_get(&pool, "s1")
                .await
                .unwrap()
                .is_some(),
            "暂存保留"
        );
        let diff = crate::services::sync_diff::diff_service(&pool, "s1")
            .await
            .unwrap();
        assert_eq!(diff.summary.changed, 1, "未勾选的变更行仍在清单");
        assert_eq!(diff.summary.added, 1, "已应用行幂等重现（基线未推进）");

        // 全量应用后转正：代 2 写入、暂存清除
        apply(&pool, "s1", None).await.unwrap();
        let current = snapshot_repo::current(&pool, "s1").await.unwrap().unwrap();
        assert_eq!(current.generation, 2);
        assert!(
            snapshot_repo::pending_get(&pool, "s1")
                .await
                .unwrap()
                .is_none()
        );
    }

    /// 徽标重打的键集限定：部分应用只清勾选行徽标并重打勾选变更行，未勾选
    /// 变更行的旧徽标保留（留待其应用）。
    #[tokio::test]
    async fn partial_apply_badge_reset_scoped_to_selected_keys() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        fetch_seed(&pool, &swagger(&[("/users", "查"), ("/orders", "单")])).await;
        apply(&pool, "s1", None).await.unwrap();
        // 两行预置旧徽标（上一轮应用形态）
        sqlx::query("UPDATE endpoints SET badge = 'changed' WHERE service_id = 's1'")
            .execute(&pool)
            .await
            .unwrap();
        // 二代：仅 orders 定义变化（users 不动）；只勾选 users＝真正的部分应用
        let changed = swagger2_with_param(&swagger(&[("/users", "查"), ("/orders", "单")]));
        fetch_seed(&pool, &changed).await;

        let selected = vec!["GET /users".to_string()];
        apply(&pool, "s1", Some(&selected)).await.unwrap();
        let rows = badges(&pool).await;
        let users = rows.iter().find(|(k, _)| k == "GET /users").unwrap();
        assert_eq!(users.1, None, "勾选行徽标清空");
        let orders = rows.iter().find(|(k, _)| k == "GET /orders").unwrap();
        assert_eq!(
            orders.1.as_deref(),
            Some("changed"),
            "未勾选变更行旧徽标保留"
        );
    }

    /// 勾选集覆盖全部变更动作＝全量应用：无变化行（不在勾选集内）的旧徽标
    /// 也必须清空，快照转正——不能因未勾选而残留上一轮标记。
    #[tokio::test]
    async fn full_coverage_selection_clears_unchanged_row_badges() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        fetch_seed(&pool, &swagger(&[("/users", "查"), ("/orders", "单")])).await;
        apply(&pool, "s1", None).await.unwrap();
        sqlx::query("UPDATE endpoints SET badge = 'changed' WHERE service_id = 's1'")
            .execute(&pool)
            .await
            .unwrap();
        // 二代：仅 orders 变化；勾选集只含全部变更动作（orders），users 不在其内
        let changed = swagger2_with_param(&swagger(&[("/users", "查"), ("/orders", "单")]));
        fetch_seed(&pool, &changed).await;
        let selected = vec!["GET /orders".to_string()];
        apply(&pool, "s1", Some(&selected)).await.unwrap();

        let rows = badges(&pool).await;
        let users = rows.iter().find(|(k, _)| k == "GET /users").unwrap();
        assert_eq!(users.1, None, "无变化行旧徽标随全量应用清空");
        let orders = rows.iter().find(|(k, _)| k == "GET /orders").unwrap();
        assert_eq!(orders.1.as_deref(), Some("changed"), "勾选变更行重打徽标");
        // 全量覆盖＝转正：暂存清除、代 2 写入
        assert!(
            snapshot_repo::pending_get(&pool, "s1")
                .await
                .unwrap()
                .is_none()
        );
        let current = snapshot_repo::current(&pool, "s1").await.unwrap().unwrap();
        assert_eq!(current.generation, 2);
    }

    // —— 参数与请求体静默对齐（用户数据表唯一写入路径）——

    /// 带 in:body 请求体的 POST 接口。
    fn post_swagger(path: &str, body_schema: &str) -> String {
        format!(
            r#"{{
        "swagger": "2.0",
        "info": {{"title": "t", "version": "1"}},
        "paths": {{
            "{path}": {{
                "post": {{
                    "tags": ["默认"],
                    "summary": "建",
                    "parameters": [{{"name": "body", "in": "body", "required": true, "schema": {body_schema}}}],
                    "responses": {{"200": {{"description": "ok"}}}}
                }}
            }}
        }}
    }}"#
        )
    }

    const BODY_SCHEMA: &str = r#"{"type": "object", "properties": {
        "name": {"type": "string"},
        "email": {"type": "string", "example": "a@b.c"},
        "age": {"type": "integer"}
    }}"#;

    /// GET 接口带一个 query 参数（page，integer，带描述）。
    fn get_with_query_swagger(path: &str) -> String {
        format!(
            r#"{{"swagger": "2.0", "info": {{"title": "t", "version": "1"}}, "paths": {{"{path}": {{"get": {{"tags": ["用户"], "summary": "查", "parameters": [{{"name": "page", "in": "query", "type": "integer", "description": "页码"}}], "responses": {{"200": {{"description": "ok"}}}}}}}}}}}}"#
        )
    }

    /// GET 接口带一个 query 参数与两个 header 参数（page query；X-Trace /
    /// X-Env header，各带类型与描述）。
    fn get_with_query_header_swagger(path: &str) -> String {
        format!(
            r#"{{"swagger": "2.0", "info": {{"title": "t", "version": "1"}}, "paths": {{"{path}": {{"get": {{"tags": ["用户"], "summary": "查", "parameters": [{{"name": "page", "in": "query", "type": "integer", "description": "页码"}}, {{"name": "X-Trace", "in": "header", "type": "string", "description": "追踪"}}, {{"name": "X-Env", "in": "header", "type": "string"}}], "responses": {{"200": {{"description": "ok"}}}}}}}}}}}}"#
        )
    }

    async fn seed_user_row(pool: &SqlitePool, key: &str, body: Option<&str>, params: &str) {
        seed_user_row_full(pool, key, body, params, r#"{"X-Trace":"t1"}"#).await;
    }

    /// headers 列可指定的播种变体（headers 对齐测试需要行数组 / 对象两种形态）。
    async fn seed_user_row_full(
        pool: &SqlitePool,
        key: &str,
        body: Option<&str>,
        params: &str,
        headers: &str,
    ) {
        user_data_repo::upsert(
            pool,
            "s1",
            key,
            &UserDataInput {
                body: body.map(str::to_owned),
                params: params.into(),
                headers: headers.into(),
                timeout_seconds: Some(30),
                auth: None,
                path_override: None,
                method_override: None,
            },
        )
        .await
        .unwrap();
    }

    async fn user_row(
        pool: &SqlitePool,
        key: &str,
    ) -> Option<crate::domain::user_data::EndpointUserData> {
        user_data_repo::get(pool, "s1", key).await.unwrap()
    }

    /// 断言 body 列为 kind=json 信封并取 text 载体解析（铺底 / 写回断言的
    /// 公共步；信封契约与前端 body-envelope / 发送面 parse_body_envelope 同构）。
    fn envelope_json_text(body: &str) -> serde_json::Value {
        let envelope: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(envelope["kind"], "json", "body 应为 json 信封: {body}");
        serde_json::from_str(envelope["text"].as_str().unwrap()).unwrap()
    }

    /// 带 requestBody 的 OpenAPI 3.0 文档（content 对象按媒型→schema 声明，
    /// 供多 media 类型择优与信封铺底测试用）。
    fn post_openapi3(paths: &[(&str, &str)]) -> String {
        let body: Vec<String> = paths
            .iter()
            .map(|(path, content)| {
                format!(
                    r#""{path}": {{"post": {{"requestBody": {{"content": {content}}}, "responses": {{"200": {{"description": "ok"}}}}}}}}"#
                )
            })
            .collect();
        format!(
            r#"{{"openapi": "3.0.1", "info": {{"title": "t", "version": "1"}}, "paths": {{{}}}}}"#,
            body.join(",")
        )
    }

    /// Swashbuckle 产物形态：一个 requestBody 声明四种 JSON 媒体类型
    /// （serde_json Map 字母序使 `application/*+json` 排最前）。
    fn four_media_types_content() -> String {
        format!(
            r#"{{
                "application/*+json": {{"schema": {{"type": "object", "properties": {{"star": {{"type": "string"}}}}}}}},
                "application/json": {{"schema": {BODY_SCHEMA}}},
                "text/json": {{"schema": {{"type": "object", "properties": {{"text": {{"type": "string"}}}}}}}},
                "application/json-patch+json": {{"schema": {{"type": "object", "properties": {{"patch": {{"type": "string"}}}}}}}}
            }}"#
        )
    }

    /// 首次同步铺初始行：文档 query 参数 → 空值行（type/description 随定义），
    /// 请求体骨架 → 示例体；无骨架不建 body。
    #[tokio::test]
    async fn first_apply_seeds_params_and_body_from_doc() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        fetch_seed(&pool, &get_with_query_swagger("/users")).await;
        apply(&pool, "s1", None).await.unwrap();

        let ud = user_row(&pool, "GET /users")
            .await
            .expect("铺行必建用户数据行");
        let rows: serde_json::Value = serde_json::from_str(&ud.params).unwrap();
        assert_eq!(rows[0]["name"], "page");
        assert_eq!(rows[0]["value"], "", "铺行值恒空");
        assert_eq!(rows[0]["enabled"], true);
        assert_eq!(rows[0]["type"], "integer");
        assert_eq!(rows[0]["description"], "页码");
        assert_eq!(ud.body, None, "无请求体骨架不建 body");
        assert_eq!(ud.headers, "[]", "文档无 header 参数时 headers 铺空行数组");

        // POST 带骨架：铺示例体（email 走 example，其余骨架键全量铺底）
        fetch_seed(&pool, &post_swagger("/users", BODY_SCHEMA)).await;
        apply(&pool, "s1", None).await.unwrap();
        let ud = user_row(&pool, "POST /users").await.expect("骨架铺底");
        let body = envelope_json_text(&ud.body.unwrap());
        assert_eq!(body["email"], "a@b.c", "fill 走文档 example");
        assert!(
            body.get("name").is_some() && body.get("age").is_some(),
            "骨架键全量铺底"
        );
        // GET 的 params 面保持不变（对齐幂等：无补无删不写回）
        let ud = user_row(&pool, "GET /users").await.unwrap();
        let rows: serde_json::Value = serde_json::from_str(&ud.params).unwrap();
        assert_eq!(rows[0]["name"], "page");
    }

    /// 对齐核心语义：已填值/启停/标注保留、文档外行删除、缺行补上；
    /// body 骨架内用户值恒保留、骨架外键剔除、缺键补值。
    #[tokio::test]
    async fn align_keeps_user_values_drops_extras_fills_missing() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        // 文档 POST：无 query 参数；body 骨架 name/email/age
        fetch_seed(&pool, &post_swagger("/users", BODY_SCHEMA)).await;
        seed_user_row(
            &pool,
            "POST /users",
            Some(r#"{"name":"张三","extra":"用户自加"}"#),
            r#"[{"name":"page","value":"1"},{"name":"debug","value":"on"}]"#,
        )
        .await;

        apply(&pool, "s1", None).await.unwrap();

        let ud = user_row(&pool, "POST /users").await.unwrap();
        // 文档无 query 参数：用户自加行全删
        assert_eq!(ud.params, "[]");
        // headers / timeout / auth 用户面零触碰
        assert_eq!(ud.headers, r#"{"X-Trace":"t1"}"#);
        assert_eq!(ud.timeout_seconds, Some(30));
        let body = envelope_json_text(&ud.body.unwrap());
        assert_eq!(body["name"], "张三", "骨架内用户值原样");
        assert!(body.get("extra").is_none(), "骨架外键剔除");
        assert_eq!(body["email"], "a@b.c", "缺键补 example");
    }

    /// 首次同步的 header 分流：header 参数对齐到 headers 列（铺空值行、
    /// type/description 随定义），params 行不含 header 参数名。
    #[tokio::test]
    async fn first_apply_seeds_header_params_into_headers_not_params() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        fetch_seed(&pool, &get_with_query_header_swagger("/users")).await;
        apply(&pool, "s1", None).await.unwrap();

        let ud = user_row(&pool, "GET /users").await.unwrap();
        // params 行只含非 header 参数（query 进 params，header 不混入）
        let rows: serde_json::Value = serde_json::from_str(&ud.params).unwrap();
        let param_names: Vec<&str> = rows
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|r| r["name"].as_str())
            .collect();
        assert_eq!(param_names, ["page"], "header 参数名不进 params 行");
        // headers 铺文档 header 参数空值行（行模型与 params 同构）
        let headers: serde_json::Value = serde_json::from_str(&ud.headers).unwrap();
        let header_rows = headers.as_array().unwrap();
        assert_eq!(header_rows.len(), 2);
        assert_eq!(header_rows[0]["name"], "X-Trace");
        assert_eq!(header_rows[0]["value"], "", "铺行值恒空");
        assert_eq!(header_rows[0]["enabled"], true);
        assert_eq!(header_rows[0]["type"], "string");
        assert_eq!(header_rows[0]["description"], "追踪");
        assert_eq!(header_rows[1]["name"], "X-Env");
        assert_eq!(
            header_rows[1]["description"],
            serde_json::Value::Null,
            "无描述不落键"
        );
    }

    /// headers 行数组对齐核心语义（与 params 同构）：已填值/启停/标注保留、
    /// 文档外行删、缺行补。
    #[tokio::test]
    async fn align_headers_keeps_values_drops_extras_fills_missing() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        fetch_seed(&pool, &get_with_query_header_swagger("/users")).await;
        // 用户 headers 行数组：X-Trace 已填值＋禁用（不动）、stale 文档外行
        // （删）、X-Env 缺行（补空值行）
        seed_user_row_full(
            &pool,
            "GET /users",
            None,
            "[]",
            r#"[{"name":"X-Trace","value":"t1","enabled":false,"type":"old","description":"旧标注"},{"name":"stale","value":"x"}]"#,
        )
        .await;

        apply(&pool, "s1", None).await.unwrap();

        let ud = user_row(&pool, "GET /users").await.unwrap();
        let headers: serde_json::Value = serde_json::from_str(&ud.headers).unwrap();
        let header_rows = headers.as_array().unwrap();
        assert_eq!(header_rows.len(), 2, "删一补一");
        assert_eq!(header_rows[0]["name"], "X-Trace");
        assert_eq!(header_rows[0]["value"], "t1", "已填值不动");
        assert_eq!(header_rows[0]["enabled"], false, "启停不动");
        assert_eq!(header_rows[0]["type"], "old", "标注不动");
        assert_eq!(header_rows[0]["description"], "旧标注");
        assert_eq!(header_rows[1]["name"], "X-Env", "缺行补上");
        assert_eq!(header_rows[1]["value"], "");
        assert_eq!(header_rows[1]["enabled"], true);
    }

    /// headers 原文保真边界：非空对象（用户真实键值对）不改写为行数组——
    /// 行数组才是可对齐形态，读路径不引入新形态。
    #[tokio::test]
    async fn align_headers_preserves_object_form() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        fetch_seed(&pool, &get_with_query_header_swagger("/users")).await;
        seed_user_row_full(&pool, "GET /users", None, "[]", r#"{"X-Trace":"t1"}"#).await;

        apply(&pool, "s1", None).await.unwrap();

        let ud = user_row(&pool, "GET /users").await.unwrap();
        assert_eq!(ud.headers, r#"{"X-Trace":"t1"}"#, "对象形态保真不铺行");
    }

    /// 存量空对象归一：headers 列的零键 `{}` 不是用户键值数据（历史铺行的
    /// 遗留初值形态），对齐补行时视同空行集归一为行数组写回。
    #[tokio::test]
    async fn align_headers_normalizes_empty_object_when_filling() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        fetch_seed(&pool, &get_with_query_header_swagger("/users")).await;
        seed_user_row_full(&pool, "GET /users", None, "[]", "{}").await;

        apply(&pool, "s1", None).await.unwrap();

        let ud = user_row(&pool, "GET /users").await.unwrap();
        let headers: serde_json::Value = serde_json::from_str(&ud.headers).unwrap();
        let header_rows = headers.as_array().expect("空对象补行后归一为行数组");
        assert_eq!(header_rows.len(), 2);
        assert_eq!(header_rows[0]["name"], "X-Trace");
        assert_eq!(header_rows[0]["value"], "", "铺行值恒空");
        assert_eq!(header_rows[0]["enabled"], true);
        assert_eq!(header_rows[1]["name"], "X-Env");
        assert_eq!(header_rows[1]["value"], "");
    }

    /// 零变化不写回：headers 为空对象且文档无 header 参数、params / body 均
    /// 无对齐变化时整行不写——归一只为补行服务，不为归一而写。
    #[tokio::test]
    async fn align_headers_empty_object_without_header_params_not_written() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        fetch_seed(&pool, &swagger(&[("/users", "查")])).await; // GET 无任何参数与请求体
        seed_user_row_full(&pool, "GET /users", None, "[]", "{}").await;
        // updated_at 压成固定历史值：apply 后未变＝零写回（upsert 必刷新它）
        sqlx::query(
            "UPDATE endpoint_user_data SET updated_at = '2026-01-01T00:00:00Z' \
             WHERE service_id = 's1' AND key = 'GET /users'",
        )
        .execute(&pool)
        .await
        .unwrap();

        apply(&pool, "s1", None).await.unwrap();

        let (headers, updated_at): (String, String) = sqlx::query_as(
            "SELECT headers, updated_at FROM endpoint_user_data \
             WHERE service_id = 's1' AND key = 'GET /users'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(headers, "{}", "空对象原样保留（无 header 参数无归一写回）");
        assert_eq!(updated_at, "2026-01-01T00:00:00Z", "零变化零写回");
    }

    /// 原文保真边界：非 JSON params / body 不改写；文档无骨架不触碰 body；
    /// 手工接口零触碰。
    #[tokio::test]
    async fn align_skips_unparseable_and_non_json() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        endpoint_repo::insert_manual(
            &pool,
            &crate::domain::endpoint::ManualEndpointInput {
                service_id: "s1".into(),
                key: "019bbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb".into(),
                title: "手工".into(),
                category_id: None,
                definition: Definition::new(HttpMethod::GET, "/manual").unwrap(),
            },
        )
        .await
        .unwrap();
        seed_user_row(
            &pool,
            "019bbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
            Some(r#"{"x":1}"#),
            "[]",
        )
        .await;
        fetch_seed(&pool, &swagger(&[("/users", "查")])).await; // GET 无请求体骨架
        seed_user_row(&pool, "GET /users", Some("name=张三"), "not-json").await;

        apply(&pool, "s1", None).await.unwrap();

        let manual = user_row(&pool, "019bbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb")
            .await
            .unwrap();
        assert_eq!(manual.body.as_deref(), Some(r#"{"x":1}"#), "手工键零触碰");
        let get_ud = user_row(&pool, "GET /users").await.unwrap();
        assert_eq!(get_ud.body.as_deref(), Some("name=张三"), "非 JSON 体保真");
        assert_eq!(get_ud.params, "not-json", "原文保真模式不改写");
    }

    /// 对齐铺底体量超限 → 整事务回滚（endpoints 面不得落库）。
    #[tokio::test]
    async fn oversized_aligned_body_rejected_and_rolled_back() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        // 预置超大 string example：铺底 fill 后体量必超限
        let fat = "x".repeat(crate::constants::MAX_USER_DATA_BYTES);
        let fat_schema = format!(
            r#"{{"type": "object", "properties": {{"name": {{"type": "string"}}, "big": {{"type": "string", "example": "{}"}}}}}}"#,
            fat
        );
        fetch_seed(&pool, &post_swagger("/users", &fat_schema)).await;
        seed_user_row(&pool, "POST /users", Some(r#"{"name":"张三"}"#), "[]").await;

        let err = apply(&pool, "s1", None).await.unwrap_err();
        assert_eq!(err.code, codes::USER_DATA_TOO_LARGE, "补值超限拒绝");
        // 整事务回滚：endpoints 面不得落库（快照滚动在拉取段、不在本事务）
        assert!(
            endpoint_repo::get(&pool, "s1", "POST /users")
                .await
                .unwrap()
                .is_none()
        );
    }

    // —— 多媒体类型择优与 body 信封铺底（对齐读写信封契约）——

    /// 四 JSON 媒型同现（Swashbuckle 产物形态，`application/*+json` 因字母序
    /// 排最前）：首次 apply 铺出 body 信封（kind=json、text 含骨架示例值），
    /// 不再因媒型择优缺失而全部跳过。
    #[tokio::test]
    async fn four_media_types_seed_envelope_body_on_first_apply() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        fetch_seed(
            &pool,
            &post_openapi3(&[("/users", &four_media_types_content())]),
        )
        .await;

        let outcome = apply(&pool, "s1", None).await.unwrap();
        assert_eq!(outcome.added, 1);
        let ud = user_row(&pool, "POST /users")
            .await
            .expect("四媒型铺底必须成功");
        let body = envelope_json_text(&ud.body.expect("骨架铺底"));
        assert_eq!(body["email"], "a@b.c", "text 载体含文档 example");
        assert!(
            body.get("name").is_some() && body.get("age").is_some(),
            "骨架键取自精确 application/json 媒型的 schema"
        );
        assert_eq!(ud.headers, "[]", "无参数接口铺行 headers 为空行数组");
    }

    /// 信封 body 用户行（kind=json 已填值）：text 载体参与合并——骨架内已填
    /// 值保留、骨架外键剔除、缺键补值，写回仍为信封。
    #[tokio::test]
    async fn envelope_json_body_merges_text_carrier() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        fetch_seed(
            &pool,
            &post_openapi3(&[("/users", &four_media_types_content())]),
        )
        .await;
        seed_user_row(
            &pool,
            "POST /users",
            Some(r#"{"kind":"json","text":"{\"name\":\"张三\",\"extra\":\"用户自加\"}"}"#),
            "[]",
        )
        .await;

        apply(&pool, "s1", None).await.unwrap();

        let ud = user_row(&pool, "POST /users").await.unwrap();
        let body = envelope_json_text(&ud.body.unwrap());
        assert_eq!(body["name"], "张三", "text 载体内骨架已填值保留");
        assert!(body.get("extra").is_none(), "骨架外键剔除");
        assert_eq!(body["email"], "a@b.c", "缺键补 example");
    }

    /// 用户已填值等价（text 载体与合并结果语义一致）＝不写回，用户列原样
    /// （紧凑排版保留，不被重排为骨架 pretty 形态）。
    #[tokio::test]
    async fn envelope_json_body_equivalent_text_not_rewritten() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        fetch_seed(
            &pool,
            &post_openapi3(&[("/users", &four_media_types_content())]),
        )
        .await;
        // 用户填了骨架全部键（含 age），值与骨架 fill 语义一致之外的自由排版
        let user_text = r#"{"name":"张三","email":"a@b.c","age":1}"#;
        let envelope = format!(
            r#"{{"kind":"json","text":{}}}"#,
            serde_json::to_string(user_text).unwrap()
        );
        seed_user_row(&pool, "POST /users", Some(&envelope), "[]").await;

        apply(&pool, "s1", None).await.unwrap();

        let ud = user_row(&pool, "POST /users").await.unwrap();
        assert_eq!(ud.body.as_deref(), Some(envelope.as_str()), "等价不写回");
    }

    /// 信封 kind=none / form 系（rows 载体）＝用户有意选择：body 整列不触碰。
    #[tokio::test]
    async fn envelope_none_and_form_kinds_are_untouched() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        fetch_seed(
            &pool,
            &post_openapi3(&[("/users", &four_media_types_content())]),
        )
        .await;
        seed_user_row(&pool, "POST /users", Some(r#"{"kind":"none"}"#), "[]").await;

        apply(&pool, "s1", None).await.unwrap();
        let ud = user_row(&pool, "POST /users").await.unwrap();
        assert_eq!(
            ud.body.as_deref(),
            Some(r#"{"kind":"none"}"#),
            "none 整列不触碰"
        );

        // form 系（rows 载体）同口径（上一轮全量应用已消费暂存，重新拉取）
        let form_envelope = r#"{"kind":"form-data","rows":[{"name":"f","value":"v"}]}"#;
        seed_user_row(&pool, "POST /users", Some(form_envelope), "[]").await;
        fetch_seed(
            &pool,
            &post_openapi3(&[("/users", &four_media_types_content())]),
        )
        .await;
        apply(&pool, "s1", None).await.unwrap();
        let ud = user_row(&pool, "POST /users").await.unwrap();
        assert_eq!(ud.body.as_deref(), Some(form_envelope), "form 系整列不触碰");
    }

    /// 文档仅声明 +json 变体媒型（无精确 application/json）：JSON 家族判定
    /// 放宽后同样铺底。
    #[tokio::test]
    async fn json_family_variant_media_type_still_seeds_body() {
        let pool = memory_pool().await;
        seeded(&pool).await;
        let content = r#"{"application/json-patch+json": {"schema": {"type": "object", "properties": {"patched": {"type": "string", "example": "v1"}}}}}"#;
        fetch_seed(&pool, &post_openapi3(&[("/users", content)])).await;

        apply(&pool, "s1", None).await.unwrap();
        let ud = user_row(&pool, "POST /users").await.expect("变体媒型铺底");
        let body = envelope_json_text(&ud.body.expect("骨架铺底"));
        assert_eq!(body["patched"], "v1");
    }
}
