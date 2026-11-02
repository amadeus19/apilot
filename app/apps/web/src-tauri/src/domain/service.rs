//! 服务实体：一份 OpenAPI 文档的接入（doc_url 配置时）或纯手工容器（doc_url 为空）。

use sqlx::FromRow;

/// 服务。`doc_url = None` 表示纯手工容器（用户直接在树下建接口）；
/// `doc_type` 为协议判别字段，当前恒 `openapi`，其他协议只留字段不建抽象。
#[derive(Debug, Clone, FromRow)]
pub struct Service {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub doc_url: Option<String>,
    pub doc_type: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 新建服务的输入（身份与时间戳由调用方生成；sort_order 追加末尾由 repo 计）。
pub struct NewService {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub doc_url: Option<String>,
    pub doc_type: String,
}

/// 文档类型判别字段当前唯一取值。
pub const DOC_TYPE_OPENAPI: &str = "openapi";

/// 相邻交换方向（上移 / 下移菜单动作）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MoveDirection {
    Up,
    Down,
}
