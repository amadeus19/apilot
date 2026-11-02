//! 发送装配缝：预取三步（工作空间 → 接口 → 用户数据）＋生效变量集与
//! SynthesisInput 十字段装配的唯一现场。
//!
//! 调用方差异全部经装配请求参数化：普通发送先解析当前空间再传显式
//! workspace_id、按服务内键直查接口、无执行内变量；工作流请求节点携带
//! 执行空间、按稳定键跨服务解析接口、注入执行内变量层（节点输出 ＞
//! 工作流变量 ＞ 生效变量集）。spawn 任务体（普通发送与 SSE 流）不重复
//! 预取——任务输入已持有装配产物，直接投影为字段装配输入走单点。
//!
//! 认证继承（两级认证值解析与注入）与超时口径（接口级覆写 ＞ 全局档）
//! 在 crate 内各只有一份实现；本模块吸收全部装配调用面，装配口径变更
//! 不再出现第二处手写序列。生效集逐节点现取（执行期写回改变生效集时
//! 此口径不变），不在本模块缓存。

use std::collections::BTreeMap;

use sqlx::SqlitePool;

use crate::domain::endpoint::Definition;
use crate::domain::user_data::EndpointUserData;
use crate::domain::variable::EffectiveVariable;
use crate::domain::workflow_execution::{ExecutionVariable, merge_execution_variables};
use crate::error::AppError;
use crate::error::codes;
use crate::infrastructure::{endpoint_repo, user_data_repo, workspace_repo};
use crate::services::http::request::{SendOverrides, SynthesisInput, synthesize};
use crate::services::variable::load_effective;
use crate::services::workflow_validate;

use super::compose::{ComposedSend, compose};

/// 接口用户数据的发送面提取（普通发送与工作流请求节点同口径）：body /
/// 参数行 / 头行原样；路径与方法覆写空白串视同未覆写（与写侧归一同
/// 口径）；另携请求级认证与接口级超时。
pub(crate) struct UserDataSendFace {
    pub body: Option<String>,
    pub params: String,
    pub headers: String,
    /// 路径覆写（None＝跟随接口定义）
    pub path_override: Option<String>,
    /// 方法覆写（None＝跟随接口定义；非空归一大写）
    pub method_override: Option<String>,
    pub auth: Option<String>,
    pub timeout_seconds: Option<i64>,
}

impl UserDataSendFace {
    /// 从接口用户数据提取发送面（None＝接口无用户数据，行集取空缺省）。
    pub(crate) fn extract(user_data: Option<&EndpointUserData>) -> Self {
        let (params, headers) = match user_data {
            Some(d) => (d.params.clone(), d.headers.clone()),
            None => ("[]".to_string(), "[]".to_string()),
        };
        Self {
            body: user_data.and_then(|d| d.body.clone()),
            params,
            headers,
            path_override: user_data
                .and_then(|d| d.path_override.clone())
                .map(|p| p.trim().to_owned())
                .filter(|p| !p.is_empty()),
            method_override: user_data
                .and_then(|d| d.method_override.clone())
                .map(|m| m.trim().to_ascii_uppercase())
                .filter(|m| !m.is_empty()),
            auth: user_data.and_then(|d| d.auth.clone()),
            timeout_seconds: user_data.and_then(|d| d.timeout_seconds),
        }
    }
}

/// 发送前装配结果（预取三步＋变量解析的产物面；普通发送与 SSE 流的
/// spawn 任务体直接持有，工作流请求节点就地消费）。
#[derive(Debug)]
pub(crate) struct AssembledSend {
    pub workspace_id: String,
    pub definition: Definition,
    pub base_url: Option<String>,
    /// 生效变量集（Resolver 输入：兜底链合成，GUI / CLI / 预览同一来源；
    /// 注入执行内变量层时＝铺层合成后的最终解析输入）
    pub variables: Vec<EffectiveVariable>,
    pub workspace_auth: Option<String>,
    pub user_body: Option<String>,
    pub user_params: String,
    pub user_headers: String,
    /// 路径覆写（用户数据层；None／空白＝跟随接口定义）
    pub path_override: Option<String>,
    /// 方法覆写（用户数据层；None／空白＝跟随接口定义）
    pub method_override: Option<String>,
    pub timeout_endpoint: Option<i64>,
    pub request_auth: Option<String>,
}

