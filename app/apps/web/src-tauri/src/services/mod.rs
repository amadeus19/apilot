//! Application Service 层：业务逻辑所在地。Command 只做参数反序列化、
//! 调用 Service、错误转换、返回 DTO（架构铁律）。

pub mod backup;
pub mod category;
pub mod cli;
pub mod devtools;
pub mod endpoint;
pub mod exit_gate;
pub mod http;
pub mod log_dir;
pub mod logging;
pub mod probe;
pub mod send;
pub mod service;
pub mod service_import;
pub mod session;
pub mod settings;
pub mod sync_apply;
pub mod sync_diff;
pub mod sync_fetch;
pub mod sync_status;
pub mod tree;
pub mod update_source;
pub mod user_data;
pub mod variable;
pub mod workflow;
pub mod workflow_engine;
pub mod workflow_refs;
pub mod workflow_validate;
pub mod workspace;
