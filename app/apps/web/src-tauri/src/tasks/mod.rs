//! 任务子系统：TaskRegistry 与统一 Shutdown 序列。

pub mod registry;

use std::time::Duration;

pub use registry::{TaskRegistry, shutdown};

/// 日志运行期巡检的任务键（诊断可观测：registry 活跃任务里应能见到它）
pub const LOG_PRUNE_TASK_KEY: &str = "log:prune";

/// 可达性探测启动轮的任务键
pub const PROBE_STARTUP_TASK_KEY: &str = "probe:startup";

/// 可达性探测手动全量刷新的任务键（同键在途时再触发无害——registry 拒绝
/// 重复登记，前端状态照常经事件回流）
pub const PROBE_REFRESH_ALL_TASK_KEY: &str = "probe:refresh_all";

/// 可达性探测联动重探（单服务）的任务键：同服务在途时再触发被 registry
/// 拒绝（无害——在途任务的探测即将回流状态）；已完成的同键残留由下一次
/// 触发解除重登（见 `ProbeService::refresh_in_background`）。
pub fn probe_refresh_task_key(service_id: &str) -> String {
    format!("probe:refresh:{service_id}")
}

/// 可达性探测启动轮：后台对全部服务探测一次（有界并发），不阻塞应用
/// 启动。DB 未就绪（启动失败面）时静默跳过——探测是尽力事实，状态留
/// 「未知」等手动刷新。注册失败只可能因 shutdown 已启动，同样无害。
pub fn spawn_probe_startup(state: tauri::State<'_, crate::AppState>) {
    let Ok(db) = state.db.as_ref().map_err(Clone::clone) else {
        return;
    };
    let pool = db.pool.clone();
    let probe = state.probe.clone();
    let _ = state
        .tasks
        .spawn(PROBE_STARTUP_TASK_KEY, |token| async move {
            let services = match crate::infrastructure::service_repo::list_all(&pool).await {
                Ok(services) => services,
                Err(err) => {
                    tracing::warn!(error = %err, "probe startup: list services failed");
                    return;
                }
            };
            let done = probe.probe_all(&pool, services, &token).await;
            tracing::debug!(done, "probe startup round finished");
        });
}

/// 日志份数运行期巡检：注册常驻任务，按间隔清理超过保留上限的滚动文件——
/// 长驻会话（桌面工具常态）跨日滚动后旧份数仍能有界，不必等下次启动。
/// 目录在会话内固定（日志目录切换重启生效）；启动期已清过一轮，任务先睡
/// 后清。注册失败只可能因 shutdown 已启动，此时巡检本身也不再需要。
pub fn spawn_log_prune(registry: &TaskRegistry, log_dir: std::path::PathBuf) {
    spawn_log_prune_with_interval(
        registry,
        log_dir,
        Duration::from_millis(crate::constants::LOG_PRUNE_INTERVAL_MS),
    );
}

/// 间隔可注入的巡检装配（测试用短间隔驱动滚动清理）
pub(crate) fn spawn_log_prune_with_interval(
    registry: &TaskRegistry,
    log_dir: std::path::PathBuf,
    interval: Duration,
) {
    let _ = registry.spawn(LOG_PRUNE_TASK_KEY, |token| async move {
        loop {
            tokio::select! {
                _ = token.cancelled() => break,
                _ = tokio::time::sleep(interval) => {
                    let removed = crate::services::logging::prune_old_logs(&log_dir);
                    if removed > 0 {
                        tracing::debug!(removed, "runtime log prune");
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 运行期巡检：注入短间隔，模拟长驻会话滚动出超限文件后仍被清理；
    /// 取消后任务退出（受 registry 管理，shutdown 可排空）
    #[tokio::test]
    async fn log_prune_task_bounds_file_count_at_runtime() {
        let dir = std::env::temp_dir().join(format!("apilot-prune-runtime-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // 造 20 份超上限的滚动文件（清理逻辑本身由 logging 单测覆盖，
        // 此处验证的是巡检循环的驱动与取消）
        for day in 1..=20 {
            std::fs::write(dir.join(format!("apilot.log.2026-02-{day:02}")), b"log").unwrap();
        }

        let registry = TaskRegistry::new();
        spawn_log_prune_with_interval(&registry, dir.clone(), Duration::from_millis(20));
        tokio::time::sleep(Duration::from_millis(120)).await;

        let remain: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            remain.len(),
            crate::constants::MAX_LOG_FILES,
            "长驻会话的滚动文件应被巡检收敛到保留上限"
        );

        // 取消后退出：shutdown 序列可排空（不悬挂）
        shutdown(&registry, None).await;
        assert!(!registry.is_running(LOG_PRUNE_TASK_KEY));
        std::fs::remove_dir_all(&dir).ok();
    }
}
