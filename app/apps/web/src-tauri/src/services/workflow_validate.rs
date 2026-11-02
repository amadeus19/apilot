//! 工作流执行前校验编排与稳定键引用解析单点。
//!
//! 职责边界：domain `workflow_validation` 是纯函数判定核；本文件承载两类
//! 共用编排——执行前校验（解析预取 ＋ domain 调用；`workflow.validate`
//! 命令、execute 拦截与 CLI validate 共用入口，无第二实现）与稳定键引用
//! 解析（`resolve_endpoint` / `resolve_endpoint_hits`：执行引擎与校验预取
//! 共用命中语义，0 / 1 / 多命中的分歧在此收口）。

use std::collections::HashMap;

use sqlx::SqlitePool;

use crate::domain::endpoint::Endpoint;
use crate::domain::service::Service;
use crate::domain::workflow::WorkflowGraph;
use crate::domain::workflow_validation::{EndpointResolution, WorkflowIssue, validate_workflow};
use crate::error::codes::ENDPOINT_AMBIGUOUS;
use crate::error::{AppError, codes};
use crate::infrastructure::{endpoint_repo, service_repo};
use crate::services::workflow::get_or_not_found;

/// 稳定键 → 命中接口列表（工作空间内跨服务解析单点：引用纯键无服务维度，
/// 0 / 1 / 多命中的语义由调用方定——执行链多命中即报错，校验预取多命中
/// 即失效面）。错误码字面经本函数兜底构造，调用方不重复拼装。
pub async fn resolve_endpoint_hits(
    pool: &SqlitePool,
    workspace_id: &str,
    endpoint_key: &str,
) -> Result<Vec<(Service, Endpoint)>, AppError> {
    let services = service_repo::list_by_workspace(pool, workspace_id).await?;
    let mut hits: Vec<(Service, Endpoint)> = Vec::new();
    for service in &services {
        if let Some(endpoint) = endpoint_repo::get(pool, &service.id, endpoint_key).await? {
            hits.push((service.clone(), endpoint));
        }
    }
    Ok(hits)
}

/// 编辑会话校验入口：graph 传 Some 时校验传入图（未保存的编辑态），None
/// 校验落库图。返回全部问题（空表＝通过）。
pub async fn validate(
    pool: &SqlitePool,
    id: &str,
    graph: Option<&WorkflowGraph>,
) -> Result<Vec<WorkflowIssue>, AppError> {
    let row = get_or_not_found(pool, id).await?;
    let graph = match graph {
        Some(graph) => graph.clone(),
        None => crate::services::workflow::parse_or_graph_invalid(&row.graph, &row.id)?,
    };
    let resolutions = prefetch_endpoint_resolutions(pool, &row.workspace_id, &graph).await?;
    Ok(validate_workflow(&graph, &resolutions))
}

/// 执行拦截入口（engine execute 调用）：工作流已确认存在、图已确认可解析
/// 的前提下跑全清单校验。
pub async fn validate_for_execution(
    pool: &SqlitePool,
    workspace_id: &str,
    graph: &WorkflowGraph,
) -> Result<Vec<WorkflowIssue>, AppError> {
    let resolutions = prefetch_endpoint_resolutions(pool, workspace_id, graph).await?;
    Ok(validate_workflow(graph, &resolutions))
}

/// 图内全部请求引用键的解析预取（逐键跨服务查库；图规模有限，顺序即可）。
async fn prefetch_endpoint_resolutions(
    pool: &SqlitePool,
    workspace_id: &str,
    graph: &WorkflowGraph,
) -> Result<HashMap<String, EndpointResolution>, AppError> {
    let mut resolutions = HashMap::new();
    for key in crate::domain::workflow::referenced_endpoint_keys(graph) {
        let hits = resolve_endpoint_hits(pool, workspace_id, &key).await?;
        resolutions.insert(
            key,
            match hits.len() {
                0 => EndpointResolution::NotFound,
                1 => EndpointResolution::Found,
                _ => EndpointResolution::Ambiguous,
            },
        );
    }
    Ok(resolutions)
}

