//! 同步域领域层：统一内部模型（model）、双规范归一层（normalize）、
//! 结构化 diff 引擎＋EndpointDiff 契约（diff）、同步计划决策面（plan，
//! 插入 / 删除 / 手工身份对账谓词的单点）与用户体对骨架静默对齐引擎
//! （merge）。
//!
//! 纯函数与数据结构：不接触数据库、不做网络（拉取与对比编排在 services 层）。

pub mod diff;
pub mod merge;
pub mod model;
pub mod normalize;
pub mod plan;
