//! 变量域 repo：变量分类 / 变量 / 激活指针 / BaseUrl 候选的全部 SQL。
//!
//! 约定（沿 infrastructure 层风格）：单语句函数收 `impl Executor`；
//! 时间戳由 SQL 侧 strftime 生成；写路径用 RETURNING 回读生成列。
//! 激活指针是 `workspaces.active_category_id` 单列——读写均走本 repo，
//! workspace 域自身的读写不受影响（显式列名 SELECT 不含该列）。

use sqlx::Sqlite;
use sqlx::{Connection, Executor};

use crate::domain::variable::{
    BaseUrlCandidate, NewBaseUrlCandidate, NewVariable, NewVariableCategory, StoredVariable,
    VariableCategory,
};
use crate::error::AppError;
use crate::error::codes;

// —— 变量分类 ——

/// 工作空间内分类清单（本空间行；不含全局行），sort_order 升序。
pub async fn list_workspace_categories(
    conn: impl Executor<'_, Database = Sqlite>,
    workspace_id: &str,
) -> Result<Vec<VariableCategory>, AppError> {
    let rows = sqlx::query_as::<_, VariableCategory>(
        "SELECT id, workspace_id, name, sort_order, created_at \
         FROM variable_categories WHERE workspace_id = ? ORDER BY sort_order, created_at, id",
    )
    .bind(workspace_id)
    .fetch_all(conn)
    .await?;
    Ok(rows)
}

/// 全局分类清单（workspace_id NULL 行），sort_order 升序。
pub async fn list_global_categories(
    conn: impl Executor<'_, Database = Sqlite>,
) -> Result<Vec<VariableCategory>, AppError> {
    let rows = sqlx::query_as::<_, VariableCategory>(
        "SELECT id, workspace_id, name, sort_order, created_at \
         FROM variable_categories WHERE workspace_id IS NULL ORDER BY sort_order, created_at, id",
    )
    .fetch_all(conn)
    .await?;
    Ok(rows)
}

