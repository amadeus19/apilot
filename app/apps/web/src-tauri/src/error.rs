//! 统一错误协议 AppError。
//!
//! 序列化形态（camelCase + kind 标签）：
//! `{"kind":"apilot_error","code":"...","message":"...","details":...}`
//!
//! 约定：
//! - `code` 是稳定标识符，前端按 `errors.<code>` 映射本地化文案，一经发布不可改名；
//!   全部 code 在 [`codes`] 模块单点登记（可 grep 对账），前端 i18n 字典与该登记
//!   区机械对账（web 侧 error-codes.test.ts 直读本文件校验两语言键齐全）。
//! - `message` 恒英文（面向日志与开发者，本地化由前端字典负责）。
//! - `details` 携带结构化补充信息（如超限字节数、损坏详情），供前端插值。

use serde::Serialize;

/// 稳定错误码登记区（单点）：新增错误类别 = 本区加常量 + zh/en 字典同批补键。
/// 按域分组；更新链路按失败阶段精确切分（检查 / 下载 / 校验 / 落盘 / 安装），
/// 一个码只描述一种失败，不再多阶段复用。
pub mod codes {
    // —— 通用 ——
    /// 兜底码：不应发生的内部错误
    pub const INTERNAL: &str = "INTERNAL";
    /// 参数形态不合法（不属任何业务域的通用拒绝）
    pub const INVALID_ARGUMENT: &str = "INVALID_ARGUMENT";

    // —— Settings ——
    pub const SETTINGS_UNKNOWN_KEY: &str = "SETTINGS_UNKNOWN_KEY";
    pub const SETTINGS_VALUE_TOO_LARGE: &str = "SETTINGS_VALUE_TOO_LARGE";
    pub const SETTINGS_KEY_LIMIT_EXCEEDED: &str = "SETTINGS_KEY_LIMIT_EXCEEDED";

    // —— DB ——
    pub const DB_OPEN_FAILED: &str = "DB_OPEN_FAILED";
    pub const DB_CORRUPTED: &str = "DB_CORRUPTED";
    pub const DB_MIGRATION_FAILED: &str = "DB_MIGRATION_FAILED";
    pub const DB_QUERY_FAILED: &str = "DB_QUERY_FAILED";
    /// 写锁等待耗尽（busy_timeout 内未获锁）：双进程并发写的排队上限
    pub const DB_BUSY: &str = "DB_BUSY";

    // —— IO ——
    pub const IO_CREATE_DIR_FAILED: &str = "IO_CREATE_DIR_FAILED";
    pub const IO_RESOLVE_PATH_FAILED: &str = "IO_RESOLVE_PATH_FAILED";
    pub const IO_OPEN_PATH_FAILED: &str = "IO_OPEN_PATH_FAILED";

    // —— CLI 开关（PATH 注册 / 注销的注册表读写）——
    /// 用户 PATH 注册表（`HKCU\Environment`）打开 / 读取 / 写入失败；
    /// 与「打开目录」语义的 IO_OPEN_PATH_FAILED 分码，前端映射各自文案
    pub const CLI_PATH_REGISTRY_FAILED: &str = "CLI_PATH_REGISTRY_FAILED";

