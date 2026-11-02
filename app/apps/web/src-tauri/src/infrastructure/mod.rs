//! Infrastructure 层：sqlx repo——全部领域 SQL 收敛于此。
//!
//! 约定：
//! - 单语句函数收 `impl Executor`（连接池与事务皆可用），多语句原子操作
//!   收 `&mut SqliteConnection`，由 services 层在同一事务内组合；
//! - 时间戳统一由 SQL 侧 strftime 生成（RFC3339 UTC，单时钟源）；
//! - 写路径用 RETURNING 回读生成列，避免二次查询。

pub mod category_repo;
pub mod data_dir;
pub mod endpoint_repo;
pub mod path_env;
pub mod run_repo;
pub mod service_repo;
pub mod session_repo;
pub mod snapshot_repo;
pub mod sort_move;
pub mod user_data_repo;
pub mod variable_repo;
pub mod workflow_execution_repo;
pub mod workflow_repo;
pub mod workspace_repo;
