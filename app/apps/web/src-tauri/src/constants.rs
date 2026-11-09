//! 有界常量登记——一切缓冲有界：任何数量 / 内存 / 时长上限，
//! 先在此登记（附依据）再在实现处引用，禁止散落魔法数。

/// 应用标识符（＝tauri.conf.json 的 identifier）：GUI（Tauri path resolver）
/// 与 CLI（known folder 解析）双进程据此落到同一数据目录，不得单侧改动；
/// 防漂移静态测试断言两处一致。
pub const APP_IDENTIFIER: &str = "com.apilot2.app";

/// CLI 迁移竞态退避重试间隔（GUI 与 CLI 同秒冷启动时后到者的
/// DDL 报 DB_MIGRATION_FAILED，先到者提交在毫秒级，300ms 足够跨过窗口）
pub const MIGRATION_RETRY_DELAY_MS: u64 = 300;

/// 内存环形日志缓冲封顶条数（桌面常驻内存预算内的护栏值）
pub const MAX_LOG_ENTRIES: usize = 5000;

/// 日志文件按日滚动保留份数，超限删旧
pub const MAX_LOG_FILES: usize = 14;

/// 日志份数运行期巡检间隔（长驻会话跨日滚动后旧份数仍能有界，不必等下次
/// 启动；小时级粒度足够——日志按日滚动，一天最多新增一份超限文件）
pub const LOG_PRUNE_INTERVAL_MS: u64 = 60 * 60 * 1000;

/// 单条日志行截断阈值（一切缓冲有界派生：超大行同样占环形缓冲内存；
/// 8KB 足以容纳完整事件 + 超长 payload 的截断标注）
pub const LOG_LINE_MAX_BYTES: usize = 8 * 1024;

/// 统一 Shutdown 序列等待任务退出的超时（超时强退语义，不因单任务卡死挂起）
pub const SHUTDOWN_TIMEOUT_MS: u64 = 5000;

/// Shutdown 序列 wait_all 的轮询粒度（粒度非上限，
/// 但作为序列唯一可调参数统一登记便于调参与对账）
pub const SHUTDOWN_POLL_INTERVAL_MS: u64 = 20;

/// settings 单键 value 序列化后的字节数上限
pub const MAX_SETTING_VALUE_BYTES: usize = 4096;

/// settings 键总数上限（缓存有界：精确键 11 + 预留组 `http.*`，
/// 256 远超可预见需求，防前缀组无界写入；超限写入拒绝）
pub const MAX_SETTING_KEYS: usize = 256;

/// 更新源可达性校验超时：UNC 路径在 SMB 不可达时 `metadata()`
/// 会阻塞数秒以上，校验放 `spawn_blocking` 并以此超时兜底（防 Command 卡死）
pub const UPDATE_SOURCE_CHECK_TIMEOUT_MS: u64 = 5000;

/// 更新安装包字节数上限：下载前按清单 size 校验（防异常清单
/// 撑爆内存/磁盘——一切缓冲有界）；现产物约 4MB，256MB 为远超需求的护栏
pub const MAX_UPDATE_FILE_BYTES: u64 = 256 * 1024 * 1024;

/// 云端更新清单字节数上限：清单为 KB 量级 JSON，1 MiB 已是数百倍余量；
/// 与资产侧 `MAX_UPDATE_FILE_BYTES` 分开设护栏（清单整体读入内存解析，
/// 防异常服务端回超大 body 撑爆内存）
pub const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

/// 云端更新请求连接超时（清单与资产统一：连接层成败通常亚秒级，
/// 10s 容公网抖动与镜像回源）
pub const UPDATE_CLOUD_CONNECT_TIMEOUT_MS: u64 = 10_000;

/// 云端清单请求总超时（从连接到清单 body 读完；清单为 KB 级小对象，
/// 30s 远超常态）——资产下载**不设**总超时（时长不可预估），见下行
pub const UPDATE_CLOUD_MANIFEST_TIMEOUT_MS: u64 = 30_000;

/// 云端资产下载单次读超时（读成功即重置）：大文件不设总超时的前提下，
/// 以此检测僵死连接（对端静默不发包的最长在途时长）
pub const UPDATE_CLOUD_READ_TIMEOUT_MS: u64 = 30_000;

/// 云端请求可重试失败（网络错 / 429 / 5xx）的额外尝试次数：首次 + 2 次重试
/// （GitHub 资产间歇 503 egress 实证重试即可成功；404 为终态不重试）
pub const UPDATE_CLOUD_RETRY_ATTEMPTS: u32 = 2;

/// 云端重试指数退避基数：第 n 次重试等待 `基数 × 4^(n-1)`（1s → 4s）
pub const UPDATE_CLOUD_RETRY_BASE_DELAY_MS: u64 = 1_000;

/// 429 Retry-After 响应头的封顶秒数（防异常大值把检查挂死）
pub const UPDATE_CLOUD_RETRY_AFTER_CAP_SECS: u64 = 30;

// —— 工作台领域（七表 CRUD，Phase 3）——

/// 领域实体名称长度上限（工作空间/服务/分类/接口标题共用，字节）：
/// 桌面单用户场景 256 字节远超可读名称需求，防无界写入
pub const MAX_ENTITY_NAME_BYTES: usize = 256;

/// 工作空间 BaseUrl 长度上限（字节；URL 实际限长远小于此，防无界写入）
pub const MAX_BASE_URL_BYTES: usize = 2048;

/// 接口路径模板长度上限（字节）
pub const MAX_PATH_TEMPLATE_BYTES: usize = 2048;

/// 单份接口用户数据（草稿）body/params/headers 三列合计字节上限：
/// 编辑器草稿为纯文本量级，1MB 远超需求且与单连接串行写入预算相称
pub const MAX_USER_DATA_BYTES: usize = 1024 * 1024;

