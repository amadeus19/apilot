//! 接口实体与身份 / 定义不变量。
//!
//! 身份分治：同步接口＝稳定键（`方法 + 空格 + 路由模板`，文档约束），
//! 手工接口＝UUID（方法 / 路径可随意改不丢数据）；两值域物理不撞
//! （稳定键含空格，UUID 含连字符），同步流程不被手工内容阻塞。

use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use crate::constants::MAX_PATH_TEMPLATE_BYTES;
use crate::error::AppError;
use crate::error::codes;

/// HTTP 方法七选。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HttpMethod {
    GET,
    POST,
    PUT,
    PATCH,
    DELETE,
    HEAD,
    OPTIONS,
}

impl HttpMethod {
    /// 大小写不敏感解析；七选之外拒绝（同步文档出现其他方法同样拒绝）。
    pub fn parse(raw: &str) -> Result<Self, AppError> {
        match raw.trim().to_ascii_uppercase().as_str() {
            "GET" => Ok(Self::GET),
            "POST" => Ok(Self::POST),
            "PUT" => Ok(Self::PUT),
            "PATCH" => Ok(Self::PATCH),
            "DELETE" => Ok(Self::DELETE),
            "HEAD" => Ok(Self::HEAD),
            "OPTIONS" => Ok(Self::OPTIONS),
            _ => Err(AppError::new(
                codes::INVALID_HTTP_METHOD,
                format!("http method not allowed: {raw}"),
            )),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::GET => "GET",
            Self::POST => "POST",
            Self::PUT => "PUT",
            Self::PATCH => "PATCH",
            Self::DELETE => "DELETE",
            Self::HEAD => "HEAD",
            Self::OPTIONS => "OPTIONS",
        }
    }
}

/// 接口定义（结构，随身份落 `endpoints.definition`）：方法 + 路径模板
/// ＋可选定义侧文档元数据（同步接口经应用事务写入的扩容面）。
/// 与用户数据（参数值 / 请求头 / 请求体，落 `endpoint_user_data`）严格分界。
///
/// 扩容兼容口径：`doc` 缺席（serde default）＝瘦定义（手工接口与尚未经
/// 同步应用的接口），既有读者只取 method / path_template 不受影响；
/// 写入侧（应用事务）构造完整形态，序列化键序与瘦时代完全兼容。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Definition {
    pub method: HttpMethod,
    pub path_template: String,
    /// 定义侧文档元数据（同步接口专有；文档抽屉与 diff 合并的数据源）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doc: Option<EndpointDoc>,
}

/// 定义侧文档元数据（归一模型子结构的持久化形态；字段语义见
/// `domain::sync::model`，此处持久化容器与其保持同构）。序列化键名与内嵌
/// Unified* 同为 camelCase（前端文档抽屉契约）；`request_body` 的蛇形
/// alias 兼容 camelCase 化之前落库的存量 definition（读侧零迁移）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointDoc {
    pub title: String,
    pub category: Option<String>,
    pub description: Option<String>,
    pub parameters: Vec<crate::domain::sync::model::UnifiedParameter>,
    #[serde(alias = "request_body")]
    pub request_body: Option<crate::domain::sync::model::UnifiedRequestBody>,
    pub responses: Vec<crate::domain::sync::model::UnifiedResponse>,
}

impl Definition {
    pub fn new(method: HttpMethod, path_template: impl Into<String>) -> Result<Self, AppError> {
        let path_template = path_template.into();
        validate_path_template(&path_template)?;
        Ok(Self {
            method,
            path_template,
            doc: None,
        })
    }

    /// 稳定键（同步接口身份）：`方法 + 空格 + 路由模板`，方法恒规范化大写，
    /// 路由模板大小写保留（OpenAPI 路由模板大小写敏感）。
    pub fn stable_key(&self) -> String {
        format!("{} {}", self.method.as_str(), self.path_template)
    }
}

/// 路径模板校验：`/` 开头、不含空白、不含查询串（查询归参数面板）、长度上限。
/// 绝对 URL 形态（`http://` / `https://` 开头）豁免「`/` 开头」约束——完整
/// URL 模板在合成时跳过 BaseUrl 拼接（跨主机请求与未配置 BaseUrl 的发送面），
/// 其余约束（无空白 / 无查询串 / 长度上限）同等适用。
pub fn validate_path_template(path: &str) -> Result<(), AppError> {
    let invalid = |message: String| AppError::new(codes::INVALID_PATH_TEMPLATE, message);
    if path.is_empty() {
        return Err(invalid("path template must not be empty".into()));
    }
    let is_absolute_url = path.starts_with("http://") || path.starts_with("https://");
    if !is_absolute_url && !path.starts_with('/') {
        return Err(invalid(format!(
            "path template must start with '/': {path}"
        )));
    }
    if path.chars().any(char::is_whitespace) {
        return Err(invalid(format!(
            "path template must not contain whitespace: {path}"
        )));
    }
    if path.contains('?') {
        return Err(invalid(format!(
            "path template must not contain a query string: {path}"
        )));
    }
    if path.len() > MAX_PATH_TEMPLATE_BYTES {
        return Err(invalid(format!(
            "path template exceeds {MAX_PATH_TEMPLATE_BYTES} bytes"
        )));
    }
    Ok(())
}

