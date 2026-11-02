//! `apilot run` 命令组：工作流执行记录的状态查询。本组仅余 status——
//! 接口 Run Record 的历史查询子命令（get / result / list）已下架、查询
//! 归 GUI History，不在本组恢复。
//!
//! 语义边界：执行记录只落终态（在途状态经事件流实时推送，不落库——避免
//! 阻塞进程被杀后残留幻影 running 行）。CLI `workflow run` 恒阻塞至终态，
//! 本命令用于事后回收终态记录（阻塞进程被杀后查结局、跨终端查 GUI 已
//! 完成的执行）；在途执行无库内留痕，查询未命中即 `RUN_NOT_FOUND`
//! （exit 3）。只查工作流执行（`wexec_` 前缀身份），操作范围缺省当前
//! 工作空间、`--workspace` 可指定（未指定空间内的跨空间 id 与不存在
//! 同语义）。

use clap::Args;
use clap::Subcommand;
use serde::Serialize;

use super::output::Output;
use crate::app_context::AppContext;
use crate::error::AppError;
use crate::services::workflow;

#[derive(Debug, Args)]
pub(crate) struct RunCommand {
    #[command(subcommand)]
    pub(super) command: RunSub,
}

#[derive(Debug, Subcommand)]
pub(super) enum RunSub {
    /// 查询工作流执行的终态记录
    Status {
        /// 执行 id（`workflow run` 输出的 runId，`wexec_` 前缀）
        #[arg(value_name = "RUN_ID")]
        run_id: String,
    },
}

/// `run status` 的 data 值（JSON 形态即契约；轻量元信息，全量逐节点明细
/// 归 `workflow run` 输出与 GUI 回看面板）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunStatus {
    pub run_id: String,
    pub workflow_id: String,
    /// passed / failed / cancelled（执行记录只落终态）
    pub status: String,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub error_code: Option<String>,
}

/// `apilot run status <run_id>`：按执行 id 查终态记录（作用域过滤与
/// not-found 错误转换归 Service 单点：跨空间执行与不存在同报
/// `RUN_NOT_FOUND`，不泄露存在性）。
pub(crate) async fn status(
    ctx: &AppContext,
    out: &Output,
    ws: Option<&str>,
    run_id: &str,
) -> Result<(), AppError> {
    let workspace = super::resolve_workspace(ctx, ws).await?;
    let exec = workflow::get_execution_in_workspace(&ctx.db.pool, run_id, &workspace.id).await?;
    let info = RunStatus {
        run_id: exec.id,
        workflow_id: exec.workflow_id,
        status: exec.status,
        started_at: exec.started_at,
        completed_at: exec.completed_at,
        duration_ms: exec.duration_ms,
        error_code: exec.error_code,
    };
    let entries = [
        ("run_id", info.run_id.clone()),
        ("workflow_id", info.workflow_id.clone()),
        ("status", info.status.clone()),
        ("started_at", info.started_at.clone()),
        (
            "completed_at",
            info.completed_at.clone().unwrap_or_else(|| "null".into()),
        ),
        (
            "duration_ms",
            info.duration_ms
                .map(|ms| ms.to_string())
                .unwrap_or_else(|| "null".into()),
        ),
        (
            "error_code",
            info.error_code.clone().unwrap_or_else(|| "null".into()),
        ),
    ];
    out.success_kv(&info, &entries);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::workflow_execution::{
        NodeExecutionRecord, STATUS_PASSED, WorkflowExecution,
    };
    use crate::infrastructure::workflow_execution_repo as repo;

    /// 测试专用临时目录（不引 tempfile 依赖，stdlib 组合即可）。
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("apilot2-cli-run-test-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn seed_terminal_record(pool: &sqlx::SqlitePool, workflow_id: &str) {
        let exec = WorkflowExecution {
            id: "wexec_TEST00000000000000000000".into(),
            workflow_id: workflow_id.to_owned(),
            status: STATUS_PASSED.to_owned(),
            started_at: "2026-10-25T00:00:00Z".into(),
            completed_at: Some("2026-10-25T00:00:01Z".into()),
            duration_ms: Some(1000),
            error_code: None,
            error_message: None,
            nodes: vec![NodeExecutionRecord {
                node_id: "start".into(),
                status: STATUS_PASSED.to_owned(),
                started_at: None,
                completed_at: None,
                duration_ms: None,
                error_code: None,
                error_message: None,
                output: None,
                request: None,
                response: None,
                writebacks: Vec::new(),
                assertions: Vec::new(),
            }],
        };
        repo::upsert(pool, &exec).await.unwrap();
    }

    /// 空间限定查询：本空间命中、他空间执行与未知 id 同为 None
    /// （run status 层转 RUN_NOT_FOUND，不泄露存在性）。
    #[tokio::test]
    async fn get_by_id_in_workspace_scopes_by_workspace() {
        let dir = temp_dir("status-scope");
        let ctx = AppContext::new(dir.clone()).await.unwrap();
        let pool = &ctx.db.pool;
        let (ws,): (String,) = sqlx::query_as("SELECT id FROM workspaces LIMIT 1")
            .fetch_one(pool)
            .await
            .unwrap();
        let created = workflow::create(pool, &ws, "链").await.unwrap();
        seed_terminal_record(pool, &created.id).await;

        let hit = repo::get_by_id_in_workspace(pool, "wexec_TEST00000000000000000000", &ws)
            .await
            .unwrap()
            .expect("本空间执行应命中");
        assert_eq!(hit.workflow_id, created.id);
        assert_eq!(hit.status, STATUS_PASSED);

        assert!(
            repo::get_by_id_in_workspace(pool, "wexec_TEST00000000000000000000", "w-other")
                .await
                .unwrap()
                .is_none(),
            "跨空间 id 与不存在同语义"
        );
        assert!(
            repo::get_by_id_in_workspace(pool, "wexec_MISSING", &ws)
                .await
                .unwrap()
                .is_none()
        );

        ctx.db.pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
