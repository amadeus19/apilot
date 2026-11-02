//! SQLite 连接池、启动完整性校验与嵌入式迁移。
//!
//! 连接参数定值：journal_mode=WAL、busy_timeout=5000、foreign_keys=ON、
//! max_connections=1（Phase 1 仅 settings 读写，串行即可，后续阶段按读写压力重估）。

//! 迁移 SQL 位于本 crate 根 `migrations/` 目录，经 `sqlx::migrate!` 编译期嵌入。

use std::path::Path;
use std::time::Duration;

use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

use crate::error::AppError;

/// 库文件名，挂 `{app_data_dir}/` 下（落地即定）
pub const DB_FILE_NAME: &str = "apilot2.db";

/// 打开连接池（不含迁移）。文件不存在则创建（首次启动）。
pub async fn connect(db_path: &Path) -> Result<SqlitePool, AppError> {
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        // 定值：busy_timeout=5000ms
        .busy_timeout(Duration::from_millis(5000))
        .foreign_keys(true);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|err| {
            // SQLite code 26（SQLITE_NOTADB）：文件存在但不是有效 SQLite 库，
            // 对用户而言这就是「库损坏」，与 quick_check 失败同码呈现
            if is_not_a_database(&err) {
                AppError::new(
                    crate::error::codes::DB_CORRUPTED,
                    format!(
                        "database file at {} is not a valid sqlite database",
                        db_path.display()
                    ),
                )
            } else {
                AppError::new(
                    crate::error::codes::DB_OPEN_FAILED,
                    format!("failed to open database at {}: {err}", db_path.display()),
                )
            }
        })
}

/// 识别 SQLite SQLITE_NOTADB（code 26）：连接期即暴露的「非数据库文件」损坏
fn is_not_a_database(err: &sqlx::Error) -> bool {
    matches!(err, sqlx::Error::Database(db) if db.code().as_deref() == Some("26"))
}

/// 启动完整性校验：`PRAGMA quick_check` 不通过即判 DB_CORRUPTED。
/// 损坏库上的 PRAGMA 本身也可能直接报错（如 "file is not a database"），同样归入损坏。
pub async fn quick_check(pool: &SqlitePool) -> Result<(), AppError> {
    let rows: Vec<(String,)> = sqlx::query_as("PRAGMA quick_check")
        .fetch_all(pool)
        .await
        .map_err(|err| {
            AppError::new(
                crate::error::codes::DB_CORRUPTED,
                format!("database integrity check failed: {err}"),
            )
        })?;
    // 完整库返回单行 "ok"；其余任何行都是问题描述
    if !rows.is_empty() && rows.iter().all(|(verdict,)| verdict == "ok") {
        Ok(())
    } else {
        let findings: Vec<String> = rows.into_iter().map(|(verdict,)| verdict).collect();
        Err(AppError::new(
            crate::error::codes::DB_CORRUPTED,
            "database integrity check reported problems",
        )
        .with_details(serde_json::json!({ "findings": findings })))
    }
}

/// 嵌入式迁移（`sqlx::migrate!` 编译期打包，构建不依赖 DATABASE_URL）
pub async fn run_migrations(pool: &SqlitePool) -> Result<(), AppError> {
    sqlx::migrate!("./migrations")
        .run(pool)
        .await
        .map_err(|err| {
            AppError::new(
                crate::error::codes::DB_MIGRATION_FAILED,
                format!("database migration failed: {err}"),
            )
        })
}

/// 建数据目录（不存在时）：GUI 与 headless 装配链共用。
fn ensure_app_dir(app_data_dir: &Path) -> Result<(), AppError> {
    if !app_data_dir.exists() {
        std::fs::create_dir_all(app_data_dir).map_err(|err| {
            AppError::new(
                crate::error::codes::IO_CREATE_DIR_FAILED,
                format!(
                    "failed to create app data dir {}: {err}",
                    app_data_dir.display()
                ),
            )
        })?;
    }
    Ok(())
}

