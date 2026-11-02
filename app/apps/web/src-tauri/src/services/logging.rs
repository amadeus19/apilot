//! 日志装置：tracing 全量装置——
//! EnvFilter 由 `logLevel` 设置驱动（改级即时生效，reload 层）、
//! tracing-appender 按日滚动文件（`app_log_dir()`，可经 `logDir` 设置在
//! boot 期切换到自定义目录，重启生效语义）、内存环形缓冲
//! （`MAX_LOG_ENTRIES` 封顶，诊断导出数据源）。
//!
//! **敏感值不落日志规则（先立后用）**：API Key / Token / Password /
//! Cookie / Secret / Authorization 头及其结构体字段，禁止以任何级别写入日志；
//! 排查确需引用敏感值时只记录长度与前缀哈希。后续 code review 按此检查项执行。
//!
//! 资源四问：WorkerGuard 存于 static 的 `Mutex<Option<_>>`，常驻期间 worker
//! 每批事件后自行 flush；**显式 flush 唯一入口是 [`shutdown_flush`]（take guard
//! → drop 触发 worker Shutdown 并等待清空，上限 1s）**——Rust static 项退出
//! 时不运行 Drop，panic unwind 下缓冲日志不保证落盘，退出路径必须显式调用
//! （由 Shutdown 序列接线）。环形缓冲按条数封顶、单行截断，无 unbounded
//! 增长；文件滚动超限删旧。

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, RwLock, RwLockReadGuard};

use tracing_appender::non_blocking::{NonBlocking, WorkerGuard};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, reload};

use crate::constants::{LOG_LINE_MAX_BYTES, MAX_LOG_ENTRIES, MAX_LOG_FILES};
use crate::error::AppError;

// —— 进程级装置句柄（init 一次，随进程生命周期）——

static LOG_GUARD: Mutex<Option<WorkerGuard>> = Mutex::new(None);
static LOG_RELOAD: OnceLock<reload::Handle<EnvFilter, tracing_subscriber::Registry>> =
    OnceLock::new();
static RING: OnceLock<RingBuffer> = OnceLock::new();
/// 当前生效级别快照（reload 层无 getter，set_level 时同步维护；诊断摘要读数）
static CURRENT_LEVEL: OnceLock<Mutex<String>> = OnceLock::new();
/// 文件落地路由（init 灌入，switch_log_dir boot 单次替换）
static FILE_ROUTE: OnceLock<FileRoute> = OnceLock::new();

// —— 环形缓冲：诊断导出数据源（get_diagnostics / 设置面板「复制诊断信息」）——

#[derive(Clone)]
struct RingBuffer {
    inner: std::sync::Arc<Mutex<RingInner>>,
}

struct RingInner {
    lines: std::collections::VecDeque<String>,
    /// 因单行截断丢弃的字节数累计（诊断可见，不撑内存）
    dropped_bytes: u64,
}

impl RingBuffer {
    fn new() -> Self {
        Self {
            inner: std::sync::Arc::new(Mutex::new(RingInner {
                lines: std::collections::VecDeque::with_capacity(MAX_LOG_ENTRIES),
                dropped_bytes: 0,
            })),
        }
    }

    fn lock(&self) -> MutexGuard<'_, RingInner> {
        // 锁中毒仅可能发生在持锁写入 panic 时；VecDeque 不因中毒损坏，
        // 取回内部数据继续使用即可（不让 panic 沿锁扩散）
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn push_line(&self, line: &str) {
        let mut dropped = 0u64;
        let owned: String;
        let line = if line.len() > LOG_LINE_MAX_BYTES {
            // 按字符边界截断（日志内容可含多字节中文，直接按字节切会撕开 UTF-8）
            let mut end = LOG_LINE_MAX_BYTES;
            while !line.is_char_boundary(end) {
                end -= 1;
            }
            dropped = (line.len() - end) as u64;
            owned = format!("{} [truncated {dropped} bytes]", &line[..end]);
            owned.as_str()
        } else {
            line
        };
        let mut guard = self.lock();
        guard.dropped_bytes += dropped;
        guard.push_line_inner(line.to_owned());
    }

