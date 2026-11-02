//! 同步域 IPC 命令（sync.*）：拉取段（拉取 → 归一 → 待应用暂存）与对比段
//! （待应用暂存 vs 已应用代 → 结构化 diff）。
//!
//! 拉取是长期任务：经 TaskRegistry spawn（键形 `sync:fetch:<service_id>`，
//! 与 `http:tab:<id>` 同族约定）、oneshot 通道回传结果、完成后清理登记
//! （与发送链路同形态）。取消＝registry cancel → CancellationToken → 任务
//! 在拉取 / 下载 await 点退出（写入集中在完成后的单事务，取消零副作用）。

// lib.rs 的 invoke_handler 注册行由调度者验收时统一挂载，挂载前命令函数
// 无引用面（commands 模块私有，dead_code 警告因此误报）；挂载后本属性无害。
#![allow(dead_code)]

use tauri::State;

use crate::AppState;
use crate::error::AppError;
use crate::error::codes;
use crate::services::sync_fetch::{self, FetchOutcome};

/// 拉取任务的登记键（一服务一键：同服务重复拉取在旧任务未结束时拒绝）。
fn fetch_task_key(service_id: &str) -> String {
    format!("sync:fetch:{service_id}")
}

/// sync.fetch：对单个服务执行拉取并写待应用暂存（不推进快照代），返回
/// 暂存元信息。结果等待与任务登记同生命周期：命令返回即任务已结束并清理登记。
#[tauri::command(rename = "sync.fetch")]
pub async fn sync_fetch(
    state: State<'_, AppState>,
    service_id: String,
) -> Result<FetchOutcome, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    let key = fetch_task_key(&service_id);
    // 完成未清理的残留条目先解除（remove 仅用于已结束条目的清理纪律）；
    // 仍在运行的旧任务＝同服务拉取进行中，拒绝并发重复拉取
    if state.tasks.is_running(&key) {
        return Err(AppError::new(
            codes::TASK_KEY_EXISTS,
            format!("a fetch is already running for service {service_id}"),
        ));
    }
    state.tasks.remove(&key);

    let pool = db.pool.clone();
    let probe = state.probe.clone();
    // 句柄克隆进任务体：拉取成功后嵌套登记联动重探（probe:refresh:<id>，
    // 子任务生命周期独立，由自己的键回收）
    let tasks = state.tasks.clone();
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<FetchOutcome, AppError>>();
    state.tasks.spawn(&key, move |token| async move {
        // 拉取＋成功后联动重探的业务编排单点在服务层（fetch_and_refresh）
        let outcome =
            sync_fetch::fetch_and_refresh(&pool, &probe, &tasks, &service_id, &token).await;
        let _ = tx.send(outcome);
    })?;
    let outcome = rx
        .await
        .map_err(|_| AppError::internal("fetch task dropped before completion"))?;
    // 完成后清理登记（任务必然已结束；防御式 is_running 检查与发送链路同款）
    if !state.tasks.is_running(&key) {
        state.tasks.remove(&key);
    }
    outcome
}

/// sync.fetch_cancel：取消进行中的拉取（幂等：无进行中任务返回 false）。
/// 取消后等待方收到 `CANCELLED`，暂存、快照与用户数据零变化。
#[tauri::command(rename = "sync.fetch_cancel")]
pub async fn sync_fetch_cancel(
    state: State<'_, AppState>,
    service_id: String,
) -> Result<bool, AppError> {
    Ok(state.tasks.cancel(&fetch_task_key(&service_id)))
}

/// sync.diff：对指定服务执行结构化对比（只读短任务，不经 TaskRegistry）。
/// 前置＝服务已有待应用拉取（拉取段先行）；无待应用拉取返回
/// `SYNC_NO_SNAPSHOT`。
#[tauri::command(rename = "sync.diff")]
pub async fn sync_diff(
    state: State<'_, AppState>,
    service_id: String,
) -> Result<crate::services::sync_diff::DiffOutcome, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    crate::services::sync_diff::diff_service(&db.pool, &service_id).await
}

/// sync.apply：向导确认段的应用事务（徽标 / 删除 / definition
/// 扩容 / 参数与请求体静默对齐；单事务快速本地操作，不经 TaskRegistry；
/// diff 库内重算、不收前端载荷）。`keys`＝接口粒度勾选集（稳定键，缺省
/// 全量）：只落勾选行，徽标重打同口径限定。
#[tauri::command(rename = "sync.apply")]
pub async fn sync_apply(
    state: State<'_, AppState>,
    service_id: String,
    keys: Option<Vec<String>>,
) -> Result<crate::services::sync_apply::ApplyOutcome, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    let outcome =
        crate::services::sync_apply::apply(&db.pool, &service_id, keys.as_deref()).await?;
    // 应用成功后树缓存失效由前端失效策略承担（返回计数供向导完成段呈现）
    Ok(outcome)
}

/// sync.last_synced：工作空间最近一次同步应用时刻（向导头部「上次同步」
/// 呈现；只读短任务）。无任何已应用快照＝null。
#[tauri::command(rename = "sync.last_synced")]
pub async fn sync_last_synced(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<Option<String>, AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    crate::services::sync_status::last_synced_at(&db.pool, &workspace_id).await
}

/// 拉取任务登记键（测试可见）。
pub(crate) fn task_key_for_test(service_id: &str) -> String {
    fetch_task_key(service_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::TaskRegistry;

    /// 键形约定：`sync:fetch:<service_id>`（与 TaskRegistry 登记处文档一致）。
    #[test]
    fn fetch_task_key_shape() {
        assert_eq!(task_key_for_test("s1"), "sync:fetch:s1");
    }

    /// spawn / cancel / 完成清理语义对齐既有用法（快速任务完成后即清理）。
    #[tokio::test]
    async fn registry_spawn_cancel_and_cleanup_semantics() {
        let registry = TaskRegistry::new();
        registry
            .spawn(&task_key_for_test("s1"), |token| async move {
                token.cancelled().await;
            })
            .unwrap();
        assert!(registry.is_running(&task_key_for_test("s1")));
        assert!(registry.cancel(&task_key_for_test("s1")));
        // 等待任务退出后按「完成清理」纪律解除登记
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while registry.is_running(&task_key_for_test("s1")) {
            assert!(
                std::time::Instant::now() < deadline,
                "task did not finish in time"
            );
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        registry.remove(&task_key_for_test("s1"));
        assert!(!registry.is_running(&task_key_for_test("s1")));
        // 幂等取消：无条目返回 false
        assert!(!registry.cancel(&task_key_for_test("s1")));
    }
}
