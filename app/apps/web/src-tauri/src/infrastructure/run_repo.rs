//! Run Record repo：终态单次写入（单事务 INSERT＋封顶修剪）、查询与删除。
//!
//! GUI 发送与 CLI api run 经编排层共用此写入路径（双入口同源）；
//! GUI History 视图与 CLI run 命令组共用查询面；删除面只服务 GUI
//! History 管理（右键删除 / 多选删除 / 清空本工作空间）。

use sqlx::{Acquire, AssertSqlSafe, Executor, Sqlite, SqliteConnection};

use crate::constants::RUN_RECORDS_CAP;
use crate::domain::run_record::{RunSource, RunState};
use crate::error::AppError;

/// Run Record 行实体（快照列 request_json / response_json 为 JSON 字符串，
/// 语义结构由编排层组装；repo 不感知）。
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct RunRecord {
    pub id: String,
    pub workspace_id: String,
    pub service_id: String,
    pub endpoint_key: String,
    pub method: String,
    pub url: String,
    pub status_code: Option<i64>,
    pub duration_ms: Option<i64>,
    pub state: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub request_json: String,
    pub response_json: Option<String>,
    pub source: String,
    pub created_at: String,
}

impl RunRecord {
    /// 字符串列 → 领域枚举（现消费面直接读原始列；枚举桥接留给
    /// `run status` 异步查询与运维观测消费）。
    #[allow(dead_code)]
    pub fn state(&self) -> Option<RunState> {
        RunState::parse(&self.state)
    }

    #[allow(dead_code)]
    pub fn source(&self) -> Option<RunSource> {
        match self.source.as_str() {
            "gui" => Some(RunSource::Gui),
            "cli" => Some(RunSource::Cli),
            _ => None,
        }
    }
}

/// 终态行写入输入。
pub struct RunRecordInsert {
    pub id: String,
    pub workspace_id: String,
    pub service_id: String,
    pub endpoint_key: String,
    pub method: String,
    pub url: String,
    pub status_code: Option<i64>,
    pub duration_ms: Option<i64>,
    pub state: RunState,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub request_json: String,
    pub response_json: Option<String>,
    pub source: RunSource,
}

/// 列表过滤：`--state` 多选（空＝不过滤）＋工作空间范围。
#[derive(Debug, Clone, Default)]
pub struct RunListFilter {
    pub workspace_id: Option<String>,
    pub states: Vec<RunState>,
    pub limit: u32,
}

/// 终态单次写入＋封顶修剪（同一事务：写入与删最旧原子可见）。
/// 封顶＝保留最新 `RUN_RECORDS_CAP` 条，超出按 created_at（ULID 次序）删最旧。
pub async fn insert_final(
    conn: &mut SqliteConnection,
    input: &RunRecordInsert,
) -> Result<RunRecord, AppError> {
    let mut tx: sqlx::Transaction<'_, Sqlite> = conn.begin().await?;
    let row = sqlx::query_as::<_, RunRecord>(
        "INSERT INTO run_records (\
           id, workspace_id, service_id, endpoint_key, method, url, status_code, \
           duration_ms, state, error_code, error_message, request_json, response_json, \
           source, created_at\
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) \
         RETURNING \
           id, workspace_id, service_id, endpoint_key, method, url, status_code, \
           duration_ms, state, error_code, error_message, request_json, response_json, \
           source, created_at",
    )
    .bind(&input.id)
    .bind(&input.workspace_id)
    .bind(&input.service_id)
    .bind(&input.endpoint_key)
    .bind(&input.method)
    .bind(&input.url)
    .bind(input.status_code)
    .bind(input.duration_ms)
    .bind(input.state.as_str())
    .bind(&input.error_code)
    .bind(&input.error_message)
    .bind(&input.request_json)
    .bind(&input.response_json)
    .bind(input.source.as_str())
    .fetch_one(&mut *tx)
    .await?;
    // 修剪：保留最新 CAP 条（created_at 同毫秒以 id＝run_<ULID> 定序）
    sqlx::query(
        "DELETE FROM run_records WHERE id IN (\
           SELECT id FROM run_records ORDER BY created_at DESC, id DESC \
           LIMIT -1 OFFSET ?\
         )",
    )
    .bind(RUN_RECORDS_CAP as i64)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(row)
}