/// 单工作空间会话（tabs + tree_expanded）合计字节上限：
/// Tab 元数据为轻量快照，1MB 可容数千 Tab（Tab 数不设硬上限，此为护栏）
pub const MAX_SESSION_BYTES: usize = 1024 * 1024;

/// 首启动 / 删光后自动重建的默认工作空间名称（用户数据，可重命名）
pub const DEFAULT_WORKSPACE_NAME: &str = "默认工作空间";

/// 退出闸门等待前端收尾（会话保存 + 草稿 flush）的超时：
/// 本地 SQLite 毫秒级写入，3s 已容慢盘抖动；前端崩溃时兜底放行不挂死退出
pub const EXIT_ACK_TIMEOUT_MS: u64 = 3000;

// —— HTTP 执行域 ——

/// Run Record 全局封顶条数：写入时单事务修剪删最旧。封顶是全局语义——
/// 任一工作空间的写入都按 created_at 淘汰全局最旧记录（可能淘汰他空间记录）；
/// 「清空本工作空间」是唯一清空口径，与全局封顶并行不悖。
pub const RUN_RECORDS_CAP: usize = 1000;

/// 请求 / 响应快照的 body 截断阈值（run_records.request_json / response_json
/// 的 excerpt ≤64KB＋truncated 标记；headers 全量）
pub const SNAPSHOT_EXCERPT_BYTES: usize = 64 * 1024;

/// 响应内存分级线：≤此值全量入内存；超过则边收边写临时文件
pub const HTTP_MEMORY_TIER_BYTES: usize = 2 * 1024 * 1024;

/// 响应体量上限：超过即停止下载（UI 只读 Preview；一切缓冲与落盘有界的界）
pub const HTTP_MAX_RESPONSE_BYTES: u64 = 50 * 1024 * 1024;

/// Preview 片段上限（UI 与 CLI 输出的响应体前缀；恒 ≤64KB）
pub const HTTP_PREVIEW_BYTES: usize = 64 * 1024;

/// SSE 环形缓冲尾部容量（流式展示有界内存）
pub const SSE_RING_BUFFER_BYTES: usize = 256 * 1024;

// —— 同步域（拉取 / 快照，Phase 5）——

/// 同步拉取 swagger 文档大小上限（超限按异常响应处理：拉全量前查
/// Content-Length、下载中累计字节超限即断开——一切缓冲有界）
pub const MAX_SWAGGER_DOC_BYTES: usize = 32 * 1024 * 1024;

/// 同步拉取 HTTP 重定向上限（与批量导入发现链路同值：内网 Swashbuckle
/// 反代跳数远低于此，防 $ref 地址环）
pub const SYNC_FETCH_REDIRECT_LIMIT: usize = 5;

/// 归一层 schema 受控展开深度上限（$ref 链与嵌套层数的界：真实 Swashbuckle
/// 文档最深十几层，64 是防深嵌套栈风险的护栏；超限截断并标记 truncated）
pub const SYNC_SCHEMA_MAX_DEPTH: usize = 64;

/// 同步铺底数组骨架的序列化字节上限（单数组首元素骨架超限回落 `[]`）：
/// 骨架为线性展开——每数组仅取 1 元素、深度受 [`SYNC_SCHEMA_MAX_DEPTH`]
/// 截断，总量由字段数与 example 体量决定；护栏防宽 schema 顶到
/// [`MAX_USER_DATA_BYTES`]（1MB）触发整包回滚，宁可少铺不阻断同步应用
pub const SYNC_BODY_SKELETON_MAX_BYTES: usize = 64 * 1024;

/// 可达性探测批量并发上限（启动轮 / 手动全量刷新的在途请求界）。
pub const PROBE_CONCURRENCY: usize = 4;

/// 可达性探测请求兜底超时：对端 accept 后静默不回包的已建立连接最长
/// 在途时长（OS 只兜底 SYN 阶段，应用层必须自兜）。远大于探测常态
/// （连接层成败通常亚秒级）——慢服务不会在正常时长内撞上兜底；超时
/// 回「未知」而非「不可达」（见 `ProbeService::probe_one` 口径注释）。
pub const PROBE_FALLBACK_TIMEOUT_MS: u64 = 60_000;

// —— 备份域（手动导出 / 恢复）——

/// 备份 zip 内唯一的 .sqlite 条目名（导出写入、恢复校验双向锁定）
pub const BACKUP_ZIP_ENTRY_NAME: &str = "apilot-backup.sqlite";

// 启动替换链暂存面三文件名（暂存库 / 标记 / 旧库落点）；标记与暂存的
// 孤儿收敛、替换与搬回的状态机流转以 services/backup.rs 模块头为单点权威
// 描述，此处不重复展开

/// 恢复暂存库文件名（app_data_dir 下）
pub const BACKUP_STAGE_FILE_NAME: &str = "backup-pending.sqlite";

/// 恢复标记文件名（app_data_dir 下）：存在性即「待重启执行的恢复」语义
pub const BACKUP_MARKER_FILE_NAME: &str = "backup-pending.marker";

/// 替换期间原库的落点文件名
pub const BACKUP_OLD_DB_FILE_NAME: &str = "backup-old.sqlite";

#[cfg(test)]
mod tests {
    use super::*;

    /// 防漂移：APP_IDENTIFIER 必须与 tauri.conf.json 的
    /// identifier 一致——GUI（Tauri path resolver）与 CLI（known folder 解析）
    /// 双进程据此落到同一数据目录，单侧改动即分叉出两套数据。
    #[test]
    fn app_identifier_matches_tauri_config() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], APP_IDENTIFIER);
    }
}
