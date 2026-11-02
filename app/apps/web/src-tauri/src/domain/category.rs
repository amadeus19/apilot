//! 分类实体：服务下的手工分组；分类可选——不选时接口直挂服务散层。

use sqlx::FromRow;

/// 分类。删除时其下接口 `category_id` 置 NULL 上移散层（FK SET NULL）。
#[derive(Debug, Clone, FromRow)]
pub struct Category {
    pub id: String,
    pub service_id: String,
    pub name: String,
    pub sort_order: i64,
    pub created_at: String,
}

/// 新建分类的输入（身份与时间戳由调用方生成）。
pub struct NewCategory {
    pub id: String,
    pub service_id: String,
    pub name: String,
}

/// 分类跨服务随迁时，身份键含 `(service_id, key)` 的关联表清单（domain 级
/// 对账物，与 `endpoint::cascade_scope` 的删除级联清单对齐——两层都把
/// 「用户测试数据跟着实体走、不丢不悬挂」声明为可对账的领域约束）。
/// 分类改归属服务时这些表必须与 `endpoints` 同一事务内原子改写
/// （见 category_repo::move_category_to 的迁移段）；新增同类关联表时
/// 此清单与 repo 迁移实现须同步演进。
pub const CROSS_SERVICE_KEY_TABLES: &[&str] = &["endpoint_user_data", "pinned_endpoints"];