    // —— 更新链路（按失败阶段切分）——
    /// 更新源未配置 / 类型未对接
    pub const UPDATE_SOURCE_NOT_CONFIGURED: &str = "UPDATE_SOURCE_NOT_CONFIGURED";
    /// 源目录不可达（保存前校验与检查阶段；云端语境含 401/403 等源侧拒绝）
    pub const UPDATE_SOURCE_UNREACHABLE: &str = "UPDATE_SOURCE_UNREACHABLE";
    /// 云端清单 / 资产在源上不存在（HTTP 404，终态不重试——latest 通道无
    /// 正式 Release 或未挂对应资产）
    pub const UPDATE_SOURCE_NOT_FOUND: &str = "UPDATE_SOURCE_NOT_FOUND";
    /// 云端请求可重试失败（网络错 / 超时 / 429 / 5xx）退避重试耗尽
    pub const UPDATE_SOURCE_RETRIES_EXHAUSTED: &str = "UPDATE_SOURCE_RETRIES_EXHAUSTED";
    /// manifest.json 文件读不到（下载阶段；检查阶段归 unreachable 状态）
    pub const UPDATE_MANIFEST_UNREADABLE: &str = "UPDATE_MANIFEST_UNREADABLE";
    /// 清单损坏（非法 JSON / manifestVersion 不支持 / 缺当前平台条目）
    pub const UPDATE_MANIFEST_INVALID: &str = "UPDATE_MANIFEST_INVALID";
    /// 安装包文件读不到
    pub const UPDATE_PACKAGE_UNREADABLE: &str = "UPDATE_PACKAGE_UNREADABLE";
    /// 尺寸或 sha256 校验不符
    pub const UPDATE_CHECKSUM_MISMATCH: &str = "UPDATE_CHECKSUM_MISMATCH";
    /// minisign 验签失败
    pub const UPDATE_SIGNATURE_INVALID: &str = "UPDATE_SIGNATURE_INVALID";
    /// 校验通过后的落盘失败（.part 写入 / rename）
    pub const UPDATE_STAGE_WRITE_FAILED: &str = "UPDATE_STAGE_WRITE_FAILED";
    /// 下载整体超时
    pub const UPDATE_DOWNLOAD_TIMED_OUT: &str = "UPDATE_DOWNLOAD_TIMED_OUT";
    /// 安装器启动失败（暂存包缺失 / spawn 失败）
    pub const UPDATE_INSTALL_FAILED: &str = "UPDATE_INSTALL_FAILED";
    /// 已完成更新包的清理失败
    pub const UPDATE_DISCARD_FAILED: &str = "UPDATE_DISCARD_FAILED";

    // —— 任务登记处 ——
    pub const TASK_KEY_EXISTS: &str = "TASK_KEY_EXISTS";
    pub const SHUTDOWN_IN_PROGRESS: &str = "SHUTDOWN_IN_PROGRESS";

    // —— 工作台领域（工作空间 / 服务 / 分类 / 接口）——
    /// 实体名称校验失败（空 / 超长；工作空间/服务/分类/接口标题/变量分类名/
    /// 变量 key 共用）
    pub const NAME_INVALID: &str = "NAME_INVALID";
    /// URL 校验失败（工作空间 BaseUrl / BaseUrl 候选共用）
    pub const URL_INVALID: &str = "URL_INVALID";
    pub const WORKSPACE_NOT_FOUND: &str = "WORKSPACE_NOT_FOUND";
    pub const SERVICE_NOT_FOUND: &str = "SERVICE_NOT_FOUND";
    pub const CATEGORY_NOT_FOUND: &str = "CATEGORY_NOT_FOUND";
    pub const ENDPOINT_NOT_FOUND: &str = "ENDPOINT_NOT_FOUND";
    /// 同稳定键（方法+路由模板）跨服务撞车且未消歧：details 携带候选清单
    pub const ENDPOINT_AMBIGUOUS: &str = "ENDPOINT_AMBIGUOUS";
    /// CLI 命令被权限架构拦截（检查点在 CLI 入口，Core 不感知）
    pub const PERMISSION_DENIED: &str = "PERMISSION_DENIED";
    /// HTTP 方法不在七选之内（GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS）
    pub const INVALID_HTTP_METHOD: &str = "INVALID_HTTP_METHOD";
    /// 接口路径模板非法（非 / 开头、含空白或查询串、超长）
    pub const INVALID_PATH_TEMPLATE: &str = "INVALID_PATH_TEMPLATE";
    /// 接口用户数据（草稿）超过大小上限
    pub const USER_DATA_TOO_LARGE: &str = "USER_DATA_TOO_LARGE";
    /// 工作空间会话载荷超过大小上限
    pub const SESSION_TOO_LARGE: &str = "SESSION_TOO_LARGE";

    // —— 服务批量导入（Swashbuckle 入口页发现）——
    /// 入口页 / 配置页拉取失败（网络错误、超时、非 2xx）
    pub const IMPORT_FETCH_FAILED: &str = "IMPORT_FETCH_FAILED";
    /// 入口页形态未识别（未发现 Swashbuckle swagger 文档引用）
    pub const IMPORT_PAGE_UNRECOGNIZED: &str = "IMPORT_PAGE_UNRECOGNIZED";

    // —— 同步域（拉取 / 快照 / 对比）——
    /// 服务不可达（网络错误 / 超时）
    pub const SYNC_SERVICE_UNREACHABLE: &str = "SYNC_SERVICE_UNREACHABLE";
    /// 拉取的文档不可用（HTTP 非 2xx / 非法 JSON / 版本不支持 / 超大小上限）
    pub const SYNC_BAD_SWAGGER: &str = "SYNC_BAD_SWAGGER";
    /// 对比段前置缺失：服务尚无快照（对比恒跟在拉取段之后）
    pub const SYNC_NO_SNAPSHOT: &str = "SYNC_NO_SNAPSHOT";

