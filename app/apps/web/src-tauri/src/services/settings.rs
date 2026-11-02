//! settings 服务：SQLite 写穿 + 常驻内存缓存 + 键生效编排单点。
//!
//! 读路径：启动时 `load_all` 全量灌入缓存，`get_boot_settings` 直接走缓存直出；
//! 写路径：`set` 先落 SQLite 成功后再更新缓存（写穿，DB 是唯一真值来源），
//! 随后查键注册表执行旁路生效动作；boot 校正（`correct_on_boot`）对快照
//! 逐键查同一注册表，两入口共用一套「键 → 生效动作」映射。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde_json::{Value, json};
use sqlx::SqlitePool;
use tauri::AppHandle;

use crate::constants::{MAX_SETTING_KEYS, MAX_SETTING_VALUE_BYTES};
use crate::error::AppError;

/// settings 内存缓存。启动灌入全量，此后与写操作保持同步。
/// 锁中毒仅可能发生在持锁写入 panic 时；HashMap 不因中毒而损坏，
/// 取回内部数据继续使用即可（不让 panic 沿锁扩散成不可恢复状态）。
#[derive(Default)]
pub struct SettingsCache {
    inner: RwLock<HashMap<String, Value>>,
}

impl SettingsCache {
    /// 全量替换缓存内容（启动 `load_all` 专用）
    pub fn replace_all(&self, map: HashMap<String, Value>) {
        *self.lock_write() = map;
    }

    /// 写穿后的缓存同步
    pub fn insert(&self, key: String, value: Value) {
        self.lock_write().insert(key, value);
    }

    /// 快照直出（`get_boot_settings` 载荷）
    pub fn snapshot(&self) -> HashMap<String, Value> {
        self.lock_read().clone()
    }

    pub fn contains(&self, key: &str) -> bool {
        self.lock_read().contains_key(key)
    }

    pub fn len(&self) -> usize {
        self.lock_read().len()
    }