/// 接口身份定位（调用方差异之一）。
pub(crate) enum EndpointRef<'a> {
    /// 服务内键直查（普通发送链：请求携带服务身份）
    InService { service_id: &'a str, key: &'a str },
    /// 工作空间内跨服务解析稳定键（工作流请求节点链：引用纯键不含服务
    /// 维度，多服务撞车＝ENDPOINT_AMBIGUOUS）
    StableKey { key: &'a str },
}

/// 执行内变量层（工作流执行持有；引擎在锁内取值复制后注入，guard 不跨
/// await 持有）。`node_outputs` 为消费节点的可见层：其直接上游节点输出桶
/// 按边序并集后的平铺键值（连线作用域，由引擎就地合成后传入）。
pub(crate) struct ExecutionLayer {
    pub workflow_vars: BTreeMap<String, ExecutionVariable>,
    pub node_outputs: BTreeMap<String, ExecutionVariable>,
}

/// 发送装配请求（调用方差异的参数化表达面）。
pub(crate) struct AssembleRequest<'a> {
    /// 目标工作空间（显式传入：普通发送由调用方先解析当前空间，工作流
    /// 节点携带执行空间——装配不感知「当前空间」隐式态）
    pub workspace_id: &'a str,
    /// 接口身份定位
    pub endpoint: EndpointRef<'a>,
    /// 执行内变量层（普通发送＝None）
    pub execution: Option<ExecutionLayer>,
}

/// 发送前预取（工作空间 / 接口 / 用户数据 ＋ 生效变量集与执行内层合并；
/// 不落库的失败：查不到即拒绝）。
pub(crate) async fn assemble(
    pool: &SqlitePool,
    req: AssembleRequest<'_>,
) -> Result<AssembledSend, AppError> {
    let workspace = workspace_repo::get(pool, req.workspace_id)
        .await?
        .ok_or_else(|| {
            AppError::new(
                codes::WORKSPACE_NOT_FOUND,
                format!("workspace not found: {}", req.workspace_id),
            )
        })?;
    let (_service_id, endpoint_key, endpoint) = match req.endpoint {
        EndpointRef::InService { service_id, key } => {
            let endpoint = endpoint_repo::get(pool, service_id, key)
                .await?
                .ok_or_else(|| {
                    AppError::new(
                        codes::ENDPOINT_NOT_FOUND,
                        format!("endpoint not found: {key}"),
                    )
                })?;
            (service_id.to_owned(), key.to_owned(), endpoint)
        }
        EndpointRef::StableKey { key } => {
            let (service, endpoint) =
                workflow_validate::resolve_endpoint(pool, req.workspace_id, key).await?;
            // 解析命中的 endpoint.key 即请求键本身，直接取请求键避免移出
            (service.id, key.to_owned(), endpoint)
        }
    };
    let definition: Definition = serde_json::from_str(&endpoint.definition).map_err(|e| {
        AppError::new(
            codes::INTERNAL,
            format!("endpoint definition corrupted: {e}"),
        )
    })?;
    let user_data = user_data_repo::get(pool, &_service_id, &endpoint_key).await?;
    let user_face = UserDataSendFace::extract(user_data.as_ref());
    // 生效变量集随装配预取；执行内层按「节点输出 ＞ 工作流变量 ＞ 生效
    // 变量集」铺层合成（逐节点现取，执行期写回不缓存）
    let effective = load_effective(pool, req.workspace_id).await?;
    let variables = match req.execution {
        None => effective,
        Some(layer) => {
            merge_execution_variables(effective, &layer.workflow_vars, &layer.node_outputs)
        }
    };
    Ok(AssembledSend {
        workspace_id: req.workspace_id.to_owned(),
        definition,
        base_url: workspace.base_url,
        variables,
        workspace_auth: workspace.auth,
        user_body: user_face.body,
        user_params: user_face.params,
        user_headers: user_face.headers,
        path_override: user_face.path_override,
        method_override: user_face.method_override,
        timeout_endpoint: user_face.timeout_seconds,
        request_auth: user_face.auth,
    })
}

