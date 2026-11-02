//! 发送装配编排单点：合成 → 认证值解析 → 认证注入 → 脱敏提示装配。
//!
//! [`SpawnedSend::compose_send`] 覆盖装配全链：任务输入投影为字段装配面，
//! SynthesisInput 十字段构造收敛于 assembly 模块单点——普通发送
//! （`run_once`）与 SSE 流（`run_sse_stream`）两路共用；工作流节点发送
//! 经 assembly 模块（预取＋字段装配单点）复用同一装配链。`compose`
//! 纯函数（不接触任务体系、事件流与存储），可脱离任务体系直接单测。

use crate::domain::variable::EffectiveVariable;
use crate::domain::variable_resolver::{ResolutionHit, merge_secret_values, resolve_auth_json};
use crate::error::AppError;
use crate::services::http::auth::{AuthInput, RedactionHints, apply_auth};
use crate::services::http::request::{RequestModel, SynthesisOutput};

use super::SpawnedSend;

/// 发送装配产物（自足返回结构）。
#[derive(Debug)]
pub(crate) struct ComposedSend {
    /// 认证注入后的引擎输入模型（URL 已含认证派生 query，headers 已含认证头）
    pub model: RequestModel,
    /// 脱敏提示：认证派生的敏感头名 / query 键＋Secret 消费清单（展示与
    /// 输出面对请求镜像全文替换掩码；快照本体仍存明文）
    pub redactions: RedactionHints,
    /// 本次发送全部模板命中记录（合成 → 请求级认证值 → 工作空间级认证值，
    /// 按此顺序保序；含未命中记录）
    pub hits: Vec<ResolutionHit>,
}

/// 发送装配编排（纯函数）：在合成产物之上解析两级认证值 → 注入认证 →
/// 装配脱敏提示。
///
/// 认证值解析按白名单字段（bearer·token / basic·username·password /
/// apiKey·value）；非法 JSON 原样透传——配置错误归 apply_auth fail-fast，
/// 解析层不吞认证配置错误。两级认证的解析无条件执行（命中记录与 Secret
/// 消费值全部并入，注入与否由认证继承链判定，两者互不影响）。
pub(crate) fn compose(
    synthesis: SynthesisOutput,
    request_auth: Option<&str>,
    workspace_auth: Option<&str>,
    variables: &[EffectiveVariable],
) -> Result<ComposedSend, AppError> {
    let SynthesisOutput {
        mut model,
        mut hits,
        mut secret_values,
    } = synthesis;
    let request_auth_resolved = request_auth.map(|raw| resolve_auth_json(raw, variables));
    let workspace_auth_resolved = workspace_auth.map(|raw| resolve_auth_json(raw, variables));
    for resolved in [&request_auth_resolved, &workspace_auth_resolved] {
        let Some(resolved) = resolved else { continue };
        hits.extend(resolved.hits.iter().cloned());
        merge_secret_values(&mut secret_values, resolved.secret_values());
    }
    let auth_input = AuthInput {
        request_auth: request_auth_resolved.as_ref().map(|r| r.text.as_str()),
        workspace_auth: workspace_auth_resolved.as_ref().map(|r| r.text.as_str()),
    };
    let mut redactions = apply_auth(&mut model, &auth_input)?;
    // Secret 消费清单并入 redactions（展示与输出面对请求镜像全文替换掩码；
    // 快照本体仍存明文）
    redactions.secret_values = secret_values;
    Ok(ComposedSend {
        model,
        redactions,
        hits,
    })
}

