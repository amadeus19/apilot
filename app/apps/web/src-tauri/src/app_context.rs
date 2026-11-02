//! Headless 装配产物：数据目录 + DB 句柄的进程级上下文。
//!
//! GUI 与 `apilot` CLI 复用同一构造函数链（settings 缓存灌入、默认工作空间
//! seeding 同源）；GUI 侧 AppState 保持 Tauri 装配形态不动——DB 初始化失败
//! 不终止启动、由前端全屏呈现，而 headless 侧任何装配失败都直接报错退出。
//! 数据目录解析（`infrastructure::data_dir`）只允许在两入口 main 调用，
//! 本类型的构造即测试注入缝：测试传临时目录，永不触碰生产数据。

use std::path::PathBuf;

use crate::error::AppError;
use crate::{Db, db, services};

/// 进程级装配上下文：`apilot` CLI 的唯一运行时依赖容器。
pub struct AppContext {
    /// 数据目录（已存在；由调用方 main 经 data_dir 解析或测试构造注入）
    pub data_dir: PathBuf,
    /// DB 句柄（连接池 + settings 内存缓存）
    pub db: Db,
    /// HTTP 引擎服务：与 GUI 同一构建入口（`http` 设置键快照——CLI 与 GUI
    /// 同读同源；纯 Mode B 直连同库，键值实时）
    pub http: services::http::HttpService,
    /// 任务登记处：执行域命令（api run）的取消登记面；CLI 进程退出即整体释放。
    /// Arc＝Ctrl+C 侧车任务跨 await 持有（信号到 → cancel_all）。
    pub tasks: std::sync::Arc<crate::tasks::TaskRegistry>,
}

impl AppContext {
    /// Headless 装配链：`init_headless`（无 quick_check，迁移竞态退避重试一次）
    /// → settings 缓存灌入 → 默认工作空间 seeding（CLI 首跑建库也要有）。
    /// 任何一步失败即返回 AppError，由 CLI 报错退出——不静默降级。
    pub async fn new(data_dir: PathBuf) -> Result<Self, AppError> {
        let pool = db::init_headless(&data_dir).await?;
        let cache = services::settings::SettingsCache::default();
        services::settings::load_all(&pool, &cache).await?;
        let db = Db { pool, cache };
        services::workspace::ensure_default(&db.pool).await?;
        let http = crate::http_service_from_cache(&db.cache);
        Ok(Self {
            data_dir,
            db,
            http,
            tasks: std::sync::Arc::new(crate::tasks::TaskRegistry::new()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试专用临时目录（不引 tempfile 依赖，stdlib 组合即可）
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("apilot2-appctx-test-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir); // 清理上次运行残留
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn new_seeds_default_workspace_into_fresh_dir() {
        let dir = temp_dir("fresh");
        let ctx = AppContext::new(dir.clone()).await.unwrap();
        assert_eq!(ctx.data_dir, dir);
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM workspaces")
            .fetch_one(&ctx.db.pool)
            .await
            .unwrap();
        assert_eq!(count, 1, "CLI 首跑建库也要有默认工作空间");
        // settings 缓存已灌入（空库为空快照，但可读）
        let _ = ctx.db.cache.snapshot();
        ctx.db.pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn new_is_idempotent_on_existing_dir() {
        let dir = temp_dir("reuse");
        let first = AppContext::new(dir.clone()).await.unwrap();
        first.db.pool.close().await;
        let second = AppContext::new(dir.clone()).await.unwrap();
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM workspaces")
            .fetch_one(&second.db.pool)
            .await
            .unwrap();
        assert_eq!(count, 1, "重复装配不得重复 seeding");
        second.db.pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