    // —— 工作流域（编辑模型 CRUD；执行引擎错误码随执行落地追加）——
    /// 工作流不存在（not-found 族）
    pub const WORKFLOW_NOT_FOUND: &str = "WORKFLOW_NOT_FOUND";
    /// 工作流图 JSON 损坏（未知节点类型 / 结构不符——读侧拒绝不静默降级）
    pub const WORKFLOW_GRAPH_INVALID: &str = "WORKFLOW_GRAPH_INVALID";
    /// 图不可执行（缺 Start 等结构性前提缺失；完整执行前校验清单归校验器）
    pub const WORKFLOW_NOT_EXECUTABLE: &str = "WORKFLOW_NOT_EXECUTABLE";
    /// 同一工作流的并发闸：在途执行未结束时拒绝新执行
    pub const WORKFLOW_ALREADY_RUNNING: &str = "WORKFLOW_ALREADY_RUNNING";
    /// 参数提取的上游不是请求节点（提取无响应可取；完整校验清单归校验器）
    pub const WORKFLOW_EXTRACT_SOURCE_INVALID: &str = "WORKFLOW_EXTRACT_SOURCE_INVALID";
    /// 参数提取求值失败（JSONPath 语法不受支持 / 路径未命中响应 / 行级失败）
    pub const WORKFLOW_EXTRACT_EVAL_FAILED: &str = "WORKFLOW_EXTRACT_EVAL_FAILED";
    /// 断言的上游不是请求节点（断言无响应可判定；完整校验清单归校验器）
    pub const WORKFLOW_ASSERT_SOURCE_INVALID: &str = "WORKFLOW_ASSERT_SOURCE_INVALID";
    /// 断言不通过（任一规则判否——期望 vs 实际逐条进记录与事件）
    pub const WORKFLOW_ASSERT_FAILED: &str = "WORKFLOW_ASSERT_FAILED";
    /// 条件表达式求值失败（语法不支持 / 词元结构不完整——完整校验清单归校验器）
    pub const WORKFLOW_CONDITION_EVAL_FAILED: &str = "WORKFLOW_CONDITION_EVAL_FAILED";
    /// 条件命中分支（或 Default）在图上没有对应出边（分支与边标注不一致）
    pub const WORKFLOW_BRANCH_EDGE_MISSING: &str = "WORKFLOW_BRANCH_EDGE_MISSING";
    /// Join 缺少可汇聚的并行前提（无分支到达 / 分支未汇聚到同一 Join）
    pub const WORKFLOW_JOIN_INVALID: &str = "WORKFLOW_JOIN_INVALID";
    /// 工作流分组重名（同工作空间内组名唯一；改名与新建共用）
    pub const WORKFLOW_GROUP_NAME_EXISTS: &str = "WORKFLOW_GROUP_NAME_EXISTS";
    /// 导入的导出文件图结构版本高于当前支持（新版应用导出，拒收不静默降级）
    pub const WORKFLOW_IMPORT_VERSION_UNSUPPORTED: &str = "WORKFLOW_IMPORT_VERSION_UNSUPPORTED";
    /// 工作流导出落盘失败（目标路径不可写 / 无权限 / 盘满）
    pub const WORKFLOW_EXPORT_WRITE_FAILED: &str = "WORKFLOW_EXPORT_WRITE_FAILED";

    // —— 变量域（变量分类 / 变量 / BaseUrl 候选）——
    /// 变量分类不存在（或跨空间引用——对调用方上下文不可见等价不存在）
    pub const VARIABLE_CATEGORY_NOT_FOUND: &str = "VARIABLE_CATEGORY_NOT_FOUND";
    /// 变量不存在（复合主键 (category_id, key) 未命中）
    pub const VARIABLE_NOT_FOUND: &str = "VARIABLE_NOT_FOUND";
    /// 同分类下变量 key 撞车（复合主键约束冲突；不静默覆盖）
    pub const VARIABLE_KEY_DUPLICATE: &str = "VARIABLE_KEY_DUPLICATE";
    /// 全局分类（workspace_id NULL 行）不可激活
    pub const VARIABLE_CATEGORY_NOT_ACTIVATABLE: &str = "VARIABLE_CATEGORY_NOT_ACTIVATABLE";
    /// BaseUrl 候选撞车（同工作空间同 URL 的 UNIQUE 约束冲突）
    pub const BASE_URL_CANDIDATE_DUPLICATE: &str = "BASE_URL_CANDIDATE_DUPLICATE";
    /// BaseUrl 候选不存在（或跨空间引用——对调用方上下文不可见等价不存在）
    pub const BASE_URL_CANDIDATE_NOT_FOUND: &str = "BASE_URL_CANDIDATE_NOT_FOUND";