/// 按 id 读取单条；不存在返回 None。
pub async fn get(
    conn: impl Executor<'_, Database = Sqlite>,
    id: &str,
) -> Result<Option<RunRecord>, AppError> {
    let row = sqlx::query_as::<_, RunRecord>(
        "SELECT id, workspace_id, service_id, endpoint_key, method, url, status_code, \
         duration_ms, state, error_code, error_message, request_json, response_json, \
         source, created_at FROM run_records WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(conn)
    .await?;
    Ok(row)
}

/// 列表行（list 专用）：RunRecord 全列＋接口标题。标题经 LEFT JOIN endpoints
/// （按 service_id＋endpoint_key）带回——接口随同步 / 手工编辑改名后历史行
/// 跟随现名；接口已删除（级联物理删）或脏键时为 NULL，展示层回落 URL 路径段。
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct RunListRow {
    #[sqlx(flatten)]
    pub record: RunRecord,
    pub endpoint_title: Option<String>,
}

/// created_at 倒序列表（limit 上限由调用方校验）；联查接口标题。
pub async fn list(
    conn: impl Executor<'_, Database = Sqlite>,
    filter: &RunListFilter,
) -> Result<Vec<RunListRow>, AppError> {
    let mut sql = String::from(
        "SELECT r.id, r.workspace_id, r.service_id, r.endpoint_key, r.method, r.url, r.status_code, \
         r.duration_ms, r.state, r.error_code, r.error_message, r.request_json, r.response_json, \
         r.source, r.created_at, e.title AS endpoint_title \
         FROM run_records r \
         LEFT JOIN endpoints e ON e.service_id = r.service_id AND e.key = r.endpoint_key",
    );
    let mut conditions: Vec<String> = Vec::new();
    if filter.workspace_id.is_some() {
        conditions.push("r.workspace_id = ?".into());
    }
    if !filter.states.is_empty() {
        // 动态占位：绑定数与选中状态数一致
        let placeholders = filter
            .states
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(", ");
        conditions.push(format!("r.state IN ({placeholders})"));
    }
    if !conditions.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.join(" AND "));
    }
    sql.push_str(" ORDER BY r.created_at DESC, r.id DESC LIMIT ?");

    // 动态拼接仅为条件占位与 LIMIT 占位（值全走绑定参数），无用户数据内插：
    // 经 AssertSqlSafe 显式声明已审计无注入面
    let mut query = sqlx::query_as::<_, RunListRow>(AssertSqlSafe(sql));
    if let Some(workspace_id) = &filter.workspace_id {
        query = query.bind(workspace_id);
    }
    for state in &filter.states {
        query = query.bind(state.as_str());
    }
    let rows = query.bind(filter.limit).fetch_all(conn).await?;
    Ok(rows)
}

/// 按 id 批量删除，返回实际删除行数；不存在的 id 静默跳过（幂等，无错误）。
///
/// 单条 `DELETE ... IN` 语句在 SQLite 内即隐式单事务（全删或全不删），
/// 无需显式 begin/commit。空 ids 直接返回 0，不发起 SQL（`IN ()` 非法）。
/// 物理删除、无留痕。
pub async fn delete_many(
    conn: impl Executor<'_, Database = Sqlite>,
    ids: &[String],
) -> Result<u64, AppError> {
    if ids.is_empty() {
        return Ok(0);
    }
    // 动态占位：绑定数与 id 数一致（值全走绑定参数，无用户数据内插），
    // 经 AssertSqlSafe 显式声明已审计无注入面
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let sql = format!("DELETE FROM run_records WHERE id IN ({placeholders})");
    let mut query = sqlx::query(AssertSqlSafe(sql));
    for id in ids {
        query = query.bind(id);
    }
    let result = query.execute(conn).await?;
    Ok(result.rows_affected())
}

/// 清空指定工作空间的全部历史（GUI「清空本工作空间历史」）。
///
/// 取舍：不走「查全量 id 再 delete_many」往返——workspace 谓词直接约束
/// 删除面，误删他空间在 SQL 层即不可能（interface 最小：一个谓词删除
/// 代替 list-ids＋delete_many 两步）；返回实际删除行数。
pub async fn delete_all_in_workspace(
    conn: impl Executor<'_, Database = Sqlite>,
    workspace_id: &str,
) -> Result<u64, AppError> {
    let result = sqlx::query("DELETE FROM run_records WHERE workspace_id = ?")
        .bind(workspace_id)
        .execute(conn)
        .await?;
    Ok(result.rows_affected())
}

