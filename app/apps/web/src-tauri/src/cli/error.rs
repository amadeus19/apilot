//! CLI 错误协议：错误码与 AppError 一码一义零第二套；
//! `AppError code → exit code` 单点映射（未登记码 fallback 1）。
//!
//! exit code 表：0 成功（含空集；`api run` 含 4xx/5xx——请求到达且响应已回，
//! 成败判定交消费者）/ 1 通用失败（装配类＋`INTERNAL`＋工作流执行期域码
//! ＋GUI-only 域码＋fallback）/ 2 clap 参数错误（clap 原生与本表
//! `INVALID_ARGUMENT`、`NOT_IMPLEMENTED` 同码）/ 3 资源未找到或歧义（含
//! `RUN_NOT_FOUND`）/ 4 执行失败（传输层含超时、发送合成失败）/ 5 权限
//! 拒绝 / 130 用户取消（SIGINT 惯例）。
//!
//! 登记区（`error.rs` 的 `codes` 模块）全部码在此显式登记映射——编译器
//! 不强制，对账由契约夹具 `tests/fixtures/cli/contract.json` 的 `exitCodes`
//! 表与三断言单测机械承担：夹具码集＝登记区、`exit_code_for` 逐码等于夹具
//! 值、登记区每码在本函数 match 源码显式出现。新增错误码的完整动作＝登记区
//! 加常量＋zh/en 字典补键＋本函数登记映射＋夹具 `exitCodes` 表登记，任一步
//! 漏做都在 `cargo test` 变红。

use crate::error::codes;