    fn lock_read(&self) -> std::sync::RwLockReadGuard<'_, HashMap<String, Value>> {
        self.inner
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn lock_write(&self) -> std::sync::RwLockWriteGuard<'_, HashMap<String, Value>> {
        self.inner
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// 精确键白名单：theme / locale / devMode / logLevel 为首批，
/// logDir、updateSource 与 autoCheckUpdates 为后续追加；
/// 工作台三键：当前工作空间、命令键位覆盖表（JSON 仅存覆盖项）、左栏宽度持久化
const EXACT_KEYS: &[&str] = &[
    "theme",
    "locale",
    "devMode",
    "logLevel",
    "logDir",
    "updateSource",
    "autoCheckUpdates",
    "workspace.current",
    "keybindings",
    "shell.leftPanelWidth",
    // HTTP 设置组（全局单键：超时档 / 重定向 / TLS 校验 / 代理）——机器与网络
    // 语境，不随工作空间切换；写入经 EffectHost 通知 HttpService 重建 Client
    "http",
    // 状态栏固定工作流（每工作空间至多一个，workspaceId → workflowId 映射；
    // UI 偏好无副作用，落库即终态）
    "workflowPins",
];

/// 预留组前缀：`http.*`（写权限先放行，具体键语义由后续阶段定义）。
/// 备份为手动导出 / 恢复的 IPC 动作，零设置键，不设预留前缀
const RESERVED_PREFIXES: &[&str] = &["http."];

fn ensure_key_allowed(key: &str) -> Result<(), AppError> {
    if EXACT_KEYS.contains(&key)
        || RESERVED_PREFIXES
            .iter()
            .any(|prefix| key.starts_with(prefix))
    {
        Ok(())
    } else {
        Err(AppError::new(
            crate::error::codes::SETTINGS_UNKNOWN_KEY,
            format!("unknown setting key: {key}"),
        ))
    }
}

// —— 键副作用注册表（单点）：哪个设置键有什么生效动作 ——

/// 设置键生效动作。新增副作用键 = [`effect_of`] 加一行 +（如需新的执行面）
/// [`EffectHost`] 增方法，写后生效与 boot 校正自动共用，不再散布编排。
#[derive(Debug, Clone, PartialEq, Eq)]
enum KeyEffect {
    /// 无副作用（落库即终态：theme / locale / updateSource / 预留组等）
    None,
    /// 日志级别热更（改级即时生效；boot 校正同入口）
    LogLevel,
    /// DevTools 门控热更（运行时写库触发；boot 侧走窗口创建初值，
    /// 见 [`devtools_initial`]——F12 加速键只认 webview 创建时的值）
    DevMode,
    /// 日志目录：重启生效语义，仅 boot 校正执行切换/搬移/清理，
    /// 运行时写库无旁路动作
    LogDir,
    /// HTTP 设置组：写后经 EffectHost 通知 HttpService 重建 Client
    /// （在途请求持旧 Client Arc 不受影响，新请求即生效）；boot 侧由
    /// AppState 装配时按缓存值构建，不经 correct_on_boot
    Http,
}

/// 键 → 生效动作映射（注册表本体）。
fn effect_of(key: &str) -> KeyEffect {
    match key {
        "logLevel" => KeyEffect::LogLevel,
        "devMode" => KeyEffect::DevMode,
        "logDir" => KeyEffect::LogDir,
        "http" => KeyEffect::Http,
        _ => KeyEffect::None,
    }
}

/// 生效动作执行面：生效编排经此执行，服务层不直接依赖 AppHandle，
/// 测试以记录式宿主替换（真实宿主 = [`AppHost`]）。
/// Send + Sync 超界：async 写路径跨 await 持有 `&dyn EffectHost`。
pub trait EffectHost: Send + Sync {
    /// 日志级别热更
    fn apply_log_level(&self, value: &Value);
    /// DevTools 门控热更
    fn apply_dev_mode(&self, enabled: bool);
    /// HTTP 设置组生效：重建 HttpService 的 Client（快照缓存＋变更重建）
    fn apply_http(&self, value: &Value);
}

/// 真实宿主：logging / devtools 服务落地（Command 层与 setup 装配）。
pub struct AppHost<'a> {
    app: &'a AppHandle,
}

impl AppHost<'_> {
    pub fn new(app: &AppHandle) -> AppHost<'_> {
        AppHost { app }
    }
}

impl EffectHost for AppHost<'_> {
    fn apply_log_level(&self, value: &Value) {
        crate::services::logging::apply_log_level_setting(value);
    }

    fn apply_dev_mode(&self, enabled: bool) {
        crate::services::devtools::apply_enabled(self.app, enabled);
    }

    fn apply_http(&self, value: &Value) {
        // 写后重建：命令期 AppState 必已 manage；解析失败（库内脏值）降级保留旧
        // Client 并留痕，下次写入或重启校正
        use tauri::Manager;
        let state = self.app.state::<crate::AppState>();
        match crate::services::http::HttpSettings::from_value(value) {
            Ok(settings) => {
                if let Err(err) = state.http.rebuild(settings) {
                    tracing::warn!(code = %err.code, message = %err.message, "http client rebuild failed");
                }
            }
            Err(err) => {
                tracing::warn!(code = %err.code, message = %err.message, "stored http setting invalid, keeping current client");
            }
        }
    }
}

/// 注册表运行时执行面：写后生效与 boot 校正共用（boot 对快照逐键调同一映射）。
fn apply_runtime_effect(host: &dyn EffectHost, effect: KeyEffect, value: &Value) {
    match effect {
        KeyEffect::LogLevel => host.apply_log_level(value),
        KeyEffect::DevMode => {
            host.apply_dev_mode(crate::services::devtools::enabled_from_value(value))
        }
        KeyEffect::Http => host.apply_http(value),
        // 无副作用与重启生效键（logDir）运行时无动作
        KeyEffect::None | KeyEffect::LogDir => {}
    }
}

