//! 工作空间实体：变量等字段留待后续阶段补迁移。

use sqlx::FromRow;

/// 工作空间。BaseUrl 可空；「当前工作空间」是 settings 键（不进本表）。
/// `auth`＝工作空间级认证配置 JSON（NULL＝未配置＝认证继承链根无认证），
/// 结构由发送时的 services/http/auth 解析（写路径整包存取不感知语义）。
#[derive(Debug, Clone, FromRow)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub base_url: Option<String>,
    pub auth: Option<String>,
    /// 用户可控顺序（拖拽放落整批落序）；清单与树按此列升序呈现。
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 新建工作空间的输入（身份与时间戳由调用方生成；auth 与 base_url 一样
/// 可带创建默认值，缺省 NULL）。
pub struct NewWorkspace {
    pub id: String,
    pub name: String,
    pub base_url: Option<String>,
    pub auth: Option<String>,
}