/// GUI 启动初始化：建目录 → 连接 → 完整性校验 → 迁移。
/// 任何一步失败都返回 AppError，由调用方决定呈现方式（前端全屏错误）。
pub async fn init_gui(app_data_dir: &Path) -> Result<SqlitePool, AppError> {
    ensure_app_dir(app_data_dir)?;
    let pool = connect(&app_data_dir.join(DB_FILE_NAME)).await?;
    quick_check(&pool).await?;
    run_migrations(&pool).await?;
    Ok(pool)
}

/// Headless 初始化（CLI 装配）：建目录 → 连接 → 迁移（带一次退避重试）。
/// 不跑 quick_check：短命进程每次命令做全库扫描过重，且长读会暂阻 checkpoint
/// 重置 `-wal`；健康诊断语义归收尾阶段 `apilot doctor`。
pub async fn init_headless(app_data_dir: &Path) -> Result<SqlitePool, AppError> {
    ensure_app_dir(app_data_dir)?;
    let pool = connect(&app_data_dir.join(DB_FILE_NAME)).await?;
    migrate_with_retry(|| run_migrations(&pool)).await?;
    Ok(pool)
}

/// 迁移执行带一次退避重试：sqlx 对 SQLite 无跨进程迁移锁，
/// GUI 与 CLI 同秒冷启动时后到者的 DDL 报 `DB_MIGRATION_FAILED`（库无损、
/// 事务整体回滚）——退避后先到者已提交，重跑按迁移登记跳过。
/// 仅对 `DB_MIGRATION_FAILED` 重试，其余错误原样返回（不掩盖真实故障）。
pub(crate) async fn migrate_with_retry<F, Fut>(mut migrate: F) -> Result<(), AppError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<(), AppError>>,
{
    match migrate().await {
        Err(err) if err.code == crate::error::codes::DB_MIGRATION_FAILED => {
            tokio::time::sleep(Duration::from_millis(
                crate::constants::MIGRATION_RETRY_DELAY_MS,
            ))
            .await;
            migrate().await
        }
        other => other,
    }
}

