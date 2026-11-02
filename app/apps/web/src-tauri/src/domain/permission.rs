//! CLI 命令权限级别（权限是 CLI 侧概念）：检查点在 CLI 入口统一拦截
//! （clap 解析后、分发前），Core Service 不感知权限与调用方——GUI 交互
//! 是本人操作，不经权限体系。动机：经 CLI 操作的 Agent 可控性。

/// 四级权限。映射挂 CLI 命令枚举的 `permission()` 方法（match 穷尽性由
/// 编译器强制：新增命令必须显式定级，不存在漏配级的静默路径）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionLevel {
    /// 只读：恒允许
    Read,
    /// 执行（HTTP 请求等资源消耗动作）：恒允许（随执行域命令引入）
    Execute,
    /// 写入：可配（settings `cli` 键族预留 `permissions` 子对象，键形待定）；
    /// 配置落地前按拒绝（fail-closed——新写命令不得在无配置时静默放行）
    Write,
    /// 高危：恒拒（硬编码，不接受配置放行；落地前须过默认策略审查）
    Dangerous,
}