/// 单点映射：AppError code → 进程 exit code。新增码必须在此显式登记；
/// 未登记码走 fallback 1（防御性兜底，不豁免登记纪律）。match 臂按
/// 「CLI 可达 / GUI-only」分组：GUI-only 域码不会经 CLI 命令面产生，
/// 显式登记归通用失败、冻结其登记前静默兜底的现值。
pub(crate) fn exit_code_for(code: &str) -> i32 {
    match code {
        // —— CLI 可达：装配类与通用失败 ——
        codes::IO_CREATE_DIR_FAILED
        | codes::DB_OPEN_FAILED
        | codes::DB_CORRUPTED
        | codes::DB_MIGRATION_FAILED
        | codes::DB_QUERY_FAILED
        | codes::DB_BUSY
        | codes::INTERNAL => 1,
        // —— CLI 可达：用法域（clap 原生参数错误同码）——
        codes::INVALID_ARGUMENT | codes::NOT_IMPLEMENTED => 2,
        // —— CLI 可达：资源未找到或歧义 ——
        codes::WORKSPACE_NOT_FOUND
        | codes::SERVICE_NOT_FOUND
        | codes::ENDPOINT_NOT_FOUND
        | codes::ENDPOINT_AMBIGUOUS
        | codes::RUN_NOT_FOUND
        | codes::WORKFLOW_NOT_FOUND => 3,
        // —— CLI 可达：执行失败（传输层含超时 / 发送合成失败；工作流执行前
        // 校验拒绝同属执行域——命令已受理但执行未成）——
        codes::TIMEOUT
        | codes::HTTP_REQUEST_FAILED
        | codes::HTTP_SYNTHESIS_INVALID
        | codes::WORKFLOW_NOT_EXECUTABLE => 4,
        // —— CLI 可达：工作流执行期域码（断言不通过 / 提取或条件求值失败 /
        // 图损坏读侧拒绝）——执行记录的 error_code 经失败包络透出，失败判定
        // 经包络 code 消费，exit 归通用失败 ——
        codes::WORKFLOW_ASSERT_FAILED
        | codes::WORKFLOW_EXTRACT_EVAL_FAILED
        | codes::WORKFLOW_CONDITION_EVAL_FAILED
        | codes::WORKFLOW_GRAPH_INVALID => 1,
        // —— CLI 可达：用户取消（SIGINT 惯例）与权限拒绝 ——
        codes::CANCELLED => 130,
        codes::PERMISSION_DENIED => 5,
        // —— GUI-only 域码：CLI 无对应命令面，码不会经 CLI 产生 ——
        // 设置域
        codes::SETTINGS_UNKNOWN_KEY
        | codes::SETTINGS_VALUE_TOO_LARGE
        | codes::SETTINGS_KEY_LIMIT_EXCEEDED
        // 工作台写域（CLI 无写命令）
        | codes::NAME_INVALID
        | codes::URL_INVALID
        | codes::CATEGORY_NOT_FOUND
        | codes::INVALID_HTTP_METHOD
        | codes::INVALID_PATH_TEMPLATE
        | codes::USER_DATA_TOO_LARGE
        | codes::SESSION_TOO_LARGE
        // 服务批量导入
        | codes::IMPORT_FETCH_FAILED
        | codes::IMPORT_PAGE_UNRECOGNIZED
        // 同步域（CLI 无同步命令）
        | codes::SYNC_SERVICE_UNREACHABLE
        | codes::SYNC_BAD_SWAGGER
        | codes::SYNC_NO_SNAPSHOT
        // 工作流编辑域；并发闸挂进程内 TaskRegistry，CLI 单进程单执行不可达
        | codes::WORKFLOW_ALREADY_RUNNING
        | codes::WORKFLOW_EXTRACT_SOURCE_INVALID
        | codes::WORKFLOW_ASSERT_SOURCE_INVALID
        | codes::WORKFLOW_BRANCH_EDGE_MISSING
        | codes::WORKFLOW_JOIN_INVALID
        | codes::WORKFLOW_GROUP_NAME_EXISTS
        | codes::WORKFLOW_IMPORT_VERSION_UNSUPPORTED
        | codes::WORKFLOW_EXPORT_WRITE_FAILED
        // 变量域
        | codes::VARIABLE_CATEGORY_NOT_FOUND
        | codes::VARIABLE_NOT_FOUND
        | codes::VARIABLE_KEY_DUPLICATE
        | codes::VARIABLE_CATEGORY_NOT_ACTIVATABLE
        | codes::BASE_URL_CANDIDATE_DUPLICATE
        | codes::BASE_URL_CANDIDATE_NOT_FOUND
        // 任务登记处
        | codes::TASK_KEY_EXISTS
        | codes::SHUTDOWN_IN_PROGRESS
        // 更新链路
        | codes::UPDATE_SOURCE_NOT_CONFIGURED
        | codes::UPDATE_SOURCE_UNREACHABLE
        | codes::UPDATE_SOURCE_NOT_FOUND
        | codes::UPDATE_SOURCE_RETRIES_EXHAUSTED
        | codes::UPDATE_MANIFEST_UNREADABLE
        | codes::UPDATE_MANIFEST_INVALID
        | codes::UPDATE_PACKAGE_UNREADABLE
        | codes::UPDATE_CHECKSUM_MISMATCH
        | codes::UPDATE_SIGNATURE_INVALID
        | codes::UPDATE_STAGE_WRITE_FAILED
        | codes::UPDATE_DOWNLOAD_TIMED_OUT
        | codes::UPDATE_INSTALL_FAILED
        | codes::UPDATE_DISCARD_FAILED
        // 备份域（CLI 无备份命令）
        | codes::BACKUP_EXPORT_WRITE_FAILED
        | codes::BACKUP_INVALID_ZIP
        | codes::BACKUP_INVALID_DB
        | codes::BACKUP_SCHEMA_NEWER
        | codes::BACKUP_RESTORE_WRITE_FAILED
        | codes::BACKUP_FILE_LOCKED
        // CLI 开关的 PATH 注册表读写（归设置开关编排）
        | codes::CLI_PATH_REGISTRY_FAILED
        // 文件揭示 / 路径解析（CLI 装配失败走 IO_CREATE_DIR_FAILED）
        | codes::IO_RESOLVE_PATH_FAILED
        | codes::IO_OPEN_PATH_FAILED => 1,
        // 防御兜底（登记对账由三断言单测承担）
        _ => 1,
    }
}