    // —— 备份域（手动导出 / 恢复，按失败阶段切分）——
    /// 导出链路落盘失败（VACUUM INTO 副本 / zip 写入）
    pub const BACKUP_EXPORT_WRITE_FAILED: &str = "BACKUP_EXPORT_WRITE_FAILED";
    /// 恢复输入不是合法备份包（非 zip / 缺唯一 .sqlite 条目）
    pub const BACKUP_INVALID_ZIP: &str = "BACKUP_INVALID_ZIP";
    /// 恢复输入内嵌的库损坏（quick_check 不通过 / 非合法 apilot 库）
    pub const BACKUP_INVALID_DB: &str = "BACKUP_INVALID_DB";
    /// 恢复输入的 schema 版本新于当前应用（新版备份拒绝，防降级打开）
    pub const BACKUP_SCHEMA_NEWER: &str = "BACKUP_SCHEMA_NEWER";
    /// 恢复链路落盘失败（暂存解包写 / rename / 标记写入）
    pub const BACKUP_RESTORE_WRITE_FAILED: &str = "BACKUP_RESTORE_WRITE_FAILED";
    /// 恢复替换目标被其他进程占用（如 CLI 持写锁）；标记与暂存保留，
    /// 下次启动自动重试
    pub const BACKUP_FILE_LOCKED: &str = "BACKUP_FILE_LOCKED";

    // —— HTTP 执行域 ——
    /// 用户主动取消执行（GUI 取消按钮 / 关 Tab / CLI Ctrl+C）
    pub const CANCELLED: &str = "CANCELLED";
    /// 请求按超时配置被系统终止（归 failed 态，非用户取消）
    pub const TIMEOUT: &str = "TIMEOUT";
    /// 能力未交付（fail-fast，不静默降级）
    pub const NOT_IMPLEMENTED: &str = "NOT_IMPLEMENTED";
    /// Run Record 不存在（not-found 族）
    pub const RUN_NOT_FOUND: &str = "RUN_NOT_FOUND";
    /// 传输层失败（连接拒绝 / DNS / TLS / 请求构建失败等；细分见 details）
    pub const HTTP_REQUEST_FAILED: &str = "HTTP_REQUEST_FAILED";
    /// 发送合成的输入非法（params/headers JSON 契约不符等）
    pub const HTTP_SYNTHESIS_INVALID: &str = "HTTP_SYNTHESIS_INVALID";
}

#[derive(Debug, Clone, thiserror::Error, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", rename = "apilot_error")]
#[error("{code}: {message}")]
pub struct AppError {
    /// 稳定错误码（见 [`codes`] 登记区）
    pub code: String,
    /// 英文描述，恒英文，不本地化
    pub message: String,
    /// 结构化补充信息（键、限额、实际值等）
    pub details: Option<serde_json::Value>,
}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    /// 附加结构化 details（链式）
    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }

    /// 兜底码：不应发生的内部错误（可证明不可失败的场合之外）
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(codes::INTERNAL, message)
    }
}

/// 基础设施错误统一转换：Service 层 `?` 即得 AppError，Command 层只做 map_err。
/// 语义化更强的错误（打开失败 / 损坏等）由 db 模块在贴近语义处显式构造并提前返回，
/// 走到此处的均为查询期通用失败。
impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        // 写锁等待耗尽（SQLITE_BUSY）：busy_timeout 是带上限的睡眠重试，
        // 耗尽后得到 code 5——双进程并发写的排队上限，与查询期通用失败分码
        if is_busy(&err) {
            return AppError::new(codes::DB_BUSY, format!("database is busy: {err}"));
        }
        AppError::new(
            codes::DB_QUERY_FAILED,
            format!("database query failed: {err}"),
        )
    }
}

/// 识别 SQLite SQLITE_BUSY（code 5，含 BUSY_RECOVERY / BUSY_SNAPSHOT 扩展态）。
fn is_busy(err: &sqlx::Error) -> bool {
    matches!(err, sqlx::Error::Database(db) if db.code().as_deref() == Some("5"))
}