impl SpawnedSend {
    /// 发送装配全链：任务输入投影为字段装配面 → SynthesisInput 十字段
    /// 构造（assembly 单点）→ 合成 → 认证值解析 → 认证注入 → 脱敏提示。
    /// 普通发送与 SSE 流两路共用的装配入口；工作流节点发送经 assembly
    /// 模块复用同一装配单点。
    pub(super) fn compose_send(&self) -> Result<ComposedSend, AppError> {
        super::assembly::compose_request(super::assembly::AssemblyFace {
            definition: &self.definition,
            base_url: self.base_url.as_deref(),
            base_url_override: self.base_url_override.as_deref(),
            user_body: self.user_body.as_deref(),
            user_params: &self.user_params,
            user_headers: &self.user_headers,
            path_override: self.path_override.as_deref(),
            method_override: self.method_override.as_deref(),
            overrides: &self.overrides,
            variables: &self.variables,
            request_auth: self.request_auth.as_deref(),
            workspace_auth: self.workspace_auth.as_deref(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::endpoint::HttpMethod;
    use crate::domain::user_data_codec::KvRow;
    use crate::domain::variable::VariableSource;
    use crate::error::codes;
    use crate::services::http::request::BodyKind;

    fn var(key: &str, value: &str, secret: bool) -> EffectiveVariable {
        EffectiveVariable {
            key: key.to_owned(),
            value: value.to_owned(),
            secret,
            source: VariableSource::Active,
        }
    }

    fn hit(key: &str, resolved: &str, is_hit: bool, secret: bool) -> ResolutionHit {
        ResolutionHit {
            template: format!("{{{{{key}}}}}"),
            key: key.to_owned(),
            resolved: resolved.to_owned(),
            hit: is_hit,
            secret,
        }
    }

    fn synthesis(hits: Vec<ResolutionHit>, secret_values: Vec<String>) -> SynthesisOutput {
        SynthesisOutput {
            model: RequestModel {
                method: HttpMethod::GET,
                url: "http://x.test/api".to_string(),
                headers: vec![KvRow::new("X-Env", "smoke")],
                body: BodyKind::None,
            },
            hits,
            secret_values,
        }
    }

    /// 无认证：合成产物原样透传（模型不动、命中与 Secret 清单不丢）
    #[test]
    fn compose_without_auth_keeps_synthesis_artifacts() {
        let vars = vec![var("sk", "s1", true)];
        let output = compose(
            synthesis(vec![hit("sk", "s1", true, true)], vec!["s1".to_owned()]),
            None,
            None,
            &vars,
        )
        .unwrap();
        assert_eq!(output.model.url, "http://x.test/api");
        assert_eq!(output.model.headers.len(), 1, "不注入认证头");
        assert_eq!(output.redactions.header_names, Vec::<String>::new());
        assert_eq!(output.redactions.secret_values, vec!["s1".to_owned()]);
        assert_eq!(output.hits.len(), 1);
        assert_eq!(output.hits[0].key, "sk");
    }

    /// 两级认证值解析：命中按「合成 → 请求级 → 工作空间级」保序并入；
    /// 注入按继承链只取请求级（解析与注入互不影响）；Secret 清单去重
    #[test]
    fn compose_resolves_both_auth_levels_merging_hits_in_order() {
        let vars = vec![
            var("env", "smoke", false),
            var("tok", "tk", true),
            var("user", "ada", false),
        ];
        let output = compose(
            synthesis(vec![hit("env", "smoke", true, false)], Vec::new()),
            Some(r#"{"type":"bearer","token":"{{tok}}"}"#),
            Some(r#"{"type":"basic","username":"{{user}}","password":"{{tok}}"}"#),
            &vars,
        )
        .unwrap();
        // 命中顺序：合成 → 请求级 token → 工作空间级 username·password
        let keys: Vec<&str> = output.hits.iter().map(|h| h.key.as_str()).collect();
        assert_eq!(keys, vec!["env", "tok", "user", "tok"]);
        // 注入只按继承链取请求级（bearer 压过工作空间 basic）
        assert!(
            output
                .model
                .headers
                .iter()
                .any(|r| r.key == "Authorization" && r.value == "Bearer tk")
        );
        assert_eq!(
            output.redactions.header_names,
            vec!["Authorization".to_owned()]
        );
        // Secret 清单：请求级与工作空间级消费同一 tok 值，去重为一条
        assert_eq!(output.redactions.secret_values, vec!["tk".to_owned()]);
    }

    /// 跨路去重：合成与认证值消费同一 Secret 值，清单只留一条
    #[test]
    fn compose_dedupes_secret_values_across_synthesis_and_auth() {
        let vars = vec![var("sk", "s1", true)];
        let output = compose(
            synthesis(vec![hit("sk", "s1", true, true)], vec!["s1".to_owned()]),
            Some(r#"{"type":"bearer","token":"{{sk}}"}"#),
            None,
            &vars,
        )
        .unwrap();
        assert_eq!(output.redactions.secret_values, vec!["s1".to_owned()]);
        assert_eq!(output.hits.len(), 2, "命中记录不去重（各位置消费逐条记录）");
    }

    /// 认证配置非法：解析层原样透传，apply_auth fail-fast 归构建失败
    #[test]
    fn compose_fails_fast_on_invalid_auth_json() {
        let err = compose(
            synthesis(Vec::new(), Vec::new()),
            Some(r#"{"type":"bearer","token":"{{tok}""#),
            None,
            &[var("tok", "tk", true)],
        )
        .unwrap_err();
        assert_eq!(err.code, codes::HTTP_SYNTHESIS_INVALID);

        let unsupported = compose(
            synthesis(Vec::new(), Vec::new()),
            Some(r#"{"type":"oauth2"}"#),
            None,
            &[],
        )
        .unwrap_err();
        assert_eq!(unsupported.code, codes::HTTP_SYNTHESIS_INVALID);
    }

    /// 认证值未命中模板：字面透传注入（不吞占位符），命中记录含未命中项
    #[test]
    fn compose_keeps_unresolved_auth_template_literal() {
        let output = compose(
            synthesis(Vec::new(), Vec::new()),
            Some(r#"{"type":"bearer","token":"{{missing}}"}"#),
            None,
            &[],
        )
        .unwrap();
        assert!(
            output
                .model
                .headers
                .iter()
                .any(|r| r.key == "Authorization" && r.value == "Bearer {{missing}}")
        );
        assert_eq!(output.hits.len(), 1);
        assert!(!output.hits[0].hit);
        assert!(
            output.redactions.secret_values.is_empty(),
            "未命中不入 Secret 清单"
        );
    }

    // —— compose_send 直测（SpawnedSend 全链装配面）——
    // 任务输入构造：pool / client 等执行面字段不被装配触碰，取惰性占位。

    async fn spawned_send(
        request_auth: Option<String>,
        workspace_auth: Option<String>,
        variables: Vec<EffectiveVariable>,
        user_params: &str,
    ) -> SpawnedSend {
        SpawnedSend {
            pool: crate::db::connect_in_memory().await,
            run_id: "run_test".to_owned(),
            workspace_id: "w1".to_owned(),
            service_id: "s1".to_owned(),
            endpoint_key: "GET /api".to_owned(),
            source: crate::domain::run_record::RunSource::Gui,
            task_key: "http:tab:test".to_owned(),
            tab_id: None,
            sink: None,
            definition: crate::domain::endpoint::Definition::new(HttpMethod::GET, "/api").unwrap(),
            base_url: Some("http://x.test".to_owned()),
            base_url_override: None,
            variables,
            request_auth,
            workspace_auth,
            user_body: None,
            user_params: user_params.to_owned(),
            user_headers: "[]".to_owned(),
            path_override: None,
            method_override: None,
            overrides: crate::services::http::request::SendOverrides::default(),
            client: reqwest::Client::new(),
            timeout_global: None,
            timeout_endpoint: None,
            sink_root: None,
            preview_only: true,
        }
    }

    /// 透传：无认证时合成产物原样——URL＝BaseUrl＋路径＋query（params 值列
    /// 变量解析）、不注入认证头、命中与 Secret 清单保序带回
    #[tokio::test]
    async fn compose_send_passes_synthesis_through_without_auth() {
        let input = spawned_send(
            None,
            None,
            vec![var("env", "smoke", false), var("sk", "s1", true)],
            r#"[{"name":"env","value":"{{env}}"},{"name":"key","value":"{{sk}}"}]"#,
        )
        .await;
        let output = input.compose_send().unwrap();
        assert_eq!(output.model.url, "http://x.test/api?env=smoke&key=s1");
        assert!(
            output
                .model
                .headers
                .iter()
                .all(|r| r.key != "Authorization")
        );
        assert_eq!(output.redactions.header_names, Vec::<String>::new());
        assert_eq!(output.redactions.secret_values, vec!["s1".to_owned()]);
        let keys: Vec<(&str, bool, bool)> = output
            .hits
            .iter()
            .map(|h| (h.key.as_str(), h.hit, h.secret))
            .collect();
        assert_eq!(keys, vec![("env", true, false), ("sk", true, true)]);
    }

    /// 认证注入＋脱敏清单：注入按继承链取请求级（bearer 压过工作空间
    /// basic），两级解析无条件并入（命中保序、Secret 清单去重）
    #[tokio::test]
    async fn compose_send_injects_auth_and_collects_redactions() {
        let input = spawned_send(
            Some(r#"{"type":"bearer","token":"{{tok}}"}"#.to_owned()),
            Some(r#"{"type":"basic","username":"{{user}}","password":"{{tok}}"}"#.to_owned()),
            vec![var("tok", "tk", true), var("user", "ada", false)],
            "[]",
        )
        .await;
        let output = input.compose_send().unwrap();
        assert!(
            output
                .model
                .headers
                .iter()
                .any(|r| r.key == "Authorization" && r.value == "Bearer tk")
        );
        assert_eq!(
            output.redactions.header_names,
            vec!["Authorization".to_owned()]
        );
        assert_eq!(output.redactions.secret_values, vec!["tk".to_owned()]);
        let keys: Vec<&str> = output.hits.iter().map(|h| h.key.as_str()).collect();
        assert_eq!(keys, vec!["tok", "user", "tok"]);
    }

    /// 工作空间级继承：请求级未配置时注入工作空间级认证
    #[tokio::test]
    async fn compose_send_inherits_workspace_auth_when_request_level_absent() {
        let input = spawned_send(
            None,
            Some(r#"{"type":"bearer","token":"{{tok}}"}"#.to_owned()),
            vec![var("tok", "tk", true)],
            "[]",
        )
        .await;
        let output = input.compose_send().unwrap();
        assert!(
            output
                .model
                .headers
                .iter()
                .any(|r| r.key == "Authorization" && r.value == "Bearer tk")
        );
        assert_eq!(output.redactions.secret_values, vec!["tk".to_owned()]);
    }
}