/// 字段装配输入（装配产物的借用视图）：SynthesisInput 十字段＋两级认证
/// 的统一供给面。预取产物（AssembledSend）与 spawn 任务输入（SpawnedSend）
/// 各自投影到它，SynthesisInput 的字面构造因此只有一份。
pub(crate) struct AssemblyFace<'a> {
    pub definition: &'a Definition,
    pub base_url: Option<&'a str>,
    /// 接口级 BaseUrl 覆写（GUI Tab 会话态；CLI 与工作流节点＝None）
    pub base_url_override: Option<&'a str>,
    pub user_body: Option<&'a str>,
    pub user_params: &'a str,
    pub user_headers: &'a str,
    pub path_override: Option<&'a str>,
    pub method_override: Option<&'a str>,
    pub overrides: &'a SendOverrides,
    pub variables: &'a [EffectiveVariable],
    pub request_auth: Option<&'a str>,
    pub workspace_auth: Option<&'a str>,
}

/// 字段装配单点：SynthesisInput 十字段构造（crate 内唯一现场）→ 合成 →
/// 两级认证值解析 → 认证注入 → 脱敏提示（认证继承链在 compose 单点）。
pub(crate) fn compose_request(face: AssemblyFace<'_>) -> Result<ComposedSend, AppError> {
    let synthesis = synthesize(&SynthesisInput {
        definition: face.definition,
        base_url: face.base_url,
        base_url_override: face.base_url_override,
        user_body: face.user_body,
        user_params: face.user_params,
        user_headers: face.user_headers,
        path_override: face.path_override,
        method_override: face.method_override,
        overrides: face.overrides,
        variables: face.variables,
    })?;
    compose(
        synthesis,
        face.request_auth,
        face.workspace_auth,
        face.variables,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::domain::endpoint::HttpMethod;
    use sqlx::SqlitePool;

    async fn memory_pool() -> SqlitePool {
        let pool = db::connect_in_memory().await;
        db::run_migrations(&pool).await.unwrap();
        pool
    }

    /// 种子：空间 w1（BaseUrl 指向不可达地址，装配不发请求无需可达）＋
    /// 服务 s1 ＋ 稳定键接口 GET /healthz ＋ 激活分类变量 env=smoke。
    async fn seed(pool: &SqlitePool) {
        crate::infrastructure::workspace_repo::test_support::seed_workspace(pool, "w1", "空间")
            .await;
        crate::infrastructure::workspace_repo::update(
            pool,
            "w1",
            "空间",
            Some("http://127.0.0.1:1"),
        )
        .await
        .unwrap();
        crate::infrastructure::service_repo::test_support::seed_service(pool, "s1", "w1", "服务")
            .await;
        crate::infrastructure::endpoint_repo::test_support::seed_endpoint_with_definition(
            pool,
            "s1",
            "GET /healthz",
            Definition::new(HttpMethod::GET, "/healthz").unwrap(),
            "健康检查",
        )
        .await;
        use crate::infrastructure::variable_repo::test_support as var_support;
        var_support::seed_category(pool, "vc1", "w1", "开发").await;
        var_support::seed_variable(pool, "vc1", "env", "smoke", false).await;
        crate::services::variable::set_active_category(pool, "w1", Some("vc1"))
            .await
            .unwrap();
    }

    fn exec_var(value: &str, secret: bool) -> ExecutionVariable {
        ExecutionVariable {
            value: value.to_owned(),
            secret,
        }
    }

    /// 预取单点（稳定键跨服务解析＋服务内键直查两形态）：产物字段投影
    /// 完整；执行内变量层按「节点输出 ＞ 工作流变量 ＞ 生效变量集」压过
    /// 同名生效键；无执行层时生效集原样。
    #[tokio::test]
    async fn assemble_via_stable_key_and_in_service_with_execution_layer() {
        let pool = memory_pool().await;
        seed(&pool).await;

        // 稳定键跨服务解析＋执行内层注入：工作流变量 env 压过生效集同名键
        let assembled = assemble(
            &pool,
            AssembleRequest {
                workspace_id: "w1",
                endpoint: EndpointRef::StableKey {
                    key: "GET /healthz",
                },
                execution: Some(ExecutionLayer {
                    workflow_vars: BTreeMap::from([("env".to_owned(), exec_var("from-wf", false))]),
                    node_outputs: BTreeMap::from([("status".to_owned(), exec_var("200", false))]),
                }),
            },
        )
        .await
        .unwrap();
        assert_eq!(assembled.workspace_id, "w1");
        assert_eq!(assembled.base_url.as_deref(), Some("http://127.0.0.1:1"));
        assert_eq!(assembled.definition.path_template, "/healthz");
        assert_eq!(assembled.user_params, "[]", "无用户数据时行集空缺省");
        assert_eq!(assembled.request_auth, None);
        assert_eq!(assembled.workspace_auth, None);
        let vars: Vec<(&str, &str)> = assembled
            .variables
            .iter()
            .map(|v| (v.key.as_str(), v.value.as_str()))
            .collect();
        assert!(
            vars.contains(&("env", "from-wf")),
            "执行内工作流变量压过生效集: {vars:?}"
        );
        assert!(vars.contains(&("status", "200")), "节点输出在列: {vars:?}");
        assert_eq!(
            vars.iter().filter(|(k, _)| *k == "env").count(),
            1,
            "同名键铺层去重"
        );

        // 服务内键直查（无执行层）：生效集原样，命中同一接口
        let plain = assemble(
            &pool,
            AssembleRequest {
                workspace_id: "w1",
                endpoint: EndpointRef::InService {
                    service_id: "s1",
                    key: "GET /healthz",
                },
                execution: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(plain.definition.path_template, "/healthz");
        assert!(
            plain
                .variables
                .iter()
                .any(|v| v.key == "env" && v.value == "smoke")
        );
    }

    /// 查找失败不落库不panic：稳定键 0 命中与服务内键未命中同归
    /// ENDPOINT_NOT_FOUND；空间不存在归 WORKSPACE_NOT_FOUND。
    #[tokio::test]
    async fn assemble_rejects_missing_workspace_endpoint_or_stable_key() {
        let pool = memory_pool().await;
        seed(&pool).await;

        let missing_key = assemble(
            &pool,
            AssembleRequest {
                workspace_id: "w1",
                endpoint: EndpointRef::StableKey { key: "GET /gone" },
                execution: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(missing_key.code, codes::ENDPOINT_NOT_FOUND);

        let missing_in_service = assemble(
            &pool,
            AssembleRequest {
                workspace_id: "w1",
                endpoint: EndpointRef::InService {
                    service_id: "s1",
                    key: "GET /gone",
                },
                execution: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(missing_in_service.code, codes::ENDPOINT_NOT_FOUND);

        let missing_workspace = assemble(
            &pool,
            AssembleRequest {
                workspace_id: "w-none",
                endpoint: EndpointRef::StableKey {
                    key: "GET /healthz",
                },
                execution: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(missing_workspace.code, codes::WORKSPACE_NOT_FOUND);
    }
}