    fn len(&self) -> usize {
        self.lock().lines.len()
    }
}

impl RingInner {
    fn push_line_inner(&mut self, line: String) {
        if self.lines.len() >= MAX_LOG_ENTRIES {
            self.lines.pop_front();
        }
        self.lines.push_back(line);
    }
}

/// fmt 层输出按行进入环形缓冲：write 调用可能分段，累积到 \n 成条入队。
/// 阻塞写入（Mutex 内仅内存操作，微秒级），不走 non_blocking——
/// 诊断读数与写入同锁，读到的快照是完整的。
impl Write for RingBuffer {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // 已知边界：write 调用边界恰好切开多字节字符时产生 U+FFFD 替换符
        // （fmt 层整事件单次 write，实际概率极低）
        let text = String::from_utf8_lossy(buf);
        for segment in text.split_inclusive('\n') {
            match segment.strip_suffix('\n') {
                Some(complete) => self.push_line(complete.trim_end_matches('\r')),
                None => self.push_line(segment),
            }
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

// —— 双写 writer：文件（滚动，路由可切换）+ 环形缓冲，单次格式化两路落地 ——

/// 文件落地路由：内部 `Arc<RwLock<NonBlocking>>`，write 时短暂读锁 clone 当前
/// 句柄；[`switch_log_dir`] 走写侧原子替换（boot 单次：logDir 配置生效）。
#[derive(Clone)]
struct FileRoute(Arc<RwLock<NonBlocking>>);

impl FileRoute {
    fn lock_read(&self) -> RwLockReadGuard<'_, NonBlocking> {
        // 锁中毒仅可能发生在持锁替换 panic 时；NonBlocking 克隆句柄不因中毒损坏，
        // 取回继续使用（与本项目其他锁同款恢复策略）
        self.0
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn lock_write(&self) -> std::sync::RwLockWriteGuard<'_, NonBlocking> {
        self.0
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

struct CombinedWriter {
    file: FileRoute,
    ring: RingBuffer,
}

impl Write for CombinedWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // 环形缓冲失败不阻断文件落地（诊断数据源尽力而为）
        let _ = self.ring.write(buf);
        self.file.lock_read().clone().write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.lock_read().clone().flush()
    }
}

// —— 装置初始化与级别热更新 ——

/// 初始化全局日志装置：默认 `info` 级（boot 读库前的兜底）、默认目录
/// （`app_log_dir()`）落地；DB 就绪后由 setup 按 `logLevel` 调 [`set_level`]、
/// 按 `logDir` 调 [`switch_log_dir`] 校正（重启生效语义的 boot 端）。
pub fn init(log_dir: &Path) {
    let file_appender = tracing_appender::rolling::daily(log_dir, "apilot.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    // guard 存 Mutex<Option<_>>：常驻期间 worker 每批事件后自行 flush；
    // 显式落盘 flush 经 shutdown_flush()（见模块头资源四问说明）
    match LOG_GUARD.lock() {
        Ok(mut slot) => *slot = Some(guard),
        Err(_) => {
            // init 在 setup 钩子单调用点执行，锁竞争理论不可达；毒化时放弃 guard
            eprintln!("[apilot2] LOG_GUARD poisoned, file logs will not flush on shutdown");
        }
    }

    let ring = RingBuffer::new();
    let _ = RING.set(ring.clone());
    let _ = CURRENT_LEVEL.set(Mutex::new("info".to_owned()));

    let route = FileRoute(Arc::new(RwLock::new(non_blocking)));
    let _ = FILE_ROUTE.set(route.clone());

    let ring_for_layer = ring.clone();
    let (filter_layer, reload_handle) = reload::Layer::new(EnvFilter::new("info"));
    let _ = LOG_RELOAD.set(reload_handle);

    let fmt_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_writer(move || CombinedWriter {
            file: route.clone(),
            ring: ring_for_layer.clone(),
        });

    tracing_subscriber::registry()
        .with(filter_layer)
        .with(fmt_layer)
        .init();
}

/// 日志目录切换（**boot 单次动作、非运行时热切换**——`logDir` 设置
/// 的生效语义是重启，此处只服务 boot 读库后的校正）：以新目录重建 rolling
/// appender 并原子替换文件路由（新事件即刻写新目录），随后旧 worker guard
/// 被 drop（排空缓冲、释放旧目录文件句柄）——调用方在 Ok 后可安全搬移旧
/// 目录文件。新目录创建失败返回 Err 且装置保持默认目录（降级不阻断启动）。
pub fn switch_log_dir(new_dir: &Path) -> Result<(), AppError> {
    fs::create_dir_all(new_dir).map_err(|err| {
        AppError::new(
            crate::error::codes::IO_CREATE_DIR_FAILED,
            format!(
                "failed to create custom log dir {}: {err}",
                new_dir.display()
            ),
        )
    })?;
    let Some(route) = FILE_ROUTE.get() else {
        // 理论不可达：switch 仅在 boot init 之后调用；防御性放弃切换
        tracing::warn!("log dir switch requested before logging init, ignored");
        return Err(AppError::internal("logging not initialized"));
    };
    let file_appender = tracing_appender::rolling::daily(new_dir, "apilot.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    // 1. 原子替换路由（此后新事件写新目录）
    *route.lock_write() = non_blocking;
    // 2. 旧 worker 排空并释放旧目录句柄（Windows 上句柄未释放则文件不可搬）
    let old_guard = LOG_GUARD
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
    drop(old_guard);
    // 3. 换上新 guard（shutdown_flush 收口语义不变）
    *LOG_GUARD
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(guard);
    Ok(())
}

/// 显式 flush：take guard → drop 触发 worker Shutdown 并等待队列清空（上限 1s）。
/// 幂等（已 take 后 no-op）。Shutdown 序列与 RunEvent::Exit
/// 兜底各调一次（Rust static 项退出不运行 Drop，panic unwind 的缓冲日志
/// 亦依赖此入口）。
pub fn shutdown_flush() {
    let guard = match LOG_GUARD.lock() {
        Ok(mut slot) => slot.take(),
        Err(poisoned) => poisoned.into_inner().take(),
    };
    drop(guard);
}

/// 日志级别热更新（改级即时生效）：`logLevel` 设置写库成功后由
/// command 层调用。非法级别保持当前值（前端 Zod 已校验，此处对绕过 IPC 的
/// 直调宽容，仅记内部 warn）。
pub fn set_level(level: &str) {
    let Some(handle) = LOG_RELOAD.get() else {
        tracing::warn!("log level reload requested before logging init, ignored");
        return;
    };
    let filter = EnvFilter::try_new(level);
    match filter {
        Ok(filter) => {
            if let Err(err) = handle.reload(filter) {
                tracing::warn!(error = %err, "failed to reload log level filter");
            } else if let Some(current) = CURRENT_LEVEL.get() {
                // 锁中毒取回数据继续写（与 SettingsCache 同款恢复策略）
                *current
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = level.to_owned();
            }
        }
        Err(err) => {
            tracing::warn!(level = %level, error = %err, "invalid log level, keeping current");
        }
    }
}

/// logLevel 设置 value（形态 `{"level":"..."}`）的宽松解析与生效——
/// set_setting 写路径与 boot 校正路径经 settings 服务的键注册表统一汇入
/// （级别解析逻辑单点；生效编排见 services/settings.rs 的 EffectHost）。
pub fn apply_log_level_setting(value: &serde_json::Value) {
    if let Some(level) = value.get("level").and_then(|v| v.as_str()) {
        set_level(level);
    }
}

/// 当前生效级别快照（诊断摘要用；装置未初始化时为默认 info）。
pub fn current_level() -> String {
    CURRENT_LEVEL
        .get()
        .map(|current| {
            current
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        })
        .unwrap_or_else(|| "info".to_owned())
}

/// 环形缓冲快照（诊断导出数据源）。
/// 设置面板「复制诊断信息」预留的数据源；暂无调用方（登记处语义）。
#[allow(dead_code)]
pub fn ring_snapshot() -> Vec<String> {
    match RING.get() {
        Some(ring) => ring.lock().lines.iter().cloned().collect(),
        None => Vec::new(),
    }
}

/// 环形缓冲当前条数。
pub fn ring_len() -> usize {
    RING.get().map(|ring| ring.len()).unwrap_or(0)
}

/// `logDir` 设置 value（形态 `{"path": string|null}`）解析：null / 缺失 / 空串
/// = None（维持默认目录）；非空字符串 = Some(路径)。boot 校正单点，可单测。
pub fn log_dir_from_value(value: &serde_json::Value) -> Option<PathBuf> {
    value
        .get("path")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// 旧目录滚动日志搬移（boot 尽力而为）：`apilot.log.*` 逐个 move 到
/// 新目录；目标同名已存在时跳过（目标目录可能曾是自定义目录，保留其更新
/// 内容）；被占用 / 权限失败留原地记 warn。任何失败都不阻断启动。
/// 返回 (moved, left_behind)。调用前置：[`switch_log_dir`] 已成功（旧 worker
/// 停止、句柄释放），否则 Windows 上当天文件因占用必然搬不动。
pub fn migrate_log_files(from: &Path, to: &Path) -> (usize, usize) {
    let entries = match fs::read_dir(from) {
        Ok(entries) => entries,
        Err(err) => {
            tracing::warn!(from = %from.display(), error = %err, "log migration source unreadable, skip");
            return (0, 0);
        }
    };
    let mut moved = 0;
    let mut left_behind = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with("apilot.log.") || !entry.path().is_file() {
            continue;
        }
        let target = to.join(name);
        if target.exists() {
            tracing::info!(file = name, target = %target.display(), "log migration target exists, skipped");
            left_behind += 1;
            continue;
        }
        match fs::rename(entry.path(), &target) {
            Ok(()) => moved += 1,
            Err(err) => {
                tracing::warn!(file = name, error = %err, "log migration failed, file left in place");
                left_behind += 1;
            }
        }
    }
    (moved, left_behind)
}

/// 滚动日志文件清理：按文件名倒序保留 `MAX_LOG_FILES` 份，超限删旧。
/// 启动时执行一次；周期清理待 TaskRegistry 落地后接入
/// （每日一次即可，按日滚动一天至多新增一份）。
/// 返回删除的文件数（测试断言用）。非 `apilot.log.*` 命名的文件不触碰。
pub fn prune_old_logs(log_dir: &Path) -> usize {
    let entries = match fs::read_dir(log_dir) {
        Ok(entries) => entries,
        // 目录不存在（首启动）属正常形态；其余失败可观测
        Err(err) => {
            if !log_dir.exists() {
                tracing::warn!(error = %err, "log dir missing, skip pruning");
            } else {
                tracing::warn!(error = %err, "failed to read log dir, skip pruning");
            }
            return 0;
        }
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.starts_with("apilot.log.").then_some(name)
        })
        .collect();
    // 文件名含日期（apilot.log.2026-09-28），字典序即时间序
    names.sort();
    names.reverse();
    let mut removed = 0;
    for stale in names.into_iter().skip(MAX_LOG_FILES) {
        match fs::remove_file(log_dir.join(&stale)) {
            Ok(()) => removed += 1,
            // Windows 上旧日志被防病毒/编辑器占用是常态，宽容跳过下次重试
            Err(err) => {
                tracing::warn!(file = %stale, error = %err, "failed to remove stale log file")
            }
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    fn write_lines(ring: &RingBuffer, count: usize) {
        for i in 0..count {
            ring.push_line(&format!("line {i}"));
        }
    }

    #[test]
    fn ring_caps_at_max_entries_and_drops_oldest() {
        let ring = RingBuffer::new();
        write_lines(&ring, MAX_LOG_ENTRIES + 1000);
        assert_eq!(ring.len(), MAX_LOG_ENTRIES);
        let snapshot = ring_snapshot_of(&ring);
        // 最旧的 1000 条被淘汰，首条是第 1000 号
        assert_eq!(snapshot.first().unwrap(), "line 1000");
        assert_eq!(
            snapshot.last().unwrap(),
            &format!("line {}", MAX_LOG_ENTRIES + 999)
        );
    }

    #[test]
    fn ring_truncates_oversized_lines() {
        let ring = RingBuffer::new();
        let huge = "x".repeat(LOG_LINE_MAX_BYTES + 4096);
        ring.push_line(&huge);
        let snapshot = ring_snapshot_of(&ring);
        assert_eq!(snapshot.len(), 1);
        let line = &snapshot[0];
        assert!(line.len() < huge.len());
        assert!(
            line.contains("[truncated"),
            "截断标注缺失: {}",
            &line[line.len() - 40..]
        );
    }

    fn ring_snapshot_of(ring: &RingBuffer) -> Vec<String> {
        ring.lock().lines.iter().cloned().collect()
    }

    #[test]
    fn write_splits_multisegment_input_by_lines() {
        let ring = RingBuffer::new();
        let mut writer = ring.clone();
        // fmt 层可能分段写：一次 write 含多行、无结尾换行
        writer
            .write_all(b"first\nsecond\nthird-without-newline")
            .unwrap();
        let snapshot = ring_snapshot_of(&ring);
        assert_eq!(snapshot, vec!["first", "second", "third-without-newline"]);
    }

    #[test]
    fn prune_keeps_max_files_and_deletes_oldest() {
        let dir = std::env::temp_dir().join(format!("apilot-prune-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        // 20 份滚动日志 + 1 份无关文件（不得触碰）
        for day in 1..=20 {
            fs::write(dir.join(format!("apilot.log.2026-01-{day:02}")), "log").unwrap();
        }
        fs::write(dir.join("unrelated.txt"), "keep me").unwrap();

        let removed = prune_old_logs(&dir);
        assert_eq!(removed, 20 - MAX_LOG_FILES);
        let mut remain: VecDeque<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        remain.make_contiguous().sort();
        assert_eq!(remain.len(), MAX_LOG_FILES + 1);
        // 剩下的滚动文件是最新的 14 份（01-07..01-20）+ 无关文件
        assert!(remain.contains(&"unrelated.txt".to_owned()));
        assert!(!remain.contains(&"apilot.log.2026-01-01".to_owned()));
        assert!(remain.contains(&format!("apilot.log.2026-01-{:02}", 20 - MAX_LOG_FILES + 1)));

        fs::remove_dir_all(&dir).ok();
    }

    /// 级别过滤行为链（reload 热更新）：不碰全局 subscriber，
    /// with_default 下逐级验证过滤生效。
    #[test]
    fn reload_filter_applies_new_level_immediately() {
        let ring = RingBuffer::new();
        let (filter_layer, handle) = reload::Layer::new(EnvFilter::new("info"));
        let subscriber = tracing_subscriber::registry().with(filter_layer).with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer({
                    let ring = ring.clone();
                    move || ring.clone()
                }),
        );

        tracing::subscriber::with_default(subscriber, || {
            tracing::info!("before reload");
            handle.reload(EnvFilter::new("warn")).unwrap();
            tracing::info!("filtered out after reload");
            tracing::warn!("kept after reload");
        });

        let snapshot = ring_snapshot_of(&ring);
        // fmt 层每行带时间戳/级别/target 前缀，按子串断言
        assert_eq!(
            snapshot.len(),
            2,
            "reload 前后恰两条：{}",
            snapshot.join(" | ")
        );
        assert!(snapshot[0].contains("before reload"));
        assert!(snapshot[1].contains("kept after reload"));
        assert!(!snapshot.iter().any(|line| line.contains("filtered out")));
    }

    #[test]
    fn set_level_tolerates_missing_handle() {
        // 本套测试不调全局 init（set_global_default 仅可设一次），
        // 覆盖 handle 缺失分支：静默 warn 返回而非 panic。
        // try_new 的 Err 分支需注入式 handle 才可单测，当前实现直连
        // LOG_RELOAD，接受由「非法值宽容保持当前级别」的代码审读保证。
        set_level("definitely-not-a-level");
    }

    /// 临时目录工作台（每用例独立前缀，收尾清理）
    fn temp_workdir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("apilot-migrate-{tag}-{}", std::process::id()));
        fs::remove_dir_all(&dir).ok();
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn log_dir_from_value_parses_path_and_treats_blank_as_default() {
        assert_eq!(
            log_dir_from_value(&serde_json::json!({"path": "D:\\Logs"})),
            Some(PathBuf::from("D:\\Logs"))
        );
        // null / 缺失 / 空串 / 纯空白 = 默认目录
        assert_eq!(log_dir_from_value(&serde_json::json!({"path": null})), None);
        assert_eq!(log_dir_from_value(&serde_json::json!({})), None);
        assert_eq!(
            log_dir_from_value(&serde_json::json!({"path": "   "})),
            None
        );
        // path 非字符串（脏数据）按默认处理（结构校验由前端 Zod 负责）
        assert_eq!(log_dir_from_value(&serde_json::json!({"path": 42})), None);
    }

    #[test]
    fn migrate_moves_rolling_logs_and_keeps_unrelated_files() {
        let from = temp_workdir("from");
        let to = temp_workdir("to");
        fs::write(from.join("apilot.log.2026-09-27"), "old").unwrap();
        fs::write(from.join("apilot.log.2026-09-28"), "today").unwrap();
        fs::write(from.join("unrelated.txt"), "keep").unwrap();

        let (moved, left) = migrate_log_files(&from, &to);
        assert_eq!((moved, left), (2, 0));
        assert!(to.join("apilot.log.2026-09-27").exists());
        assert!(to.join("apilot.log.2026-09-28").exists());
        assert!(!from.join("apilot.log.2026-09-27").exists());
        // 无关文件不触碰
        assert!(from.join("unrelated.txt").exists());
        assert!(!to.join("unrelated.txt").exists());

        fs::remove_dir_all(&from).ok();
        fs::remove_dir_all(&to).ok();
    }

    #[test]
    fn migrate_skips_existing_target_names_without_overwriting() {
        let from = temp_workdir("from2");
        let to = temp_workdir("to2");
        fs::write(from.join("apilot.log.2026-09-28"), "source").unwrap();
        // 目标已有同名（该目录曾是自定义目录）：跳过且不覆盖
        fs::write(to.join("apilot.log.2026-09-28"), "existing").unwrap();

        let (moved, left) = migrate_log_files(&from, &to);
        assert_eq!((moved, left), (0, 1));
        assert_eq!(
            fs::read_to_string(to.join("apilot.log.2026-09-28")).unwrap(),
            "existing"
        );
        assert!(from.join("apilot.log.2026-09-28").exists());

        fs::remove_dir_all(&from).ok();
        fs::remove_dir_all(&to).ok();
    }

    #[test]
    fn migrate_leaves_file_in_place_when_rename_fails() {
        let from = temp_workdir("from3");
        // 失败路径注入：目标目录不存在 → rename 报错（真实「文件被占用」在
        // NTFS 同卷 rename 下不可稳定复现——已打开句柄跟随文件移动，故用
        // rename 错误分支等价覆盖「失败留原地 + 计数」语义）
        let to = from.join("nonexistent-target");
        fs::write(from.join("apilot.log.2026-09-28"), "stuck").unwrap();

        let (moved, left) = migrate_log_files(&from, &to);
        assert_eq!((moved, left), (0, 1));
        assert!(from.join("apilot.log.2026-09-28").exists());

        fs::remove_dir_all(&from).ok();
    }

    #[test]
    fn migrate_tolerates_missing_source_dir() {
        let missing =
            std::env::temp_dir().join(format!("apilot-migrate-absent-{}", std::process::id()));
        let to = temp_workdir("to4");
        assert_eq!(migrate_log_files(&missing, &to), (0, 0));
        fs::remove_dir_all(&to).ok();
    }
}
