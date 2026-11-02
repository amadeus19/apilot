//! 工作流引用反查：「稳定键 → 引用它的工作流清单」（删除接口的反向提示
//! 与同步向导「将删除」计数的数据源）。
//!
//! 扫描面：工作空间内全部工作流逐条解析图、收集引用稳定键求交（纯函数
//! 收集核在 domain `referenced_endpoint_keys`）。损坏图跳过不炸——反查
//! 是提示面，宁可少列不阻断；引用计数不落库（派生态，随图实时）。

use std::collections::BTreeMap;

use serde::Serialize;
use sqlx::SqlitePool;

use crate::domain::workflow::referenced_endpoint_keys;
use crate::error::AppError;
use crate::infrastructure::workflow_repo;

/// 单工作流的引用留痕（id 定位 + 名称展示）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRefUsage {
    pub workflow_id: String,
    pub workflow_name: String,
}

/// 稳定键 → 引用工作流清单（工作空间内全量扫描；未列入结果表的键＝无
/// 引用，调用方按零处理）。
pub async fn endpoint_usage(
    pool: &SqlitePool,
    workspace_id: &str,
    keys: &[String],
) -> Result<BTreeMap<String, Vec<WorkflowRefUsage>>, AppError> {
    let wanted: std::collections::BTreeSet<&str> = keys.iter().map(String::as_str).collect();
    let mut usage: BTreeMap<String, Vec<WorkflowRefUsage>> = BTreeMap::new();
    for row in workflow_repo::list_by_workspace(pool, workspace_id).await? {
        let Ok(graph) = crate::domain::workflow::parse_graph(&row.graph) else {
            continue;
        };
        let referenced = referenced_endpoint_keys(&graph);
        let usage_row = WorkflowRefUsage {
            workflow_id: row.id,
            workflow_name: row.name,
        };
        for key in referenced {
            if wanted.contains(key.as_str()) {
                usage.entry(key).or_default().push(usage_row.clone());
            }
        }
    }
    Ok(usage)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::domain::workflow::{
        Position, RequestNodeConfig, WorkflowEdge, WorkflowNode, WorkflowNodeConfig,
    };
    use sqlx::SqlitePool;

    async fn seeded_pool() -> SqlitePool {
        let pool = db::connect_in_memory().await;
        db::run_migrations(&pool).await.unwrap();
        crate::infrastructure::workspace_repo::test_support::seed_workspace(&pool, "w1", "空间")
            .await;
        crate::infrastructure::workspace_repo::test_support::seed_workspace(&pool, "w2", "别家")
            .await;
        pool
    }

    async fn seed_workflow(
        pool: &SqlitePool,
        workspace_id: &str,
        name: &str,
        keys: &[Option<&str>],
    ) -> String {
        let nodes = std::iter::once(WorkflowNode {
            id: "start".into(),
            name: String::new(),
            position: Position { x: 0.0, y: 0.0 },
            config: WorkflowNodeConfig::Start,
        })
        .chain(
            keys.into_iter()
                .enumerate()
                .map(|(index, key)| WorkflowNode {
                    id: format!("n{index}"),
                    name: String::new(),
                    position: Position {
                        x: index as f64 + 1.0,
                        y: 0.0,
                    },
                    config: WorkflowNodeConfig::Request(RequestNodeConfig {
                        endpoint_key: key.map(str::to_owned),
                        ..Default::default()
                    }),
                }),
        )
        .collect::<Vec<_>>();
        let edges = (0..nodes.len() - 1)
            .map(|index| WorkflowEdge {
                id: format!("e{index}"),
                source: nodes[index].id.clone(),
                target: nodes[index + 1].id.clone(),
                label: None,
            })
            .collect();
        let created = crate::services::workflow::create(pool, workspace_id, name)
            .await
            .unwrap();
        crate::services::workflow::save(
            pool,
            &created.id,
            &crate::domain::workflow::WorkflowGraph {
                schema_version: crate::domain::workflow::GRAPH_SCHEMA_VERSION,
                nodes,
                edges,
            },
        )
        .await
        .unwrap();
        created.id
    }

    /// 多工作流 × 多键的反查矩阵：命中键列出全部引用工作流，未引用键缺表，
    /// 其他空间的工作流不串。
    #[tokio::test]
    async fn usage_maps_keys_to_referencing_workflows() {
        let pool = seeded_pool().await;
        let a = seed_workflow(&pool, "w1", "链A", &[Some("GET /a"), Some("GET /shared")]).await;
        let b = seed_workflow(&pool, "w1", "链B", &[Some("GET /shared")]).await;
        let _c = seed_workflow(&pool, "w1", "无引用", &[None]).await;
        let _d = seed_workflow(&pool, "w2", "别家链", &[Some("GET /shared")]).await;

        let usage = endpoint_usage(
            &pool,
            "w1",
            &[
                "GET /shared".to_owned(),
                "GET /a".to_owned(),
                "GET /unused".to_owned(),
            ],
        )
        .await
        .unwrap();
        assert_eq!(usage["GET /shared"].len(), 2, "同空间两条链都引用");
        // 同键两条引用的返回顺序无确定性保证（创建时间同精度），按集合断言
        let shared_ids: Vec<&str> = usage["GET /shared"]
            .iter()
            .map(|row| row.workflow_id.as_str())
            .collect();
        assert!(shared_ids.contains(&a.as_str()), "链A 在引用集合中");
        assert!(shared_ids.contains(&b.as_str()), "链B 在引用集合中");
        assert_eq!(usage["GET /a"][0].workflow_name, "链A");
        assert!(!usage.contains_key("GET /unused"), "无引用键不进结果表");
        assert!(
            !usage["GET /shared"]
                .iter()
                .any(|row| row.workflow_name == "别家链"),
            "跨空间不串"
        );
    }

    /// 损坏图跳过不炸：反查照常返回其余工作流的引用。
    #[tokio::test]
    async fn corrupt_graph_is_skipped() {
        let pool = seeded_pool().await;
        seed_workflow(&pool, "w1", "好链", &[Some("GET /a")]).await;
        let broken = seed_workflow(&pool, "w1", "坏链", &[]).await;
        crate::infrastructure::workflow_repo::save_graph(&pool, &broken, "{broken")
            .await
            .unwrap();
        let usage = endpoint_usage(&pool, "w1", &["GET /a".to_owned()])
            .await
            .unwrap();
        assert_eq!(usage["GET /a"].len(), 1, "坏链跳过，好链照常列出");
    }
}
