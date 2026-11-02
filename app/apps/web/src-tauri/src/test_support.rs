//! crate 级测试支持（仅 `cfg(test)` 编译）：跨测试模块共用的引擎测试
//! 夹具与图 / 节点构造器。种子助手（workspace / service / endpoint）沿用
//! 各 repo 模块自带的 `test_support`，本模块只做组装。

use std::sync::{Arc, Mutex};

use sqlx::SqlitePool;

use crate::db;
use crate::domain::endpoint::{Definition, HttpMethod};
use crate::domain::workflow::{
    Position, RequestNodeConfig, WorkflowEdge, WorkflowGraph, WorkflowNode, WorkflowNodeConfig,
};
use crate::domain::workflow_execution::{NodeExecutionRecord, WorkflowExecution};
use crate::error::AppError;
use crate::services::workflow_engine::{WorkflowEngineCtx, WorkflowExecutionDto};
use crate::tasks::TaskRegistry;

/// 引擎测试夹具：内存库＋演示靶机＋种子空间 / 服务 / 接口。
pub(crate) struct Fixture {
    pub(crate) pool: SqlitePool,
    pub(crate) http: crate::services::http::HttpService,
    pub(crate) registry: TaskRegistry,
    pub(crate) events: Arc<Mutex<Vec<serde_json::Value>>>,
    pub(crate) target: demo_server::DemoServer,
}

impl Fixture {
    pub(crate) async fn new() -> Self {
        let pool = db::connect_in_memory().await;
        db::run_migrations(&pool).await.unwrap();
        let target = demo_server::spawn_ephemeral().await.unwrap();
        let base = target.base_url();
        crate::infrastructure::workspace_repo::test_support::seed_workspace(&pool, "w1", "空间")
            .await;
        crate::infrastructure::workspace_repo::update(&pool, "w1", "空间", Some(base.as_str()))
            .await
            .unwrap();
        crate::infrastructure::service_repo::test_support::seed_service(&pool, "s1", "w1", "服务")
            .await;
        seed_endpoint(&pool, "GET /healthz", HttpMethod::GET, "/healthz").await;
        seed_endpoint(&pool, "GET /api/slow", HttpMethod::GET, "/api/slow").await;
        seed_endpoint(&pool, "GET /api/flaky", HttpMethod::GET, "/api/flaky").await;
        seed_endpoint(
            &pool,
            "GET /api/error/{status}",
            HttpMethod::GET,
            "/api/error/{status}",
        )
        .await;
        // 登录链集成靶：JWT 登录（响应体 token）与 Bearer 受保护接口
        seed_endpoint(&pool, "POST /auth/login", HttpMethod::POST, "/auth/login").await;
        seed_endpoint(&pool, "GET /auth/me", HttpMethod::GET, "/auth/me").await;
        Self {
            pool,
            http: crate::services::http::HttpService::new(),
            registry: TaskRegistry::new(),
            events: Arc::new(Mutex::new(Vec::new())),
            target,
        }
    }

