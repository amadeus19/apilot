//! Tauri Command 层：只做参数反序列化、调用 Service、错误转换、返回 DTO。
//! 工作台域命令点分命名（`workspace.list` 等）经 `rename` 属性登记，
//! 前端 invoke 名与规格清单一致。

pub mod backup;
pub mod category;
pub mod cli;
pub mod diagnostics;
pub mod endpoint;
pub mod http;
pub mod probe;
pub mod run;
pub mod service;
pub mod session;
pub mod settings;
pub mod sync;
pub mod system;
pub mod tree;
pub mod user_data;
pub mod variable;
pub mod workflow;
pub mod workspace;