/// 手工接口身份：UUID v4（方法 / 路径可随意改不丢数据）。
pub fn new_manual_identity() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// 手工身份判定：稳定键（同步）必含空格（`方法 + 空格 + 路由模板`），
/// 手工 UUID 恒不含——两值域物理不撞的反向判定。
pub fn is_manual_identity(key: &str) -> bool {
    !key.contains(' ')
}

/// 接口。`badge` 仅同步接口消费；`sort_order` 是 (service_id, category_id)
/// 分组内的手动排序序号。
#[derive(Debug, Clone, FromRow)]
pub struct Endpoint {
    pub service_id: String,
    pub key: String,
    pub title: String,
    pub category_id: Option<String>,
    pub definition: String,
    pub created_at: String,
    pub badge: Option<String>,
    pub sort_order: i64,
}

/// 新建 / 更新手工接口的输入（key 恒 UUID，更新不改身份）。
pub struct ManualEndpointInput {
    pub service_id: String,
    pub key: String,
    pub title: String,
    pub category_id: Option<String>,
    pub definition: Definition,
}

/// 删除级联范围：删除实体时连带清除的数据面，供删除确认语义与事务内
/// 手工级联的对账基准。FK（CASCADE / SET NULL）覆盖的表由 SQLite 兜底；
/// `endpoint_user_data` 与 endpoints 无外键（身份跨表语义），
/// `pinned_endpoints` 在接口 / 服务 / 工作空间删除时由 FK 兜底，
/// 但接口删除路径的两张表都在同一事务内显式清除（不依赖 FK 时序）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CascadeScope {
    /// 连带清除的表（含实体自身表）
    pub tables: &'static [&'static str],
    /// 无外键关联、必须由服务层在同一事务内显式 DELETE 的表
    pub manual_tables: &'static [&'static str],
}

/// 删除级联范围计算（按实体种类）。
pub fn cascade_scope(entity: CascadeEntity) -> CascadeScope {
    match entity {
        CascadeEntity::Workspace => CascadeScope {
            tables: &[
                "workspaces",
                "services",
                "categories",
                "endpoints",
                "endpoint_user_data",
                "pinned_endpoints",
                "workspace_sessions",
            ],
            manual_tables: &["endpoint_user_data"],
        },
        CascadeEntity::Service => CascadeScope {
            tables: &[
                "services",
                "categories",
                "endpoints",
                "endpoint_user_data",
                "pinned_endpoints",
            ],
            manual_tables: &["endpoint_user_data"],
        },
        CascadeEntity::Endpoint => CascadeScope {
            tables: &["endpoints", "endpoint_user_data", "pinned_endpoints"],
            manual_tables: &["endpoint_user_data", "pinned_endpoints"],
        },
        // 分类删除＝接口上移散层（FK SET NULL），不删任何行
        CascadeEntity::Category => CascadeScope {
            tables: &["categories"],
            manual_tables: &[],
        },
    }
}

