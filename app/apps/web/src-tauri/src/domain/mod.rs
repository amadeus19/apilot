//! 领域层：工作台实体类型与不变量纯函数。
//!
//! 职责边界：实体类型 + 校验 / 身份构造 / 级联范围等纯函数；
//! 不接触数据库（SQL 全收 infrastructure 层）、不做编排（services 层职责）。
//! 错误统一返回 AppError（稳定错误码，见 error::codes）。

pub mod category;
pub mod clock;
pub mod endpoint;
pub mod json_path;
pub mod permission;
pub mod redact;
pub mod run_id;
pub mod run_record;
pub mod service;
pub mod session;
pub mod sync;
pub mod url;
pub mod user_data;
pub mod user_data_codec;
pub mod validate;
pub mod variable;
pub mod variable_resolver;
pub mod workflow;
pub mod workflow_assert;
pub mod workflow_condition;
pub mod workflow_execution;
pub mod workflow_validation;
pub mod workspace;