/// 引擎执行链的稳定键解析（命中唯一即返回；0 / 多命中的错误构造收口到
/// 命中语义单点）。
pub async fn resolve_endpoint(
    pool: &SqlitePool,
    workspace_id: &str,
    endpoint_key: &str,
) -> Result<(Service, Endpoint), AppError> {
    let hits = resolve_endpoint_hits(pool, workspace_id, endpoint_key).await?;
    match hits.len() {
        0 => Err(AppError::new(
            codes::ENDPOINT_NOT_FOUND,
            format!("endpoint not found: {endpoint_key}"),
        )),
        1 => Ok(hits.into_iter().next().expect("len checked")),
        _ => {
            let candidates: Vec<String> = hits
                .iter()
                .map(|(service, _)| service.name.clone())
                .collect();
            Err(AppError::new(
                ENDPOINT_AMBIGUOUS,
                format!("endpoint key is ambiguous across services: {endpoint_key}"),
            )
            .with_details(serde_json::json!({ "candidates": candidates })))
        }
    }
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
        crate::infrastructure::service_repo::test_support::seed_service(&pool, "s1", "w1", "服务")
            .await;
        seed_endpoint(&pool, "s1", "GET /healthz", "健康检查").await;
        pool
    }

    async fn seed_endpoint(pool: &SqlitePool, service_id: &str, key: &str, title: &str) {
        let (method, path) = key.split_once(' ').unwrap();
        let definition = crate::domain::endpoint::Definition::new(
            crate::domain::endpoint::HttpMethod::parse(method).unwrap(),
            path,
        )
        .unwrap();
        crate::infrastructure::endpoint_repo::test_support::seed_endpoint_with_definition(
            pool, service_id, key, definition, title,
        )
        .await;
    }

    fn graph_with_key(key: Option<&str>) -> WorkflowGraph {
        WorkflowGraph {
            schema_version: crate::domain::workflow::GRAPH_SCHEMA_VERSION,
            nodes: vec![
                WorkflowNode {
                    id: "start".into(),
                    name: String::new(),
                    position: Position { x: 0.0, y: 0.0 },
                    config: WorkflowNodeConfig::Start,
                },
                WorkflowNode {
                    id: "req".into(),
                    name: String::new(),
                    position: Position { x: 1.0, y: 0.0 },
                    config: WorkflowNodeConfig::Request(RequestNodeConfig {
                        endpoint_key: key.map(str::to_owned),
                        ..Default::default()
                    }),
                },
                WorkflowNode {
                    id: "end".into(),
                    name: String::new(),
                    position: Position { x: 2.0, y: 0.0 },
                    config: WorkflowNodeConfig::End,
                },
            ],
            edges: vec![
                WorkflowEdge {
                    id: "e1".into(),
                    source: "start".into(),
                    target: "req".into(),
                    label: None,
                },
                WorkflowEdge {
                    id: "e2".into(),
                    source: "req".into(),
                    target: "end".into(),
                    label: None,
                },
            ],
        }
    }

    /// 编排链：落库图校验（预取命中）全绿；失效引用经预取报 requestInvalidRef。
    #[tokio::test]
    async fn validate_prefetches_endpoint_resolutions() {
        let pool = seeded_pool().await;
        let service = crate::services::workflow::create(&pool, "w1", "链")
            .await
            .unwrap();
        let graph = graph_with_key(Some("GET /healthz"));
        crate::services::workflow::save(&pool, &service.id, &graph)
            .await
            .unwrap();
        let issues = validate(&pool, &service.id, None).await.unwrap();
        assert!(issues.is_empty(), "命中引用全绿: {issues:?}");

        // 失效引用：落库图含不存在的键
        let graph = graph_with_key(Some("GET /gone"));
        crate::services::workflow::save(&pool, &service.id, &graph)
            .await
            .unwrap();
        let issues = validate(&pool, &service.id, None).await.unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].code,
            crate::domain::workflow_validation::issue_codes::REQUEST_INVALID_REF
        );
        assert_eq!(issues[0].node_id.as_deref(), Some("req"));
    }

    /// 传入图优先于落库图（编辑会话未保存编辑态的校验面）；工作流不存在
    /// 转 WORKFLOW_NOT_FOUND。
    #[tokio::test]
    async fn validate_prefers_passed_graph_and_reports_not_found() {
        let pool = seeded_pool().await;
        let service = crate::services::workflow::create(&pool, "w1", "链")
            .await
            .unwrap();
        // 落库图缺 Start；传入图健全——校验传入图应全绿
        let broken = WorkflowGraph::empty();
        crate::services::workflow::save(&pool, &service.id, &broken)
            .await
            .unwrap();
        let issues = validate(
            &pool,
            &service.id,
            Some(&graph_with_key(Some("GET /healthz"))),
        )
        .await
        .unwrap();
        assert!(issues.is_empty(), "传入图优先: {issues:?}");
        // 不传图时校验落库图：缺 Start 暴露
        let issues = validate(&pool, &service.id, None).await.unwrap();
        assert_eq!(
            issues[0].code,
            crate::domain::workflow_validation::issue_codes::MISSING_START
        );

        let err = validate(&pool, "nope", None).await.unwrap_err();
        assert_eq!(err.code, codes::WORKFLOW_NOT_FOUND);
    }

    /// 未绑定请求报 requestUnbound（预取不查库——空键无解析面）。
    #[tokio::test]
    async fn validate_reports_unbound_request() {
        let pool = seeded_pool().await;
        let service = crate::services::workflow::create(&pool, "w1", "链")
            .await
            .unwrap();
        crate::services::workflow::save(&pool, &service.id, &graph_with_key(None))
            .await
            .unwrap();
        let issues = validate(&pool, &service.id, None).await.unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].code,
            crate::domain::workflow_validation::issue_codes::REQUEST_UNBOUND
        );
    }

    /// resolve_endpoint：唯一命中返回；多服务撞车报 ENDPOINT_AMBIGUOUS。
    #[tokio::test]
    async fn resolve_endpoint_reports_ambiguity() {
        let pool = seeded_pool().await;
        let (service, _) = resolve_endpoint(&pool, "w1", "GET /healthz").await.unwrap();
        assert_eq!(service.id, "s1");

        // 第二服务同键（撞车面）
        crate::infrastructure::service_repo::test_support::seed_service(
            &pool,
            "s2",
            "w1",
            "服务二",
        )
        .await;
        seed_endpoint(&pool, "s2", "GET /healthz", "重复键").await;
        let err = resolve_endpoint(&pool, "w1", "GET /healthz")
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::ENDPOINT_AMBIGUOUS);

        let err = resolve_endpoint(&pool, "w1", "GET /gone")
            .await
            .unwrap_err();
        assert_eq!(err.code, codes::ENDPOINT_NOT_FOUND);
    }

    /// 失效 → 同稳定键回归导入 → 校验自动恢复全绿（失效是解析派生态：
    /// 同一份图重校验即翻转，无需手工修图）。
    #[tokio::test]
    async fn invalid_ref_recovers_after_endpoint_reimport() {
        let pool = seeded_pool().await;
        let service = crate::services::workflow::create(&pool, "w1", "链")
            .await
            .unwrap();
        crate::services::workflow::save(&pool, &service.id, &graph_with_key(Some("GET /gone")))
            .await
            .unwrap();
        let issues = validate(&pool, &service.id, None).await.unwrap();
        assert_eq!(
            issues[0].code,
            crate::domain::workflow_validation::issue_codes::REQUEST_INVALID_REF
        );

        seed_endpoint(&pool, "s1", "GET /gone", "回归接口").await;
        let issues = validate(&pool, &service.id, None).await.unwrap();
        assert!(issues.is_empty(), "重导入后解析命中即恢复: {issues:?}");
    }

    /// 保存不被校验拦截：含多类错误（缺 Start＋未绑定请求）的图照常落库
    /// 且读回一致——保存通道只要求反序列化合法，语义校验归执行前校验器。
    #[tokio::test]
    async fn save_not_blocked_by_validation() {
        let pool = seeded_pool().await;
        let service = crate::services::workflow::create(&pool, "w1", "含错保存")
            .await
            .unwrap();
        let mut broken = WorkflowGraph::empty();
        broken.nodes.push(WorkflowNode {
            id: "req".into(),
            name: String::new(),
            position: Position { x: 0.0, y: 0.0 },
            config: WorkflowNodeConfig::Request(RequestNodeConfig::default()),
        });
        let saved = crate::services::workflow::save(&pool, &service.id, &broken)
            .await
            .unwrap();
        assert_eq!(saved.graph.nodes.len(), 1, "含错图照常保存");
        let reloaded = crate::services::workflow::load(&pool, &service.id)
            .await
            .unwrap();
        assert_eq!(reloaded.graph.nodes.len(), 1, "读回一致");

        // 保存成功不等于校验通过：校验面同时报出两题
        let issues = validate(&pool, &service.id, None).await.unwrap();
        let found: Vec<&str> = issues.iter().map(|issue| issue.code.as_str()).collect();
        assert!(
            found.contains(&crate::domain::workflow_validation::issue_codes::MISSING_START),
            "{issues:?}"
        );
        assert!(
            found.contains(&crate::domain::workflow_validation::issue_codes::REQUEST_UNBOUND),
            "{issues:?}"
        );
    }
}