/// 级联范围计算的作用实体。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CascadeEntity {
    Workspace,
    Service,
    Endpoint,
    Category,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_accepts_seven_methods_case_insensitive() {
        for raw in ["get", "POST", "Put", "patch", "delete", "head", "options"] {
            assert!(HttpMethod::parse(raw).is_ok(), "{raw} should parse");
        }
        assert_eq!(HttpMethod::parse("get").unwrap(), HttpMethod::GET);
        assert_eq!(
            HttpMethod::parse("  OPTIONS  ").unwrap(),
            HttpMethod::OPTIONS
        );
    }

    /// EndpointDoc 序列化恒 camelCase（前端文档抽屉契约），且存量蛇形
    /// definition（request_body 键）经 alias 继续可读——零迁移兼容。
    #[test]
    fn endpoint_doc_serializes_camelcase_and_reads_legacy_snake_case() {
        let doc = EndpointDoc {
            title: "查".into(),
            category: None,
            description: None,
            parameters: Vec::new(),
            request_body: None,
            responses: Vec::new(),
        };
        let json = serde_json::to_value(&doc).unwrap();
        assert!(
            json.get("requestBody").is_some(),
            "序列化键应为驼峰 requestBody"
        );
        assert!(json.get("request_body").is_none(), "不得再写蛇形键");

        // 存量蛇形串（camelCase 化之前落库）读侧 alias 命中
        let legacy: EndpointDoc = serde_json::from_str(
            r#"{"title":"查","parameters":[],"request_body":null,"responses":[]}"#,
        )
        .unwrap();
        assert!(legacy.request_body.is_none());
        let legacy_some: EndpointDoc = serde_json::from_str(
            r#"{"title":"查","parameters":[],"request_body":{"contentType":"application/json","required":true,"schema":{"schemaType":"object","truncated":false,"required":[],"enumValues":[],"properties":[]}},"responses":[]}"#,
        )
        .unwrap();
        assert!(legacy_some.request_body.is_some());
    }

    #[test]
    fn parse_rejects_methods_outside_the_seven() {
        for raw in ["", "GET2", "CONNECT", "TRACE", "fetch", "GRPC"] {
            let err = HttpMethod::parse(raw).unwrap_err();
            assert_eq!(err.code, codes::INVALID_HTTP_METHOD, "{raw}");
        }
    }

    #[test]
    fn definition_builds_and_serializes() {
        let def = Definition::new(HttpMethod::GET, "/users/{id}").unwrap();
        assert_eq!(def.stable_key(), "GET /users/{id}");
        let json = serde_json::to_string(&def).unwrap();
        let back: Definition = serde_json::from_str(&json).unwrap();
        assert_eq!(back, def);
    }

    #[test]
    fn stable_key_normalizes_method_and_keeps_path_case() {
        let def = Definition::new(HttpMethod::POST, "/API/v1/Items").unwrap();
        assert_eq!(def.stable_key(), "POST /API/v1/Items");
    }

    #[test]
    fn path_template_rejects_invalid_shapes() {
        let invalid = [
            "",
            "users",
            " /x",
            "/x y",
            "/x?name=1",
            &"x".repeat(MAX_PATH_TEMPLATE_BYTES + 1),
        ];
        for raw in invalid {
            let err = validate_path_template(raw).unwrap_err();
            assert_eq!(err.code, codes::INVALID_PATH_TEMPLATE, "{raw}");
        }
        assert!(validate_path_template("/a/b/{id}/c").is_ok());
        let edge = format!("/{}", "x".repeat(MAX_PATH_TEMPLATE_BYTES - 1));
        assert!(validate_path_template(&edge).is_ok());
    }

    /// 绝对 URL 模板形态：豁免「`/` 开头」，其余约束（无空白 / 无查询串 /
    /// 长度上限）同等适用；非 http(s) scheme 仍按相对模板口径拒绝。
    #[test]
    fn path_template_accepts_absolute_url_shape() {
        assert!(validate_path_template("http://api.example.com/v1/users").is_ok());
        assert!(validate_path_template("https://api.example.com").is_ok());
        // scheme 之外的其余约束不豁免
        for raw in [
            "http://x.test/a b",
            "https://x.test/a?x=1",
            "ftp://x.test/a",
            &format!("https://x.test/{}", "x".repeat(MAX_PATH_TEMPLATE_BYTES)),
        ] {
            let err = validate_path_template(raw).unwrap_err();
            assert_eq!(err.code, codes::INVALID_PATH_TEMPLATE, "{raw}");
        }
    }

    #[test]
    fn manual_identity_is_uuid_v4() {
        let a = new_manual_identity();
        let b = new_manual_identity();
        assert_ne!(a, b, "uuid v4 must be unique");
        assert_eq!(a.len(), 36);
        assert!(a.chars().filter(|c| *c == '-').count() == 4);
    }

    #[test]
    fn manual_identity_disjoint_from_stable_key() {
        assert!(is_manual_identity(&new_manual_identity()));
        assert!(!is_manual_identity("GET /users/{id}"));
        assert!(is_manual_identity("e1"));
    }

    #[test]
    fn cascade_scope_lists_manual_tables_without_foreign_keys() {
        let workspace = cascade_scope(CascadeEntity::Workspace);
        assert_eq!(workspace.tables.len(), 7);
        assert_eq!(workspace.manual_tables, &["endpoint_user_data"]);
        let service = cascade_scope(CascadeEntity::Service);
        assert_eq!(service.manual_tables, &["endpoint_user_data"]);
        let endpoint = cascade_scope(CascadeEntity::Endpoint);
        assert_eq!(
            endpoint.manual_tables,
            &["endpoint_user_data", "pinned_endpoints"]
        );
        let category = cascade_scope(CascadeEntity::Category);
        assert_eq!(category.tables, &["categories"]);
        assert!(category.manual_tables.is_empty());
    }
}
