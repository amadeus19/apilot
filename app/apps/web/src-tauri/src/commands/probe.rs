//! 可达性探测 IPC 命令（probe.*）：状态快照与手动全量刷新。
//!
//! 探测状态进程内存态（不落库），UI 消费口径＝初始 `probe.list` 快照＋
//! 之后全程 `probe://status` 事件（不轮询）。手动刷新入口＝全量刷新
//! （接口树底部计数行）；同步拉取完成、手动建 / 改服务后的联动重探在
//! 服务层 `refresh_in_background` 接续（不经 IPC）。

use tauri::State;

use crate::AppState;
use crate::error::AppError;
use crate::services::probe::ProbeState;

/// probe.list：全部已记录的探测状态快照（未记录的服务＝未知，前端兜底）。
#[tauri::command(rename = "probe.list")]
pub async fn probe_list(state: State<'_, AppState>) -> Result<Vec<ProbeState>, AppError> {
    Ok(state.probe.snapshot())
}

/// probe.refresh_all：手动全量刷新（接口树底部计数行入口）。批量面走
/// TaskRegistry 登记；状态经 `probe://status` 事件回流，本命令
/// fire-and-forget 不等待全量完成。上一次全量刷新仍在途时静默吸收
/// （在途轮即将回流全部状态，再触发无增益）；已完成的同键残留先解除
/// 再登记（任务完成后条目不自动移除——不清理则第二次全量刷新被
/// TASK_KEY_EXISTS 永久拒绝，入口表现成「只能点一次」）。
#[tauri::command(rename = "probe.refresh_all")]
pub async fn probe_refresh_all(state: State<'_, AppState>) -> Result<(), AppError> {
    let db = state.db.as_ref().map_err(Clone::clone)?;
    let key = crate::tasks::PROBE_REFRESH_ALL_TASK_KEY;
    if state.tasks.is_running(key) {
        return Ok(());
    }
    state.tasks.remove(key);
    let services = crate::infrastructure::service_repo::list_all(&db.pool).await?;
    let probe = state.probe.clone();
    let pool = db.pool.clone();
    let _ = state.tasks.spawn(key, |token| async move {
        probe.probe_all(&pool, services, &token).await;
    });
    Ok(())
}
