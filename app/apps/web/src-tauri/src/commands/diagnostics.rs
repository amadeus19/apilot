//! 诊断 IPC 命令：`get_diagnostics` 输出版本 / 系统 / 运行环境 /
//! 后台任务 / 日志统计摘要——设置面板「复制诊断信息」预留的数据源。

use serde::Serialize;
use tauri::State;

use crate::AppState;
use crate::services::logging;

/// 诊断摘要 DTO（camelCase 对齐前端 AppError/BootSettings 同款序列化约定）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    /// 应用版本（tauri.conf.json 与 Cargo 同源）
    pub version: String,
    /// 操作系统平台（windows / linux / macos…）
    pub platform: &'static str,
    /// CPU 架构
    pub arch: &'static str,
    /// 系统家族（windows / unix）
    pub family: &'static str,
    /// 运行环境：debug 构建（开发期）或 release 构建
    pub build: &'static str,
    /// 当前活跃后台任务数（registry 已登记且未结束；排查后台问题的关键观测）
    pub active_tasks: usize,
    /// 日志统计摘要
    pub log: LogSummary,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSummary {
    /// 当前生效级别（EnvFilter 指令形态）
    pub level: String,
    /// 环形缓冲当前条数（封顶 MAX_LOG_ENTRIES）
    pub ring_count: usize,
    /// 环形缓冲容量上限
    pub ring_capacity: usize,
}

/// 纯函数装配（环境取值之外的状态由调用方注入，可直接单测字段完整性）
pub fn diagnostics_payload(active_tasks: usize) -> Diagnostics {
    Diagnostics {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        platform: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        family: std::env::consts::FAMILY,
        build: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        active_tasks,
        log: LogSummary {
            level: logging::current_level(),
            ring_count: logging::ring_len(),
            ring_capacity: crate::constants::MAX_LOG_ENTRIES,
        },
    }
}

#[tauri::command]
pub fn get_diagnostics(state: State<'_, AppState>) -> Diagnostics {
    diagnostics_payload(state.tasks.active_count())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 序列化形态含 activeTasks（前端镜像类型与复制诊断文本的对账依据）
    #[test]
    fn payload_serializes_active_tasks_as_camel_case() {
        let value = serde_json::to_value(diagnostics_payload(2)).unwrap();
        assert_eq!(value["activeTasks"], 2);
        assert!(value["log"]["ringCapacity"].is_u64());
        assert_eq!(
            value["build"],
            if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            }
        );
    }
}