    pub(crate) fn ctx(&self) -> WorkflowEngineCtx<'_> {
        let events = self.events.clone();
        WorkflowEngineCtx {
            pool: &self.pool,
            registry: &self.registry,
            http: &self.http,
            sink: Some(Arc::new(move |value| {
                events.lock().expect("事件锁").push(value);
            })),
        }
    }

    pub(crate) async fn seed_workflow(&self, name: &str, graph: &WorkflowGraph) -> String {
        let created = crate::services::workflow::create(&self.pool, "w1", name)
            .await
            .unwrap();
        crate::services::workflow::save(&self.pool, &created.id, graph)
            .await
            .unwrap();
        created.id
    }

    /// 给 GET /auth/me 种接口用户数据：授权头随用户数据承担（节点头覆写
    /// 已取消），值携带 `{{token}}` 产物引用（me 的直接上游是提取节点，
    /// 连线作用域内可见）——按调用方需要播种，不播种即无授权（401 反
    /// 证链）。
    pub(crate) async fn seed_me_bearer_auth(&self) {
        sqlx::query(
            "INSERT INTO endpoint_user_data (service_id, key, body, params, headers, updated_at) \
             VALUES ('s1', 'GET /auth/me', NULL, '[]', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        )
        .bind(r#"[{"name":"Authorization","value":"Bearer {{token}}"}]"#)
        .execute(&self.pool)
        .await
        .unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.target.shutdown();
    }
}

pub(crate) async fn seed_endpoint(pool: &SqlitePool, key: &str, method: HttpMethod, path: &str) {
    crate::infrastructure::endpoint_repo::test_support::seed_endpoint_with_definition(
        pool,
        "s1",
        key,
        Definition::new(method, path).unwrap(),
        "样本",
    )
    .await;
}

/// 最小种子内存库（迁移就绪＋工作空间 `w1`；无服务 / 接口种子、无演示
/// 靶机）：纯逻辑直测夹具——不发送 HTTP 的执行器直调面（快照注入与写回
/// 落库仍走真实库；写回链的变量分类外键需要工作空间行存在）。
pub(crate) async fn seeded_memory_pool() -> SqlitePool {
    let pool = db::connect_in_memory().await;
    db::run_migrations(&pool).await.unwrap();
    crate::infrastructure::workspace_repo::test_support::seed_workspace(&pool, "w1", "空间").await;
    pool
}

/// 不指向任何服务的空 Client（执行器直调面：不真正发送请求）。
pub(crate) fn plain_client() -> reqwest::Client {
    reqwest::Client::new()
}

/// 串行链图：Start → 每个键一个请求节点（None＝未绑定占位）→ End，顺序连边。
pub(crate) fn chain_graph(keys: &[Option<&str>]) -> WorkflowGraph {
    let mut nodes = vec![WorkflowNode {
        id: "start".into(),
        name: String::new(),
        position: Position { x: 0.0, y: 0.0 },
        config: WorkflowNodeConfig::Start,
    }];
    let mut edges = Vec::new();
    let mut previous = "start".to_string();
    for (index, key) in keys.iter().enumerate() {
        let id = format!("n{index}");
        nodes.push(WorkflowNode {
            id: id.clone(),
            name: String::new(),
            position: Position {
                x: index as f64 + 1.0,
                y: 0.0,
            },
            config: WorkflowNodeConfig::Request(RequestNodeConfig {
                endpoint_key: key.map(|key| key.to_string()),
                ..Default::default()
            }),
        });
        edges.push(WorkflowEdge {
            id: format!("e{index}"),
            source: previous.clone(),
            target: id.clone(),
            label: None,
        });
        previous = id;
    }
    nodes.push(WorkflowNode {
        id: "end".into(),
        name: String::new(),
        position: Position {
            x: keys.len() as f64 + 1.0,
            y: 0.0,
        },
        config: WorkflowNodeConfig::End,
    });
    edges.push(WorkflowEdge {
        id: format!("e{}", keys.len()),
        source: previous,
        target: "end".into(),
        label: None,
    });
    WorkflowGraph {
        schema_version: crate::domain::workflow::GRAPH_SCHEMA_VERSION,
        nodes,
        edges,
    }
}

/// 事件身份序列（事件名＋节点 / 边标识）：事件相互顺序断言用——
/// 只看事件名会漏掉节点交错与错位推送。
pub(crate) fn event_ids(events: &Mutex<Vec<serde_json::Value>>) -> Vec<String> {
    events
        .lock()
        .expect("事件锁")
        .iter()
        .map(|event| {
            let kind = event["event"].as_str().expect("事件名词段");
            if let Some(id) = event["nodeId"].as_str() {
                format!("{kind}:{id}")
            } else if let Some(id) = event["edgeId"].as_str() {
                format!("{kind}:{id}")
            } else {
                kind.to_string()
            }
        })
        .collect()
}

/// 节点状态查找（按节点 id）。
pub(crate) fn node_status(dto: &WorkflowExecutionDto, id: &str) -> String {
    dto.nodes
        .iter()
        .find(|node| node.node_id == id)
        .unwrap_or_else(|| panic!("节点记录缺失: {id}"))
        .status
        .clone()
}

/// 节点记录查找（按节点 id）。
pub(crate) fn node_record<'a>(dto: &'a WorkflowExecutionDto, id: &str) -> &'a NodeExecutionRecord {
    dto.nodes
        .iter()
        .find(|node| node.node_id == id)
        .unwrap_or_else(|| panic!("节点记录缺失: {id}"))
}

/// 执行拒绝时的问题清单（details.issues；校验拦截断言面）。
pub(crate) fn issues_of(err: &AppError) -> &[serde_json::Value] {
    err.details
        .as_ref()
        .and_then(|details| details["issues"].as_array())
        .map(Vec::as_slice)
        .expect("问题清单应随错误下发")
}

pub(crate) async fn last_record(pool: &SqlitePool, workflow_id: &str) -> WorkflowExecution {
    crate::infrastructure::workflow_execution_repo::get_by_workflow(pool, workflow_id)
        .await
        .unwrap()
        .expect("执行记录应存在")
}

/// 基础节点构造器（测试图共用）。
pub(crate) fn node(id: &str, config: WorkflowNodeConfig) -> WorkflowNode {
    WorkflowNode {
        id: id.to_owned(),
        name: String::new(),
        position: Position { x: 0.0, y: 0.0 },
        config,
    }
}

pub(crate) fn edge(index: usize, source: &str, target: &str) -> WorkflowEdge {
    edge_labeled(index, source, target, None)
}

pub(crate) fn edge_labeled(
    index: usize,
    source: &str,
    target: &str,
    label: Option<&str>,
) -> WorkflowEdge {
    WorkflowEdge {
        id: format!("e{index}"),
        source: source.to_owned(),
        target: target.to_owned(),
        label: label.map(str::to_owned),
    }
}

pub(crate) fn request_node(id: &str, key: &str) -> WorkflowNode {
    node(
        id,
        WorkflowNodeConfig::Request(RequestNodeConfig {
            endpoint_key: Some(key.to_owned()),
            ..Default::default()
        }),
    )
}