/// 错误包络结构（serde 单点）：`{"success":false,"error":{code,message,details}}`。
/// `details` 恒在（None 序列化为 null）——包络 schema 稳定，Agent 消费方
/// 依赖 `success` / `error.code` / `error.message` / `error.details` 四字段。
#[derive(serde::Serialize)]
pub(crate) struct ErrorEnvelope<'a> {
    pub success: bool,
    pub error: ErrorBody<'a>,
}

#[derive(serde::Serialize)]
pub(crate) struct ErrorBody<'a> {
    pub code: &'a str,
    pub message: &'a str,
    pub details: &'a Option<serde_json::Value>,
}

impl<'a> ErrorEnvelope<'a> {
    pub fn new(err: &'a crate::error::AppError) -> Self {
        Self {
            success: false,
            error: ErrorBody {
                code: &err.code,
                message: &err.message,
                details: &err.details,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;
    use crate::cli::contract_fixture;

    /// 登记区（`error.rs` 的 `codes` 模块）常量的（名称, 取值）对：直读
    /// 源码文本提取——Rust 运行期无法枚举模块常量，对账走源码。
    fn registered_codes() -> Vec<(String, String)> {
        contract_fixture::string_consts(contract_fixture::block_after(
            include_str!("../error.rs"),
            "pub mod codes {",
        ))
    }

    /// 断言 ①：夹具 `exitCodes` 码集＝登记区（多登、漏登都失败）。
    #[test]
    fn fixture_exit_table_matches_registration_area() {
        let registered: BTreeSet<String> = registered_codes()
            .into_iter()
            .map(|(_, value)| value)
            .collect();
        assert!(!registered.is_empty(), "登记区提取不得为空");
        let fixture_codes: BTreeSet<String> = contract_fixture::parse()
            .exit_codes
            .keys()
            .cloned()
            .collect();
        assert_eq!(
            fixture_codes, registered,
            "夹具 exitCodes 码集必须与登记区全等（新增错误码须同批登记夹具）"
        );
    }

    /// 断言 ②：`exit_code_for` 逐码等于夹具值（已有码改 exit 值属破坏性
    /// 变更，须用户裁定并同批改夹具）。
    #[test]
    fn exit_code_for_matches_fixture_value_per_code() {
        let fixture = contract_fixture::parse();
        for (code, exit) in &fixture.exit_codes {
            assert_eq!(exit_code_for(code), *exit, "{code}");
        }
    }

    /// 断言 ③：登记区每个码都在 `exit_code_for` 的 match 源码中显式出现
    /// ——`_ => 1` 兜底只作防御，不豁免登记。
    #[test]
    fn every_registered_code_appears_explicitly_in_exit_match() {
        let match_source =
            contract_fixture::block_after(include_str!("error.rs"), "fn exit_code_for");
        for (name, _) in registered_codes() {
            assert!(
                match_source.contains(&format!("codes::{name}")),
                "登记区码 {name} 未在 exit_code_for 的 match 中显式登记"
            );
        }
    }

    #[test]
    fn unregistered_code_falls_back_to_1() {
        assert_eq!(exit_code_for("NOT_REGISTERED_ANYWHERE"), 1);
    }

    #[test]
    fn error_envelope_serializes_with_stable_schema() {
        let err = crate::error::AppError::new(codes::ENDPOINT_NOT_FOUND, "no such endpoint");
        let json = serde_json::to_value(ErrorEnvelope::new(&err)).unwrap();
        assert_eq!(json["success"], serde_json::Value::Bool(false));
        assert_eq!(json["error"]["code"], "ENDPOINT_NOT_FOUND");
        assert_eq!(json["error"]["message"], "no such endpoint");
        assert!(
            json["error"]["details"].is_null(),
            "details 恒在：None 序列化为 null"
        );
        let with_details = crate::error::AppError::new(codes::DB_BUSY, "locked")
            .with_details(serde_json::json!({ "waitedMs": 5000 }));
        let json = serde_json::to_value(ErrorEnvelope::new(&with_details)).unwrap();
        assert_eq!(json["error"]["details"]["waitedMs"], 5000);
    }
}
