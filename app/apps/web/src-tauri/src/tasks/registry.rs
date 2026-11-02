//! TaskRegistry：任务登记处。
//!
//! 一切长期运行任务（Workflow / HTTP 请求 / 备份等）经此 spawn——登记、可取消、
//! 可清理；裸 `tokio::spawn` 不登记、不可取消、不清理，**禁止合入**（code review
//! 检查项）。键形约定 `类型:<id>`（如 `backup:api-42`）；取消走 CancellationToken，
//! 任务 future 接收 token 自行选择取消感知点（select / cancelled().await）。
//!
//! 资源四问：任务由调用方（功能模块）创建、经本登记处持有句柄与取消令牌；
//! 任务完成不自动移除（保留可观测），`cleanup_finished` 批量清理或调用方
//! `remove`；关闭 Tab / 取消操作 → `cancel`；应用退出 → 统一 Shutdown 序列
//! `cancel_all` + `wait_all` 超时强退。
//!
//! 并发模型：`tokio::spawn` 直接可用——tauri 异步上下文运行在 tokio runtime 上
//! （async command / async_runtime::spawn 的 future 内），单元测试用独立
//! `#[tokio::test]` runtime 亦不受 tauri 全局 runtime 干扰。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::error::AppError;

struct TaskEntry {
    token: CancellationToken,
    handle: JoinHandle<()>,
}

#[derive(Default)]
struct RegistryInner {
    tasks: HashMap<String, TaskEntry>,
    /// shutdown 第一步置位后拒绝一切新 spawn（停止接受新任务）
    closed: bool,
}

/// 任务登记处。线程安全（内部 Mutex 只包同步操作，无锁跨 await）。
/// 句柄语义（内部 Arc 共享同一登记表）：克隆传递进任务体，供嵌套登记
/// 子任务（如 `sync:fetch` 任务体内登记联动重探 `probe:refresh:<id>`，
/// 子任务生命周期独立于父任务、由自己的键回收）。
#[derive(Default, Clone)]
pub struct TaskRegistry {
    inner: Arc<Mutex<RegistryInner>>,
}

impl TaskRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, RegistryInner> {
        // 锁中毒仅可能发生在持锁写入 panic 时；HashMap 不因中毒损坏，
        // 取回内部数据继续使用（不让 panic 沿锁扩散，与 SettingsCache 同款）
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// 登记并启动任务：重复键拒绝（`TASK_KEY_EXISTS`）；shutdown 进行中拒绝
    /// （`SHUTDOWN_IN_PROGRESS`）。future 经 `make` 接收本任务的 token，
    /// 取消语义由任务实现决定（建议在 await 点 select token）。
    /// JoinHandle 由 registry 内部持有（`-> JoinHandle` 形态不采纳的
    /// 裁定：is_finished/abort 需要句柄，外泄会造成双重所有权）。
    pub fn spawn<F, Fut>(&self, key: &str, make: F) -> Result<(), AppError>
    where
        F: FnOnce(CancellationToken) -> Fut,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let mut inner = self.lock();
        if inner.closed {
            return Err(AppError::new(
                crate::error::codes::SHUTDOWN_IN_PROGRESS,
                "registry is closed, refusing new task",
            ));
        }
        if inner.tasks.contains_key(key) {
            return Err(AppError::new(
                crate::error::codes::TASK_KEY_EXISTS,
                format!("task key already registered: {key}"),
            )
            .with_details(serde_json::json!({ "key": key })));
        }
        let token = CancellationToken::new();
        let handle = tokio::spawn(make(token.clone()));
        inner
            .tasks
            .insert(key.to_owned(), TaskEntry { token, handle });
        Ok(())
    }

    /// 取消单个任务：发取消信号，不等待退出（等待见 [`Self::wait_all`]）。
    /// 幂等：键不存在返回 false，二次取消无害。
    pub fn cancel(&self, key: &str) -> bool {
        match self.lock().tasks.get(key) {
            Some(entry) => {
                entry.token.cancel();
                true
            }
            None => false,
        }
    }

    /// 取消全部任务（对已完成条目 cancel 亦无害），返回**活跃**任务数
    /// （已完成未清理的条目不计——它们无需取消）。
    pub fn cancel_all(&self) -> usize {
        let inner = self.lock();
        let mut active = 0;
        for entry in inner.tasks.values() {
            if !entry.handle.is_finished() {
                active += 1;
            }
            entry.token.cancel();
        }
        active
    }

    /// 任务是否在运行：已登记且未结束（完成后未清理 → false）。
    pub fn is_running(&self, key: &str) -> bool {
        self.lock()
            .tasks
            .get(key)
            .is_some_and(|entry| !entry.handle.is_finished())
    }

    /// 当前活跃（已登记且未结束）任务数。
    pub fn active_count(&self) -> usize {
        self.lock()
            .tasks
            .values()
            .filter(|e| !e.handle.is_finished())
            .count()
    }

    /// 解除登记（无论任务是否结束）。键不存在返回 false。
    /// **纪律约束：仅用于已完成条目的清理**——移除运行中任务＝放弃管理权
    /// （JoinHandle drop 即 detach，任务继续执行但不可取消不可观测，
    /// 等于绕过 registry 制造裸任务）；需要停止运行中任务请先 cancel。
    pub fn remove(&self, key: &str) -> bool {
        self.lock().tasks.remove(key).is_some()
    }

    /// 清理已结束任务的登记项，返回移除数（finished task cleanup）。
    pub fn cleanup_finished(&self) -> usize {
        let mut inner = self.lock();
        let before = inner.tasks.len();
        inner.tasks.retain(|_, entry| !entry.handle.is_finished());
        before - inner.tasks.len()
    }

    /// 停止接受新任务（shutdown 序列第一步）。幂等。
    pub fn close(&self) {
        self.lock().closed = true;
    }

    /// 等待全部任务退出；超过 `timeout` 对未退出者 abort 强退
    /// （不得因单任务卡死挂起）。返回 (正常退出数, 强退数)。
    /// abort 在任务下一 await 点终止，本函数不等待强退任务的收尾。
    pub async fn wait_all(&self, timeout: Duration) -> (usize, usize) {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            {
                let inner = self.lock();
                let stuck: Vec<&TaskEntry> = inner
                    .tasks
                    .values()
                    .filter(|e| !e.handle.is_finished())
                    .collect();
                if stuck.is_empty() {
                    // completed 含序列开始前已完成未清理的条目（登记快照语义）
                    return (inner.tasks.len(), 0);
                }
                if tokio::time::Instant::now() >= deadline {
                    let stuck_count = stuck.len();
                    for entry in stuck {
                        entry.handle.abort();
                    }
                    return (inner.tasks.len() - stuck_count, stuck_count);
                }
            }
            tokio::time::sleep(Duration::from_millis(
                crate::constants::SHUTDOWN_POLL_INTERVAL_MS,
            ))
            .await;
        }
    }
}