/// 测试专用：单连接内存库（与生产同款连接参数，勿在生产代码使用）。
/// 单连接保证 `in_memory` 的 schema 在整个测试期间存活。
#[cfg(test)]
pub(crate) async fn connect_in_memory() -> SqlitePool {
    let options = SqliteConnectOptions::new()
        .in_memory(true)
        .busy_timeout(Duration::from_millis(5000))
        .foreign_keys(true);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("in-memory sqlite pool must be creatable")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试专用临时目录（不引 tempfile 依赖，stdlib 组合即可）
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("apilot2-db-test-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir); // 清理上次运行残留
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn init_gui_creates_db_and_applies_migrations() {
        let dir = temp_dir("init-ok");
        let pool = init_gui(&dir).await.unwrap();
        // settings 表已建且为空；__sqlx_migrations 记录了全部嵌入迁移
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM settings")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 0);
        let applied: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(applied.0, 20);
        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn init_headless_creates_db_and_applies_migrations() {
        let dir = temp_dir("headless-ok");
        let pool = init_headless(&dir).await.unwrap();
        let applied: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(applied.0, 20, "headless 装配同样要跑完全部迁移");
        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 重试语义（确定性注入）：首次 `DB_MIGRATION_FAILED` → 退避 → 恰好重试一次；
    /// 其余错误码不重试（不掩盖真实故障）。
    #[tokio::test]
    async fn migrate_retry_reruns_once_only_for_migration_failures() {
        use std::cell::Cell;

        let calls = Cell::new(0u32);
        let ok = migrate_with_retry(|| {
            calls.set(calls.get() + 1);
            let n = calls.get();
            async move {
                if n < 2 {
                    Err(AppError::new(
                        crate::error::codes::DB_MIGRATION_FAILED,
                        "simulated concurrent cold start",
                    ))
                } else {
                    Ok(())
                }
            }
        })
        .await;
        assert!(ok.is_ok());
        assert_eq!(calls.get(), 2, "首次迁移失败应触发恰好一次重试");

        let calls = Cell::new(0u32);
        let err = migrate_with_retry(|| {
            calls.set(calls.get() + 1);
            async {
                Err(AppError::new(
                    crate::error::codes::DB_OPEN_FAILED,
                    "not a migration failure",
                ))
            }
        })
        .await
        .unwrap_err();
        assert_eq!(err.code, crate::error::codes::DB_OPEN_FAILED);
        assert_eq!(calls.get(), 1, "非迁移失败不得重试");
    }

    /// 迁移竞态持久失败路径：登记表被库外删除（业务表仍在）时，重跑迁移
    /// 必然与既有表冲突，重试后仍失败 → `DB_MIGRATION_FAILED` 原样上抛。
    #[tokio::test]
    async fn init_headless_surfaces_persistent_migration_failure() {
        let dir = temp_dir("headless-mig-fail");
        let pool = init_headless(&dir).await.unwrap();
        pool.close().await;
        // 破坏迁移登记：删登记表但保留业务表 → 重新装配时迁移必然撞既有表
        let options = SqliteConnectOptions::new().filename(dir.join(DB_FILE_NAME));
        let raw = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query("DROP TABLE _sqlx_migrations")
            .execute(&raw)
            .await
            .unwrap();
        raw.close().await;

        let err = init_headless(&dir).await.unwrap_err();
        assert_eq!(err.code, crate::error::codes::DB_MIGRATION_FAILED);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 捆绑 SQLite 必须含 WAL-Reset Bug 修复（修复于 3.51.3）——
    /// 双进程直写（Mode B）的生效前提。断言取运行时 `sqlite_version()`，
    /// 校验的是真实链接进产物的库，而非任何头文件宏。
    #[tokio::test]
    async fn bundled_sqlite_has_wal_reset_fix() {
        let pool = connect_in_memory().await;
        let (version,): (String,) = sqlx::query_as("SELECT sqlite_version()")
            .fetch_one(&pool)
            .await
            .unwrap();
        let parts: Vec<u32> = version
            .split('.')
            .filter_map(|p| p.parse::<u32>().ok())
            .collect();
        assert_eq!(
            parts.len(),
            3,
            "unexpected sqlite version format: {version}"
        );
        assert!(
            (parts[0], parts[1], parts[2]) >= (3, 51, 3),
            "bundled SQLite {version} lacks the WAL-reset fix (fixed in 3.51.3)"
        );
    }

    /// BUSY 分码行为：写锁被占且 busy_timeout=0 时，写入得到 `DB_BUSY`
    /// 而非查询期通用失败码（双进程并发写的排队上限语义）。
    #[tokio::test]
    async fn busy_error_maps_to_db_busy_code() {
        let dir = temp_dir("busy");
        let db_path = dir.join(DB_FILE_NAME);
        let options = |timeout| {
            SqliteConnectOptions::new()
                .filename(&db_path)
                .create_if_missing(true)
                .busy_timeout(timeout)
        };
        let holder = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options(Duration::from_millis(5000)))
            .await
            .unwrap();
        // 持写事务不提交：占用文件写锁
        let mut conn = holder.acquire().await.unwrap();
        sqlx::query("CREATE TABLE IF NOT EXISTS busy_probe (id INTEGER)")
            .execute(&mut *conn)
            .await
            .unwrap();
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO busy_probe VALUES (1)")
            .execute(&mut *conn)
            .await
            .unwrap();

        let contender = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options(Duration::from_millis(0)))
            .await
            .unwrap();
        let err = sqlx::query("INSERT INTO busy_probe VALUES (2)")
            .execute(&contender)
            .await
            .expect_err("写锁被占时必须失败");
        let mapped: AppError = err.into();
        assert_eq!(
            mapped.code,
            crate::error::codes::DB_BUSY,
            "actual: {mapped:?}"
        );

        let _ = conn.close().await;
        holder.close().await;
        contender.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn corrupt_db_file_reports_db_corrupted() {
        let dir = temp_dir("corrupt");
        let db_path = dir.join(DB_FILE_NAME);
        // 人为损坏：写一个明显不是 SQLite 的文件（含非法头）
        std::fs::write(&db_path, b"this is definitely not a sqlite database").unwrap();
        let err = init_gui(&dir).await.unwrap_err();
        assert_eq!(err.code, "DB_CORRUPTED", "actual error: {err:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