/// 当前总条数（封顶断言与运维观测面；现消费面走 list 分页，计数留给
/// `run status` 与运维查询）。
#[allow(dead_code)]
pub async fn count(conn: impl Executor<'_, Database = Sqlite>) -> Result<i64, AppError> {
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM run_records")
        .fetch_one(conn)
        .await?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use sqlx::SqlitePool;

    async fn memory_pool() -> SqlitePool {
        let pool = db::connect_in_memory().await;
        db::run_migrations(&pool).await.unwrap();
        pool
    }

    fn insert_input(id: &str, state: RunState) -> RunRecordInsert {
        RunRecordInsert {
            id: id.to_string(),
            workspace_id: "w1".into(),
            service_id: "s1".into(),
            endpoint_key: "GET /a".into(),
            method: "GET".into(),
            url: "http://127.0.0.1:18080/a".into(),
            status_code: (state == RunState::Passed).then_some(200),
            duration_ms: Some(12),
            state,
            error_code: None,
            error_message: None,
            request_json: "{}".into(),
            response_json: (state == RunState::Passed).then(|| "{}".to_string()),
            source: RunSource::Gui,
        }
    }

    async fn insert_via_pool(pool: &SqlitePool, input: &RunRecordInsert) -> RunRecord {
        let mut conn = pool.acquire().await.unwrap();
        insert_final(&mut conn, input).await.unwrap()
    }

    #[tokio::test]
    async fn insert_final_writes_passed_row_with_defaults() {
        let pool = memory_pool().await;
        let row = insert_via_pool(&pool, &insert_input("run_1", RunState::Passed)).await;
        assert_eq!(row.state(), Some(RunState::Passed));
        assert_eq!(row.status_code, Some(200));
        assert_eq!(row.source(), Some(RunSource::Gui));
        assert!(row.created_at.ends_with('Z'));
        // created_at 由 SQL 侧生成（RFC3339 毫秒）
        assert_eq!(row.created_at.len(), "2026-01-01T00:00:00.000Z".len());
    }

    #[tokio::test]
    async fn failed_row_keeps_null_status_and_error_fields() {
        let pool = memory_pool().await;
        let mut input = insert_input("run_2", RunState::Failed);
        input.status_code = None;
        input.response_json = None;
        input.error_code = Some("TIMEOUT".into());
        input.error_message = Some("request timed out".into());
        let row = insert_via_pool(&pool, &input).await;
        assert_eq!(row.state(), Some(RunState::Failed));
        assert_eq!(row.status_code, None);
        assert_eq!(row.error_code.as_deref(), Some("TIMEOUT"));
    }

    #[tokio::test]
    async fn get_missing_returns_none() {
        let pool = memory_pool().await;
        assert!(get(&pool, "run_nothing").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn cap_trims_oldest_beyond_limit() {
        let pool = memory_pool().await;
        // 构造 1001 条（封顶 1000）：最旧一条被修剪
        for i in 0..=(RUN_RECORDS_CAP as u32) {
            insert_via_pool(
                &pool,
                &insert_input(&format!("run_{i:05}"), RunState::Passed),
            )
            .await;
        }
        assert_eq!(count(&pool).await.unwrap(), RUN_RECORDS_CAP as i64);
        // 最旧（run_00000）被删、其余保留
        assert!(get(&pool, "run_00000").await.unwrap().is_none());
        assert!(get(&pool, "run_00001").await.unwrap().is_some());
        let rows = list(
            &pool,
            &RunListFilter {
                limit: 10,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(rows.len(), 10);
        // created_at 倒序：最新在前
        assert_eq!(rows[0].record.id, format!("run_{RUN_RECORDS_CAP:05}"));
    }

    #[tokio::test]
    async fn list_filters_by_state_and_workspace() {
        let pool = memory_pool().await;
        insert_via_pool(&pool, &insert_input("run_a", RunState::Passed)).await;
        insert_via_pool(&pool, &insert_input("run_b", RunState::Failed)).await;
        insert_via_pool(&pool, &insert_input("run_c", RunState::Cancelled)).await;
        let mut other = insert_input("run_d", RunState::Passed);
        other.workspace_id = "w2".into();
        insert_via_pool(&pool, &other).await;

        let rows = list(
            &pool,
            &RunListFilter {
                workspace_id: Some("w1".into()),
                states: vec![RunState::Passed, RunState::Cancelled],
                limit: 100,
            },
        )
        .await
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.record.workspace_id == "w1"));
        assert!(
            rows.iter()
                .all(|r| r.record.state == "passed" || r.record.state == "cancelled")
        );
    }

    #[tokio::test]
    async fn list_joins_endpoint_title_and_nulls_when_missing() {
        let pool = memory_pool().await;
        // 接口定义链：workspaces → services → endpoints（title 随接口改名更新）
        sqlx::query(
            "INSERT INTO workspaces (id, name, created_at, updated_at) \
             VALUES ('w1', 'W', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), \
                     ('w2', 'W2', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO services (id, workspace_id, name, doc_url, doc_type, sort_order, created_at, updated_at) \
             VALUES ('s1', 'w1', 'S', '', 'swagger', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO endpoints (service_id, key, title, category_id, definition, created_at, badge, sort_order) \
             VALUES ('s1', 'GET /a', '接口 A', NULL, '{}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, 0)",
        )
        .execute(&pool)
        .await
        .unwrap();

        insert_via_pool(&pool, &insert_input("run_hit", RunState::Passed)).await;
        // 无对应接口行（接口已删 / 脏键）：标题 NULL，行不丢
        let mut orphan = insert_input("run_orphan", RunState::Passed);
        orphan.endpoint_key = "GET /gone".into();
        insert_via_pool(&pool, &orphan).await;

        let rows = list(
            &pool,
            &RunListFilter {
                limit: 100,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let title_of = |id: &str| {
            rows.iter()
                .find(|r| r.record.id == id)
                .map(|r| r.endpoint_title.clone())
                .unwrap()
        };
        assert_eq!(title_of("run_hit").as_deref(), Some("接口 A"));
        assert_eq!(title_of("run_orphan"), None);
    }

    #[tokio::test]
    async fn delete_many_removes_only_listed_ids_and_reports_count() {
        let pool = memory_pool().await;
        for id in ["run_a", "run_b", "run_c"] {
            insert_via_pool(&pool, &insert_input(id, RunState::Passed)).await;
        }
        let ids = vec!["run_a".to_string(), "run_c".to_string()];
        assert_eq!(delete_many(&pool, &ids).await.unwrap(), 2);
        // 未列出的 run_b 保留，已删的两条不可再读
        assert!(get(&pool, "run_b").await.unwrap().is_some());
        assert!(get(&pool, "run_a").await.unwrap().is_none());
        assert!(get(&pool, "run_c").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_many_is_idempotent_and_silent_on_missing_ids() {
        let pool = memory_pool().await;
        insert_via_pool(&pool, &insert_input("run_a", RunState::Passed)).await;

        // 空切片：不发起 SQL，直接 0
        assert_eq!(delete_many(&pool, &[]).await.unwrap(), 0);
        // 全不存在的 id：0 行受影响，不报错
        let missing = vec!["run_gone".to_string()];
        assert_eq!(delete_many(&pool, &missing).await.unwrap(), 0);
        // 存在与不存在混合：只计实际删除数
        let mixed = vec!["run_a".to_string(), "run_gone".to_string()];
        assert_eq!(delete_many(&pool, &mixed).await.unwrap(), 1);
        // 重复删除：幂等归 0
        assert_eq!(delete_many(&pool, &mixed).await.unwrap(), 0);
        assert_eq!(count(&pool).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn delete_many_coexists_with_cap_pruning() {
        let pool = memory_pool().await;
        // 先删掉若干既有行，再灌满到封顶之外：修剪仍按 created_at 删最旧，
        // 与显式删除互不干扰（两条链路对同一张表，语义各自独立收敛）
        for i in 0..5 {
            insert_via_pool(
                &pool,
                &insert_input(&format!("run_old_{i}"), RunState::Passed),
            )
            .await;
        }
        let olds: Vec<String> = (0..5).map(|i| format!("run_old_{i}")).collect();
        assert_eq!(delete_many(&pool, &olds).await.unwrap(), 5);

        for i in 0..=(RUN_RECORDS_CAP as u32) {
            insert_via_pool(
                &pool,
                &insert_input(&format!("run_new_{i:05}"), RunState::Passed),
            )
            .await;
        }
        // 封顶语义不变：总数封顶、被删旧 id 不复活、最旧新行被修剪
        assert_eq!(count(&pool).await.unwrap(), RUN_RECORDS_CAP as i64);
        assert!(get(&pool, "run_old_0").await.unwrap().is_none());
        assert!(get(&pool, "run_new_00000").await.unwrap().is_none());
        assert!(get(&pool, "run_new_00001").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn delete_all_in_workspace_only_clears_target_workspace() {
        let pool = memory_pool().await;
        insert_via_pool(&pool, &insert_input("run_a1", RunState::Passed)).await;
        insert_via_pool(&pool, &insert_input("run_a2", RunState::Failed)).await;
        let mut other = insert_input("run_b1", RunState::Passed);
        other.workspace_id = "w2".into();
        insert_via_pool(&pool, &other).await;

        assert_eq!(delete_all_in_workspace(&pool, "w1").await.unwrap(), 2);
        // 目标空间清空、他空间完整（workspace 谓词在 SQL 层约束删除面）
        assert!(get(&pool, "run_a1").await.unwrap().is_none());
        assert!(get(&pool, "run_a2").await.unwrap().is_none());
        assert!(get(&pool, "run_b1").await.unwrap().is_some());
        // 幂等：再清返回 0
        assert_eq!(delete_all_in_workspace(&pool, "w1").await.unwrap(), 0);
    }
}