/// 统一 Shutdown 序列：停止接受新任务 → cancel_all →
/// 等待退出（SHUTDOWN_TIMEOUT_MS 超时强退）→ flush 日志 → 关闭 SQLite 连接池。
/// 结果状态经 tracing 落日志；退出码 0 由调用方 `app.exit(0)` 保证。
/// DB 初始化失败的应用实例 pool 为空，只走任务清理与日志 flush。
pub async fn shutdown(registry: &TaskRegistry, pool: Option<&sqlx::SqlitePool>) {
    registry.close();
    let cancelled = registry.cancel_all();
    let timeout = Duration::from_millis(crate::constants::SHUTDOWN_TIMEOUT_MS);
    let (completed, aborted) = registry.wait_all(timeout).await;
    tracing::info!(
        cancelled,
        completed,
        aborted,
        timeout_ms = crate::constants::SHUTDOWN_TIMEOUT_MS,
        "task registry drained"
    );
    crate::services::logging::shutdown_flush();
    if let Some(pool) = pool {
        pool.close().await;
        tracing::info!("sqlite pool closed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// 轮询等待任务退出（测试辅助；不持 registry 锁）
    async fn wait_idle(registry: &TaskRegistry, timeout: Duration) {
        let deadline = tokio::time::Instant::now() + timeout;
        while registry.active_count() > 0 {
            assert!(
                tokio::time::Instant::now() < deadline,
                "task did not finish in time"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    #[tokio::test]
    async fn spawn_registers_and_reports_running() {
        let registry = TaskRegistry::new();
        registry
            .spawn("test:1", |token| async move {
                token.cancelled().await;
            })
            .unwrap();
        assert!(registry.is_running("test:1"));
        assert_eq!(registry.active_count(), 1);
    }

    #[tokio::test]
    async fn duplicate_key_is_rejected() {
        let registry = TaskRegistry::new();
        registry
            .spawn("test:1", |token| async move {
                token.cancelled().await;
            })
            .unwrap();
        let err = registry
            .spawn("test:1", |token| async move {
                token.cancelled().await;
            })
            .unwrap_err();
        assert_eq!(err.code, "TASK_KEY_EXISTS");
        // 原任务不受影响
        assert!(registry.is_running("test:1"));
    }

    #[tokio::test]
    async fn cancel_notifies_task_and_cleanup_removes_entry() {
        let registry = TaskRegistry::new();
        let ran = Arc::new(AtomicUsize::new(0));
        let ran_clone = ran.clone();
        registry
            .spawn("test:1", |token| async move {
                // 取消感知任务的标准形态：select 挂起等待
                token.cancelled().await;
                ran_clone.fetch_add(1, Ordering::SeqCst);
            })
            .unwrap();

        assert!(registry.cancel("test:1"));
        wait_idle(&registry, Duration::from_secs(2)).await;
        assert_eq!(ran.load(Ordering::SeqCst), 1, "任务应感知取消并执行收尾");
        assert!(!registry.is_running("test:1"), "完成后未清理也应报不在运行");

        // finished task cleanup：清理已完成条目
        assert_eq!(registry.cleanup_finished(), 1);
        assert_eq!(registry.active_count(), 0);
        assert!(!registry.is_running("test:1"));
    }

    #[tokio::test]
    async fn double_cancel_is_idempotent() {
        let registry = TaskRegistry::new();
        registry
            .spawn("test:1", |token| async move {
                token.cancelled().await;
            })
            .unwrap();
        assert!(registry.cancel("test:1"));
        assert!(registry.cancel("test:1"), "二次取消返回 true 且无害");
        assert!(!registry.cancel("nonexistent:1"), "不存在键返回 false");
        wait_idle(&registry, Duration::from_secs(2)).await;
    }

    #[tokio::test]
    async fn cancel_all_drains_active_count_to_zero() {
        let registry = TaskRegistry::new();
        for i in 0..5 {
            registry
                .spawn(&format!("test:{i}"), |token| async move {
                    token.cancelled().await;
                })
                .unwrap();
        }
        assert_eq!(registry.cancel_all(), 5);
        wait_idle(&registry, Duration::from_secs(2)).await;
        // 终态：cancel_all() → active task count == 0
        assert_eq!(registry.active_count(), 0);
    }

    #[tokio::test]
    async fn remove_unregisters_entry() {
        let registry = TaskRegistry::new();
        registry
            .spawn("test:1", |token| async move {
                token.cancelled().await;
            })
            .unwrap();
        assert!(registry.remove("test:1"));
        assert!(!registry.remove("test:1"));
        assert!(!registry.is_running("test:1"));
        registry.cancel_all();
    }

    #[tokio::test]
    async fn closed_registry_rejects_new_spawn() {
        let registry = TaskRegistry::new();
        registry.close();
        let err = registry
            .spawn("test:1", |token| async move {
                token.cancelled().await;
            })
            .unwrap_err();
        assert_eq!(err.code, "SHUTDOWN_IN_PROGRESS");
        registry.close(); // 幂等
    }

    #[tokio::test]
    async fn wait_all_aborts_stuck_task_without_hanging() {
        let registry = TaskRegistry::new();
        // 卡死任务：不感知 token、长 sleep（生产对应卡死的 HTTP 请求）
        registry
            .spawn("stuck:1", |_token| async move {
                tokio::time::sleep(Duration::from_secs(600)).await;
            })
            .unwrap();
        registry
            .spawn("good:1", |token| async move {
                token.cancelled().await;
            })
            .unwrap();

        registry.close();
        registry.cancel_all();
        // 测试超时远小于 SHUTDOWN_TIMEOUT_MS（5000）以验证超时路径本身
        let (completed, aborted) = registry.wait_all(Duration::from_millis(100)).await;
        assert_eq!(completed, 1, "good 任务应正常退出");
        assert_eq!(aborted, 1, "stuck 任务应被强退");
        // 强退后调用不挂起（abort 即返回）
        assert_eq!(
            registry.active_count(),
            1,
            "强退任务需在下一 await 点才真正终止"
        );
    }

    #[tokio::test]
    async fn shutdown_sequence_drains_everything() {
        let registry = TaskRegistry::new();
        for i in 0..3 {
            registry
                .spawn(&format!("test:{i}"), |token| async move {
                    token.cancelled().await;
                })
                .unwrap();
        }
        shutdown(&registry, None).await;
        assert_eq!(registry.active_count(), 0);
        let err = registry
            .spawn("after:1", |token| async move {
                token.cancelled().await;
            })
            .unwrap_err();
        assert_eq!(err.code, "SHUTDOWN_IN_PROGRESS");
    }
}