/// 按 id 取变量分类。
pub async fn get_category(
    conn: impl Executor<'_, Database = Sqlite>,
    id: &str,
) -> Result<Option<VariableCategory>, AppError> {
    let row = sqlx::query_as::<_, VariableCategory>(
        "SELECT id, workspace_id, name, sort_order, created_at FROM variable_categories WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(conn)
    .await?;
    Ok(row)
}

/// 按名取本空间分类（工作流写回的快照名解析面；全局行不算命中）。
pub async fn find_workspace_category_by_name(
    conn: impl Executor<'_, Database = Sqlite>,
    workspace_id: &str,
    name: &str,
) -> Result<Option<VariableCategory>, AppError> {
    let row = sqlx::query_as::<_, VariableCategory>(
        "SELECT id, workspace_id, name, sort_order, created_at \
         FROM variable_categories WHERE workspace_id = ? AND name = ? LIMIT 1",
    )
    .bind(workspace_id)
    .bind(name)
    .fetch_optional(conn)
    .await?;
    Ok(row)
}

/// 工作空间内分类计数（本空间行，不含全局行）——CLI `project info` 的
/// environments 实数。
pub async fn count_workspace_categories(
    conn: impl Executor<'_, Database = Sqlite>,
    workspace_id: &str,
) -> Result<i64, AppError> {
    let (count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM variable_categories WHERE workspace_id = ?")
            .bind(workspace_id)
            .fetch_one(conn)
            .await?;
    Ok(count)
}

/// 新建变量分类：sort_order 按分组追加末尾（空间分类按 workspace_id 分组、
/// 全局行按 NULL 分组各自独立编号）。工作空间存在性由 services 层先行校验。
pub async fn insert_category(
    conn: impl Executor<'_, Database = Sqlite>,
    input: &NewVariableCategory,
) -> Result<VariableCategory, AppError> {
    match &input.workspace_id {
        Some(workspace_id) => {
            sqlx::query_as::<_, VariableCategory>(
                "INSERT INTO variable_categories (id, workspace_id, name, sort_order, created_at) \
                 VALUES (?, ?, ?, \
                 (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM variable_categories WHERE workspace_id = ?), \
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) \
                 RETURNING id, workspace_id, name, sort_order, created_at",
            )
            .bind(&input.id)
            .bind(workspace_id)
            .bind(&input.name)
            .bind(workspace_id)
            .fetch_one(conn)
            .await
            .map_err(AppError::from)
        }
        None => {
            sqlx::query_as::<_, VariableCategory>(
                "INSERT INTO variable_categories (id, workspace_id, name, sort_order, created_at) \
                 VALUES (?, NULL, ?, \
                 (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM variable_categories WHERE workspace_id IS NULL), \
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) \
                 RETURNING id, workspace_id, name, sort_order, created_at",
            )
            .bind(&input.id)
            .bind(&input.name)
            .fetch_one(conn)
            .await
            .map_err(AppError::from)
        }
    }
}

/// 重命名变量分类。
pub async fn rename_category(
    conn: impl Executor<'_, Database = Sqlite>,
    id: &str,
    name: &str,
) -> Result<VariableCategory, AppError> {
    sqlx::query_as::<_, VariableCategory>(
        "UPDATE variable_categories SET name = ? WHERE id = ? \
         RETURNING id, workspace_id, name, sort_order, created_at",
    )
    .bind(name)
    .bind(id)
    .fetch_one(conn)
    .await
    .map_err(|err| {
        missing(
            err,
            codes::VARIABLE_CATEGORY_NOT_FOUND,
            "variable category rename matched no category",
        )
    })
}

/// 移动分类到同层（同一 scope：本空间组或全局组）的 `index` 位：先摘除
/// 自身再插入（越界钳制到末尾），整组 sort_order 同事务重写。scope 以
/// `workspace_id IS ?` 匹配（NULL＝全局组），跨 scope 移动不存在——全局
/// 组与本空间组是树上的两个固定区。
pub async fn move_category(
    conn: &mut sqlx::SqliteConnection,
    category_id: &str,
    index: i64,
) -> Result<(), AppError> {
    let mut tx = conn.begin().await?;
    let scope: Option<(Option<String>,)> =
        sqlx::query_as("SELECT workspace_id FROM variable_categories WHERE id = ?")
            .bind(category_id)
            .fetch_optional(&mut *tx)
            .await?;
    let (workspace_id,) = scope.ok_or_else(|| {
        AppError::new(
            codes::VARIABLE_CATEGORY_NOT_FOUND,
            format!("variable category move matched no category: {category_id}"),
        )
    })?;
    // 同组现序（排除自身后即插入基线）
    let mut order: Vec<String> = sqlx::query_as::<_, (String,)>(
        "SELECT id FROM variable_categories \
         WHERE workspace_id IS ? AND id != ? \
         ORDER BY sort_order, created_at, id",
    )
    .bind(workspace_id)
    .bind(category_id)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .map(|(id,)| id)
    .collect();
    crate::infrastructure::sort_move::insert_at_clamped(&mut order, category_id, index);
    for (position, id) in order.iter().enumerate() {
        sqlx::query("UPDATE variable_categories SET sort_order = ? WHERE id = ?")
            .bind(position as i64)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// 删除变量分类：其下变量经 FK CASCADE 全删；激活指针经 FK SET NULL 自动
/// 回落到「全不激活」（兜底链只剩全局＋内置）。
pub async fn delete_category(
    conn: impl Executor<'_, Database = Sqlite>,
    id: &str,
) -> Result<u64, AppError> {
    let result = sqlx::query("DELETE FROM variable_categories WHERE id = ?")
        .bind(id)
        .execute(conn)
        .await?;
    Ok(result.rows_affected())
}

// —— 变量 ——

/// 分类内变量清单（sort_order 升序、同序按 key 稳定）。
pub async fn list_variables(
    conn: impl Executor<'_, Database = Sqlite>,
    category_id: &str,
) -> Result<Vec<StoredVariable>, AppError> {
    let rows = sqlx::query_as::<_, StoredVariable>(
        "SELECT category_id, key, value, secret, sort_order, updated_at \
         FROM variables WHERE category_id = ? ORDER BY sort_order, key",
    )
    .bind(category_id)
    .fetch_all(conn)
    .await?;
    Ok(rows)
}

/// 新建变量：同分类下 key 撞车（复合主键冲突）转稳定错误码，
/// 不做静默覆盖——更新走显式 [`update_variable`]。
pub async fn insert_variable(
    conn: impl Executor<'_, Database = Sqlite>,
    input: &NewVariable,
) -> Result<StoredVariable, AppError> {
    sqlx::query_as::<_, StoredVariable>(
        "INSERT INTO variables (category_id, key, value, secret, sort_order, updated_at) \
         VALUES (?, ?, ?, ?, \
         (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM variables WHERE category_id = ?), \
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) \
         RETURNING category_id, key, value, secret, sort_order, updated_at",
    )
    .bind(&input.category_id)
    .bind(&input.key)
    .bind(&input.value)
    .bind(input.secret)
    .bind(&input.category_id)
    .fetch_one(conn)
    .await
    .map_err(|err| {
        if is_primary_key_violation(&err) {
            AppError::new(
                codes::VARIABLE_KEY_DUPLICATE,
                format!("variable key already exists in category: {}", input.key),
            )
        } else {
            AppError::from(err)
        }
    })
}

/// 更新变量值与敏感标记（updated_at 随写刷新；身份 (category_id, key) 不动）。
pub async fn update_variable(
    conn: impl Executor<'_, Database = Sqlite>,
    category_id: &str,
    key: &str,
    value: &str,
    secret: bool,
) -> Result<StoredVariable, AppError> {
    sqlx::query_as::<_, StoredVariable>(
        "UPDATE variables SET value = ?, secret = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
         WHERE category_id = ? AND key = ? \
         RETURNING category_id, key, value, secret, sort_order, updated_at",
    )
    .bind(value)
    .bind(secret)
    .bind(category_id)
    .bind(key)
    .fetch_one(conn)
    .await
    .map_err(|err| missing(err, codes::VARIABLE_NOT_FOUND, "variable update matched no variable"))
}

/// 重命名变量：key 是复合主键的组成，单条 UPDATE 原子改身份；值、secret
/// 标记与 sort_order（同分类内位置）不动。新 key 撞车转稳定错误码，
/// 原变量不存在转 VARIABLE_NOT_FOUND。
pub async fn rename_variable(
    conn: impl Executor<'_, Database = Sqlite>,
    category_id: &str,
    key: &str,
    new_key: &str,
) -> Result<StoredVariable, AppError> {
    sqlx::query_as::<_, StoredVariable>(
        "UPDATE variables SET key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
         WHERE category_id = ? AND key = ? \
         RETURNING category_id, key, value, secret, sort_order, updated_at",
    )
    .bind(new_key)
    .bind(category_id)
    .bind(key)
    .fetch_one(conn)
    .await
    .map_err(|err| {
        if is_primary_key_violation(&err) {
            AppError::new(
                codes::VARIABLE_KEY_DUPLICATE,
                format!("variable key already exists in category: {new_key}"),
            )
        } else {
            missing(
                err,
                codes::VARIABLE_NOT_FOUND,
                "variable rename matched no variable",
            )
        }
    })
}

/// 删除变量。
pub async fn delete_variable(
    conn: impl Executor<'_, Database = Sqlite>,
    category_id: &str,
    key: &str,
) -> Result<u64, AppError> {
    let result = sqlx::query("DELETE FROM variables WHERE category_id = ? AND key = ?")
        .bind(category_id)
        .bind(key)
        .execute(conn)
        .await?;
    Ok(result.rows_affected())
}

// —— 激活指针 ——

/// 读激活分类 id（NULL＝全不激活）。
pub async fn get_active_category_id(
    conn: impl Executor<'_, Database = Sqlite>,
    workspace_id: &str,
) -> Result<Option<String>, AppError> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT active_category_id FROM workspaces WHERE id = ?")
            .bind(workspace_id)
            .fetch_optional(conn)
            .await?;
    // 工作空间存在性由 services 层先行校验；此处行缺失按「无激活」容错读取
    // （激活指针读路径容错，写路径仍严格校验）
    Ok(row.and_then(|(active,)| active))
}

/// 设置激活分类（category_id None＝取消激活）。单条 UPDATE 即原子切换：
/// 指针单列语义下不存在「旧已清、新未设」的中间态。校验（存在性 / 归属 /
/// 非全局）由 services 层先行完成。
pub async fn set_active_category(
    conn: impl Executor<'_, Database = Sqlite>,
    workspace_id: &str,
    category_id: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query("UPDATE workspaces SET active_category_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
        .bind(category_id)
        .bind(workspace_id)
        .execute(conn)
        .await?;
    Ok(())
}

// —— BaseUrl 候选 ——

/// 工作空间的候选清单（创建时间升序）。
pub async fn list_base_urls(
    conn: impl Executor<'_, Database = Sqlite>,
    workspace_id: &str,
) -> Result<Vec<BaseUrlCandidate>, AppError> {
    let rows = sqlx::query_as::<_, BaseUrlCandidate>(
        "SELECT id, workspace_id, url, created_at \
         FROM workspace_base_urls WHERE workspace_id = ? ORDER BY created_at, id",
    )
    .bind(workspace_id)
    .fetch_all(conn)
    .await?;
    Ok(rows)
}

/// 新增候选：同工作空间同 URL（UNIQUE 约束）转稳定错误码。
/// 候选表与 `workspaces.base_url` 无联动——删除候选不影响生效值。
pub async fn insert_base_url(
    conn: impl Executor<'_, Database = Sqlite>,
    input: &NewBaseUrlCandidate,
) -> Result<BaseUrlCandidate, AppError> {
    sqlx::query_as::<_, BaseUrlCandidate>(
        "INSERT INTO workspace_base_urls (id, workspace_id, url, created_at) \
         VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) \
         RETURNING id, workspace_id, url, created_at",
    )
    .bind(&input.id)
    .bind(&input.workspace_id)
    .bind(&input.url)
    .fetch_one(conn)
    .await
    .map_err(|err| {
        if is_unique_violation(&err) {
            AppError::new(
                codes::BASE_URL_CANDIDATE_DUPLICATE,
                format!("base url candidate already exists: {}", input.url),
            )
        } else {
            AppError::from(err)
        }
    })
}

/// 删除候选（轻操作；不影响 `workspaces.base_url` 生效值）。
/// workspace_id 内联过滤：跨空间 id 与不存在等价（rows_affected 0 交由服务层裁决）。
pub async fn delete_base_url(
    conn: impl Executor<'_, Database = Sqlite>,
    workspace_id: &str,
    id: &str,
) -> Result<u64, AppError> {
    let result = sqlx::query("DELETE FROM workspace_base_urls WHERE id = ? AND workspace_id = ?")
        .bind(id)
        .bind(workspace_id)
        .execute(conn)
        .await?;
    Ok(result.rows_affected())
}

// —— 错误映射 ——

/// 单行写操作主键未命中（RETURNING 空集）统一转「实体不存在」。
fn missing(err: sqlx::Error, code: &'static str, message: &'static str) -> AppError {
    match err {
        sqlx::Error::RowNotFound => AppError::new(code, message),
        other => AppError::from(other),
    }
}

/// SQLite 主键约束冲突（SQLITE_CONSTRAINT_PRIMARYKEY = 1555）：
/// variables 复合主键 (category_id, key) 撞车。
fn is_primary_key_violation(err: &sqlx::Error) -> bool {
    matches!(err, sqlx::Error::Database(db) if db.code().as_deref() == Some("1555"))
}

/// SQLite 唯一约束冲突（SQLITE_CONSTRAINT_UNIQUE = 2067）：
/// workspace_base_urls 的 UNIQUE (workspace_id, url) 撞车。
fn is_unique_violation(err: &sqlx::Error) -> bool {
    matches!(err, sqlx::Error::Database(db) if db.code().as_deref() == Some("2067"))
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// 测试装置：插入最简工作空间分类（领域校验由 services 层测试覆盖）。
    pub async fn seed_category(
        conn: impl Executor<'_, Database = Sqlite>,
        id: &str,
        workspace_id: &str,
        name: &str,
    ) -> VariableCategory {
        insert_category(
            conn,
            &NewVariableCategory {
                id: id.to_owned(),
                workspace_id: Some(workspace_id.to_owned()),
                name: name.to_owned(),
            },
        )
        .await
        .expect("seed variable category must insert")
    }

    /// 测试装置：插入最简全局分类。
    pub async fn seed_global_category(
        conn: impl Executor<'_, Database = Sqlite>,
        id: &str,
        name: &str,
    ) -> VariableCategory {
        insert_category(
            conn,
            &NewVariableCategory {
                id: id.to_owned(),
                workspace_id: None,
                name: name.to_owned(),
            },
        )
        .await
        .expect("seed global variable category must insert")
    }

    /// 测试装置：插入最简变量。
    pub async fn seed_variable(
        conn: impl Executor<'_, Database = Sqlite>,
        category_id: &str,
        key: &str,
        value: &str,
        secret: bool,
    ) -> StoredVariable {
        insert_variable(
            conn,
            &NewVariable {
                category_id: category_id.to_owned(),
                key: key.to_owned(),
                value: value.to_owned(),
                secret,
            },
        )
        .await
        .expect("seed variable must insert")
    }
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

    async fn seeded_pool() -> SqlitePool {
        let pool = memory_pool().await;
        crate::infrastructure::workspace_repo::test_support::seed_workspace(&pool, "w1", "一")
            .await;
        crate::infrastructure::workspace_repo::test_support::seed_workspace(&pool, "w2", "二")
            .await;
        pool
    }

    // —— 分组一：分类 CRUD ——

    #[tokio::test]
    async fn category_crud_roundtrip() {
        let pool = seeded_pool().await;
        let created = insert_category(
            &pool,
            &NewVariableCategory {
                id: "vc1".into(),
                workspace_id: Some("w1".into()),
                name: "开发环境".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(created.workspace_id.as_deref(), Some("w1"));
        assert_eq!(created.sort_order, 0, "空分组首条 sort_order 为 0");
        assert!(created.created_at.starts_with("20"));

        // 第二条追加末尾
        let second = test_support::seed_category(&pool, "vc2", "w1", "测试环境").await;
        assert_eq!(second.sort_order, 1);

        // 清单只含本空间行
        let list = list_workspace_categories(&pool, "w1").await.unwrap();
        assert_eq!(
            list.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            vec!["vc1", "vc2"]
        );

        // 重命名
        let renamed = rename_category(&pool, "vc1", "新名字").await.unwrap();
        assert_eq!(renamed.name, "新名字");
        let err = rename_category(&pool, "nope", "x").await.unwrap_err();
        assert_eq!(err.code, codes::VARIABLE_CATEGORY_NOT_FOUND);

        // 删除
        assert_eq!(delete_category(&pool, "vc2").await.unwrap(), 1);
        assert_eq!(
            delete_category(&pool, "vc2").await.unwrap(),
            0,
            "重复删除零命中"
        );
        assert_eq!(
            list_workspace_categories(&pool, "w1").await.unwrap().len(),
            1
        );
    }

    #[tokio::test]
    async fn global_and_workspace_categories_number_sort_order_separately() {
        let pool = seeded_pool().await;
        test_support::seed_category(&pool, "vc1", "w1", "空间分类").await;
        let g1 = test_support::seed_global_category(&pool, "g1", "全局一").await;
        let g2 = test_support::seed_global_category(&pool, "g2", "全局二").await;
        // 全局分组独立编号，不受空间行影响
        assert_eq!((g1.sort_order, g2.sort_order), (0, 1));
        // 两个清单互不可见
        assert_eq!(
            list_workspace_categories(&pool, "w1").await.unwrap().len(),
            1
        );
        assert_eq!(list_global_categories(&pool).await.unwrap().len(), 2);
        assert_eq!(count_workspace_categories(&pool, "w1").await.unwrap(), 1);
        // 空间分类与全局分类同名允许并存（spec DDL 无 UNIQUE 约束）
        let same_name = insert_category(
            &pool,
            &NewVariableCategory {
                id: "vc2".into(),
                workspace_id: Some("w1".into()),
                name: "全局一".into(),
            },
        )
        .await;
        assert!(same_name.is_ok(), "分类名不设唯一约束");
    }

    // —— 分组二：激活独占 ——

    #[tokio::test]
    async fn activation_is_exclusive_single_pointer() {
        let pool = seeded_pool().await;
        test_support::seed_category(&pool, "vc1", "w1", "一").await;
        test_support::seed_category(&pool, "vc2", "w1", "二").await;

        set_active_category(&pool, "w1", Some("vc1")).await.unwrap();
        assert_eq!(
            get_active_category_id(&pool, "w1")
                .await
                .unwrap()
                .as_deref(),
            Some("vc1")
        );

        // 激活另一分类：单列指针直接顶替（独占），无中间态
        set_active_category(&pool, "w1", Some("vc2")).await.unwrap();
        assert_eq!(
            get_active_category_id(&pool, "w1")
                .await
                .unwrap()
                .as_deref(),
            Some("vc2")
        );

        // 取消激活：NULL＝全不激活
        set_active_category(&pool, "w1", None).await.unwrap();
        assert_eq!(get_active_category_id(&pool, "w1").await.unwrap(), None);

        // 工作空间间互不干扰
        set_active_category(&pool, "w1", Some("vc1")).await.unwrap();
        assert_eq!(get_active_category_id(&pool, "w2").await.unwrap(), None);
    }

    // —— 分组三：删除激活分类 SET NULL 兜底 ——

    #[tokio::test]
    async fn deleting_active_category_resets_pointer_to_null() {
        let pool = seeded_pool().await;
        test_support::seed_category(&pool, "vc1", "w1", "一").await;
        test_support::seed_variable(&pool, "vc1", "host", "https://x", false).await;
        set_active_category(&pool, "w1", Some("vc1")).await.unwrap();

        delete_category(&pool, "vc1").await.unwrap();

        // FK SET NULL：激活指针回落到「全不激活」
        assert_eq!(get_active_category_id(&pool, "w1").await.unwrap(), None);
        // 其下变量随分类 CASCADE 全删
        let (vars,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM variables")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(vars, 0, "变量必须随分类级联删除");
    }

    // —— 分组四：候选表 UNIQUE 与删除不影响生效值 ——

    #[tokio::test]
    async fn base_url_candidate_unique_conflict_is_stable_error() {
        let pool = seeded_pool().await;
        insert_base_url(
            &pool,
            &NewBaseUrlCandidate {
                id: "b1".into(),
                workspace_id: "w1".into(),
                url: "https://a.example.com".into(),
            },
        )
        .await
        .unwrap();
        // 同空间同 URL：稳定错误码
        let err = insert_base_url(
            &pool,
            &NewBaseUrlCandidate {
                id: "b2".into(),
                workspace_id: "w1".into(),
                url: "https://a.example.com".into(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, codes::BASE_URL_CANDIDATE_DUPLICATE);
        // 跨空间同 URL：不冲突（UNIQUE 按 (workspace_id, url)）
        insert_base_url(
            &pool,
            &NewBaseUrlCandidate {
                id: "b3".into(),
                workspace_id: "w2".into(),
                url: "https://a.example.com".into(),
            },
        )
        .await
        .unwrap();
        // 同空间不同 URL：不冲突
        insert_base_url(
            &pool,
            &NewBaseUrlCandidate {
                id: "b4".into(),
                workspace_id: "w1".into(),
                url: "https://b.example.com".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(list_base_urls(&pool, "w1").await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn deleting_candidate_keeps_workspaces_base_url_intact() {
        let pool = seeded_pool().await;
        sqlx::query(
            "UPDATE workspaces SET base_url = 'https://effective.example.com' WHERE id = 'w1'",
        )
        .execute(&pool)
        .await
        .unwrap();
        insert_base_url(
            &pool,
            &NewBaseUrlCandidate {
                id: "b1".into(),
                workspace_id: "w1".into(),
                url: "https://effective.example.com".into(),
            },
        )
        .await
        .unwrap();

        delete_base_url(&pool, "w1", "b1").await.unwrap();
        // 跨空间 id 与不存在等价：0 行受影响，不报错不误删
        assert_eq!(delete_base_url(&pool, "w2", "b1").await.unwrap(), 0);

        // 候选删空，生效值原样保留（两表无联动）
        assert_eq!(list_base_urls(&pool, "w1").await.unwrap().len(), 0);
        let (base_url,): (Option<String>,) =
            sqlx::query_as("SELECT base_url FROM workspaces WHERE id = 'w1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(base_url.as_deref(), Some("https://effective.example.com"));
    }

    // —— 分组五：复合主键冲突 ——

    #[tokio::test]
    async fn variable_composite_key_conflict_is_stable_error() {
        let pool = seeded_pool().await;
        test_support::seed_category(&pool, "vc1", "w1", "一").await;
        test_support::seed_variable(&pool, "vc1", "token", "v1", true).await;

        // 同分类同 key：复合主键冲突 → 稳定错误码（不静默覆盖）
        let err = insert_variable(
            &pool,
            &NewVariable {
                category_id: "vc1".into(),
                key: "token".into(),
                value: "v2".into(),
                secret: false,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, codes::VARIABLE_KEY_DUPLICATE);
        // 原值未被覆盖
        let list = list_variables(&pool, "vc1").await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].value, "v1");
        assert!(list[0].secret);

        // 不同分类同 key：不冲突（复合主键按 (category_id, key)）
        test_support::seed_category(&pool, "vc2", "w1", "二").await;
        test_support::seed_variable(&pool, "vc2", "token", "other", false).await;
        assert_eq!(list_variables(&pool, "vc2").await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn variable_update_and_delete_by_composite_key() {
        let pool = seeded_pool().await;
        test_support::seed_category(&pool, "vc1", "w1", "一").await;
        test_support::seed_category(&pool, "vc2", "w1", "二").await;
        test_support::seed_variable(&pool, "vc1", "token", "v1", false).await;
        test_support::seed_variable(&pool, "vc2", "token", "v2", false).await;

        let updated = update_variable(&pool, "vc1", "token", "新值", true)
            .await
            .unwrap();
        assert_eq!((updated.value.as_str(), updated.secret), ("新值", true));
        // 另一分类的同名变量不受影响
        let untouched = list_variables(&pool, "vc2").await.unwrap();
        assert_eq!(untouched[0].value, "v2");

        let err = update_variable(&pool, "vc1", "nope", "x", false)
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::VARIABLE_NOT_FOUND);

        assert_eq!(delete_variable(&pool, "vc1", "token").await.unwrap(), 1);
        assert_eq!(delete_variable(&pool, "vc1", "token").await.unwrap(), 0);
        assert_eq!(
            list_variables(&pool, "vc2").await.unwrap().len(),
            1,
            "vc2 不受 vc1 删除影响"
        );
    }

    /// 迁移落库形态对账：四表列齐全、约束就位
    #[tokio::test]
    async fn migration_creates_variable_domain_tables_and_constraints() {
        let pool = memory_pool().await;
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN \
             ('variable_categories', 'variables', 'workspace_base_urls') ORDER BY name",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        let names: Vec<&str> = rows.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(
            names,
            vec!["variable_categories", "variables", "workspace_base_urls"]
        );
        for (_, sql) in &rows {
            if sql.contains("\"variables\"") || sql.contains("variables (") {
                assert!(
                    sql.contains("PRIMARY KEY (category_id, key)"),
                    "复合主键缺失: {sql}"
                );
            }
        }
        // 表约束形式的 UNIQUE 在 SQLite 里落成 sqlite_autoindex_*（sql 为 NULL），
        // 经 pragma_index_list 检测唯一索引才可靠
        let unique_indexes: Vec<(i64,)> = sqlx::query_as(
            "SELECT \"unique\" FROM pragma_index_list('workspace_base_urls') WHERE \"unique\" = 1",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert!(
            !unique_indexes.is_empty(),
            "workspace_base_urls 缺 UNIQUE 索引"
        );
        // workspaces 新列存在且可空（无默认值约束下的可空指针）
        let cols: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM pragma_table_info('workspaces') WHERE name = 'active_category_id'",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(cols.len(), 1, "workspaces.active_category_id 列缺失");
    }
}
