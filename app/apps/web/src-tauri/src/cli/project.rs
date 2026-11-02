//! `apilot project` 命令组：工作空间概要（缺省＝当前工作空间，
//! `--workspace` 可指定目标空间）。工作空间是逻辑容器——无 path 字段；
//! environments 是目标工作空间的变量分类计数（全局分类不归属任何
//! 工作空间，不计入）；workflows 为本空间工作流实数。

use clap::Args;
use clap::Subcommand;
use serde::Serialize;

use super::output::Output;
use crate::app_context::AppContext;
use crate::error::AppError;
use crate::infrastructure::endpoint_repo;
use crate::infrastructure::variable_repo;
use crate::infrastructure::workflow_repo;

#[derive(Debug, Args)]
pub(crate) struct ProjectCommand {
    #[command(subcommand)]
    pub(super) command: ProjectSub,
}

#[derive(Debug, Subcommand)]
pub(super) enum ProjectSub {
    /// 输出当前工作空间概要（名称、BaseUrl、实体计数）
    Info,
}

/// `project info` 的 data 值（JSON 形态即契约）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectInfo {
    pub name: String,
    pub base_url: Option<String>,
    pub apis: i64,
    pub workflows: i64,
    pub environments: i64,
}

/// `apilot project info`：解析目标工作空间（缺省＝当前）→ 概要输出。
pub(crate) async fn info(ctx: &AppContext, out: &Output, ws: Option<&str>) -> Result<(), AppError> {
    let workspace = super::resolve_workspace(ctx, ws).await?;
    let apis = endpoint_repo::count_by_workspace(&ctx.db.pool, &workspace.id).await?;
    let workflows = workflow_repo::count_by_workspace(&ctx.db.pool, &workspace.id).await?;
    let environments =
        variable_repo::count_workspace_categories(&ctx.db.pool, &workspace.id).await?;
    let info = ProjectInfo {
        name: workspace.name.clone(),
        base_url: workspace.base_url.clone(),
        apis,
        workflows,
        environments,
    };
    let entries = [
        ("name", info.name.clone()),
        (
            "base_url",
            info.base_url.clone().unwrap_or_else(|| "null".into()),
        ),
        ("apis", info.apis.to_string()),
        ("workflows", info.workflows.to_string()),
        ("environments", info.environments.to_string()),
    ];
    out.success_kv(&info, &entries);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试专用临时目录（不引 tempfile 依赖，stdlib 组合即可）。
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "apilot2-cli-project-test-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn info_counts_endpoints_and_environments_across_services() {
        let dir = temp_dir("counts");
        let ctx = AppContext::new(dir.clone()).await.unwrap();
        let pool = &ctx.db.pool;
        let (ws,): (String,) = sqlx::query_as("SELECT id FROM workspaces LIMIT 1")
            .fetch_one(pool)
            .await
            .unwrap();
        crate::infrastructure::service_repo::test_support::seed_service(pool, "s1", &ws, "服务A")
            .await;
        crate::infrastructure::service_repo::test_support::seed_service(pool, "s2", &ws, "服务B")
            .await;
        crate::infrastructure::endpoint_repo::test_support::seed_endpoint(pool, "s1", "e1", "一")
            .await;
        crate::infrastructure::endpoint_repo::test_support::seed_endpoint(pool, "s2", "e2", "二")
            .await;
        // 变量分类：两个空间分类＋一个全局行（全局不计入工作空间计数）
        crate::infrastructure::variable_repo::test_support::seed_category(pool, "vc1", &ws, "开发")
            .await;
        crate::infrastructure::variable_repo::test_support::seed_category(pool, "vc2", &ws, "测试")
            .await;
        crate::infrastructure::variable_repo::test_support::seed_global_category(
            pool, "g1", "全局",
        )
        .await;

        let workspace = crate::cli::resolve_workspace(&ctx, None).await.unwrap();
        assert_eq!(workspace.name, "默认工作空间");
        assert_eq!(workspace.base_url, None);
        assert_eq!(
            endpoint_repo::count_by_workspace(pool, &workspace.id)
                .await
                .unwrap(),
            2
        );
        assert_eq!(
            variable_repo::count_workspace_categories(pool, &workspace.id)
                .await
                .unwrap(),
            2,
            "environments＝本空间变量分类实数（全局行不计入）"
        );
        // workflows 计数实数（工作流随建随计）
        assert_eq!(
            workflow_repo::count_by_workspace(pool, &workspace.id)
                .await
                .unwrap(),
            0
        );
        crate::services::workflow::create(pool, &workspace.id, "链")
            .await
            .unwrap();
        assert_eq!(
            workflow_repo::count_by_workspace(pool, &workspace.id)
                .await
                .unwrap(),
            1
        );

        ctx.db.pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