/// 写单个设置键：校验 → 落库 → 查注册表生效（`set_setting` 转发的唯一业务入口）。
pub async fn set(
    host: &dyn EffectHost,
    pool: &SqlitePool,
    cache: &SettingsCache,
    key: &str,
    value: Value,
) -> Result<(), AppError> {
    validate_value(key, &value)?;
    persist(pool, cache, key, &value).await?;
    apply_runtime_effect(host, effect_of(key), &value);
    Ok(())
}

/// 结构化键的值校验（写前 fail-fast，防脏值落库后才在生效点降级）。
fn validate_value(key: &str, value: &Value) -> Result<(), AppError> {
    match key {
        "http" => crate::services::http::HttpSettings::from_value(value).map(|_| ()),
        _ => Ok(()),
    }
}

/// 校验与落库（白名单 → 大小上限 → 键数上限 → SQLite upsert → 缓存同步）。
async fn persist(
    pool: &SqlitePool,
    cache: &SettingsCache,
    key: &str,
    value: &Value,
) -> Result<(), AppError> {
    ensure_key_allowed(key)?;
    let serialized = serde_json::to_string(value)
        .map_err(|err| AppError::internal(format!("setting value is not serializable: {err}")))?;
    if serialized.len() > MAX_SETTING_VALUE_BYTES {
        return Err(AppError::new(
            crate::error::codes::SETTINGS_VALUE_TOO_LARGE,
            format!("setting value exceeds {MAX_SETTING_VALUE_BYTES} bytes"),
        )
        .with_details(json!({ "limit": MAX_SETTING_VALUE_BYTES, "actual": serialized.len() })));
    }
    // 缓存有界：新键才占额度；覆盖既有键不受限
    if !cache.contains(key) && cache.len() >= MAX_SETTING_KEYS {
        return Err(AppError::new(
            crate::error::codes::SETTINGS_KEY_LIMIT_EXCEEDED,
            format!("setting key count exceeds {MAX_SETTING_KEYS}"),
        )
        .with_details(json!({ "limit": MAX_SETTING_KEYS })));
    }
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES (?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(&serialized)
    .execute(pool)
    .await?;
    cache.insert(key.to_owned(), value.clone());
    Ok(())
}

// —— boot 校正（重启生效语义的启动端）——

/// logDir 的 boot 校正决策（纯函数，可测）：快照值 → 应切换到的自定义目录；
/// 未配置（null / 缺失 / 空白）或与当前目录相同 → None（无需切换）。
fn boot_log_dir_target(value: &Value, active_dir: &Path) -> Option<PathBuf> {
    let custom = crate::services::logging::log_dir_from_value(value)?;
    (custom != active_dir).then_some(custom)
}

/// boot 校正（setup 读库后调用）：对快照逐键查注册表——LogLevel 经与写后
/// 生效相同的执行面热更；LogDir 在此收口 boot 编排（切目录 → 搬移旧滚动
/// 日志 → 最终目录滚动清理），目录不可用降级保持不阻断启动。返回最终生效
/// 日志目录。DevMode 的 boot 侧是窗口创建初值（[`devtools_initial`]），不经此路。
pub fn correct_on_boot(
    host: &dyn EffectHost,
    snapshot: &HashMap<String, Value>,
    default_log_dir: &Path,
) -> PathBuf {
    let mut active_dir = default_log_dir.to_path_buf();
    for (key, value) in snapshot {
        match effect_of(key) {
            KeyEffect::LogLevel => apply_runtime_effect(host, KeyEffect::LogLevel, value),
            KeyEffect::LogDir => {
                let Some(custom) = boot_log_dir_target(value, &active_dir) else {
                    continue;
                };
                match crate::services::logging::switch_log_dir(&custom) {
                    Ok(()) => {
                        let (moved, left) =
                            crate::services::logging::migrate_log_files(&active_dir, &custom);
                        tracing::info!(moved, left, target = %custom.display(), "log dir switched on boot");
                        active_dir = custom;
                    }
                    Err(err) => {
                        tracing::warn!(code = %err.code, message = %err.message, "custom log dir unavailable, keeping default")
                    }
                }
            }
            // DevMode 运行时热更形态不适用启动期（窗口尚未创建）；Http 的 boot 侧
            // 由 AppState / AppContext 装配时按缓存值构建（不经此路）；None 无动作
            KeyEffect::DevMode | KeyEffect::Http | KeyEffect::None => {}
        }
    }
    // 滚动清理在最终生效目录上执行
    crate::services::logging::prune_old_logs(&active_dir);
    active_dir
}

/// devMode 的建窗初值（boot 侧生效形态）：F12 原生加速键只认 webview
/// 创建时的 AreDevToolsEnabled，主窗口按此值构建；读库失败 / 键缺失按关。
pub fn devtools_initial(snapshot: &HashMap<String, Value>) -> bool {
    snapshot
        .get("devMode")
        .map(crate::services::devtools::enabled_from_value)
        .unwrap_or(false)
}

/// 启动全量读取并灌入缓存。库中脏数据（非合法 JSON）不炸启动：
/// 记 warn 后按缺失处理，前端回退默认值（Zod 兜底由前端负责）。
/// 键数超 `MAX_SETTING_KEYS` 时截断并 warn（正常写入路径有同款上限，
/// 此处只防绕过 IPC 的库外改动撑爆缓存）。
pub async fn load_all(pool: &SqlitePool, cache: &SettingsCache) -> Result<(), AppError> {
    let mut rows: Vec<(String, String)> = sqlx::query_as("SELECT key, value FROM settings")
        .fetch_all(pool)
        .await?;
    if rows.len() > MAX_SETTING_KEYS {
        tracing::warn!(
            count = rows.len(),
            limit = MAX_SETTING_KEYS,
            "settings row count exceeds limit, keeping first {MAX_SETTING_KEYS}"
        );
        rows.truncate(MAX_SETTING_KEYS);
    }
    let mut map = HashMap::with_capacity(rows.len());
    for (key, raw) in rows {
        match serde_json::from_str::<Value>(&raw) {
            Ok(value) => {
                map.insert(key, value);
            }
            Err(err) => {
                tracing::warn!(key = %key, error = %err, "setting value is not valid JSON, ignored");
            }
        }
    }
    cache.replace_all(map);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    /// 记录式宿主：生效动作调用留痕（编排测试断言用）
    #[derive(Default)]
    struct RecordingHost {
        log_levels: std::sync::Mutex<Vec<Value>>,
        dev_modes: std::sync::Mutex<Vec<bool>>,
        http_values: std::sync::Mutex<Vec<Value>>,
    }

    impl RecordingHost {
        fn log_levels(&self) -> Vec<Value> {
            self.log_levels
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        }

        fn dev_modes(&self) -> Vec<bool> {
            self.dev_modes
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        }

        fn http_values(&self) -> Vec<Value> {
            self.http_values
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        }
    }

    impl EffectHost for RecordingHost {
        fn apply_log_level(&self, value: &Value) {
            self.log_levels
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(value.clone());
        }

        fn apply_dev_mode(&self, enabled: bool) {
            self.dev_modes
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(enabled);
        }

        fn apply_http(&self, value: &Value) {
            self.http_values
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(value.clone());
        }
    }

    /// 测试专用内存库（单连接 + 生产同款迁移）
    async fn memory_pool() -> SqlitePool {
        let pool = db::connect_in_memory().await;
        db::run_migrations(&pool).await.unwrap();
        pool
    }

    #[test]
    fn effect_registry_maps_keys_to_actions() {
        assert_eq!(effect_of("logLevel"), KeyEffect::LogLevel);
        assert_eq!(effect_of("devMode"), KeyEffect::DevMode);
        assert_eq!(effect_of("logDir"), KeyEffect::LogDir);
        // 无副作用键与未知键同归 None
        assert_eq!(effect_of("theme"), KeyEffect::None);
        assert_eq!(effect_of("http.x"), KeyEffect::None);
        assert_eq!(effect_of("nope"), KeyEffect::None);
    }

    #[tokio::test]
    async fn set_persists_and_load_all_restores() {
        let pool = memory_pool().await;
        let cache = SettingsCache::default();
        let host = RecordingHost::default();
        set(
            &host,
            &pool,
            &cache,
            "theme",
            json!({"preference":"dark","accent":"teal"}),
        )
        .await
        .unwrap();

        // 写穿后缓存可直出
        assert_eq!(
            cache.snapshot().get("theme").unwrap(),
            &json!({"preference":"dark","accent":"teal"})
        );

        // 重启模拟：全新缓存从库中恢复
        let fresh = SettingsCache::default();
        load_all(&pool, &fresh).await.unwrap();
        assert_eq!(
            fresh.snapshot().get("theme").unwrap(),
            &json!({"preference":"dark","accent":"teal"})
        );
    }

    #[tokio::test]
    async fn set_overwrites_existing_value() {
        let pool = memory_pool().await;
        let cache = SettingsCache::default();
        let host = RecordingHost::default();
        set(&host, &pool, &cache, "logLevel", json!("info"))
            .await
            .unwrap();
        set(&host, &pool, &cache, "logLevel", json!("debug"))
            .await
            .unwrap();
        assert_eq!(cache.snapshot().get("logLevel").unwrap(), &json!("debug"));
    }

    #[tokio::test]
    async fn set_dispatches_registered_effects_after_persist() {
        // 写后生效入口：注册表内的键触发旁路动作，且只在落库成功后触发
        let pool = memory_pool().await;
        let cache = SettingsCache::default();
        let host = RecordingHost::default();

        set(&host, &pool, &cache, "logLevel", json!({"level":"debug"}))
            .await
            .unwrap();
        assert_eq!(host.log_levels(), vec![json!({"level":"debug"})]);

        set(&host, &pool, &cache, "devMode", json!({"enabled":true}))
            .await
            .unwrap();
        assert_eq!(host.dev_modes(), vec![true]);

        // http 键：写后经 EffectHost 通知重建 Client（RecordingHost 留痕）
        let http_value = json!({
            "timeoutSeconds": 30,
            "redirect": true,
            "tlsVerify": true,
            "proxy": {"mode": "none", "url": null}
        });
        set(&host, &pool, &cache, "http", http_value.clone())
            .await
            .unwrap();
        assert_eq!(host.http_values(), vec![http_value]);

        // 注册表外与重启生效键无运行时动作
        set(&host, &pool, &cache, "theme", json!({"preference":"dark"}))
            .await
            .unwrap();
        set(&host, &pool, &cache, "logDir", json!({"path":"D:\\Logs"}))
            .await
            .unwrap();
        assert!(
            host.log_levels().len() == 1
                && host.dev_modes().len() == 1
                && host.http_values().len() == 1
        );
    }

    #[tokio::test]
    async fn http_key_value_is_validated_before_persist() {
        // 写前 fail-fast：脏值不落库、不触发生效
        let pool = memory_pool().await;
        let cache = SettingsCache::default();
        let host = RecordingHost::default();
        let err = set(
            &host,
            &pool,
            &cache,
            "http",
            json!({"timeoutSeconds": "soon"}),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "INVALID_ARGUMENT");
        assert!(host.http_values().is_empty());
        assert!(!cache.snapshot().contains_key("http"));
        // custom 代理缺 url 同样拒绝
        let err = set(
            &host,
            &pool,
            &cache,
            "http",
            json!({"proxy": {"mode": "custom"}}),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "INVALID_ARGUMENT");
    }

    #[tokio::test]
    async fn failed_persist_dispatches_no_effect() {
        let pool = memory_pool().await;
        let cache = SettingsCache::default();
        let host = RecordingHost::default();
        let err = set(&host, &pool, &cache, "evil.key", json!(1))
            .await
            .unwrap_err();
        assert_eq!(err.code, "SETTINGS_UNKNOWN_KEY");
        assert!(host.log_levels().is_empty() && host.dev_modes().is_empty());
    }

    #[tokio::test]
    async fn unknown_key_is_rejected() {
        let pool = memory_pool().await;
        let cache = SettingsCache::default();
        let host = RecordingHost::default();
        let err = set(&host, &pool, &cache, "evil.key", json!(1))
            .await
            .unwrap_err();
        assert_eq!(err.code, "SETTINGS_UNKNOWN_KEY");
        // 仅前缀相似（httpx.）不算预留组，同样拒绝
        let err = set(&host, &pool, &cache, "httpx.mode", json!(1))
            .await
            .unwrap_err();
        assert_eq!(err.code, "SETTINGS_UNKNOWN_KEY");
    }

    #[tokio::test]
    async fn reserved_prefix_keys_are_allowed() {
        let pool = memory_pool().await;
        let cache = SettingsCache::default();
        let host = RecordingHost::default();
        set(&host, &pool, &cache, "http.timeout", json!(30))
            .await
            .unwrap();
        assert_eq!(cache.snapshot().len(), 1);
    }

    /// 已删预留前缀按未知键拒绝：备份为手动 IPC 动作零设置键，
    /// editor / sync 组已移除；未来需要时再白名单加回
    #[tokio::test]
    async fn removed_reserved_prefix_keys_are_rejected() {
        let pool = memory_pool().await;
        let cache = SettingsCache::default();
        let host = RecordingHost::default();
        for key in ["backup.enabled", "sync.mode", "editor.font"] {
            let err = set(&host, &pool, &cache, key, json!(1)).await.unwrap_err();
            assert_eq!(err.code, "SETTINGS_UNKNOWN_KEY", "前缀 {key} 应已删除");
        }
        assert!(cache.snapshot().is_empty());
    }

    #[tokio::test]
    async fn oversized_value_is_rejected() {
        let pool = memory_pool().await;
        let cache = SettingsCache::default();
        let host = RecordingHost::default();
        let big = "x".repeat(MAX_SETTING_VALUE_BYTES + 1);
        let err = set(&host, &pool, &cache, "theme", json!(big))
            .await
            .unwrap_err();
        assert_eq!(err.code, "SETTINGS_VALUE_TOO_LARGE");
        assert_eq!(
            err.details.as_ref().unwrap()["limit"],
            MAX_SETTING_VALUE_BYTES
        );
        // 恰好处于上限内的值可写（字符串 JSON 带两个引号）
        let edge = "x".repeat(MAX_SETTING_VALUE_BYTES - 2);
        set(&host, &pool, &cache, "theme", json!(edge))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn key_count_limit_is_enforced() {
        let pool = memory_pool().await;
        let cache = SettingsCache::default();
        let host = RecordingHost::default();
        // 填满额度（MAX_SETTING_KEYS 个新键）
        for i in 0..MAX_SETTING_KEYS {
            set(&host, &pool, &cache, &format!("http.k{i}"), json!(i))
                .await
                .unwrap();
        }
        // 再写新键 → 拒绝
        let err = set(&host, &pool, &cache, "http.overflow", json!(1))
            .await
            .unwrap_err();
        assert_eq!(err.code, "SETTINGS_KEY_LIMIT_EXCEEDED");
        // 覆盖既有键不受限
        set(&host, &pool, &cache, "http.k0", json!("updated"))
            .await
            .unwrap();
        assert_eq!(cache.snapshot().get("http.k0").unwrap(), &json!("updated"));
    }

    #[tokio::test]
    async fn load_all_skips_invalid_json_rows() {
        let pool = memory_pool().await;
        sqlx::query("INSERT INTO settings (key, value) VALUES ('broken', 'not-json')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO settings (key, value) VALUES ('devMode', '{\"enabled\":true}')")
            .execute(&pool)
            .await
            .unwrap();
        let cache = SettingsCache::default();
        load_all(&pool, &cache).await.unwrap();
        let snapshot = cache.snapshot();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot.get("devMode").unwrap(), &json!({"enabled":true}));
    }

    // —— boot 校正入口（与写后生效共用注册表）——

    #[test]
    fn boot_log_dir_target_ignores_default_and_blank() {
        let default_dir = PathBuf::from("C:\\Default\\Logs");
        // 配置了不同目录 → 应切换
        assert_eq!(
            boot_log_dir_target(&json!({"path": "D:\\Logs"}), &default_dir),
            Some(PathBuf::from("D:\\Logs"))
        );
        // null / 缺失 / 空白 / 与当前目录相同 → 无需切换
        assert_eq!(
            boot_log_dir_target(&json!({"path": null}), &default_dir),
            None
        );
        assert_eq!(boot_log_dir_target(&json!({}), &default_dir), None);
        assert_eq!(
            boot_log_dir_target(&json!({"path": "  "}), &default_dir),
            None
        );
        assert_eq!(
            boot_log_dir_target(&json!({"path": "C:\\Default\\Logs"}), &default_dir),
            None
        );
    }

    #[test]
    fn correct_on_boot_applies_log_level_via_registry() {
        let host = RecordingHost::default();
        let default_dir = std::env::temp_dir().join(format!("apilot-boot-{}", std::process::id()));
        let snapshot = HashMap::from([
            ("logLevel".to_owned(), json!({"level": "warn"})),
            ("devMode".to_owned(), json!({"enabled": true})),
        ]);
        let active = correct_on_boot(&host, &snapshot, &default_dir);
        // LogLevel 走同一执行面；DevMode 的 boot 侧是建窗初值，不经热更
        assert_eq!(host.log_levels(), vec![json!({"level": "warn"})]);
        assert!(host.dev_modes().is_empty());
        assert_eq!(active, default_dir);
    }

    #[test]
    fn correct_on_boot_downgrades_to_default_when_switch_fails() {
        // 装置未初始化（测试不调 logging::init），switch_log_dir 必然失败：
        // 覆盖「目录切换失败降级保持默认目录，不阻断启动」分支
        let host = RecordingHost::default();
        let default_dir =
            std::env::temp_dir().join(format!("apilot-boot-default-{}", std::process::id()));
        let snapshot =
            HashMap::from([("logDir".to_owned(), json!({"path": "Z:\\Not\\Creatable"}))]);
        let active = correct_on_boot(&host, &snapshot, &default_dir);
        assert_eq!(active, default_dir, "切换失败应保持默认目录");
    }

    #[test]
    fn correct_on_boot_without_effect_keys_keeps_default() {
        let host = RecordingHost::default();
        let default_dir =
            std::env::temp_dir().join(format!("apilot-boot-plain-{}", std::process::id()));
        let snapshot = HashMap::from([("theme".to_owned(), json!({"preference": "dark"}))]);
        let active = correct_on_boot(&host, &snapshot, &default_dir);
        assert_eq!(active, default_dir);
        assert!(host.log_levels().is_empty() && host.dev_modes().is_empty());
    }

    #[test]
    fn devtools_initial_reads_snapshot_leniently() {
        let snapshot = HashMap::from([("devMode".to_owned(), json!({"enabled": true}))]);
        assert!(devtools_initial(&snapshot));
        let snapshot = HashMap::from([("devMode".to_owned(), json!({"enabled": false}))]);
        assert!(!devtools_initial(&snapshot));
        // 形态异常 / 键缺失按关（门控默认从紧）
        let snapshot = HashMap::from([("devMode".to_owned(), json!("bogus"))]);
        assert!(!devtools_initial(&snapshot));
        assert!(!devtools_initial(&HashMap::new()));
    }
}
